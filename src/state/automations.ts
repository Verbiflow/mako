import { toast } from "sonner"
import { z } from "zod"
import type {
  AutomationDefinition,
  AutomationDraft,
  AutomationProjectReading,
  AutomationProposal,
  AutomationHook,
  AutomationRun,
  AutomationRunOf,
  AutomationTemplate,
  AutomationView,
} from "@mako/host/contracts/automations"
import { automationFingerprint } from "@mako/host/contracts/automations"
import type { JsonValue } from "@mako/host/contracts/json"
import { createHook, createStore } from "@/state/store"
import { getMako, hasBridge } from "@/lib/bridge"
import { ACTION_TOAST_MS } from "@/lib/toast-duration"

/**
 * Automations, as this window holds them: each project's reading (its definitions, what this Mac keeps of each, its
 * proposals and how its file read), each automation's runs once asked for, and the templates.
 *
 * The definitions live in the project's `.mako/automations.json`, committed and shared; whether one is on is this
 * Mac's alone, held by the host and never written back. A reading arrives whole per project
 * (`automations-changed`) and a run as it moves (`automation-run`), so the view, the rail's count and a Thread's line
 * all read from here.
 */
export interface AutomationsState {
  loaded: boolean
  /** Why the host couldn't read them, while it can't. */
  failed?: string
  projects: AutomationProjectReading[]
  /** Runs per automation (`runsKey`), newest first, once the view asked for them. */
  runs: Record<string, AutomationRun[]>
  templates: AutomationTemplate[] | null
  /** Each run this window heard of, by its Thread's conversation: a Thread started by an automation says so. */
  byConversation: Record<string, AutomationRun>
  /** What the host said a Thread is (`mako:automations-run-of`), for a run this window never heard of; null for none. */
  runOf: Record<string, AutomationRunOf | null>
  /** A change the person reviews before it's approved (`reviewChange`), answered from `AutomationReviewHost`. */
  review: AutomationReview | null
}

/**
 * What turning on, Run now or a save would approve, against what the person approved before (absent: never approved),
 * shown before it's approved: nothing runs a definition they haven't seen.
 */
export interface AutomationReview {
  project: string
  id: string
  name: string
  action: "on" | "run" | "save"
  before?: JsonValue
  after: JsonValue
  answer(approved: boolean): void
}

export const automationsStore = createStore<AutomationsState>({
  loaded: false,
  projects: [],
  runs: {},
  templates: null,
  byConversation: {},
  runOf: {},
  review: null,
})

export const useAutomations = createHook(automationsStore)

export function runsKey(project: string, id: string): string {
  return `${project}\u0000${id}`
}

/** One automation's view, wherever it is. */
export function automationView(state: AutomationsState, project: string, id: string): AutomationView | undefined {
  return state.projects.find((reading) => reading.project === project)?.automations.find((view) => view.definition.id === id)
}

export function projectReading(state: AutomationsState, project: string): AutomationProjectReading | undefined {
  return state.projects.find((reading) => reading.project === project)
}

export function proposalById(state: AutomationsState, id: string): AutomationProposal | undefined {
  for (const reading of state.projects) {
    const found = reading.proposals.find((proposal) => proposal.id === id)
    if (found) return found
  }
  return undefined
}

/** Every automation that's on, across projects: the rail's count. */
export function automationsOn(state: AutomationsState): number {
  return state.projects.reduce((sum, reading) => sum + reading.automations.filter((view) => view.local.enabled).length, 0)
}

/** Proposals waiting on the person, across projects. */
export function pendingProposals(state: AutomationsState): number {
  return state.projects.reduce((sum, reading) => sum + reading.proposals.filter((proposal) => proposal.status === "pending").length, 0)
}

function indexRuns(byConversation: Record<string, AutomationRun>, runs: Iterable<AutomationRun | undefined>): Record<string, AutomationRun> {
  let next = byConversation
  for (const run of runs) {
    const conversation = run?.thread?.conversation
    if (!run || !conversation) continue
    const held = next[conversation]
    if (held && held.at > run.at) continue
    if (next === byConversation) next = { ...byConversation }
    next[conversation] = run
  }
  return next
}

function readingRuns(reading: AutomationProjectReading): Array<AutomationRun | undefined> {
  return reading.automations.flatMap((view) => [view.lastRun, view.activeRun])
}

/** A project's reading, whole, in place of the one held: `automations-changed`, and every write's answer. */
export function applyAutomationsChanged(reading: AutomationProjectReading): void {
  const state = automationsStore.get()
  const at = state.projects.findIndex((each) => each.project === reading.project)
  const projects = at === -1 ? [...state.projects, reading] : state.projects.map((each, index) => (index === at ? reading : each))
  automationsStore.set({ projects, loaded: true, byConversation: indexRuns(state.byConversation, readingRuns(reading)) })
}

/** A run recorded or moved (`automation-run`): its automation's history, its row's last and active run, and its Thread. */
export function noteAutomationRun(run: AutomationRun): void {
  const state = automationsStore.get()
  const key = runsKey(run.project, run.automation)
  const held = state.runs[key]
  const runs = held ? { ...state.runs, [key]: [run, ...held.filter((each) => each.occurrence !== run.occurrence)].sort((a, b) => b.at - a.at) } : state.runs
  const projects = state.projects.map((reading) =>
    reading.project !== run.project
      ? reading
      : {
          ...reading,
          automations: reading.automations.map((view) => {
            if (view.definition.id !== run.automation) return view
            const working = run.status === "fired" || run.status === "queued"
            const activeRun = working ? run : view.activeRun?.occurrence === run.occurrence ? undefined : view.activeRun
            const lastRun = !view.lastRun || view.lastRun.occurrence === run.occurrence || run.at >= view.lastRun.at ? run : view.lastRun
            const standing = run.status === "fired" ? "running" : view.standing === "running" && !activeRun ? (view.local.enabled ? "on" : "off") : view.standing
            return { ...view, lastRun, activeRun, standing }
          }),
        }
  )
  automationsStore.set({ runs, projects, byConversation: indexRuns(state.byConversation, [run]) })
  announceRun(run)
}

function nameOf(project: string, id: string): string {
  return automationView(automationsStore.get(), project, id)?.definition.name ?? id
}

/** A run the person should hear of where they are: one they started, and one that didn't make it. */
function announceRun(run: AutomationRun): void {
  const name = nameOf(run.project, run.automation)
  const conversation = run.thread?.conversation
  if (run.status === "fired" && run.cause.kind === "person") {
    toast(`${name} started`, { duration: ACTION_TOAST_MS, description: "Its Thread works in the background", ...(conversation && { action: { label: "Open", onClick: () => void openRunThread(run) } }) })
  } else if (run.status === "failed-to-start" || run.status === "failed") {
    toast.error(`${name} ${run.status === "failed" ? "failed" : "didn't start"}`, {
      duration: ACTION_TOAST_MS,
      description: run.why,
      action: { label: "Show", onClick: () => void import("@/state/automations-view").then(({ showAutomation }) => showAutomation(run.project, run.automation)) },
    })
  }
}

/** A run's Thread, opened as a row would open it. */
export async function openRunThread(run: Pick<AutomationRun, "thread">): Promise<void> {
  const conversation = run.thread?.conversation
  if (!conversation) return
  const { acp } = await import("@/state/acp")
  acp.open(conversation)
}

function failure(error: Error | string): string {
  return error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(error)
}

const JSON_VALUE = z.json()

/** A definition as JSON, as a review shows it. */
function definitionJson(definition: AutomationDefinition): JsonValue {
  return JSON_VALUE.parse(JSON.parse(JSON.stringify(definition)))
}

/** Whether `view`'s definition, as the file says it now, is one the person approved. */
export function approvedNow(view: Pick<AutomationView, "local" | "fingerprint">): boolean {
  return view.local.approved === view.fingerprint
}

/** Shows what approving would approve and waits for the person's answer; a second review answers the first with no. */
export function reviewChange(request: Omit<AutomationReview, "answer">): Promise<boolean> {
  automationsStore.get().review?.answer(false)
  return new Promise((resolve) => {
    const answer = (approved: boolean) => {
      if (automationsStore.get().review?.answer === answer) automationsStore.set({ review: null })
      resolve(approved)
    }
    automationsStore.set({ review: { ...request, answer } })
  })
}

let loading: Promise<void> | null = null

export const automations = {
  /** Every project's reading; once, unless `force`. */
  load(force = false): Promise<void> {
    if (!hasBridge()) return Promise.resolve()
    if (loading) return loading
    if (automationsStore.get().loaded && !force) return Promise.resolve()
    loading = getMako()
      .automations()
      .then(
        (reading) => {
          const state = automationsStore.get()
          automationsStore.set({ loaded: true, failed: undefined, projects: reading.projects, byConversation: indexRuns(state.byConversation, reading.projects.flatMap(readingRuns)) })
        },
        (error) => automationsStore.set({ loaded: true, failed: failure(error instanceof Error ? error : String(error)) })
      )
      .finally(() => {
        loading = null
      })
    return loading
  },

  async loadRuns(project: string, id: string, limit = 50): Promise<void> {
    if (!hasBridge()) return
    const runs = await getMako().automationRuns(project, id, limit).catch(() => null)
    if (!runs) return
    const state = automationsStore.get()
    automationsStore.set({ runs: { ...state.runs, [runsKey(project, id)]: runs }, byConversation: indexRuns(state.byConversation, runs) })
  },

  async loadTemplates(): Promise<AutomationTemplate[]> {
    const held = automationsStore.get().templates
    if (held) return held
    if (!hasBridge()) return []
    const templates = await getMako().automationTemplates().catch(() => [])
    automationsStore.set({ templates })
    return templates
  },

  /**
   * The person's edit, written to the project's file at once; `replaces` is the id it had when renamed. On one that's on
   * whose file changed since they approved it (an edit outside Mako), they see everything their save would approve,
   * from what they approved, first: declined, nothing is saved.
   */
  async save(project: string, definition: AutomationDefinition, replaces?: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const view = automationView(automationsStore.get(), project, replaces ?? definition.id)
    let approve: string | undefined
    if (view?.local.enabled && !approvedNow(view)) {
      const after = definitionJson(definition)
      if (!(await reviewChange({ project, id: definition.id, name: definition.name, action: "save", ...(view.local.approvedDefinition !== undefined && { before: view.local.approvedDefinition }), after })))
        return { ok: false, error: "Not saved: its file changed since you approved it, and saving approves that change too." }
      approve = automationFingerprint(definition)
    }
    try {
      const reading = await getMako().saveAutomation(project, JSON_VALUE.parse(definition), replaces, approve)
      applyAutomationsChanged(reading)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: failure(error instanceof Error ? error : String(error)) }
    }
  },

  /** Removes it from the file; the toast puts it back, off, as it was written. */
  async remove(project: string, id: string): Promise<boolean> {
    const view = automationView(automationsStore.get(), project, id)
    try {
      applyAutomationsChanged(await getMako().deleteAutomation(project, id))
    } catch (error) {
      toast.error("Couldn't delete it", { description: failure(error instanceof Error ? error : String(error)) })
      return false
    }
    if (view) {
      const definition = view.definition
      toast(`Deleted ${definition.name}`, {
        duration: ACTION_TOAST_MS,
        description: "Removed from .mako/automations.json",
        action: { label: "Undo", onClick: () => void automations.save(project, definition).then((saved) => (saved.ok ? toast(`${definition.name} is back, off`) : toast.error("Couldn't put it back", { description: saved.error }))) },
      })
    }
    return true
  },

  /**
   * On or off. On again after its file changed since the person approved it shows them that change first, unless they
   * just read it on its page (`reviewed`); declined, it stays as it is.
   */
  async setEnabled(project: string, id: string, enabled: boolean, reviewed = false): Promise<void> {
    const view = automationView(automationsStore.get(), project, id)
    let approve: string | undefined
    if (enabled && view && view.local.approvedDefinition !== undefined && !approvedNow(view)) {
      if (!reviewed && !(await reviewChange({ project, id, name: view.definition.name, action: "on", before: view.local.approvedDefinition, after: definitionJson(view.definition) }))) return
      approve = view.fingerprint
    }
    try {
      applyAutomationsChanged(await getMako().setAutomationEnabled(project, id, enabled, approve))
    } catch (error) {
      toast.error(enabled ? "Couldn't turn it on" : "Couldn't turn it off", { description: failure(error instanceof Error ? error : String(error)) })
    }
  },

  /** Run now, under a key of this press: a second press is another run, a retry of this one the same. */
  async runNow(project: string, id: string): Promise<AutomationRun | undefined> {
    const clientKey = `now-${crypto.randomUUID()}`
    // Only an approved definition runs: one the file changed since, or never approved, is shown first, and approved by running it.
    const view = automationView(automationsStore.get(), project, id)
    let approve: string | undefined
    if (view && !approvedNow(view)) {
      if (!(await reviewChange({ project, id, name: view.definition.name, action: "run", ...(view.local.approvedDefinition !== undefined && { before: view.local.approvedDefinition }), after: definitionJson(view.definition) }))) return undefined
      approve = view.fingerprint
    }
    try {
      const result = await getMako().runAutomation(project, id, clientKey, approve)
      if ("refused" in result) {
        toast(`${nameOf(project, id)} didn't run`, { description: result.refused })
        return undefined
      }
      noteAutomationRun(result.run)
      return result.run
    } catch (error) {
      toast.error(`Couldn't run ${nameOf(project, id)}`, { description: failure(error instanceof Error ? error : String(error)) })
      return undefined
    }
  },

  /** Approve or decline from Automations; the Inbox answers the same proposal through its ask. */
  async decide(proposal: string, approve: boolean): Promise<AutomationProposal | undefined> {
    try {
      const decided = await getMako().decideAutomationProposal(proposal, approve)
      const state = automationsStore.get()
      automationsStore.set({
        projects: state.projects.map((reading) => (reading.project === decided.project ? { ...reading, proposals: reading.proposals.map((each) => (each.id === decided.id ? decided : each)) } : reading)),
      })
      if (decided.status === "stale") toast("That proposal is out of date", { description: decided.note ?? "The automation changed after it was proposed, so it wasn't applied." })
      else if (decided.status === "expired") toast("That proposal expired", { description: "Its agent can propose it again." })
      return decided
    } catch (error) {
      toast.error(approve ? "Couldn't approve it" : "Couldn't decline it", { description: failure(error instanceof Error ? error : String(error)) })
      return undefined
    }
  },

  /** Which automation ran a Thread, asked of the host once per conversation; the runs this window holds answer first. */
  async runOf(conversation: string): Promise<void> {
    if (!hasBridge() || conversation in automationsStore.get().runOf) return
    automationsStore.set((state) => ({ runOf: { ...state.runOf, [conversation]: null } }))
    const found = await getMako().automationRunOf(conversation).catch(() => null)
    if (found) automationsStore.set((state) => ({ runOf: { ...state.runOf, [conversation]: found } }))
  },

  /** A webhook's address at the cloud account, made if new; `rotate` gives it a new secret. The secret shows only in this answer. */
  async hook(name: string, provider: AutomationHook["provider"], rotate = false): Promise<AutomationHook | undefined> {
    try {
      return await getMako().automationHook(name, provider, rotate)
    } catch (error) {
      toast.error(rotate ? "Couldn't rotate its secret" : "Couldn't get its address", { description: failure(error instanceof Error ? error : String(error)) })
      return undefined
    }
  },

  /** An automation made from a Thread's first prompt and how it started. */
  async draft(conversationId: string): Promise<AutomationDraft | undefined> {
    try {
      return await getMako().draftAutomation(conversationId)
    } catch (error) {
      toast.error("Couldn't make an automation from this Thread", { description: failure(error instanceof Error ? error : String(error)) })
      return undefined
    }
  },
}
