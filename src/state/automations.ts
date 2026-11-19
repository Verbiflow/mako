import { toast } from "sonner"
import { z } from "zod"
import type {
  AutomationDefinition,
  AutomationDraft,
  AutomationProjectReading,
  AutomationProposal,
  AutomationRun,
  AutomationTemplate,
  AutomationView,
} from "@mako/host/contracts/automations"
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
}

export const automationsStore = createStore<AutomationsState>({
  loaded: false,
  projects: [],
  runs: {},
  templates: null,
  byConversation: {},
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

  /** The person's edit, written to the project's file at once; `replaces` is the id it had when renamed. */
  async save(project: string, definition: AutomationDefinition, replaces?: string): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const reading = await getMako().saveAutomation(project, JSON_VALUE.parse(definition), replaces)
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

  async setEnabled(project: string, id: string, enabled: boolean): Promise<void> {
    try {
      applyAutomationsChanged(await getMako().setAutomationEnabled(project, id, enabled))
    } catch (error) {
      toast.error(enabled ? "Couldn't turn it on" : "Couldn't turn it off", { description: failure(error instanceof Error ? error : String(error)) })
    }
  },

  /** Run now, under a key of this press: a second press is another run, a retry of this one the same. */
  async runNow(project: string, id: string): Promise<AutomationRun | undefined> {
    const clientKey = `now-${crypto.randomUUID()}`
    try {
      const result = await getMako().runAutomation(project, id, clientKey)
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
