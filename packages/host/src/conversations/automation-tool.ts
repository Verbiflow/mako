import { isAbsolute } from "node:path"
import { z } from "zod"
import { machineCall, NOT_THE_PERSON } from "../base/host-client.js"
import type { MethodTable } from "../base/methods.js"
import type { AccessTier } from "../contracts/access.js"
import type { AgentCaller } from "../contracts/agents.js"
import type { AgentAskWant } from "../contracts/agent-asks.js"
import { automationDiff, triggerWords, type AutomationCause, type AutomationChange, type AutomationProjectReading, type AutomationProposal, type AutomationRun, type AutomationRunNowResult } from "../contracts/automations.js"
import type { JsonValue } from "../contracts/json.js"
import { AFTER_ACT, type AutomationActInput, type AutomationActResult } from "../contracts/thread-tools.js"
import type { AgentAskGate } from "./agent-ask-gate.js"
import { OnceByKey } from "./once-by-key.js"

/** What the tool reads and asks of the host's automations (`workspaces/automations.ts`). */
export interface AutomationToolApi {
  reading(project: string): Promise<AutomationProjectReading>
  runs(project: string, id?: string, limit?: number): AutomationRun[]
  runNow(project: string, id: string, clientKey: string, cause?: AutomationCause): Promise<AutomationRunNowResult>
  setEnabled(project: string, id: string, enabled: boolean): Promise<AutomationProjectReading>
  save(project: string, definition: JsonValue, replaces?: string): Promise<AutomationProjectReading>
  remove(project: string, id: string): Promise<AutomationProjectReading>
  propose(by: { conversation: string; title?: string; harness?: string }, input: { project: string; change: AutomationChange; id?: string; definition?: JsonValue; why?: string; clientKey: string }): Promise<AutomationProposal | { refused: "no-automation" | "invalid"; why: string }>
  proposal(id: string): AutomationProposal | undefined
  decide(id: string, approve: boolean, via?: "ask" | "view"): Promise<AutomationProposal>
  legacyLaunched(operation: string): Promise<boolean>
}

export interface AutomationToolDeps {
  /** The conversation a Session's agent runs in here. */
  conversationOf(session: string): string | undefined
  tier(conversationId: string): AccessTier | undefined
  /** A conversation's folder, its title and harness, as a proposal names its agent. */
  folderOf(conversationId: string): string | undefined
  titleOf?(conversationId: string): string | undefined
  harnessOf?(conversationId: string): string | undefined
  /** The folder in front, for the person's own call from a shell outside any Thread. */
  frontFolder?(): string | undefined
  automations(): AutomationToolApi | undefined
  gate: AgentAskGate
}

const PROPOSED_NEXT = "Go on with your work: the person decides from the Inbox or Automations, and you hear the decision as Mako's note. Don't wait or ask again."

/** An agent's or a shell's look at the person's automations; what it would change is the person's to approve. */
export class AutomationTool {
  readonly #deps: AutomationToolDeps
  /** A run is a new Thread, and nothing else settles a repeat of one. */
  readonly #once = new OnceByKey<AutomationActResult>()

  constructor(deps: AutomationToolDeps) {
    this.#deps = deps
  }

  async act(caller: AgentCaller, input: AutomationActInput): Promise<AutomationActResult> {
    const automations = this.#deps.automations()
    if (!automations) return { refused: "unavailable", why: "This host has no automations." }
    const own = caller.kind === "agent" ? this.#deps.conversationOf(caller.session) : undefined
    if (caller.kind === "agent" && !own) return { refused: "no-thread", why: "No conversation here has that Session. Call it from a Thread's mako tools, or its shell, where MAKO_SESSION_ID names it." }
    const project = input.project ?? (own ? this.#deps.folderOf(own) : undefined) ?? this.#deps.frontFolder?.()
    if (!project || !isAbsolute(project)) return { refused: "no-project", why: "Name the project folder (project), as an absolute path: this Thread has none." }
    try {
      return await this.#act(automations, caller, own, project, input)
    } catch (error) {
      return { refused: "failed", why: error instanceof Error ? error.message : String(error) }
    }
  }

  async #act(automations: AutomationToolApi, caller: AgentCaller, own: string | undefined, project: string, input: AutomationActInput): Promise<AutomationActResult> {
    const { action } = input
    if (action === "proposal") {
      const proposal = input.proposal ? automations.proposal(input.proposal) : undefined
      if (!proposal) return { refused: "invalid", why: "Name the proposal by the id create, update, delete or enable answered." }
      return { outcome: "proposal", proposal: proposalJson(proposal) }
    }
    if (action === "list") {
      const reading = await automations.reading(project)
      return { outcome: "listed", automations: listJson(reading) }
    }
    if (action === "create") return this.#propose(automations, caller, own, project, "create", input)
    if (!input.id) return { refused: "no-automation", why: "Name the automation: list gives each one's id." }
    const reading = await automations.reading(project)
    const view = reading.automations.find((each) => each.definition.id === input.id)
    if (!view) return { refused: "no-automation", why: `No automation in ${project} has the id ${input.id}: list gives each one's id.` }
    if (action === "get") return { outcome: "got", automation: json({ ...view, proposals: reading.proposals.filter((proposal) => proposal.automation === input.id && proposal.status === "pending") }) }
    if (action === "runs") return { outcome: "runs", runs: json(automations.runs(project, input.id, Math.max(1, Math.min(input.limit ?? 10, 50)))) }
    if (action === "update" || action === "delete" || action === "enable") return this.#propose(automations, caller, own, project, action, input)
    // disable and run_now: now on full access, else once the person allows.
    const change = action === "disable" ? "off" : "run"
    if (own && this.#deps.tier(own) !== "full") {
      const ask = this.#deps.gate.ask(own, { kind: "automation", action: change, id: input.id, cwd: project })
      return { outcome: "asked", ask: ask.id, next: AFTER_ACT.asked }
    }
    const id = input.id
    return this.#once.run(JSON.stringify([own ?? "person", input.clientKey, action, id, project]), () =>
      this.run(change, id, project, own ? { kind: "agent", conversation: own } : { kind: "person" }, `${own ?? "person"}\0${input.clientKey}`))
  }

  async #propose(automations: AutomationToolApi, caller: AgentCaller, own: string | undefined, project: string, change: AutomationChange, input: AutomationActInput): Promise<AutomationActResult> {
    if (!own) {
      // The person's own call (a shell outside any Thread) applies at once, as their edit in Automations does.
      if (caller.kind !== "person") return { refused: "no-thread", why: "Call it from a Thread's mako tools." }
      const id = input.id
      if (change === "delete" && id) await automations.remove(project, id)
      else if (change === "enable" && id) await automations.setEnabled(project, id, true)
      else {
        const reading = await automations.reading(project)
        const current = reading.automations.find((each) => each.definition.id === id)?.definition
        await automations.save(project, json({ ...(current ?? {}), ...objectOf(input.definition), ...(id && { id }) }))
      }
      return { outcome: "done", action: change, id: id ?? "" }
    }
    const made = await automations.propose(
      { conversation: own, ...(this.#deps.titleOf?.(own) && { title: this.#deps.titleOf(own)!.slice(0, 200) }), ...(this.#deps.harnessOf?.(own) && { harness: this.#deps.harnessOf(own)! }) },
      { project, change, ...(input.id && { id: input.id }), ...(input.definition !== undefined && { definition: input.definition }), ...(input.why && { why: input.why }), clientKey: input.clientKey }
    )
    if ("refused" in made) return made
    if (made.status !== "pending") return { outcome: "proposal", proposal: proposalJson(made) }
    return { outcome: "proposed", proposal: made.id, status: "pending", expiresAt: new Date(made.expiresAt).toISOString(), diff: json(automationDiff(made.before, made.after)), next: PROPOSED_NEXT }
  }

  /** The person allowed a run or a switch an agent asked for; what's said is what the host says happened. */
  async allowed(conversationId: string, want: Extract<AgentAskWant, { kind: "automation" }>, askId: string): Promise<void> {
    // The gate passes this exact durable identity, even if another snapshot read replaced its objects.
    const ask = this.#deps.gate.open(conversationId).find((ask) => ask.id === askId)
    if (ask?.want.kind !== "automation" || ask.want.action !== want.action || ask.want.id !== want.id || ask.want.cwd !== want.cwd) throw new Error("That automation approval is no longer waiting here.")
    if (!want.cwd) throw new Error("This older ask doesn't name its automation's workspace. Keep it and ask again from the intended workspace.")
    const operation = JSON.stringify([conversationId, ask.id])
    // An older build that launched this approval kept a receipt: it never launches twice.
    if (want.action === "run" && await this.#deps.automations()?.legacyLaunched(operation)) return
    const answer = await this.run(want.action, want.id, want.cwd, { kind: "agent", conversation: conversationId, ask: ask.id }, operation)
    if ("refused" in answer) throw new Error(answer.why)
  }

  /** The person allowed an agent's proposal from its card: applied, unless it went stale. */
  async proposalAllowed(want: Extract<AgentAskWant, { kind: "automation-proposal" }>): Promise<void> {
    const automations = this.#deps.automations()
    if (!automations) throw new Error("This host has no automations.")
    await automations.decide(want.proposal, true, "ask")
  }

  /** The person declined it from its card. */
  async proposalDeclined(want: Extract<AgentAskWant, { kind: "automation-proposal" }>): Promise<void> {
    await this.#deps.automations()?.decide(want.proposal, false, "ask")
  }

  /** Run now, or the switch. A run's key makes a repeat the same run, and so the same Thread. */
  async run(action: "run" | "on" | "off", id: string, project: string, cause: AutomationCause, key: string): Promise<AutomationActResult> {
    const automations = this.#deps.automations()
    if (!automations) return { refused: "unavailable", why: "This host has no automations." }
    if (action !== "run") {
      const reading = await automations.setEnabled(project, id, action === "on")
      const now = reading.automations.find((each) => each.definition.id === id)
      if (now?.local.enabled !== (action === "on")) return { refused: "failed", why: `It stays ${now?.local.enabled ? "on" : "off"}.` }
      return { outcome: "done", action: action === "on" ? "enable" : "disable", id }
    }
    const fired = await automations.runNow(project, id, key, cause)
    if ("refused" in fired) return { refused: "no-automation", why: fired.refused }
    const { run } = fired
    if (run.status === "failed-to-start" || run.status === "skipped" || run.status === "gate-skipped") return { refused: "failed", why: run.why ?? `It was ${run.status}.` }
    return { outcome: "done", action: "run_now", id, run: json({ occurrence: run.occurrence, status: run.status, ...(run.thread && { conversation: run.thread.conversation }), ...(run.why && { why: run.why }) }) }
  }
}

/** What the tool answers with: the contract's records, whose optional parts may be absent. */
type JsonInput = string | number | boolean | null | undefined | readonly JsonInput[] | { readonly [key: string]: JsonInput }

const JsonSchema = z.json()
const JsonObjectSchema = z.record(z.string(), z.json())

function json(value: JsonInput): JsonValue {
  return JsonSchema.parse(JSON.parse(JSON.stringify(value ?? null)))
}

function objectOf(value: JsonValue | undefined): Record<string, JsonValue> {
  return JsonObjectSchema.safeParse(value).data ?? {}
}

/** The list an agent reads: each automation in a line's worth, and what waits on the person. */
function listJson(reading: AutomationProjectReading): JsonValue {
  return json({
    project: reading.project,
    automations: reading.automations.map((view) => ({
      id: view.definition.id,
      name: view.definition.name,
      standing: view.standing,
      triggers: view.definition.triggers.map(triggerWords),
      ...(view.local.nextRunAt && { nextRunAt: new Date(view.local.nextRunAt).toISOString() }),
      ...(view.local.paused && { paused: view.local.paused.reason }),
      ...(view.lastRun && { lastRun: { occurrence: view.lastRun.occurrence, status: view.lastRun.status, ...(view.lastRun.why && { why: view.lastRun.why }) } }),
    })),
    pending: reading.proposals.filter((proposal) => proposal.status === "pending").map((proposal) => ({ proposal: proposal.id, change: proposal.change, id: proposal.automation })),
    ...(reading.file.error && { error: reading.file.error }),
  })
}

function proposalJson(proposal: AutomationProposal): JsonValue {
  return json({ proposal: proposal.id, status: proposal.status, change: proposal.change, id: proposal.automation, expiresAt: new Date(proposal.expiresAt).toISOString(), diff: automationDiff(proposal.before, proposal.after), ...(proposal.note && { note: proposal.note }) })
}

/** `mako:automations-act`. */
export function declareAutomationToolMethods(methods: MethodTable, tool: () => Pick<AutomationTool, "act"> | undefined): void {
  methods.handle("mako:automations-act", (caller: AgentCaller, input: AutomationActInput) =>
    caller.kind === "person" && machineCall() ? { refused: "no-thread" as const, why: NOT_THE_PERSON } : tool()?.act(caller, input) ?? { refused: "unavailable", why: "This host has no automations." })
}
