import type { ThreadRef } from "@mako/sessions"
import type { Entry } from "@mako/sessions/entries"
import type { HostJobs } from "../base/host-jobs.js"
import { hostLog, hostWarn } from "../base/host-log.js"
import { errorMessage } from "../base/error-message.js"
import { z } from "zod"
import { ACCESS_TIER_NAMES, accessModeId, accessTierOfModeId, type AccessTier } from "../contracts/access.js"
import {
  childAccess,
  childEntry,
  childMode,
  childState,
  PlaceSchema,
  reportPhase,
  reportRoute,
  APEX_ROLE,
  APEX_WORD,
  FIN_WORD,
  TREE_BUDGET,
  type AgentCaller,
  type AgentRefused,
  type AgentsDiagnostics,
  type AgentsDirected,
  type AgentsDirectInput,
  type AgentsRedirected,
  type AgentsRedirectInput,
  type Brief,
  type ChildStart,
  type ChildState,
  type ChildThread,
  type QueueReason,
  type Report,
  type ThreadParent,
  type TreeBudget,
} from "../contracts/agents.js"
import {
  afterStart,
  WAIT_LIMIT_MS,
  type AgentOperations,
  type AgentStrip,
  type AgentsLinkInput,
  type AgentsLinkResult,
  type AgentsListInput,
  type AgentsListResult,
  type AgentsReadInput,
  type AgentsReadResult,
  type AgentsReportInput,
  type AgentsReportResult,
  type AgentsSendInput,
  type AgentsSendResult,
  type AgentsSent,
  type AgentsStarted,
  type AgentsStartInput,
  type AgentsStartResult,
  type AgentsStopInput,
  type AgentsStopResult,
  type AgentsWaitInput,
  type AgentsWaitResult,
  type StartWaited,
  type WaitedReport,
  type FrontDoorChild,
  frontDoorNote,
} from "../contracts/agent-tools.js"
import { agentWords, BRIEF_CLOSE, briefIntro, finName, PASSED_ON_NOTE, passedOn, YOUR_APEX } from "../contracts/children.js"
import { hostCallSchema } from "../contracts/host-call-inputs.js"
import type { NativeAgent } from "../contracts/native-agents.js"
import type { LiveRequest, LiveStartOptions } from "../contracts/live-conversations.js"
import type { LiveSessionMode, PromptAttachment } from "../contracts/providers-acp.js"
import { SessionIdSchema, ThreadIdSchema, type Actor } from "../contracts/thread-identity.js"
import { uniqueName, type ThreadCatalog, type ThreadStore } from "../threads/index.js"
import { AgentRuns, lastStep, type ProcessReads, type RunEnd } from "./agent-runs.js"
import { AgentWakes, digest, fromAgent, type Notice, type ParentReady } from "./agent-wakes.js"
import { namedUuid } from "./cloud-moves.js"
import type { LiveConversations } from "./live-conversations.js"
import type { ConversationChildren } from "./live-runtime.js"

const NONE: readonly NativeAgent[] = []
/** Entries `agents_read` shows of a transcript, and the characters it returns at most. */
const READ_ENTRIES = 40
const READ_CHARS = 8_000

type Live = Pick<
  LiveConversations,
  "session" | "held" | "snapshot" | "editQueued" | "transfer" | "submit" | "act" | "cancel" | "waitingOn" | "steersAtStep" | "turnReply" | "childrenChanged" | "connectedSession" | "recordDirect"
>

export interface AgentsDeps {
  store(): ThreadStore | undefined
  catalog: Pick<ThreadCatalog, "nativePath" | "ref" | "page" | "activity" | "subscribe" | "announce">
  jobs: HostJobs
  live: Live
  /** Starts a conversation as `mako:live-start` does: its worktree, its profile and its mode. */
  startLive(harness: string, cwd: string, options: LiveStartOptions): Promise<void>
  /** The harnesses a Fin can run on: those with a live driver here. */
  harnesses(): readonly string[]
  /** Whether `harness` has a CLI a Thread's shell can run, so a Session of it can be one started there. */
  runs(harness: string): boolean
  harnessLabel(harness: string): string
  /** The modes `harness`'s live driver declares, each with its access tier; undefined for one that declares none. */
  modes(harness: string): readonly LiveSessionMode[] | undefined
  budget?: TreeBudget
  processes?: ProcessReads
  now?(): number
}

/** An Apex resolved in the store: its Session, its Thread, and its conversation here. */
interface Apex {
  session: string
  thread: string
  conversation?: string
}

/** What a spawn the running budget holds keeps, so the host that drains it starts what was asked. */
interface QueuedStart {
  /** Its Apex, under the key queued spawns were stored with. */
  lead: Apex
  input: AgentsStartInput
  tier: AccessTier
  harness: string
}

const QueuedStartSchema = z.object({
  lead: z.object({ session: z.string(), thread: z.string(), conversation: z.string().optional() }),
  input: hostCallSchema("mako:agents-start").def.items[1],
  tier: z.enum(ACCESS_TIER_NAMES),
  harness: z.string(),
}) satisfies z.ZodType<QueuedStart>

/** How many of a tree's Threads work now and how many it started, as its budget counts them. */
type TreeCounts = { [Count in keyof TreeBudget]: number }

/** A `wait` start holding for its Fin: the Apex's conversation whose turn made the call, and how it hears the Fin move. */
interface Hold {
  child: string
  apex?: string
  check(): void
  end(): void
}

/**
 * The one engine every Fin goes through (`contracts/agents.ts`): a Thread
 * another Thread's agent started (`agents_start`), or a harness CLI run its
 * shell started (`discovered`) or it named (`agents_link`). It starts a
 * Fin through `mako:live-start`, so a Fin is a conversation like any
 * other with its edge written with its Session (`LiveStartOptions.parent`);
 * follows it through its live conversation, or through `AgentRuns` while a
 * process Mako didn't start runs it; writes each end once, with at most one
 * implicit report; and tells the parent through `AgentWakes`. A tree's
 * budgets are held here, by the top Apex's host. Nothing here is saved twice:
 * the edge and the reports are the store's, the state is computed.
 */
export class Agents implements AgentOperations, ConversationChildren {
  readonly runs: AgentRuns
  readonly wakes: AgentWakes
  private readonly deps: AgentsDeps
  private readonly budget: TreeBudget
  /** This host's generation as a writer of reports: a report from an older owner is refused (`keepReport`). */
  private readonly generation: number
  private readonly entries = new Map<string, NativeAgent>()
  private readonly rosters = new Map<string, readonly NativeAgent[]>()
  private readonly conversations = new Map<string, string>()
  private readonly childOf = new Map<string, string>()
  private readonly starting = new Set<string>()
  private readonly waiters = new Set<() => void>()
  /** `wait` starts holding now: while one holds a Fin, its reports answer the start rather than wake its Apex. */
  private readonly holds = new Set<Hold>()
  /** Notices for a parent whose turns a followed process runs: they start its next turn once that process ends. */
  private readonly held = new Map<string, Notice[]>()
  /** The decision a blocked Fin's Apex was told of, by Fin: told once per question. */
  private readonly asked = new Map<string, string>()
  /** What each `agents_send` key delivered, so a retry answers the same. */
  private readonly sent = new Map<string, AgentsSent>()
  /** What joined a running turn as a step, by its id: no request holds it for `redirect` to find. */
  private readonly steered = new Map<string, Pick<LiveRequest, "text" | "attachments">>()
  /** The person's direct messages by their request, delivering or delivered, so a repeat answers the first. */
  private readonly directed = new Map<string, Promise<AgentsDirected | AgentRefused>>()
  private readonly routes = { forwarded: 0, sent: 0, redirected: 0, direct: 0 }
  private latest = new Map<string, Report>()
  private seen: unknown
  private draining = false
  private stopped = false

  constructor(deps: AgentsDeps) {
    this.deps = deps
    this.budget = deps.budget ?? TREE_BUDGET
    this.generation = Math.max(1, Math.floor(this.now()))
    this.runs = new AgentRuns({
      store: deps.store,
      catalog: deps.catalog,
      jobs: deps.jobs,
      runs: deps.runs,
      conversationOwns: (ref, marker) => this.conversationOwns(ref, marker),
      changed: (edge, progressOnly) => this.childMoved(edge, progressOnly),
      ended: (edge, ended) => this.runEnded(edge, ended),
      ...(deps.processes && { processes: deps.processes }),
      now: deps.now,
    })
    this.wakes = new AgentWakes({
      ready: (conversation) => this.ready(conversation),
      wake: (conversation, request, text, actor) => {
        deps.live.submit(conversation, request, text, [], undefined, undefined, undefined, actor)
      },
      steer: (conversation, id, text) => this.steer(conversation, id, text),
      assign: (reports, request) => this.store()?.assignWake(reports, request),
      delivered: (reports, at) => this.store()?.markReportsDelivered(reports, at),
      counts: (conversation) => this.counts(conversation),
      now: deps.now,
    })
  }

  /** What the last host left: reports no Apex heard, sent again under their ids, Fins' messages its exit paused, and spawns the budget held. */
  resume(): void {
    const store = this.store()
    if (!store) return
    this.sync()
    const edges = store.edges()
    for (const { report, wake } of store.undeliveredReports()) {
      const edge = edges.of(report.child)
      if (edge && report.status !== "progress") this.noticeOf(edge, report, wake)
    }
    for (const edge of edges.all) {
      const last = store.reportsOf(edge.child, 0).at(-1)
      if (edge.closedAt === undefined && !edge.run && last?.status !== "done" && last?.status !== "failed") this.resumePaused(edge)
    }
    void this.drain()
  }

  /** An exit pauses the messages waiting in each conversation for the person's Resume; a Fin's are its Apex's, and nobody would press it. */
  private resumePaused(edge: ThreadParent): void {
    const conversation = this.conversationOf(edge.child)
    const snapshot = conversation && this.deps.live.snapshot(conversation)
    if (!snapshot) return
    const binding = snapshot.control?.bindings.find((candidate) => candidate.id === snapshot.control?.activeBindingId)
    for (const request of snapshot.requests) {
      if (request.status !== "held" || request.signIn || request.wake || request.actor?.kind !== "agent") continue
      try {
        if (binding?.nativeId) this.deps.live.editQueued(conversation, { requestId: request.id, expectedText: request.text, change: { kind: "resume" } })
        else {
          // Its harness never started: the exit cut its launch. It starts now, the brief its first message.
          this.deps.live.editQueued(conversation, { requestId: request.id, expectedText: request.text, change: { kind: "remove" } })
          this.deps.live.transfer(conversation, { id: namedUuid(`relaunch:${request.id}`), provider: snapshot.session.harness, text: request.text, attachments: request.attachments, ...(request.tuning && { tuning: request.tuning }), ...(binding?.modeId && { modeId: binding.modeId }) }, request.actor)
        }
        hostLog("agents", "resumed", { op: edge.op, request: request.id, relaunched: !binding?.nativeId })
      } catch (error) {
        hostWarn("agents", "a Fin's paused message waits for Resume", { op: edge.op, request: request.id, error: errorMessage({ error }) })
      }
    }
  }

  // ── ConversationChildren ──

  roster(conversation: string): readonly NativeAgent[] {
    const store = this.store()
    if (!store) return NONE
    this.sync()
    const thread = store.journalPlacement(conversation)?.thread
    if (!thread) return NONE
    const held = this.rosters.get(thread)
    if (held) return held
    const children = store.edges().children(thread)
    const queued = this.queuedOf(thread)
    if (!children.length && !queued.length) return NONE
    const agents = [...children.map((edge) => this.entryOf(edge)), ...queued]
    this.rosters.set(thread, agents)
    return agents
  }

  isApex(conversation: string): boolean {
    if (this.roster(conversation).length) return true
    const thread = this.store()?.journalPlacement(conversation)?.thread
    return thread !== undefined && this.store()?.edges().of(thread)?.role === APEX_ROLE
  }

  frontDoor(conversation: string, request: Pick<LiveRequest, "actor">): string[] {
    if (request.actor && request.actor.kind !== "person") return []
    const store = this.store()
    const thread = store?.journalPlacement(conversation)?.thread
    if (!store || !thread) return []
    const open = store.edges().children(thread).filter((edge) => !edge.closedAt)
    if (!open.length) return []
    this.sync()
    const lines = frontDoorNote(open.map((edge) => this.frontDoorChild(edge)), this.now())
    hostLog("agents", "front door", { conversation, children: open.length, chars: lines.reduce((sum, line) => sum + line.length + 1, 0) })
    return lines
  }

  /**
   * The person moved a message their Apex passed on to the wrong Fin: it
   * leaves that Fin if it hasn't started there, and goes to `to` as the
   * person's own. The Apex learns of it from its next front-door note, which
   * names the person's direct words to each Fin.
   */
  async redirect(conversation: string, input: AgentsRedirectInput): Promise<AgentsRedirected | AgentRefused> {
    const store = this.store()
    const placed = store?.journalPlacement(conversation)
    if (!store || !placed) return { refused: "unavailable", why: "That conversation isn't a Thread here." }
    const apex: Apex = { session: placed.session, thread: placed.thread, conversation }
    const from = this.resolve(apex, input.from, false)
    const to = this.resolve(apex, input.to, false)
    if (!from) return unknownFin(input.from)
    if (!to) return unknownFin(input.to)
    const was = this.conversationOf(from.child)
    const queued = was ? this.deps.live.held(was)?.requests.find((request) => request.id === input.request) : undefined
    const passed = queued ?? this.steered.get(input.request)
    if (!was || !passed) return { refused: "unknown-child", why: `${from.name} has no such message.` }
    const words = agentWords(passed.text)
    const text = words?.passedOn ? words.body : passed.text
    if (queued && (queued.status === "queued" || queued.status === "held"))
      this.deps.live.editQueued(was, { requestId: queued.id, expectedText: queued.text, change: { kind: "remove" } })
    const withdrawn = queued !== undefined && ["queued", "held", "canceled"].includes(queued.status)
    const sent = await this.deliver(to, namedUuid(`redirect:${input.request}:${to.child}`), text, passed.attachments, undefined)
    if ("refused" in sent) return sent
    if (!sent.deduped) this.routes.redirected += 1
    hostLog("agents", "redirect", { from: from.op, to: to.op, request: input.request, withdrawn, delivery: sent.delivery })
    return { to: to.name, withdrawn, delivery: sent.delivery }
  }

  /**
   * The person wrote to one of this Apex's Fins from the Apex's own
   * conversation: the message goes to the Fin as the person's own, as
   * `agents_send` delivers one, and the Apex's conversation keeps it as an
   * event its harness never sees, so the Apex takes no turn. It learns of it
   * from its next front-door note. A repeat of the request answers the first;
   * a refusal is asked again.
   */
  direct(conversation: string, input: AgentsDirectInput): Promise<AgentsDirected | AgentRefused> {
    const going = this.directed.get(input.request)
    if (going) return going
    const answer = this.directOnce(conversation, input)
    this.directed.set(input.request, answer)
    void answer.then((settled) => {
      if ("refused" in settled) this.directed.delete(input.request)
    })
    return answer
  }

  private async directOnce(conversation: string, input: AgentsDirectInput): Promise<AgentsDirected | AgentRefused> {
    const began = performance.now()
    const store = this.store()
    const placed = store?.journalPlacement(conversation)
    if (!store || !placed) return { refused: "unavailable", why: "That conversation isn't a Thread here." }
    const edge = this.resolve({ session: placed.session, thread: placed.thread, conversation }, input.to, false)
    if (!edge) return unknownFin(input.to)
    if (!input.text.trim() && !input.attachments?.length) return { refused: "conflict", why: "A message needs words or an attachment." }
    if (edge.closedAt) return { refused: "conflict", why: `${edge.name} was stopped. Open it to talk to it there.` }
    const received = namedUuid(`direct:${input.request}`)
    const attachments = input.attachments ?? []
    const sent = await this.deliver(edge, received, input.text, attachments, undefined)
    if ("refused" in sent) return sent
    if (sent.delivery === "steer") this.steered.set(received, { text: input.text, attachments })
    const kept = this.deps.live.recordDirect(conversation, { to: edge.name, fin: edge.child, request: input.request, received, delivery: sent.delivery, at: Date.now() }, input.text)
    if (!sent.deduped) this.routes.direct += 1
    hostLog("agents", "direct", { to: edge.op, request: input.request, delivery: sent.delivery, kept, ms: Math.round(performance.now() - began), ...(sent.deduped && { deduped: true }) })
    return { to: edge.name, fin: edge.child, delivery: sent.delivery }
  }

  async stopChild(conversation: string, child: string): Promise<boolean> {
    const store = this.store()
    const thread = store?.journalPlacement(conversation)?.thread
    const edge = store?.edges().of(child)
    if (!edge || edge.parent !== thread) return false
    return this.end(edge, "the person stopped it")
  }

  settled(conversation: string, request: string): void {
    // A turn that ended mid-wait left no one to answer: the Fin's result wakes it instead.
    for (const hold of this.holds) if (hold.apex === conversation) hold.end()
    this.wakes.settled(conversation)
    const child = this.childOfConversation(conversation)
    const edge = child ? this.store()?.edges().of(child) : undefined
    if (edge && !edge.closedAt) this.turnEnded(edge, conversation, request)
    void this.drain()
  }

  /** A conversation's snapshot moved: a Fin's entry follows it, and a decision it now waits on goes to its Apex. */
  moved(conversation: string): void {
    const child = this.childOf.get(conversation)
    const edge = child ? this.store()?.edges().of(child) : undefined
    if (edge) this.childMoved(edge, true)
  }

  // ── AgentOperations ──

  start(caller: AgentCaller, input: AgentsStartInput): Promise<AgentsStartResult> {
    return input.mode === "wait" ? this.startWaiting(caller, input) : this.admit(caller, input)
  }

  private async startWaiting(caller: AgentCaller, input: AgentsStartInput): Promise<AgentsStartResult> {
    const began = this.now()
    const answer = await this.admit(caller, input)
    if ("refused" in answer) return answer
    const window = Math.max(0, Math.min(input.timeoutMs ?? WAIT_LIMIT_MS, WAIT_LIMIT_MS) - (this.now() - began))
    const waited = answer.child ? await this.hold(answer.child, window) : { outcome: "pending" as const }
    hostLog("agents", "start waited", { child: answer.child ?? answer.name, outcome: waited.outcome, ms: this.now() - began, ...(answer.deduped && { deduped: true }) })
    return { ...answer, waited, next: afterStart(input.wake ?? "decisions", waited) }
  }

  private async admit(caller: AgentCaller, input: AgentsStartInput): Promise<AgentsStartResult> {
    const apex = this.apexOf(caller)
    if ("refused" in apex) return apex
    const store = this.store()!
    const place = input.place === undefined ? "here" : PlaceSchema.safeParse(input.place).data
    if (place !== "here") return this.refuse(input.clientKey, "place-unavailable", place
      ? "This build starts Fins on this Mac only; another device or the cloud comes later. Leave place out to start it here."
      : "place is here, device:<name> or cloud.")
    const op = `start:${apex.session}:${input.clientKey}`
    const kept = store.edges().byOp(op)
    if (kept) return this.started(kept, apex, true)
    if (store.queuedSpawns().some((spawn) => spawn.op === op)) return this.queuedAnswer(op, apex, true)
    const harness = input.harness ?? (apex.conversation ? this.deps.live.session(apex.conversation)?.harness : undefined)
    if (!harness || !this.deps.harnesses().includes(harness))
      return this.refuse(op, "unknown-harness", `No harness named ${harness ?? "(none)"} runs here: ${this.deps.harnesses().join(", ")}.`)
    const own = this.tierOf(apex)
    const allowed = childAccess(own, input.access)
    if (!allowed) return this.refuse(op, "access", `A ${FIN_WORD} runs at most at its ${APEX_WORD}'s access: this Thread is on ${own}, so ${input.access} is refused.`)
    const mode = childMode(this.deps.modes(harness), allowed)
    if (!mode) {
      const offers = (this.deps.modes(harness) ?? []).flatMap((offered) => offered.access ? [offered.access] : []).join(", ")
      return this.refuse(op, "access", `${this.deps.harnessLabel(harness)} runs on ${offers}, each above ${allowed}, the most this ${FIN_WORD} may have. Start it on another harness.`)
    }
    const tier = mode.tier
    const tree = this.rootOf(apex.thread)
    const counts = this.treeCounts(tree)
    // A queued spawn is one the tree has started: once the budget would refuse it, it never waits.
    const queued = store.queuedSpawns().filter((spawn) => spawn.tree === tree).length
    if (counts.started + queued >= this.budget.started)
      return this.refuse(op, "budget", `This tree started ${counts.started} of its ${this.budget.started} Threads${queued ? ` and ${queued} more wait to` : ""}. Stop or finish some before starting more.`)
    if (counts.running >= this.budget.running) {
      const queued: QueuedStart = { lead: apex, input, tier, harness }
      store.queueSpawn({ op, tree, record: JSON.stringify(queued), at: this.now() })
      hostLog("agents", "start queued", { op, why: "tree-running", running: counts.running, budget: this.budget.running })
      this.forget(apex.thread)
      return this.queuedAnswer(op, apex, false)
    }
    return this.launch(op, { lead: apex, input, tier, harness })
  }

  async link(caller: AgentCaller, input: AgentsLinkInput): Promise<AgentsLinkResult> {
    const apex = this.apexOf(caller)
    if ("refused" in apex) return apex
    const process = input.pid === undefined ? undefined : await this.runs.processOf(input.pid)
    if (input.pid !== undefined && !process)
      return { refused: "unknown-child", why: `No process ${input.pid} runs on this device; leave pid out for a run that has ended.` }
    const path = this.deps.catalog.nativePath({ harness: input.harness, nativeId: input.session })
    const ref = path ? this.deps.catalog.ref(path) : undefined
    if (!ref) return { refused: "unknown-child", why: `No ${input.harness} session with that ID is on this device.` }
    if (this.conversationOwns(ref)) return { refused: "conflict", why: `That session is a conversation of its own; it can't be a ${FIN_WORD}.` }
    const before = this.store()!.edges().byRun(input.harness, input.session)
    const adopted = await this.runs.adopt({
      parentSession: apex.session,
      ref,
      origin: "linked",
      ...(process && { process }),
      ...(input.name && { name: input.name }),
      ...(input.role && { role: input.role }),
      startedBy: { kind: "agent", session: SessionIdSchema.parse(apex.session) },
    })
    if ("refused" in adopted) {
      hostLog("agents", "link refused", { refused: adopted.refused, harness: input.harness })
      return adopted
    }
    this.forget(apex.thread)
    return { child: adopted.child, name: adopted.name, origin: adopted.origin, ...(before && { deduped: true as const }) }
  }

  async list(caller: AgentCaller, input: AgentsListInput): Promise<AgentsListResult> {
    const apex = this.apexOf(caller)
    if ("refused" in apex) return apex
    const store = this.store()!
    const strips: AgentStrip[] = []
    const visit = (parent: string, under?: string) => {
      for (const edge of store.edges().children(parent)) {
        strips.push(this.strip(edge, under))
        if (input.scope === "tree") visit(edge.child, edge.name)
      }
    }
    visit(apex.thread)
    const counts = this.treeCounts(this.rootOf(apex.thread))
    return { children: strips, tree: { ...counts, of: { ...this.budget } } }
  }

  async read(caller: AgentCaller, input: AgentsReadInput): Promise<AgentsReadResult> {
    const apex = this.apexOf(caller)
    if ("refused" in apex) return apex
    const edge = this.resolve(apex, input.child, true)
    if (!edge) return unknownFin(input.child)
    const limit = Math.max(200, Math.min(input.maxChars ?? READ_CHARS, 64_000))
    const state = this.stateOf(edge)
    const text = input.view === "transcript" ? await this.transcript(edge) : this.reportText(edge, state)
    const truncated = text.length > limit
    return { child: edge.child, name: edge.name, state, text: truncated ? text.slice(text.length - limit) : text, ...(truncated && { truncated: true as const }) }
  }

  async report(caller: AgentCaller, input: AgentsReportInput): Promise<AgentsReportResult> {
    const apex = this.apexOf(caller)
    if ("refused" in apex) return apex
    const edge = this.store()!.edges().of(apex.thread)
    if (!edge) return { refused: "no-parent", why: `This Thread has no ${APEX_WORD}: agents_report is for a ${FIN_WORD}, a Thread another one started.` }
    const report: Report = {
      id: `report:${edge.child}:${input.clientKey}`,
      child: ThreadIdSchema.parse(edge.child),
      status: input.status,
      summary: input.summary,
      ...(input.artifacts?.length && { artifacts: input.artifacts }),
      ...(input.question && { question: input.question }),
      ownerGeneration: this.generation,
      at: this.now(),
    }
    const kept = this.keepReport(edge, report)
    if ("refused" in kept) return kept
    return { id: kept.report.id, ...(kept.deduped && { deduped: true as const }), delivered: kept.report.status === "progress" ? "none" : "notice" }
  }

  async send(caller: AgentCaller, input: AgentsSendInput): Promise<AgentsSendResult> {
    const began = performance.now()
    const apex = this.apexOf(caller)
    if ("refused" in apex) return apex
    const edge = this.resolve(apex, input.to, false)
    if (!edge) return unknownFin(input.to)
    const op = `send:${apex.session}:${input.clientKey}`
    const request = namedUuid(op)
    const kept = this.sent.get(op)
    if (kept) return { ...kept, deduped: true }
    const own = input.text?.trim()
    let text: string
    let attachments: PromptAttachment[] = []
    if (input.forward) {
      const asked = this.personsMessage(apex)
      if (!asked) return this.refuse(op, "unavailable", "No message from the person is in this Thread to pass on: send your own words as text instead.")
      text = `${passedOn(YOUR_APEX)}\n${asked.text}${own ? `\n\n${PASSED_ON_NOTE}\n${own}` : ""}`
      attachments = asked.attachments
    } else {
      if (!own) return this.refuse(op, "conflict", "A message needs text, or forward: true to pass on the person's.")
      text = `${fromAgent(YOUR_APEX)}\n${own}`
    }
    const sent = await this.deliver(edge, request, text, attachments, { kind: "agent", session: SessionIdSchema.parse(apex.session) })
    if ("refused" in sent) return this.refuse(op, sent.refused, sent.why)
    const answer: AgentsSent = { child: edge.child, name: edge.name, request, delivery: sent.delivery, ...(sent.deduped && { deduped: true as const }) }
    this.sent.set(op, answer)
    if (sent.delivery === "steer") this.steered.set(request, { text, attachments })
    if (input.forward) this.routes.forwarded += 1
    else this.routes.sent += 1
    hostLog("agents", "send", { op, child: edge.child, request, delivery: sent.delivery, forward: input.forward ?? false, ms: Math.round(performance.now() - began) })
    return answer
  }

  async stop(caller: AgentCaller, input: AgentsStopInput): Promise<AgentsStopResult> {
    const apex = this.apexOf(caller)
    if ("refused" in apex) return apex
    const store = this.store()!
    const why = input.reason ?? `its ${APEX_WORD} stopped it`
    const one = input.child === "all" ? undefined : this.resolve(apex, input.child, false)
    if (input.child !== "all" && !one) return unknownFin(input.child)
    const targets = one ? [one] : store.edges().children(apex.thread)
    const stopped: string[] = []
    // What waits goes first, so an end below doesn't start it.
    if (input.child === "all")
      for (const spawn of store.queuedSpawns()) {
        const queued = parseQueued(spawn.record)
        if (queued?.lead.thread !== apex.thread) continue
        store.unqueueSpawn(spawn.op)
        stopped.push(queued.input.name ?? queued.input.title ?? spawn.op)
        hostLog("agents", "end", { op: spawn.op, outcome: "stopped", queued: true })
      }
    for (const edge of targets) if (await this.end(edge, why)) stopped.push(edge.name)
    this.forget(apex.thread)
    return { stopped }
  }

  async wait(caller: AgentCaller, input: AgentsWaitInput): Promise<AgentsWaitResult> {
    const apex = this.apexOf(caller)
    if ("refused" in apex) return apex
    const store = this.store()!
    const named = (input.children ?? []).map((child) => ({ child, edge: this.resolve(apex, child, true) }))
    const missing = named.find(({ edge }) => !edge)
    if (missing) return unknownFin(missing.child)
    const edges = named.length ? named.flatMap(({ edge }) => edge ?? []) : store.edges().children(apex.thread)
    const after = input.after ?? 0
    const collect = () => edges.flatMap((edge) => store.reportsOf(edge.child, after).map((report) => ({ edge, report })))
      .sort((a, b) => a.report.at - b.report.at)
    let found = collect()
    let timedOut = false
    if (!found.length) {
      timedOut = await new Promise<boolean>((resolve) => {
        const wake = () => {
          found = collect()
          if (!found.length) return
          done(false)
        }
        const timer = setTimeout(() => done(true), Math.max(0, Math.min(input.timeoutMs ?? WAIT_LIMIT_MS, WAIT_LIMIT_MS)))
        const done = (out: boolean) => {
          clearTimeout(timer)
          this.waiters.delete(wake)
          resolve(out)
        }
        this.waiters.add(wake)
      })
    }
    return {
      reports: found.map(({ edge, report }) => ({ child: edge.child, name: edge.name, status: report.status, line: reportPhase(report) ?? report.status, at: report.at })),
      cursor: found.at(-1)?.report.at ?? after,
      timedOut,
    }
  }

  /** The host's Fins and budgets, for Diagnostics. */
  diagnostics(): AgentsDiagnostics {
    const store = this.store()
    if (!store) return { fins: 0, running: 0, followed: 0, queued: 0, notices: 0, budget: this.budget, trees: [], routes: { ...this.routes } }
    const edges = store.edges()
    const roots = new Set(edges.all.map((edge) => this.rootOf(edge.parent)))
    const trees = [...roots].map((apex) => ({ apex, ...this.treeCounts(apex) }))
    return {
      fins: edges.all.length,
      running: trees.reduce((sum, tree) => sum + tree.running, 0),
      followed: this.runs.following(),
      queued: store.queuedSpawns().length,
      notices: this.wakes.pending(),
      budget: this.budget,
      trees,
      routes: { ...this.routes },
    }
  }

  dispose(): void {
    this.stopped = true
    this.runs.dispose()
    this.wakes.dispose()
    for (const wake of this.waiters) wake()
    for (const hold of this.holds) hold.end()
  }

  // ── Starting ──

  private async launch(op: string, queued: QueuedStart): Promise<AgentsStartResult> {
    const store = this.store()!
    const { lead: apex, input, tier, harness } = queued
    const began = performance.now()
    const name = uniqueName(input.name ?? input.title ?? input.brief.objective, new Set(store.edges().children(apex.thread).map((edge) => edge.name)))
    const cwd = input.cwd ?? (apex.conversation ? this.deps.live.session(apex.conversation)?.cwd : undefined)
    if (!cwd) return this.refuse(op, "unavailable", "There's no folder to start it in: name one, or start it from a Thread that has one.")
    const conversationId = namedUuid(op)
    const parent: ChildStart = {
      parent: ThreadIdSchema.parse(apex.thread),
      parentSession: SessionIdSchema.parse(apex.session),
      name,
      role: input.role ?? "worker",
      origin: "started",
      asked: {
        brief: input.brief,
        harness,
        ...(input.model && { model: input.model }),
        ...(input.reasoning && { reasoning: input.reasoning }),
        access: tier,
        ...(input.place && { place: input.place }),
        ...(input.workspace && { workspace: input.workspace }),
        ...(input.mode && { mode: input.mode }),
        ...(input.wake && { wake: input.wake }),
      },
      op,
      startedBy: { kind: "agent", session: SessionIdSchema.parse(apex.session) },
    }
    const workspace = input.workspace
    const options: LiveStartOptions = {
      conversationId,
      initialRequest: { id: namedUuid(`${op}\nbrief`), text: briefText(input.brief, name), attachments: [] },
      title: input.title ?? name,
      modeId: childMode(this.deps.modes(harness), tier)?.id ?? accessModeId(tier),
      ...((input.model || input.reasoning) && { tuning: { ...(input.model && { model: input.model }), ...(input.reasoning && { options: { effort: input.reasoning } }) } }),
      ...(workspace && {
        worktree: true,
        ...(workspace.branch ? { worktreeStart: { kind: "branch" as const, branch: workspace.branch } } : workspace.base ? { worktreeStart: { kind: "from" as const, ref: workspace.base } } : {}),
      }),
      parent,
    }
    this.starting.add(op)
    this.forget(apex.thread)
    try {
      await this.deps.startLive(harness, cwd, options)
    } catch (error) {
      if (!store.edges().byOp(op)) {
        this.starting.delete(op)
        this.forget(apex.thread)
        return this.refuse(op, "unavailable", `It didn't start: ${errorMessage({ error })}`)
      }
      hostWarn("agents", "a Fin's start failed after its edge was written; it shows as failed", { op, error: errorMessage({ error }) })
    } finally {
      this.starting.delete(op)
    }
    const edge = store.edges().byOp(op)
    if (!edge) return this.refuse(op, "unavailable", `Its Thread was made without its edge; it was not started as a ${FIN_WORD}.`)
    this.conversations.set(edge.child, conversationId)
    this.childOf.set(conversationId, edge.child)
    hostLog("agents", "start admitted", { op, child: edge.child, harness, access: tier, ms: Math.round(performance.now() - began) })
    this.childMoved(edge, false)
    return this.started(edge, apex, false)
  }

  /** Starts what the running budget held, oldest first, while each tree has room. */
  private async drain(): Promise<void> {
    const store = this.store()
    if (!store || this.draining || this.stopped) return
    this.draining = true
    try {
      for (const spawn of store.queuedSpawns()) {
        const counts = this.treeCounts(spawn.tree)
        if (counts.running >= this.budget.running) continue
        store.unqueueSpawn(spawn.op)
        const queued = parseQueued(spawn.record)
        if (!queued) continue
        hostLog("agents", "start released", { op: spawn.op, waitedMs: this.now() - spawn.at })
        await this.launch(spawn.op, queued)
      }
    } catch (error) {
      hostWarn("agents", "queued starts could not be released; they wait for the next end", { error: errorMessage({ error }) })
    } finally {
      this.draining = false
    }
  }

  private started(edge: ThreadParent, apex: Apex, deduped: boolean): AgentsStarted {
    const state = this.stateOf(edge)
    const counts = this.treeCounts(this.rootOf(apex.thread))
    const conversation = this.conversationOf(edge.child)
    return {
      child: edge.child,
      name: edge.name,
      ...(conversation && { conversation }),
      state: state.kind,
      tree: { ...counts, of: { ...this.budget } },
      ...(deduped && { deduped: true as const }),
      next: afterStart(edge.asked.wake ?? "decisions"),
    }
  }

  private queuedAnswer(op: string, apex: Apex, deduped: boolean): AgentsStarted {
    const store = this.store()!
    const tree = this.rootOf(apex.thread)
    const queue = store.queuedSpawns().filter((spawn) => spawn.tree === tree)
    const queued = parseQueued(queue.find((spawn) => spawn.op === op)?.record ?? "")
    const ahead = queue.findIndex((spawn) => spawn.op === op)
    const counts = this.treeCounts(tree)
    return {
      name: queued?.input.name ?? queued?.input.title ?? "queued",
      state: "queued",
      why: `This tree runs ${counts.running} of its ${this.budget.running} at once; it starts when one ends (${Math.max(0, ahead)} ahead).`,
      tree: { ...counts, of: { ...this.budget } },
      ...(deduped && { deduped: true as const }),
      next: afterStart(queued?.input.wake ?? "decisions"),
    }
  }

  // ── A wait ──

  /**
   * Holds a `wait` start's answer for at most `window` ms: until its Fin's
   * result, a question it asks, or the window's or the Apex's turn's end.
   * While it holds, the Fin's reports answer it instead of waking the Apex,
   * and once it lets go they wake the Apex (`reportRoute`), the result
   * settled-only. A repeat of the start answers the result again.
   */
  private hold(child: string, window: number): Promise<StartWaited> {
    const now = this.outcomeOf(child)
    if (now || window <= 0) return Promise.resolve(this.answered(child, now ?? { outcome: "pending" }))
    const edge = this.store()!.edges().of(child)
    const apex = edge && (this.conversationOfSession(edge.parentSession) ?? this.conversationOf(edge.parent))
    return new Promise((resolve) => {
      const done = (outcome: StartWaited) => {
        clearTimeout(timer)
        this.holds.delete(hold)
        resolve(this.answered(child, outcome))
      }
      const hold: Hold = {
        child,
        ...(apex && { apex }),
        check: () => {
          const outcome = this.outcomeOf(child)
          if (outcome) done(outcome)
        },
        end: () => done({ outcome: "pending" }),
      }
      const timer = setTimeout(() => hold.end(), window)
      this.holds.add(hold)
    })
  }

  /** Where a waited-for Fin stands: its result, a question it waits on, or nothing yet. */
  private outcomeOf(child: string): StartWaited | undefined {
    const store = this.store()
    const edge = store?.edges().of(child)
    if (!store || !edge) return { outcome: "result", report: { status: "failed", summary: "Its Thread is gone from this device." } }
    const last = store.reportsOf(child, 0).filter((report) => report.status !== "progress").at(-1)
    if (last && (last.status === "done" || last.status === "failed")) return { outcome: "result", report: waitedReport(last) }
    const state = this.stateOf(edge)
    if (state.kind === "blocked") {
      const asking = last && (last.status === "blocked" || last.status === "needs-input") ? waitedReport(last) : undefined
      return { outcome: "question", question: state.question, answers: state.on === "lead" ? "you" : "the person", ...(asking && { report: asking }) }
    }
    // A turn's end writes its report just after it shows as ended; only a closed delegation ends without one.
    if (state.kind === "ended" && edge.closedAt) return { outcome: "result", report: { status: "failed", summary: `It was stopped${state.reason ? `: ${state.reason}` : "."}` } }
    return undefined
  }

  /** A wait's answer carried the report: the Apex heard it, so a wake waiting with it is taken back. */
  private answered(child: string, outcome: StartWaited): StartWaited {
    const store = this.store()
    const edge = store?.edges().of(child)
    if (!store || !edge || outcome.outcome === "pending") return outcome
    const report = store.reportsOf(child, 0).filter((candidate) => candidate.status !== "progress").at(-1)
    if (!report || (outcome.outcome === "question" && !outcome.report)) return outcome
    const conversation = this.frontOf(edge.parent, edge.parentSession)
    if (conversation) this.wakes.withdraw(conversation, `notice:${child}:${report.id}`)
    store.markReportsDelivered([report.id], this.now())
    return outcome
  }

  private refuse(op: string, refused: AgentRefused["refused"], why: string): AgentRefused {
    hostLog("agents", "start refused", { op, refused, why })
    return { refused, why }
  }

  // ── Ends and reports ──

  /** A Fin's turn ended: its end, once, as its last report, unless it reported since the turn began. */
  private turnEnded(edge: ThreadParent, conversation: string, request: string): void {
    const reply = this.deps.live.turnReply(conversation, request)
    const ended = reply?.request
    if (!ended || (ended.status !== "completed" && ended.status !== "failed" && ended.status !== "interrupted")) return
    // A turn Mako's exit cut short continues on the next host (`LeftTurn.always`); it hasn't ended.
    if (ended.status === "interrupted" && ended.interruption?.reason !== "stopped") return
    const store = this.store()!
    if (store.reportsOf(edge.child, (ended.createdAt ?? 0) - 1).some((report) => !report.implicit)) return this.childMoved(edge, false)
    const done = ended.status === "completed"
    const text = reply.text.trim()
    this.keepReport(edge, {
      id: `report:${edge.child}:${request}`,
      child: ThreadIdSchema.parse(edge.child),
      status: done ? "done" : "failed",
      summary: (text || (done ? "It ended its turn without a reply." : ended.error ?? "Its turn ended before it finished.")).slice(0, 16_000),
      implicit: true,
      ownerGeneration: this.generation,
      at: this.now(),
    })
  }

  /** A followed run ended: its end is its last report, unless it reported while it ran; held notices go to its next turn. */
  private runEnded(edge: ThreadParent, ended: RunEnd): void {
    hostLog("agents", "end", { op: edge.op, child: edge.child, outcome: ended.kind })
    const run = edge.run!
    const store = this.store()
    if (store && ended.kind !== "stopped" && !store.reportsOf(edge.child, run.startedAt - 1).some((report) => !report.implicit))
      this.keepReport(edge, {
        id: `report:${edge.child}:run:${run.startedAt}`,
        child: ThreadIdSchema.parse(edge.child),
        status: ended.kind === "done" ? "done" : "failed",
        summary: ended.detail ?? (ended.kind === "done" ? "It finished." : "It ended without saying how it went."),
        implicit: true,
        ownerGeneration: this.generation,
        at: ended.at,
      })
    void this.release(edge)
    void this.drain()
  }

  private keepReport(edge: ThreadParent, report: Report): { report: Report; deduped: boolean } | AgentRefused {
    const store = this.store()!
    let kept: ReturnType<ThreadStore["keepReport"]>
    try {
      kept = store.keepReport(report)
    } catch (error) {
      return { refused: "conflict", why: `That report's key was used for another report: ${errorMessage({ error })}` }
    }
    if ("stale" in kept) {
      hostLog("agents", "report refused", { op: edge.op, report: report.id, refused: "stale-owner" })
      return { refused: "stale-owner", why: "A newer owner of this Thread already reported; this one's report is refused." }
    }
    if (kept.deduped) return kept
    hostLog("agents", "report", { op: edge.op, report: report.id, status: report.status, implicit: report.implicit ?? false })
    this.latest.set(edge.child, kept.report)
    if (report.status === "progress") store.markReportsDelivered([report.id], this.now())
    else this.noticeOf(edge, kept.report)
    this.childMoved(edge, false)
    for (const wake of this.waiters) wake()
    this.checkHolds(edge.child)
    return kept
  }

  /** `notice:{child}:{reportId}` to the Apex's owner: this host, which has the Apex's conversation; a report its spawn asked not to hear goes nowhere but its strip. */
  private noticeOf(edge: ThreadParent, report: Report, wake?: string): void {
    const store = this.store()!
    const route = reportRoute(edge.asked, report.status)
    if (route !== "apex") {
      store.markReportsDelivered([report.id], this.now())
      hostLog("agents", "report kept", { op: edge.op, report: report.id, status: report.status, to: route, wake: edge.asked.wake ?? "decisions" })
      return
    }
    const notice: Notice = {
      id: `notice:${edge.child}:${report.id}`,
      report,
      label: `"${edge.name}" (${this.deps.harnessLabel(this.harnessOf(edge))})`,
      from: store.thread(edge.child)?.sessions[0] ?? edge.parentSession,
      ...(wake && { wake }),
      ...(edge.asked.mode === "wait" && (report.status === "done" || report.status === "failed") && { settledOnly: true as const }),
    }
    const conversation = this.frontOf(edge.parent, edge.parentSession)
    if (conversation) return this.wakes.notice(conversation, this.rootOf(edge.parent), notice)
    if (this.runs.running(edge.parent)) {
      const held = this.held.get(edge.parent) ?? []
      if (!held.some((waiting) => waiting.id === notice.id)) held.push(notice)
      this.held.set(edge.parent, held)
      hostLog("agents", "message held", { notice: notice.id, until: "its process exits" })
    }
  }

  /** A Fin that is an Apex of its own ended its process: what was held for it starts its next turn, on Mako's live driver. */
  private async release(edge: ThreadParent): Promise<void> {
    const notices = this.held.get(edge.child)
    const run = edge.run
    if (!notices?.length || !run?.nativeId) return
    this.held.delete(edge.child)
    const path = this.deps.catalog.nativePath({ harness: run.harness, nativeId: run.nativeId })
    const ref = path ? this.deps.catalog.ref(path) : undefined
    if (!path || !ref?.cwd) return
    const conversationId = namedUuid(`resume:${edge.child}:${run.nativeId}`)
    const request = namedUuid(`${conversationId}\n${notices.map((notice) => notice.report.id).join("\n")}`)
    try {
      await this.deps.startLive(run.harness, ref.cwd, {
        conversationId,
        resume: run.nativeId,
        threadPath: path,
        initialRequest: { id: request, text: digest(notices, this.childCounts(edge.child)), attachments: [] },
      })
      this.store()?.markReportsDelivered(notices.map((notice) => notice.report.id), this.now())
      hostLog("agents", "held message released", { child: edge.child, notices: notices.length, conversation: conversationId })
    } catch (error) {
      hostWarn("agents", "a held message could not start its turn; it waits for the next start", { child: edge.child, error: errorMessage({ error }) })
    }
  }

  /** Stops a Fin, once: its running turn, or its process group; the delegation closes either way. */
  private async end(edge: ThreadParent, why: string): Promise<boolean> {
    if (edge.closedAt) return false
    const store = this.store()!
    this.runs.stop(edge.child)
    const conversation = this.conversationOf(edge.child)
    const status = conversation ? this.deps.live.session(conversation)?.status : undefined
    if (conversation && (status === "running" || status === "starting"))
      await this.deps.live.cancel(conversation).catch((error) => hostWarn("agents", "a Fin's turn could not be stopped", { op: edge.op, error: errorMessage({ error }) }))
    const closed = store.keepEdge({ ...edge, closedAt: this.now() })
    hostLog("agents", "end", { op: edge.op, child: edge.child, outcome: "stopped", why })
    this.childMoved(closed, false)
    void this.drain()
    return true
  }

  // ── What a Fin shows ──

  /** What the Fin's Thread shows now, from whatever runs its current turn: one source at a time. */
  private childReading(edge: ThreadParent): ChildThread {
    const run = edge.run
    const conversation = this.conversationOf(edge.child)
    if (run && (!run.ended || !conversation)) return this.runs.reading(edge.child) ?? { source: "followed", harness: run.harness }
    if (!conversation) return { source: "live", ...(this.starting.has(edge.op) && { starting: "launching" as const }) }
    const live = this.deps.live
    const session = live.session(conversation)
    if (!session) return { source: "live" }
    const held = live.held(conversation)
    const waiting = live.waitingOn(conversation)
    // A request sent and not yet answered is work, before its harness says it runs.
    const working = session.status === "running" || Boolean(held?.requests.some((request) => request.status === "queued" || request.status === "dispatching"))
    const last = held?.requests.filter((request) => request.status !== "queued" && request.status !== "held").at(-1)
    return {
      source: "live",
      conversation,
      session: this.store()?.thread(edge.child)?.sessions[0],
      ...(session.nativeId && { nativeId: session.nativeId }),
      ...(session.nativePath && { path: session.nativePath }),
      ...(session.title && { title: session.title }),
      harness: session.harness,
      ...(session.settings?.model && { model: session.settings.model }),
      ...((session.status === "starting" || this.starting.has(edge.op)) && { starting: "launching" as const }),
      ...(working && { working }),
      ...(working && held && { step: lastStep(held.blocks.slice(-24), session.harness) }),
      ...(waiting && { waiting: { question: this.waitingLine(edge, waiting.line), on: this.decides(edge) === "apex" ? "lead" : "person" } }),
      ...(!working && last?.status === "failed" && { ended: { outcome: "failed" as const, ...(last.error && { reason: last.error }), at: last.createdAt ?? edge.createdAt } }),
      ...(!working && last?.status === "interrupted" && last.interruption?.reason === "stopped" && { ended: { outcome: "stopped" as const, at: last.interruption.at } }),
      startedAt: edge.createdAt,
      ...(held?.activityAt && { updatedAt: held.activityAt }),
    }
  }

  /** Who answers a Fin's approval: its Apex on full access, unless its spawn asked to hear only its result; else the person, told why. */
  private decides(edge: ThreadParent): "apex" | "person" {
    if (reportRoute(edge.asked, "blocked") !== "apex") return "person"
    const parent = this.frontOf(edge.parent, edge.parentSession)
    const tier = parent ? this.tierOfConversation(parent) : undefined
    return tier === "full" ? "apex" : "person"
  }

  private waitingLine(edge: ThreadParent, line: string): string {
    if (this.decides(edge) === "apex") return line
    return reportRoute(edge.asked, "blocked") === "apex"
      ? `${line} (yours to answer: its ${APEX_WORD} isn't on full access)`
      : `${line} (yours to answer: its ${APEX_WORD} hears only ${edge.asked.wake === "never" ? "what it reads" : "its result"})`
  }

  private stateOf(edge: ThreadParent): ChildState {
    this.sync()
    return childState(edge, this.childReading(edge), { ...(this.latest.get(edge.child) && { latest: this.latest.get(edge.child)! }) })
  }

  private entryOf(edge: ThreadParent): NativeAgent {
    this.sync()
    const held = this.entries.get(edge.child)
    if (held) return held
    const entry = childEntry(edge, this.childReading(edge), { ...(this.latest.get(edge.child) && { latest: this.latest.get(edge.child)! }) })
    this.entries.set(edge.child, entry)
    return entry
  }

  /** A Fin's entry moved: its Apex's conversations hear it, and a decision it waits on reaches its Apex once. */
  private childMoved(edge: ThreadParent, progressOnly: boolean): void {
    if (this.stopped) return
    this.sync()
    const before = this.entries.get(edge.child)
    this.entries.delete(edge.child)
    const entry = this.entryOf(edge)
    if (before && JSON.stringify(before) === JSON.stringify(entry)) {
      this.entries.set(edge.child, before)
      return
    }
    this.rosters.delete(edge.parent)
    const kindChanged = !before || before.state.kind !== entry.state.kind || before.stoppable !== entry.stoppable
    for (const conversation of this.conversationsOfThread(edge.parent)) this.deps.live.childrenChanged(conversation, progressOnly && !kindChanged)
    this.askApex(edge)
    if (kindChanged) this.checkHolds(edge.child)
    if (before && before.state.kind === "working" && entry.state.kind !== "working") void this.drain()
  }

  private checkHolds(child: string): void {
    for (const hold of this.holds) if (hold.child === child) hold.check()
  }

  /** A Fin waiting on an approval or a question under an Apex on full access: the Apex hears it as `blocked`, keyed by what it waits on. */
  private askApex(edge: ThreadParent): void {
    const conversation = this.conversationOf(edge.child)
    const waiting = conversation ? this.deps.live.waitingOn(conversation) : undefined
    if (!waiting) {
      this.asked.delete(edge.child)
      return
    }
    if (this.asked.get(edge.child) === waiting.line) return
    this.asked.set(edge.child, waiting.line)
    const on = this.decides(edge)
    hostLog("agents", "approval routed", { op: edge.op, child: edge.child, to: on })
    if (on !== "apex") return
    this.keepReport(edge, {
      id: `report:${edge.child}:waiting:${namedUuid(waiting.line)}`,
      child: ThreadIdSchema.parse(edge.child),
      status: "blocked",
      summary: `It waits: ${waiting.line}`,
      question: `${waiting.line}. Answer it in its Thread, or stop it with agents_stop.`,
      implicit: true,
      ownerGeneration: this.generation,
      at: this.now(),
    })
  }

  private strip(edge: ThreadParent, under?: string): AgentStrip {
    const reading = this.childReading(edge)
    const latest = this.latest.get(edge.child)
    return {
      child: edge.child,
      name: edge.name,
      ...(under && { under }),
      harness: reading.harness ?? this.harnessOf(edge),
      ...((reading.model ?? edge.asked.model) && { model: reading.model ?? edge.asked.model }),
      origin: edge.origin,
      state: this.stateOf(edge),
      ...(reading.title && { title: reading.title }),
      ...(reading.toolUses && { toolUses: reading.toolUses }),
      ...(latest && { report: { status: latest.status, line: reportPhase(latest) ?? latest.status, at: latest.at } }),
      startedAt: edge.createdAt,
    }
  }

  private reportText(edge: ThreadParent, state: ChildState): string {
    const latest = this.latest.get(edge.child)
    if (!latest) return `No report yet. It is ${state.kind}${state.kind === "working" && state.step ? `: ${state.step}` : ""}.`
    const lines = [`${latest.status}${latest.implicit ? " (its turn ended without a report; this is its last reply)" : ""}:`, latest.summary]
    if (latest.question) lines.push(`Question: ${latest.question}`)
    for (const artifact of latest.artifacts ?? []) lines.push(`${artifact.kind}: ${artifact.ref}${artifact.label ? ` (${artifact.label})` : ""}`)
    return lines.join("\n")
  }

  private async transcript(edge: ThreadParent): Promise<string> {
    const reading = this.childReading(edge)
    const entries = reading.source === "followed"
      ? await this.runs.tail(edge.child, READ_ENTRIES)
      : reading.path ? (await this.deps.catalog.page(reading.path, undefined, READ_ENTRIES).catch(() => null))?.entries ?? [] : []
    if (!entries.length) return "Its transcript has nothing this device can read yet."
    return entries.map(entryLine).filter(Boolean).join("\n")
  }

  // ── Who and where ──

  private apexOf(caller: AgentCaller): Apex | AgentRefused {
    const store = this.store()
    if (!store) return { refused: "unavailable", why: `${FIN_WORD}s need the Thread store, which didn't open.` }
    if (caller.kind !== "agent")
      return { refused: "no-parent", why: `Only a Thread's agent is an ${APEX_WORD}: call it from a Thread's mako tools, or from its shell, where MAKO_SESSION_ID names it.` }
    const session = SessionIdSchema.safeParse(caller.session)
    const placed = session.success ? store.sessionPlacement(session.data) : undefined
    if (!placed) return { refused: "no-parent", why: "No Thread has that Session." }
    const conversation = this.conversationOfSession(placed.session)
    return { session: placed.session, thread: placed.thread, ...(conversation && { conversation }) }
  }

  /** A Fin by its name, `fin:<name>` (`child:<name>` before the names) or its Thread: the Apex's own, or with `deep` a descendant's. */
  private resolve(apex: Apex, ref: string, deep: boolean): ThreadParent | undefined {
    const store = this.store()!
    const name = finName(ref)
    const look = (parent: string, depth: number): ThreadParent | undefined => {
      const children = store.edges().children(parent)
      const found = children.find((edge) => edge.child === ref || edge.name === name)
      if (found || !deep || depth > 64) return found
      for (const edge of children) {
        const below = look(edge.child, depth + 1)
        if (below) return below
      }
      return undefined
    }
    return look(apex.thread, 0)
  }

  private tierOf(apex: Apex): AccessTier {
    return (apex.conversation ? this.tierOfConversation(apex.conversation) : undefined) ?? "ask"
  }

  private tierOfConversation(conversation: string): AccessTier | undefined {
    const session = this.deps.live.session(conversation)
    const mode = session?.launchMode ?? session?.currentMode ?? ""
    return session?.modes.find((offered) => offered.id === mode)?.access ?? accessTierOfModeId(mode) ?? undefined
  }

  private harnessOf(edge: ThreadParent): string {
    return edge.run?.harness ?? edge.asked.harness ?? "unknown"
  }

  private rootOf(thread: string): string {
    return this.store()?.ancestors(thread).at(-1) ?? thread
  }

  /** How a tree stands against its budgets: Threads at work now, and Threads it started. */
  private treeCounts(root: string): TreeCounts {
    const store = this.store()
    if (!store) return { running: 0, started: 0 }
    let running = 0
    let started = 0
    const visit = (parent: string, depth: number) => {
      if (depth > 10_000) return
      for (const edge of store.edges().children(parent)) {
        started += 1
        const kind = this.stateOf(edge).kind
        if (kind === "working" || kind === "starting") running += 1
        visit(edge.child, depth + 1)
      }
    }
    visit(root, 0)
    return { running, started }
  }

  /** The digest's last line, for the parent `conversation`. */
  private counts(conversation: string): string {
    const thread = this.store()?.journalPlacement(conversation)?.thread
    return thread ? this.childCounts(thread) : ""
  }

  private childCounts(thread: string): string {
    const store = this.store()
    if (!store) return ""
    const tally = new Map<string, number>()
    for (const edge of store.edges().children(thread)) {
      const kind = this.stateOf(edge).kind
      tally.set(kind, (tally.get(kind) ?? 0) + 1)
    }
    const queued = this.queuedOf(thread).length
    const parts = [`${tally.get("working") ?? 0} working`]
    if (tally.get("starting")) parts.push(`${tally.get("starting")} starting`)
    if (queued) parts.push(`${queued} queued`)
    if (tally.get("blocked")) parts.push(`${tally.get("blocked")} blocked`)
    if (tally.get("idle")) parts.push(`${tally.get("idle")} idle`)
    parts.push(`${tally.get("ended") ?? 0} ended`)
    return `${parts.join(", ")}.`
  }

  /** Spawns held for a parent, as roster entries that say why. */
  private queuedOf(thread: string): NativeAgent[] {
    const store = this.store()
    if (!store) return []
    const spawns = store.queuedSpawns()
    return spawns.flatMap((spawn) => {
      const queued = parseQueued(spawn.record)
      if (queued?.lead.thread !== thread) return []
      const ahead = spawns.filter((other) => other.tree === spawn.tree && other.at < spawn.at).length
      const placeholder: ThreadParent = {
        child: ThreadIdSchema.parse(namedUuid(spawn.op)),
        parent: ThreadIdSchema.parse(thread),
        parentSession: SessionIdSchema.parse(queued.lead.session),
        name: queued.input.name ?? queued.input.title ?? "queued",
        role: queued.input.role ?? "worker",
        origin: "started",
        asked: { brief: queued.input.brief, harness: queued.harness },
        op: spawn.op,
        startedBy: { kind: "agent", session: SessionIdSchema.parse(queued.lead.session) },
        createdAt: spawn.at,
      }
      const reason: QueueReason = "tree-running"
      return [childEntry(placeholder, { source: "live", queued: { reason, ahead } }, {})]
    })
  }

  private ready(conversation: string): ParentReady {
    const session = this.deps.live.session(conversation)
    if (!session) return "gone"
    const busy = session.status === "running" || session.status === "starting" ||
      Boolean(this.deps.live.held(conversation)?.requests.some((request) => request.status === "queued" || request.status === "dispatching"))
    if (!busy) return "idle"
    return this.deps.live.steersAtStep(conversation) ? "steer" : "queue"
  }

  private steer(conversation: string, id: string, text: string): Promise<boolean> | false {
    const running = this.deps.live.held(conversation)?.requests.find((request) => request.status === "dispatching")
    if (!running) return false
    return this.deps.live.act(conversation, { kind: "steer", id, requestId: running.id, text, attachments: [] }).then(
      (action) => {
        const took = action.state.kind === "accepted" || action.state.kind === "completed"
        if (!took) hostWarn("agents", "a digest wasn't taken by the running turn", { conversation, state: action.state.kind })
        return took
      },
      (error) => {
        hostWarn("agents", "a digest could not join the running turn", { conversation, error: errorMessage({ error }) })
        return false
      })
  }

  /**
   * A message into a child's Thread, as its next turn, a step of its running
   * one, or queued behind it: the same Thread whether it's at work, idle or
   * done, so a finished child takes a follow-up where its work is.
   */
  private async deliver(edge: ThreadParent, request: string, text: string, attachments: PromptAttachment[], actor: Actor | undefined): Promise<{ delivery: AgentsSent["delivery"]; deduped?: true } | AgentRefused> {
    if (edge.closedAt)
      return { refused: "conflict", why: `${edge.name} was stopped, and a stopped Thread's delegation stays over: start a new one with agents_start, or the person can open it and talk to it there.` }
    if (edge.run && !edge.run.ended)
      return { refused: "unavailable", why: `${edge.name} runs in a process Mako follows but didn't start, which takes no message until it exits: its report reaches you when it does.` }
    const conversation = this.conversationOf(edge.child)
    const ready = conversation ? this.ready(conversation) : "gone"
    if (!conversation || ready === "gone") return { refused: "unavailable", why: `${edge.name}'s conversation isn't on this device.` }
    const held = this.deps.live.held(conversation)?.requests.find((asked) => asked.id === request)
    if (held) return { delivery: held.status === "queued" || held.status === "held" ? "queued" : "turn", deduped: true }
    const running = ready === "steer" ? this.deps.live.held(conversation)?.requests.find((asked) => asked.status === "dispatching") : undefined
    if (running?.nativeRun) {
      try {
        await this.deps.live.act(conversation, { kind: "steer", id: request, requestId: running.id, text, attachments })
        return { delivery: "steer" }
      } catch (error) {
        hostWarn("agents", "a message could not join the running turn; it waits for the turn's end", { op: edge.op, error: errorMessage({ error }) })
      }
    }
    this.deps.live.submit(conversation, request, text, attachments, undefined, undefined, undefined, actor)
    return { delivery: ready === "idle" ? "turn" : "queued" }
  }

  /** The message the Apex's turn answers: its newest from the person, with what came with it. */
  private personsMessage(apex: Apex): LiveRequest | undefined {
    const requests = apex.conversation ? this.deps.live.held(apex.conversation)?.requests ?? [] : []
    const own = requests.filter((request) => !request.actor || request.actor.kind === "person")
    return own.find((request) => request.status === "dispatching") ?? own.at(-1)
  }

  /** A Fin as its Apex's front-door note names it: what it was asked, where it stands and what it said last. */
  private frontDoorChild(edge: ThreadParent): FrontDoorChild {
    const latest = this.latest.get(edge.child)
    const conversation = this.conversationOf(edge.child)
    const direct = conversation
      ? this.deps.live.held(conversation)?.requests.filter((request) => request.actor?.kind === "person" && request.createdAt !== undefined).at(-1)
      : undefined
    return {
      name: edge.name,
      harness: this.deps.harnessLabel(this.harnessOf(edge)),
      state: this.stateOf(edge),
      topic: noteLine(edge.asked.brief.objective, 160),
      ...(edge.asked.workspace?.branch && { branch: edge.asked.workspace.branch }),
      ...(latest && { report: { status: latest.status, line: noteLine(reportPhase(latest) ?? latest.status, 160), at: latest.at } }),
      ...(direct && { direct: { line: noteLine(direct.displayText ?? direct.text, 120), at: direct.createdAt! } }),
    }
  }

  /**
   * Where a Thread hears its children: the Session the person last wrote in,
   * which is the one speaking as its Apex; before any, the one that started
   * them. One Session answers, so two never act as the Apex at once.
   */
  private frontOf(thread: string, started: string): string | undefined {
    let front: { conversation: string; at: number } | undefined
    for (const conversation of this.conversationsOfThread(thread)) {
      const asked = this.deps.live.held(conversation)?.requests.filter((request) => (!request.actor || request.actor.kind === "person") && request.createdAt !== undefined).at(-1)
      if (asked && (!front || asked.createdAt! > front.at)) front = { conversation, at: asked.createdAt! }
    }
    return front?.conversation ?? this.conversationOfSession(started) ?? this.conversationOf(thread)
  }

  /**
   * A conversation of the `marker` Session on the same harness that is still starting, or hasn't named its native
   * session, may own this one: its shell can't have run anything yet.
   */
  private conversationOwns(ref: Pick<ThreadRef, "harness" | "nativeId" | "sessionId">, marker?: string): boolean {
    if (this.deps.live.connectedSession(ref.harness, ref.nativeId) !== null) return true
    if (ref.sessionId !== undefined && (this.store()?.conversationsOf(ref.sessionId).length ?? 0) > 0) return true
    return marker !== undefined && (this.store()?.conversationsOf(marker) ?? []).some((conversation) => {
      const session = this.deps.live.session(conversation)
      return session?.harness === ref.harness && (session.nativeId === undefined || session.connection === "starting")
    })
  }

  private conversationOfSession(session: string): string | undefined {
    return this.store()?.conversationsOf(session).at(-1)
  }

  /** The conversation that drives a Thread's turns here: its newest Session's. */
  private conversationOf(thread: string): string | undefined {
    const known = this.conversations.get(thread)
    if (known) return known
    const sessions = this.store()?.thread(ThreadIdSchema.parse(thread))?.sessions ?? []
    for (let index = sessions.length - 1; index >= 0; index -= 1) {
      const conversation = this.conversationOfSession(sessions[index]!)
      if (!conversation) continue
      this.conversations.set(thread, conversation)
      this.childOf.set(conversation, thread)
      return conversation
    }
    return undefined
  }

  private conversationsOfThread(thread: string): string[] {
    const store = this.store()
    return (store?.thread(ThreadIdSchema.parse(thread))?.sessions ?? []).flatMap((session) => store?.conversationsOf(session) ?? [])
  }

  private childOfConversation(conversation: string): string | undefined {
    const known = this.childOf.get(conversation)
    if (known) return known
    const thread = this.store()?.journalPlacement(conversation)?.thread
    if (!thread || !this.store()?.edges().of(thread)) return undefined
    this.childOf.set(conversation, thread)
    return thread
  }

  /** Takes in what other hosts wrote: a commit drops every entry, read again from the store as it's asked for. */
  private sync(): void {
    const store = this.store()
    if (!store) return
    const edges = store.edges()
    if (edges === this.seen) return
    this.seen = edges
    this.latest = store.latestReports()
    this.entries.clear()
    this.rosters.clear()
  }

  private forget(thread: string): void {
    this.rosters.delete(thread)
  }

  private store(): ThreadStore | undefined {
    return this.deps.store()
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }
}

function parseQueued(record: string): QueuedStart | undefined {
  try {
    return QueuedStartSchema.parse(JSON.parse(record))
  } catch {
    return undefined
  }
}

function waitedReport(report: Report): WaitedReport {
  return { status: report.status, summary: report.summary, ...(report.artifacts?.length && { artifacts: report.artifacts }), ...(report.question && { question: report.question }) }
}

function unknownFin(ref: string): AgentRefused {
  return { refused: "unknown-child", why: `No ${FIN_WORD} of this Thread is named ${ref}. agents_list shows them.` }
}

/** What a Fin's first turn reads: who asked, as an agent's words, and everything it knows of the work. */
export function briefText(brief: Brief, name: string): string {
  const lines = [
    fromAgent(YOUR_APEX),
    briefIntro(name),
    "",
    brief.objective,
  ]
  if (brief.doneWhen?.length) lines.push("", "Done when:", ...brief.doneWhen.map((item) => `- ${item}`))
  if (brief.boundaries?.length) lines.push("", "Boundaries:", ...brief.boundaries.map((item) => `- ${item}`))
  if (brief.output) lines.push("", `Your report carries: ${brief.output}`)
  lines.push("", BRIEF_CLOSE)
  return lines.join("\n")
}

/** Words on one line of a note: the first sentence, cut at `max` characters. */
function noteLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim()
  const sentence = /^(.+?[.!?])(?:\s|$)/.exec(flat)?.[1] ?? flat
  return sentence.length > max ? `${sentence.slice(0, max - 1).trimEnd()}…` : sentence
}

function entryLine(entry: Entry): string {
  if (entry.type === "user") return `user: ${entry.text}`
  if (entry.type === "text") return `agent: ${entry.text}`
  if (entry.type === "tool") return `tool: ${entry.title ?? entry.name}`
  return ""
}
