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
  childState,
  PlaceSchema,
  reportPhase,
  reportRoute,
  ROLE_WORD,
  TREE_BUDGET,
  type AgentCaller,
  type AgentRefused,
  type AgentsDiagnostics,
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
  type AgentsStarted,
  type AgentsStartInput,
  type AgentsStartResult,
  type AgentsStopInput,
  type AgentsStopResult,
  type AgentsWaitInput,
  type AgentsWaitResult,
  type StartWaited,
  type WaitedReport,
} from "../contracts/agent-tools.js"
import { BRIEF_CLOSE, briefIntro } from "../contracts/children.js"
import { hostCallSchema } from "../contracts/host-call-inputs.js"
import type { LiveStartOptions } from "../contracts/live-conversations.js"
import type { NativeAgent } from "../contracts/native-agents.js"
import { SessionIdSchema, ThreadIdSchema } from "../contracts/thread-identity.js"
import { uniqueName, type ThreadCatalog, type ThreadStore } from "../threads/index.js"
import { AgentRuns, lastStep, type RunEnd } from "./agent-runs.js"
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
  "session" | "held" | "snapshot" | "editQueued" | "transfer" | "submit" | "act" | "cancel" | "waitingOn" | "steersAtStep" | "turnReply" | "childrenChanged" | "connectedSession"
>

export interface AgentsDeps {
  store(): ThreadStore | undefined
  catalog: Pick<ThreadCatalog, "nativePath" | "ref" | "page" | "activity" | "subscribe" | "announce">
  jobs: HostJobs
  live: Live
  /** Starts a conversation as `mako:live-start` does: its worktree, its profile and its mode. */
  startLive(harness: string, cwd: string, options: LiveStartOptions): Promise<void>
  /** The harnesses a child can run on: those with a live driver here. */
  harnesses(): readonly string[]
  /** Whether `harness` has a CLI a Thread's shell can run, so a Session of it can be one started there. */
  runs(harness: string): boolean
  harnessLabel(harness: string): string
  budget?: TreeBudget
  now?(): number
}

/** A caller resolved in the store: its Session, its Thread, and its conversation here. */
interface Lead {
  session: string
  thread: string
  conversation?: string
}

/** What a spawn the running budget holds keeps, so the host that drains it starts what was asked. */
interface QueuedStart {
  lead: Lead
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

/** A `wait` start holding for its child: the lead's conversation whose turn made the call, and how it hears the child move. */
interface Hold {
  child: string
  lead?: string
  check(): void
  end(): void
}

/**
 * The one engine every child goes through (`contracts/agents.ts`): a Thread
 * another Thread's agent started (`agents_start`), or a harness CLI run its
 * shell started (`discovered`) or it named (`agents_link`). It starts a
 * child through `mako:live-start`, so a child is a conversation like any
 * other with its edge written with its Session (`LiveStartOptions.parent`);
 * follows it through its live conversation, or through `AgentRuns` while a
 * process Mako didn't start runs it; writes each end once, with at most one
 * implicit report; and tells the parent through `AgentWakes`. A tree's
 * budgets are held here, by the lead's host. Nothing here is saved twice:
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
  /** `wait` starts holding now: while one holds a child, its reports answer the start rather than wake its lead. */
  private readonly holds = new Set<Hold>()
  /** Notices for a parent whose turns a followed process runs: they start its next turn once that process ends. */
  private readonly held = new Map<string, Notice[]>()
  /** The decision a blocked child's lead was told of, by child: told once per question. */
  private readonly asked = new Map<string, string>()
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
      conversationOwns: (ref) => this.conversationOwns(ref),
      changed: (edge, progressOnly) => this.childMoved(edge, progressOnly),
      ended: (edge, ended) => this.runEnded(edge, ended),
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

  /** What the last host left: reports no parent heard, sent again under their ids, children's messages its exit paused, and spawns the budget held. */
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

  /** An exit pauses the messages waiting in each conversation for the person's Resume; a child's are its lead's, and nobody would press it. */
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
        hostWarn("agents", "a child's paused message waits for Resume", { op: edge.op, request: request.id, error: errorMessage({ error }) })
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

  leads(conversation: string): boolean {
    if (this.roster(conversation).length) return true
    const thread = this.store()?.journalPlacement(conversation)?.thread
    return thread !== undefined && this.store()?.edges().of(thread)?.role === "lead"
  }

  async stopChild(conversation: string, child: string): Promise<boolean> {
    const store = this.store()
    const thread = store?.journalPlacement(conversation)?.thread
    const edge = store?.edges().of(child)
    if (!edge || edge.parent !== thread) return false
    return this.end(edge, "the person stopped it")
  }

  settled(conversation: string, request: string): void {
    // A turn that ended mid-wait left no one to answer: the child's result wakes it instead.
    for (const hold of this.holds) if (hold.lead === conversation) hold.end()
    this.wakes.settled(conversation)
    const child = this.childOfConversation(conversation)
    const edge = child ? this.store()?.edges().of(child) : undefined
    if (edge && !edge.closedAt) this.turnEnded(edge, conversation, request)
    void this.drain()
  }

  /** A conversation's snapshot moved: a child's entry follows it, and a decision it now waits on goes to its lead. */
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
    const lead = this.leadOf(caller)
    if ("refused" in lead) return lead
    const store = this.store()!
    const place = input.place === undefined ? "here" : PlaceSchema.safeParse(input.place).data
    if (place !== "here") return this.refuse(input.clientKey, "place-unavailable", place
      ? "This build starts children on this Mac only; another device or the cloud comes later. Leave place out to start it here."
      : "place is here, device:<name> or cloud.")
    const op = `start:${lead.session}:${input.clientKey}`
    const kept = store.edges().byOp(op)
    if (kept) return this.started(kept, lead, true)
    if (store.queuedSpawns().some((spawn) => spawn.op === op)) return this.queuedAnswer(op, lead, true)
    const harness = input.harness ?? (lead.conversation ? this.deps.live.session(lead.conversation)?.harness : undefined)
    if (!harness || !this.deps.harnesses().includes(harness))
      return this.refuse(op, "unknown-harness", `No harness named ${harness ?? "(none)"} runs here: ${this.deps.harnesses().join(", ")}.`)
    const own = this.tierOf(lead)
    const tier = childAccess(own, input.access)
    if (!tier) return this.refuse(op, "access", `A child runs at most at its ${ROLE_WORD}'s access: this Thread is on ${own}, so ${input.access} is refused.`)
    const tree = this.rootOf(lead.thread)
    const counts = this.treeCounts(tree)
    // A queued spawn is one the tree has started: once the budget would refuse it, it never waits.
    const queued = store.queuedSpawns().filter((spawn) => spawn.tree === tree).length
    if (counts.started + queued >= this.budget.started)
      return this.refuse(op, "budget", `This tree started ${counts.started} of its ${this.budget.started} Threads${queued ? ` and ${queued} more wait to` : ""}. Stop or finish some before starting more.`)
    if (counts.running >= this.budget.running) {
      const queued: QueuedStart = { lead, input, tier, harness }
      store.queueSpawn({ op, tree, record: JSON.stringify(queued), at: this.now() })
      hostLog("agents", "start queued", { op, why: "tree-running", running: counts.running, budget: this.budget.running })
      this.forget(lead.thread)
      return this.queuedAnswer(op, lead, false)
    }
    return this.launch(op, { lead, input, tier, harness })
  }

  async link(caller: AgentCaller, input: AgentsLinkInput): Promise<AgentsLinkResult> {
    const lead = this.leadOf(caller)
    if ("refused" in lead) return lead
    const process = input.pid === undefined ? undefined : await this.runs.processOf(input.pid)
    if (input.pid !== undefined && !process)
      return { refused: "unknown-child", why: `No process ${input.pid} runs on this device; leave pid out for a run that has ended.` }
    const path = this.deps.catalog.nativePath({ harness: input.harness, nativeId: input.session })
    const ref = path ? this.deps.catalog.ref(path) : undefined
    if (!ref) return { refused: "unknown-child", why: `No ${input.harness} session with that ID is on this device.` }
    if (this.conversationOwns(ref)) return { refused: "conflict", why: "That session is a conversation of its own; it can't be a child." }
    const before = this.store()!.edges().byRun(input.harness, input.session)
    const adopted = await this.runs.adopt({
      parentSession: lead.session,
      ref,
      origin: "linked",
      ...(process && { process }),
      ...(input.name && { name: input.name }),
      ...(input.role && { role: input.role }),
      startedBy: { kind: "agent", session: SessionIdSchema.parse(lead.session) },
    })
    if ("refused" in adopted) {
      hostLog("agents", "link refused", { refused: adopted.refused, harness: input.harness })
      return adopted
    }
    this.forget(lead.thread)
    return { child: adopted.child, name: adopted.name, origin: adopted.origin, ...(before && { deduped: true as const }) }
  }

  async list(caller: AgentCaller, input: AgentsListInput): Promise<AgentsListResult> {
    const lead = this.leadOf(caller)
    if ("refused" in lead) return lead
    const store = this.store()!
    const strips: AgentStrip[] = []
    const visit = (parent: string, under?: string) => {
      for (const edge of store.edges().children(parent)) {
        strips.push(this.strip(edge, under))
        if (input.scope === "tree") visit(edge.child, edge.name)
      }
    }
    visit(lead.thread)
    const counts = this.treeCounts(this.rootOf(lead.thread))
    return { children: strips, tree: { ...counts, of: { ...this.budget } } }
  }

  async read(caller: AgentCaller, input: AgentsReadInput): Promise<AgentsReadResult> {
    const lead = this.leadOf(caller)
    if ("refused" in lead) return lead
    const edge = this.resolve(lead, input.child, true)
    if (!edge) return unknownChild(input.child)
    const limit = Math.max(200, Math.min(input.maxChars ?? READ_CHARS, 64_000))
    const state = this.stateOf(edge)
    const text = input.view === "transcript" ? await this.transcript(edge) : this.reportText(edge, state)
    const truncated = text.length > limit
    return { child: edge.child, name: edge.name, state, text: truncated ? text.slice(text.length - limit) : text, ...(truncated && { truncated: true as const }) }
  }

  async report(caller: AgentCaller, input: AgentsReportInput): Promise<AgentsReportResult> {
    const lead = this.leadOf(caller)
    if ("refused" in lead) return lead
    const edge = this.store()!.edges().of(lead.thread)
    if (!edge) return { refused: "no-parent", why: `This Thread has no ${ROLE_WORD}: agents_report is for a Thread another one started.` }
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

  async stop(caller: AgentCaller, input: AgentsStopInput): Promise<AgentsStopResult> {
    const lead = this.leadOf(caller)
    if ("refused" in lead) return lead
    const store = this.store()!
    const why = input.reason ?? `its ${ROLE_WORD} stopped it`
    const one = input.child === "all" ? undefined : this.resolve(lead, input.child, false)
    if (input.child !== "all" && !one) return unknownChild(input.child)
    const targets = one ? [one] : store.edges().children(lead.thread)
    const stopped: string[] = []
    // What waits goes first, so an end below doesn't start it.
    if (input.child === "all")
      for (const spawn of store.queuedSpawns()) {
        const queued = parseQueued(spawn.record)
        if (queued?.lead.thread !== lead.thread) continue
        store.unqueueSpawn(spawn.op)
        stopped.push(queued.input.name ?? queued.input.title ?? spawn.op)
        hostLog("agents", "end", { op: spawn.op, outcome: "stopped", queued: true })
      }
    for (const edge of targets) if (await this.end(edge, why)) stopped.push(edge.name)
    this.forget(lead.thread)
    return { stopped }
  }

  async wait(caller: AgentCaller, input: AgentsWaitInput): Promise<AgentsWaitResult> {
    const lead = this.leadOf(caller)
    if ("refused" in lead) return lead
    const store = this.store()!
    const named = (input.children ?? []).map((child) => ({ child, edge: this.resolve(lead, child, true) }))
    const missing = named.find(({ edge }) => !edge)
    if (missing) return unknownChild(missing.child)
    const edges = named.length ? named.flatMap(({ edge }) => edge ?? []) : store.edges().children(lead.thread)
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

  /** The host's children and budgets, for Diagnostics. */
  diagnostics(): AgentsDiagnostics {
    const store = this.store()
    if (!store) return { children: 0, running: 0, followed: 0, queued: 0, notices: 0, budget: this.budget, trees: [] }
    const edges = store.edges()
    const roots = new Set(edges.all.map((edge) => this.rootOf(edge.parent)))
    const trees = [...roots].map((lead) => ({ lead, ...this.treeCounts(lead) }))
    return {
      children: edges.all.length,
      running: trees.reduce((sum, tree) => sum + tree.running, 0),
      followed: this.runs.following(),
      queued: store.queuedSpawns().length,
      notices: this.wakes.pending(),
      budget: this.budget,
      trees,
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
    const { lead, input, tier, harness } = queued
    const began = performance.now()
    const name = uniqueName(input.name ?? input.title ?? input.brief.objective, new Set(store.edges().children(lead.thread).map((edge) => edge.name)))
    const cwd = input.cwd ?? (lead.conversation ? this.deps.live.session(lead.conversation)?.cwd : undefined)
    if (!cwd) return this.refuse(op, "unavailable", "There's no folder to start it in: name one, or start it from a Thread that has one.")
    const conversationId = namedUuid(op)
    const parent: ChildStart = {
      parent: ThreadIdSchema.parse(lead.thread),
      parentSession: SessionIdSchema.parse(lead.session),
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
      startedBy: { kind: "agent", session: SessionIdSchema.parse(lead.session) },
    }
    const workspace = input.workspace
    const options: LiveStartOptions = {
      conversationId,
      initialRequest: { id: namedUuid(`${op}\nbrief`), text: briefText(input.brief, name), attachments: [] },
      title: input.title ?? name,
      modeId: accessModeId(tier),
      ...((input.model || input.reasoning) && { tuning: { ...(input.model && { model: input.model }), ...(input.reasoning && { options: { effort: input.reasoning } }) } }),
      ...(workspace && {
        worktree: true,
        ...(workspace.branch ? { worktreeStart: { kind: "branch" as const, branch: workspace.branch } } : workspace.base ? { worktreeStart: { kind: "from" as const, ref: workspace.base } } : {}),
      }),
      parent,
    }
    this.starting.add(op)
    this.forget(lead.thread)
    try {
      await this.deps.startLive(harness, cwd, options)
    } catch (error) {
      if (!store.edges().byOp(op)) {
        this.starting.delete(op)
        this.forget(lead.thread)
        return this.refuse(op, "unavailable", `It didn't start: ${errorMessage({ error })}`)
      }
      hostWarn("agents", "a child's start failed after its edge was written; it shows as failed", { op, error: errorMessage({ error }) })
    } finally {
      this.starting.delete(op)
    }
    const edge = store.edges().byOp(op)
    if (!edge) return this.refuse(op, "unavailable", "Its Thread was made without its edge; it was not started as a child.")
    this.conversations.set(edge.child, conversationId)
    this.childOf.set(conversationId, edge.child)
    hostLog("agents", "start admitted", { op, child: edge.child, harness, access: tier, ms: Math.round(performance.now() - began) })
    this.childMoved(edge, false)
    return this.started(edge, lead, false)
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

  private started(edge: ThreadParent, lead: Lead, deduped: boolean): AgentsStarted {
    const state = this.stateOf(edge)
    const counts = this.treeCounts(this.rootOf(lead.thread))
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

  private queuedAnswer(op: string, lead: Lead, deduped: boolean): AgentsStarted {
    const store = this.store()!
    const tree = this.rootOf(lead.thread)
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
   * Holds a `wait` start's answer for at most `window` ms: until its child's
   * result, a question it asks, or the window's or the lead's turn's end.
   * While it holds, the child's reports answer it instead of waking the lead,
   * and once it lets go they wake the lead (`reportRoute`), the result
   * settled-only. A repeat of the start answers the result again.
   */
  private hold(child: string, window: number): Promise<StartWaited> {
    const now = this.outcomeOf(child)
    if (now || window <= 0) return Promise.resolve(this.answered(child, now ?? { outcome: "pending" }))
    const edge = this.store()!.edges().of(child)
    const lead = edge && (this.conversationOfSession(edge.parentSession) ?? this.conversationOf(edge.parent))
    return new Promise((resolve) => {
      const done = (outcome: StartWaited) => {
        clearTimeout(timer)
        this.holds.delete(hold)
        resolve(this.answered(child, outcome))
      }
      const hold: Hold = {
        child,
        ...(lead && { lead }),
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

  /** Where a waited-for child stands: its result, a question it waits on, or nothing yet. */
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

  /** A wait's answer carried the report: the lead heard it, so a wake waiting with it is taken back. */
  private answered(child: string, outcome: StartWaited): StartWaited {
    const store = this.store()
    const edge = store?.edges().of(child)
    if (!store || !edge || outcome.outcome === "pending") return outcome
    const report = store.reportsOf(child, 0).filter((candidate) => candidate.status !== "progress").at(-1)
    if (!report || (outcome.outcome === "question" && !outcome.report)) return outcome
    const conversation = this.conversationOfSession(edge.parentSession) ?? this.conversationOf(edge.parent)
    if (conversation) this.wakes.withdraw(conversation, `notice:${child}:${report.id}`)
    store.markReportsDelivered([report.id], this.now())
    return outcome
  }

  private refuse(op: string, refused: AgentRefused["refused"], why: string): AgentRefused {
    hostLog("agents", "start refused", { op, refused, why })
    return { refused, why }
  }

  // ── Ends and reports ──

  /** A child's turn ended: its end, once, as its last report, unless it reported since the turn began. */
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

  /** `notice:{child}:{reportId}` to the parent's owner: this host, which has the parent's conversation; a report its spawn asked not to hear goes nowhere but its strip. */
  private noticeOf(edge: ThreadParent, report: Report, wake?: string): void {
    const store = this.store()!
    const route = reportRoute(edge.asked, report.status)
    if (route !== "lead") {
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
    const conversation = this.conversationOfSession(edge.parentSession) ?? this.conversationOf(edge.parent)
    if (conversation) return this.wakes.notice(conversation, this.rootOf(edge.parent), notice)
    if (this.runs.running(edge.parent)) {
      const held = this.held.get(edge.parent) ?? []
      if (!held.some((waiting) => waiting.id === notice.id)) held.push(notice)
      this.held.set(edge.parent, held)
      hostLog("agents", "message held", { notice: notice.id, until: "its process exits" })
    }
  }

  /** A sub-lead's process ended: what was held for it starts its next turn, on Mako's live driver. */
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

  /** Stops a child, once: its running turn, or its process group; the delegation closes either way. */
  private async end(edge: ThreadParent, why: string): Promise<boolean> {
    if (edge.closedAt) return false
    const store = this.store()!
    this.runs.stop(edge.child)
    const conversation = this.conversationOf(edge.child)
    const status = conversation ? this.deps.live.session(conversation)?.status : undefined
    if (conversation && (status === "running" || status === "starting"))
      await this.deps.live.cancel(conversation).catch((error) => hostWarn("agents", "a child's turn could not be stopped", { op: edge.op, error: errorMessage({ error }) }))
    const closed = store.keepEdge({ ...edge, closedAt: this.now() })
    hostLog("agents", "end", { op: edge.op, child: edge.child, outcome: "stopped", why })
    this.childMoved(closed, false)
    void this.drain()
    return true
  }

  // ── What a child shows ──

  /** What the child's Thread shows now, from whatever runs its current turn: one source at a time. */
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
      ...(waiting && { waiting: { question: this.waitingLine(edge, waiting.line), on: this.decides(edge) } }),
      ...(!working && last?.status === "failed" && { ended: { outcome: "failed" as const, ...(last.error && { reason: last.error }), at: last.createdAt ?? edge.createdAt } }),
      ...(!working && last?.status === "interrupted" && last.interruption?.reason === "stopped" && { ended: { outcome: "stopped" as const, at: last.interruption.at } }),
      startedAt: edge.createdAt,
      ...(held?.activityAt && { updatedAt: held.activityAt }),
    }
  }

  /** Who answers a child's approval: its lead on full access, unless its spawn asked to hear only its result; else the person, told why. */
  private decides(edge: ThreadParent): "lead" | "person" {
    if (reportRoute(edge.asked, "blocked") !== "lead") return "person"
    const parent = this.conversationOfSession(edge.parentSession) ?? this.conversationOf(edge.parent)
    const tier = parent ? this.tierOfConversation(parent) : undefined
    return tier === "full" ? "lead" : "person"
  }

  private waitingLine(edge: ThreadParent, line: string): string {
    if (this.decides(edge) === "lead") return line
    return reportRoute(edge.asked, "blocked") === "lead"
      ? `${line} (yours to answer: its ${ROLE_WORD} isn't on full access)`
      : `${line} (yours to answer: its ${ROLE_WORD} hears only ${edge.asked.wake === "never" ? "what it reads" : "its result"})`
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

  /** A child's entry moved: its parent's conversations hear it, and a decision it waits on reaches its lead once. */
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
    this.askLead(edge)
    if (kindChanged) this.checkHolds(edge.child)
    if (before && before.state.kind === "working" && entry.state.kind !== "working") void this.drain()
  }

  private checkHolds(child: string): void {
    for (const hold of this.holds) if (hold.child === child) hold.check()
  }

  /** A child waiting on an approval or a question under a lead on full access: the lead hears it as `blocked`, keyed by what it waits on. */
  private askLead(edge: ThreadParent): void {
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
    if (on !== "lead") return
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

  private leadOf(caller: AgentCaller): Lead | AgentRefused {
    const store = this.store()
    if (!store) return { refused: "unavailable", why: "Children need the Thread store, which didn't open." }
    if (caller.kind !== "agent")
      return { refused: "no-parent", why: "Only a Thread's agent leads children: call it from a Thread's mako tools, or from its shell, where MAKO_SESSION_ID names it." }
    const session = SessionIdSchema.safeParse(caller.session)
    const placed = session.success ? store.sessionPlacement(session.data) : undefined
    if (!placed) return { refused: "no-parent", why: "No Thread has that Session." }
    const conversation = this.conversationOfSession(placed.session)
    return { session: placed.session, thread: placed.thread, ...(conversation && { conversation }) }
  }

  /** A child by its name, `child:<name>` or its Thread: the caller's own, or with `deep` a descendant's. */
  private resolve(lead: Lead, ref: string, deep: boolean): ThreadParent | undefined {
    const store = this.store()!
    const name = ref.startsWith("child:") ? ref.slice("child:".length) : ref
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
    return look(lead.thread, 0)
  }

  private tierOf(lead: Lead): AccessTier {
    return (lead.conversation ? this.tierOfConversation(lead.conversation) : undefined) ?? "ask"
  }

  private tierOfConversation(conversation: string): AccessTier | undefined {
    const session = this.deps.live.session(conversation)
    return accessTierOfModeId(session?.launchMode ?? session?.currentMode ?? "") ?? undefined
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

  private conversationOwns(ref: Pick<ThreadRef, "harness" | "nativeId" | "sessionId">): boolean {
    return this.deps.live.connectedSession(ref.harness, ref.nativeId) !== null ||
      (ref.sessionId !== undefined && (this.store()?.conversationsOf(ref.sessionId).length ?? 0) > 0)
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

function unknownChild(ref: string): AgentRefused {
  return { refused: "unknown-child", why: `No child of this Thread is named ${ref}. agents_list shows them.` }
}

/** What a child's first turn reads: who asked, as an agent's words, and everything it knows of the work. */
export function briefText(brief: Brief, name: string): string {
  const lines = [
    fromAgent(`your ${ROLE_WORD}`),
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

function entryLine(entry: Entry): string {
  if (entry.type === "user") return `user: ${entry.text}`
  if (entry.type === "text") return `agent: ${entry.text}`
  if (entry.type === "tool") return `tool: ${entry.title ?? entry.name}`
  return ""
}
