import type { ThreadRef } from "@mako/sessions"
import type { Entry } from "@mako/sessions/entries"
import { SessionSettingsSchema, type SessionModel, type SessionSettings } from "@mako/sessions/settings"
import type { HostJobs } from "../base/host-jobs.js"
import { hostLog, hostWarn } from "../base/host-log.js"
import { branchSince, checkoutSince } from "../base/checkout-since.js"
import { finResumedText } from "../contracts/resume-account.js"
import { errorMessage } from "../base/error-message.js"
import { z } from "zod"
import { ACCESS_TIER_NAMES, accessModeId, sessionAccessTier, type AccessTier } from "../contracts/access.js"
import {
  childAccess,
  childEntry,
  ruleWords,
  childMode,
  childState,
  modeWithin,
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
  type AgentsRespondInput,
  type Brief,
  type ChildStart,
  type FinDeliver,
  type FinDelivery,
  type ChildState,
  type ChildThread,
  type QueueReason,
  queuedWords,
  type Report,
  type ThreadParent,
  type TreeBudget,
} from "../contracts/agents.js"
import {
  afterStart,
  APEX_DIGEST_FINS,
  WAIT_LIMIT_MS,
  type AgentOperations,
  type AgentsApexes,
  type AgentsCrew,
  type OtherApex,
  type AgentStrip,
  type CrewMate,
  type AgentsLinkInput,
  type AgentsLinkResult,
  type AgentsListInput,
  type AgentsListResult,
  type AgentsReadInput,
  type AgentsReadResult,
  type AgentsReportInput,
  type AgentsReportResult,
  type AgentsAnswered,
  type AgentsAnswerInput,
  type AgentsAnswerResult,
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
import { agentWords, answerText, apexAsk, apexNote, BRIEF_CLOSE, briefIntro, CHILD_GROUPS, childGroup, childLine, finName, fromApex, HANDED_OVER_NOTE, PASSED_ON_NOTE, passedOn, personsApproval, rollup, YOUR_APEX } from "../contracts/children.js"
import { hostCallSchema } from "../contracts/host-call-inputs.js"
import { resetWords, type HarnessLimit } from "../contracts/account-usage.js"
import { FIN_LIMIT, finPolicyNote, placeFull, type CloudFinLimits, type FinPlaceLimit, FinTuningSourceSchema, finTuningLine, finTuningWords, resolveFinTuning, type FinPolicy, type FinTarget, type FinTuningSource } from "../contracts/fin-tuning.js"
import { AFTER_LIMIT, ASK_OPTIONS, type FinAsk, type NativeAgent } from "../contracts/native-agents.js"
import type { PendingAsk } from "../contracts/live-questions.js"
import type { LiveRequest, LiveStartOptions } from "../contracts/live-conversations.js"
import type { LivePermissionResponse, LiveSessionMode, PromptAttachment } from "../contracts/providers-acp.js"
import { SessionIdSchema, ThreadIdSchema, type Actor, type ThreadId } from "../contracts/thread-identity.js"
import { crashedChildTurn } from "../contracts/turn-continuation.js"
import { uniqueName, type ThreadCatalog, type ThreadStore } from "../threads/index.js"
import { AgentRuns, lastStep, type ProcessReads, type RunEnd } from "./agent-runs.js"
import { AgentWakes, firstParagraph, FROM_AGENTS, fromAgent, type Notice, type ParentReady } from "./agent-wakes.js"
import { namedUuid } from "./cloud-moves.js"
import type { LiveConversations } from "./live-conversations.js"
import type { ConversationChildren } from "./live-runtime.js"
import { macLoad, type MacLoad, type MacReading } from "./mac-capacity.js"

const NONE: readonly NativeAgent[] = []
/** How long a start waits to read whether a harness's account is at its limit before taking it as having room. */
const LIMIT_READ_MS = 3_000
/** A Fin's own Fins in these states are work it still waits on. */
const WAITED_ON: ReadonlySet<ChildState["kind"]> = new Set(["queued", "starting", "working", "blocked"])
/** How often what waits looks again, for a limit the person raised or a Fin that ended unseen. */
const ROOM_EVERY_MS = 10_000
/** How long an ask its Apex may answer waits on the Apex alone before the person is asked too. */
export const APEX_ANSWER_MS = 60_000

/** What a message into a child's Thread became, and when the child hears it. */
interface Delivered {
  delivery: FinDelivery
  hears: string
  deduped?: true
}

/** How long a steer waits for its child's turn to start, and then for its harness's answer, before the call answers without it. */
const STEER_WAIT_MS = 3_000
const STEER_ANSWER_MS = 2_000
/** How `agents_send` names another of the person's Apexes: `apex:<title or Thread ID>`. */
const APEX_PREFIX = "apex:"
/** Messages one Apex sends another in an hour; past them it's refused, so two Apexes can't talk in a loop. */
const APEX_SENDS_PER_HOUR = 3
const HOUR_MS = 3_600_000

/** Another of the person's Apexes as a message to it is addressed: its Thread, and the conversation that speaks for it. */
interface OtherApexRef {
  thread: string
  conversation: string
  title?: string
}

/** A message to another Apex whose reply goes back: to whom, from whom, as the sender's digest names it. */
interface ApexAsk {
  sender: Apex
  /** Its conversation and the requests whose turn answers it: the message's own, or the turn it was steered into. */
  conversation: string
  requests: string[]
  thread: string
  label: string
  /** The Apex as the sender's card of its reply names it. */
  fin: { name: string; harness?: string }
}

/** Entries `agents_read` shows of a transcript, and the characters it returns at most. */
const READ_ENTRIES = 40
const READ_CHARS = 8_000

type Live = Pick<
  LiveConversations,
  "session" | "held" | "atWork" | "resumeHeld" | "stopHolds" | "snapshot" | "editQueued" | "transfer" | "submit" | "act" | "cancel" | "continueTurn" | "leftUnsettled" | "waitingOn" | "pendingAsk" | "permission" | "steersAtStep" | "steering" | "interrupt" | "turnReply" | "childrenChanged" | "connectedSession" | "recordDirect"
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
  /** Whether a conversation's agent asked to move into its worktree and the move hasn't happened yet: it carries on there. */
  movePending?(conversation: string): boolean
  /** Whether the person archived a conversation's Thread: a Fin's work ends there for good, until they restore it. */
  archived?(conversation: string): boolean
  /** What a Fin of `harness` in `cwd` may run on: the harness's catalog, Mako's pick for it, and the person's own choices there. */
  finChoices?(harness: string, cwd: string): Promise<FinChoices>
  /** `harness`'s catalog as this host last read it, for a Fin's row; undefined before it's read. */
  catalogOf?(harness: string): readonly SessionModel[] | undefined
  /** `harness`'s account in use when it's at its limit (`HarnessAccounts.limited`); undefined while it has room. */
  limited?(harness: string): Promise<HarnessLimit | undefined>
  /** The harnesses in the person's order (Settings › Models), most preferred first: where a Fin goes when its Apex's harness is at its limit. */
  harnessOrder?(): Promise<readonly string[]>
  /** The person's rules for which work goes to which harness and model (Settings › Fins). */
  finPolicy?(): FinPolicy | undefined
  budget?: TreeBudget
  /** How many of the person's Fins run at once on this device, every tree's: its capacity or their own number (`FinCapacity`); `FIN_LIMIT` without it. */
  finLimit?(): number
  /** Reads the machine for its capacity, with the Fins at work here and their harnesses, as what waits is looked at. */
  observeCapacity?(working: number, mix: Readonly<Record<string, number>>): Promise<void>
  /** The person's Fins at once across every place (Settings › Fins): a safety net over the places' own. */
  finCeiling?(): number
  /** The places a start may name (`here`, `device:<name>`, `cloud`); only `here` until placement lands. */
  places?(): readonly string[]
  /** What bounds the cloud's Fins (the person's plan and spend ceiling), once Fins start there; nothing without it. */
  cloudLimits?(): CloudFinLimits
  /** This Mac's cores, memory and load (`MacCapacity`): a start's answer says when it's busy, and it starts anyway. */
  capacity?: { read(): Promise<MacReading> }
  processes?: ProcessReads
  /** `APEX_ANSWER_MS`, shorter in tests. */
  apexAnswerMs?: number
  now?(): number
}

/** What a Fin of one harness may run on (`AgentsDeps.finChoices`). */
export interface FinChoices {
  /** Its catalog; empty while it hasn't been read. */
  models: readonly SessionModel[]
  /** Mako's pick for the harness (`HarnessDefaults.work`). */
  recommended?: SessionSettings
  /** The person's Settings › Fins choice for it. */
  chosen?: SessionSettings
  /** The model the person last started or sent with on it. */
  used?: SessionSettings
}

/** A spawn's model, decided as it's admitted: what it starts with, where that came from, and any choice passed over. */
interface Tuned {
  settings?: SessionSettings
  source: FinTuningSource
  note?: string
  rerouted?: { from: string; until?: number; instead?: string }
  rule?: { n?: number; when: string }
}

/** The person's rule a spawn follows, or their choice for work no rule fits: where it sends the Fin, and its words. */
interface Ruled {
  target: FinTarget
  who: string
  rule: { n?: number; when: string }
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
  /** Absent from a build before models were decided at admission: decided at its start. */
  tuned?: Tuned
  /** What held it: the tree's running budget, or the person's limit of Fins at once (`place-full`). Absent: only `after`, or a record from before. */
  why?: Extract<QueueReason, "tree-running" | "place-full">
  /** The Apex's Fins it starts after, each once it has finished: a Fin by its Thread, or a spawn queued too by its op. */
  after?: AfterRef[]
  /** Why it couldn't start once released: it stays, saying so, until its Apex has heard (`tellHeld`). */
  refused?: string
}

interface AfterRef {
  name: string
  child?: string
  op?: string
}

/** How a spawn's `after` stands: the names still to finish, and the first that won't, which holds it. */
interface AfterStand {
  pending: string[]
  held?: { name: string; outcome: "failed" | "stopped"; reason?: string; session?: string }
}

const QueuedStartSchema = z.object({
  lead: z.object({ session: z.string(), thread: z.string(), conversation: z.string().optional() }),
  input: hostCallSchema("mako:agents-start").def.items[1],
  tier: z.enum(ACCESS_TIER_NAMES),
  harness: z.string(),
  tuned: z.object({
    settings: SessionSettingsSchema.optional(),
    source: FinTuningSourceSchema,
    note: z.string().optional(),
    rerouted: z.object({ from: z.string(), until: z.number().optional(), instead: z.string().optional() }).optional(),
    rule: z.object({ n: z.number().optional(), when: z.string() }).optional(),
  }).optional(),
  why: z.enum(["tree-running", "place-full"]).optional(),
  after: z.array(z.object({ name: z.string(), child: z.string().optional(), op: z.string().optional() })).optional(),
  refused: z.string().optional(),
}) satisfies z.ZodType<QueuedStart>

/** Where a Fin runs, as its limit counts it: `here` (this device), `device:<name>` or `cloud`. */
const HERE = "here"
const placeOf = (place: string | undefined) => place ?? HERE
const upper = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

/**
 * A start under way (`Agents.starts`): one per Apex and client key, from its call's first step until it settles.
 * `name` is reserved once it launches, `launching` holds its place and its tree's, and `cancelled` is its stop.
 */
interface StartRecord {
  op: string
  thread: string
  /** The name it was asked for, which a stop by name finds it by before it has one of its own. */
  asked?: string
  name?: string
  launching?: { where: string; tree: string }
  cancelled: boolean
  answer: Promise<AgentsStartResult>
}

/** A queued spawn's notice that a Fin it was to start after didn't finish: `after:<op>`; once its Apex heard it, it's dropped. */
const HELD_PREFIX = "after:"

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
  /** The rules each conversation last read (`rulesNote`), as they were said. */
  private readonly rulesSaid = new Map<string, string>()
  private readonly waiters = new Set<() => void>()
  /** `wait` starts holding now: while one holds a Fin, its reports answer the start rather than wake its Apex. */
  private readonly holds = new Set<Hold>()
  /** Apexes whose turns a followed process ran, while their held reports start their next turn (`release`). */
  private readonly releasing = new Set<string>()
  /** Fins whose turn ended while their own work went on, with that turn: its reply is their report once nothing is left. */
  private readonly awaiting = new Map<string, { conversation: string; request: string }>()
  /** The decision a blocked Fin's Apex was told of, by Fin: told once per question. */
  private readonly asked = new Map<string, string>()
  /** By Fin, the ask its Apex didn't answer in time, now the person's too, and why in the person's words. */
  private readonly escalated = new Map<string, { line: string; why: string }>()
  /** By Fin, the timer that asks the person once its Apex has left its ask unanswered for `APEX_ANSWER_MS`. */
  private readonly unanswered = new Map<string, NodeJS.Timeout>()
  /** What each `agents_send` key delivered, so a retry answers the same. */
  private readonly sent = new Map<string, AgentsSent>()
  /** Messages to another Apex, by its conversation and the request whose turn answers it: its reply goes to the sender once. */
  private readonly apexAsks = new Map<string, ApexAsk>()
  /** When each Apex messaged another, by the ordered pair: at most `APEX_SENDS_PER_HOUR` an hour. */
  private readonly apexSends = new Map<string, number[]>()
  /** What joined a running turn as a step, by its id: no request holds it for `redirect` to find. */
  private readonly steered = new Map<string, Pick<LiveRequest, "text" | "attachments">>()
  /** The person's direct messages by their request, delivering or delivered, so a repeat answers the first. */
  private readonly directed = new Map<string, Promise<AgentsDirected | AgentRefused>>()
  private readonly routes = { forwarded: 0, sent: 0, redirected: 0, direct: 0 }
  /** What each `agents_answer` key did, so a retry answers the same. */
  private readonly answers = new Map<string, AgentsAnswered>()
  private readonly answerCounts = { apex: 0, passed: 0, refused: 0, person: 0 }
  private latest = new Map<string, Report>()
  private seen: unknown
  private draining = false
  private drainAgain = false
  /**
   * Every start under way, one record per Apex and client key from the call's first synchronous step until it
   * settles: a call with the same key joins it. The record alone holds its name, its place while it launches and its
   * stop, and only its own settle gives them back (`StartRecord`).
   */
  private readonly starts = new Map<string, StartRecord>()
  /** Fins holding a place now (`occupies`): one that lets go frees it for what waits, at once. */
  private readonly occupying = new Set<string>()
  private stopped = false
  private readonly stopRoomWatch: () => void
  /** This Mac's load as a start last read it, which every answer carries while it's busy. */
  private mac: MacLoad | undefined

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
      stuck: (edge) => this.runStuck(edge),
      ...(deps.processes && { processes: deps.processes }),
      now: deps.now,
    })
    this.wakes = new AgentWakes({
      ready: (conversation) => this.ready(conversation),
      wake: (conversation, request, text, actor) => {
        // The conversation took this request already: a host that died before marking its reports heard sent it.
        if (deps.live.held(conversation)?.requests.some((asked) => asked.id === request)) return
        deps.live.submit(conversation, request, text, [], undefined, undefined, undefined, actor)
      },
      steer: (conversation, id, text) => this.steer(conversation, id, text),
      assign: (reports, request) => this.store()?.assignWake(reports.filter((id) => !id.startsWith(HELD_PREFIX)), request),
      delivered: (reports, at) => {
        this.store()?.markReportsDelivered(reports.filter((id) => !id.startsWith(HELD_PREFIX)), at)
        for (const id of reports) if (id.startsWith(HELD_PREFIX)) this.dropHeld(id.slice(HELD_PREFIX.length))
      },
      counts: (conversation) => this.counts(conversation),
      current: (notice) => this.current(notice),
      now: deps.now,
    })
    // Reads the machine for its capacity; a place that gains room says so (`capacityChanged`), and what waits goes then.
    this.stopRoomWatch = deps.jobs.every("read this device's capacity", ROOM_EVERY_MS, () => this.observe())
  }

  /** A digest never says a Fin ended that its Session shows at work: the end the host inferred for its run is past. */
  private current(notice: Notice): boolean {
    const { report } = notice
    // Nor that it waits on an ask it no longer does: answered by the person, say, while its Apex's turn ran on.
    if (report.implicit && report.status === "blocked") {
      const conversation = this.conversationOf(report.child)
      const waiting = conversation ? this.deps.live.waitingOn(conversation) : undefined
      return waiting !== undefined && report.id.endsWith(namedUuid(waiting.line))
    }
    if (!report.implicit || (report.status !== "done" && report.status !== "failed")) return true
    const edge = this.store()?.edges().of(report.child)
    if (!edge?.run || edge.closedAt !== undefined) return true
    const reading = this.childReading(edge)
    return !(reading.source === "followed" && reading.working)
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
      if (edge.closedAt !== undefined || (edge.run && !edge.run.ended)) continue
      const last = store.reportsOf(edge.child, 0).at(-1)
      const conversation = this.conversationOf(edge.child)
      // A Fin that finished is read in only when the last host left a message of it waiting, paused or running.
      if ((last?.status !== "done" && last?.status !== "failed") || (conversation && this.deps.live.leftUnsettled(conversation))) this.resumePaused(edge)
    }
    for (const apex of new Set(edges.all.map((edge) => edge.parent))) {
      // A stopped Fin's wait for it to resume (`resumeFin`).
      if (edges.of(apex)?.closedAt !== undefined) continue
      for (const conversation of this.conversationsOfThread(apex)) if (this.deps.live.leftUnsettled(conversation)) this.resumeWakes(conversation)
    }
    // The places Fins hold as this host takes over, the turns the last one cut short going on among them: each that lets
    // go of one later wakes what waits (`childMoved`).
    for (const edge of edges.all) if (this.occupies(edge)) this.occupying.add(edge.child)
    void this.drain()
  }

  /**
   * An exit pauses the messages waiting in each conversation for the person's
   * Resume, and a crash leaves the turn it cut for their Continue turn; a
   * Fin's are its Apex's, and nobody would press either. A quit's cut turn
   * the next host continues already (`LiveRestarts`).
   */
  private resumePaused(edge: ThreadParent): void {
    const conversation = this.conversationOf(edge.child)
    const snapshot = conversation && this.deps.live.snapshot(conversation)
    if (!snapshot) return
    const crashed = crashedChildTurn(snapshot.requests, this.now())
    if (crashed) {
      try {
        this.deps.live.continueTurn(conversation, { requestId: namedUuid(`crashed:${crashed.id}`), reason: "host-crashed", continues: crashed.id, actor: { kind: "service", name: "auto-continue" } })
        hostLog("agents", "resumed", { op: edge.op, request: crashed.id, crashed: true })
      } catch (error) {
        hostWarn("agents", "a Fin's turn a crash cut short waits for Continue turn", { op: edge.op, request: crashed.id, error: errorMessage({ error }) })
      }
    }
    const binding = snapshot.control?.bindings.find((candidate) => candidate.id === snapshot.control?.activeBindingId)
    let launched = Boolean(binding?.nativeId)
    for (const request of snapshot.requests) {
      if (request.status !== "held" || request.signIn || request.wake || request.retry || request.editing || request.pause === "stop" || request.actor?.kind !== "agent") continue
      const relaunched = !launched
      try {
        if (launched) this.deps.live.editQueued(conversation, { requestId: request.id, expectedText: request.text, change: { kind: "resume" } })
        else {
          // Its harness never started: the exit cut its launch. It starts now, the brief its first message, and the rest wait behind it.
          this.deps.live.editQueued(conversation, { requestId: request.id, expectedText: request.text, change: { kind: "remove" } })
          this.deps.live.transfer(conversation, { id: namedUuid(`relaunch:${request.id}`), provider: snapshot.session.harness, text: request.text, attachments: request.attachments, ...(request.tuning && { tuning: request.tuning }), ...(binding?.modeId && { modeId: binding.modeId }) }, request.actor)
          launched = true
        }
        hostLog("agents", "resumed", { op: edge.op, request: request.id, relaunched })
      } catch (error) {
        hostWarn("agents", "a Fin's paused message waits for Resume", { op: edge.op, request: request.id, error: errorMessage({ error }) })
      }
    }
  }

  /** An exit or a crash pauses the digests waiting for an Apex with the person's messages; they're Mako's, so they go on. */
  private resumeWakes(conversation: string): void {
    for (const request of this.deps.live.snapshot(conversation)?.requests ?? []) {
      if (request.status !== "held" || request.signIn || request.wake || request.retry || request.editing || request.pause === "stop" || request.actor?.kind !== "agent" || !request.text.startsWith(FROM_AGENTS)) continue
      try {
        this.deps.live.editQueued(conversation, { requestId: request.id, expectedText: request.text, change: { kind: "resume" } })
        hostLog("agents", "resumed", { conversation, request: request.id, wake: true })
      } catch (error) {
        hostWarn("agents", "a digest an exit paused waits for Resume", { conversation, request: request.id, error: errorMessage({ error }) })
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
    const rules = this.rulesNote(conversation)
    const open = store.edges().children(thread).filter((edge) => !edge.closedAt)
    if (!open.length) return rules
    this.sync()
    const lines = [...rules, ...frontDoorNote(open.map((edge) => this.frontDoorChild(edge)), this.now())]
    hostLog("agents", "front door", { conversation, children: open.length, chars: lines.reduce((sum, line) => sum + line.length + 1, 0) })
    return lines
  }

  /**
   * The person's rules for Fins, for a conversation that hasn't read them as they stand: once, and again when they
   * change, so every Thread that might start a Fin knows them without paying for them on every message.
   */
  private rulesNote(conversation: string): string[] {
    const lines = this.policyLines()
    const said = lines.join("\n")
    if (this.rulesSaid.get(conversation) === said) return []
    this.rulesSaid.set(conversation, said)
    return lines
  }

  /** The person's rules as an Apex reads them, each target in its catalog's words. */
  private policyLines(): string[] {
    const policy = this.deps.finPolicy?.()
    if (!policy) return []
    return finPolicyNote(policy, (target) => {
      const label = this.deps.harnessLabel(target.harness)
      const catalog = this.deps.catalogOf?.(target.harness)
      const words = catalog && target.settings ? finTuningWords(catalog, target.settings) : undefined
      return words ? `${label} · ${finTuningLine(words)}` : target.settings?.model ? `${label} · ${target.settings.model}` : `${label}, on the model the person uses there`
    })
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
    const steeredIn = this.steered.get(input.request)
    const queued = was && !steeredIn ? this.deps.live.held(was)?.requests.find((request) => request.id === input.request) : undefined
    const passed = queued ?? steeredIn
    if (!was || !passed) return { refused: "unknown-child", why: `${from.name} has no such message.` }
    const words = agentWords(passed.text)
    const text = words?.passedOn ? words.body : passed.text
    if (queued && (queued.status === "queued" || queued.status === "held"))
      this.deps.live.editQueued(was, { requestId: queued.id, expectedText: queued.text, change: { kind: "remove" } })
    const withdrawn = queued !== undefined && ["queued", "held", "canceled"].includes(queued.status)
    const sent = await this.deliver(to, namedUuid(`redirect:${input.request}:${to.child}`), text, passed.attachments, undefined, "steer")
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
    const received = namedUuid(`direct:${input.request}`)
    const attachments = input.attachments ?? []
    const sent = await this.deliver(edge, received, input.text, attachments, undefined, "steer")
    if ("refused" in sent) return sent
    if (sent.delivery === "steer") this.steered.set(received, { text: input.text, attachments })
    const kept = this.deps.live.recordDirect(conversation, { to: edge.name, fin: edge.child, request: input.request, received, delivery: sent.delivery, at: Date.now() }, input.text)
    if (!sent.deduped) this.routes.direct += 1
    hostLog("agents", "direct", { to: edge.op, request: input.request, delivery: sent.delivery, kept, ms: Math.round(performance.now() - began), ...(sent.deduped && { deduped: true }) })
    return { to: edge.name, fin: edge.child, delivery: sent.delivery }
  }

  /**
   * The person archived a conversation's Thread: a Fin's work ends there, once.
   * One at work is stopped as a stop would, in those words; one stopped
   * already keeps its stop. A message to it is refused until it's restored.
   */
  async archived(conversation: string): Promise<boolean> {
    const child = this.childOfConversation(conversation)
    const edge = child ? this.store()?.edges().of(child) : undefined
    if (!edge) return false
    return this.end(edge, "the person archived it")
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
    this.apexReplied(conversation, request)
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
    if (!edge) return
    // The person writing in a stopped Fin's own Thread resumes it, as a message from its Apex does.
    const closedAt = edge.closedAt
    const persons = closedAt === undefined || this.deps.archived?.(conversation) ? undefined
      : this.deps.live.held(conversation)?.requests.find((request) => (request.createdAt ?? 0) > closedAt && (!request.actor || request.actor.kind === "person"))
    if (persons) {
      this.reopen(edge, "the person")
      return this.resumeFin(conversation, persons.id)
    }
    this.childMoved(edge, true)
  }

  // ── AgentOperations ──

  start(caller: AgentCaller, input: AgentsStartInput): Promise<AgentsStartResult> {
    return input.mode === "wait" ? this.startWaiting(caller, input) : this.admitOnce(caller, input)
  }

  /**
   * One admission per Apex and client key: the record is made before anything is awaited, so a second call with the
   * same key, while the first is still deciding or launching, joins its answer rather than starting again.
   */
  private admitOnce(caller: AgentCaller, input: AgentsStartInput): Promise<AgentsStartResult> {
    const apex = this.apexOf(caller)
    if ("refused" in apex) return Promise.resolve(apex)
    const op = `start:${apex.session}:${input.clientKey}`
    const held = this.starts.get(op)
    if (held) return held.answer.then((answer) => ("refused" in answer ? answer : { ...answer, deduped: true as const }))
    const record = this.record(op, apex.thread, input.name ?? input.title)
    record.answer = this.admit(apex, input, record).finally(() => this.retire(record))
    return record.answer
  }

  /** A start's record, in place before its first await (`starts`). */
  private record(op: string, thread: string, name?: string): StartRecord {
    const record: StartRecord = { op, thread, ...(name && { asked: name }), cancelled: false, answer: Promise.resolve({ refused: "unavailable", why: "" }) }
    this.starts.set(op, record)
    return record
  }

  /**
   * Its own settle gives back what it held: its name, its place and its stop. A place given back goes to what waits in
   * the same tick, whichever way the start ended; a record its replacement already took over gives back nothing.
   */
  private retire(record: StartRecord): void {
    if (this.starts.get(record.op) !== record) return
    this.starts.delete(record.op)
    if (record.launching) void this.drain()
  }

  /** Its Apex stopped it: no edge is written for it from now (`startWanted`), and one written already ends. */
  private cancel(record: StartRecord): void {
    record.cancelled = true
    const edge = this.store()?.edges().byOp(record.op)
    if (edge) void this.end(edge, `its ${APEX_WORD} stopped it`)
  }

  /** How many starts are under way, each holding its name, place and stop until it settles: none once all have. */
  startsUnderWay(): number {
    return this.starts.size
  }

  /** Whether the start `op` is under way: deciding, launching, or taken from its queue row and coming up. */
  startUnderWay(op: string): boolean {
    return this.starts.has(op)
  }

  /** Whether a start under way is still wanted: one its Apex stopped isn't (`mako:live-start` asks before writing its edge). */
  startWanted(op: string): boolean {
    return this.starts.get(op)?.cancelled !== true
  }

  private async startWaiting(caller: AgentCaller, input: AgentsStartInput): Promise<AgentsStartResult> {
    const began = this.now()
    const answer = await this.admitOnce(caller, input)
    if ("refused" in answer) return answer
    const window = Math.max(0, Math.min(input.timeoutMs ?? WAIT_LIMIT_MS, WAIT_LIMIT_MS) - (this.now() - began))
    const waited = answer.child ? await this.hold(answer.child, window) : { outcome: "pending" as const }
    hostLog("agents", "start waited", { child: answer.child ?? answer.name, outcome: waited.outcome, ms: this.now() - began, ...(answer.deduped && { deduped: true }) })
    return { ...answer, waited, next: afterStart(input.wake ?? "decisions", waited) }
  }

  private async admit(apex: Apex, input: AgentsStartInput, start: StartRecord): Promise<AgentsStartResult> {
    const store = this.store()!
    const place = input.place === undefined ? "here" : PlaceSchema.safeParse(input.place).data
    if (place !== "here") return this.refuse(input.clientKey, "place-unavailable", place
      ? "This build starts Fins on this Mac only; another device or the cloud comes later. Leave place out to start it here."
      : "place is here, device:<name> or cloud.")
    const op = `start:${apex.session}:${input.clientKey}`
    const kept = store.edges().byOp(op)
    if (kept) return this.started(kept, apex, true)
    if (store.queuedSpawns().some((spawn) => spawn.op === op)) return this.queuedAnswer(op, apex, true)
    const policy = this.deps.finPolicy?.()
    const followed = input.rule === undefined ? undefined : policy?.rules[input.rule - 1]
    if (input.rule !== undefined && !followed)
      return this.refuse(op, "unknown-rule", policy?.rules.length
        ? `The person has ${policy.rules.length} rule${policy.rules.length === 1 ? "" : "s"}, so there's no rule ${input.rule}: ${policy.rules.map((rule, index) => `${index + 1}. ${rule.when}`).join(" ")}`
        : "The person has no rules for Fins: leave rule out.")
    const otherwise = !followed && input.harness === undefined && input.model === undefined ? policy?.otherwise : undefined
    const ruled: Ruled | undefined = followed
      ? { target: followed.target, who: `Your rule ${input.rule}`, rule: { n: input.rule!, when: followed.when } }
      : otherwise ? { target: otherwise, who: "Your choice for work no rule fits", rule: { when: "No rule fit" } } : undefined
    const asked = input.harness ?? ruled?.target.harness ?? (apex.conversation ? this.deps.live.session(apex.conversation)?.harness : undefined)
    if (!asked || !this.deps.harnesses().includes(asked))
      return this.refuse(op, "unknown-harness", `No harness named ${asked ?? "(none)"} runs here: ${this.deps.harnesses().join(", ")}.`)
    const own = this.tierOf(apex)
    const allowed = childAccess(own, input.access)
    if (!allowed) return this.refuse(op, "access", `A ${FIN_WORD} runs at most at its ${APEX_WORD}'s access: this Thread is on ${own}, so ${input.access} is refused.`)
    const fit = await this.fitAccess(apex, asked, allowed, own, input, ruled)
    if ("refused" in fit) return this.refuse(op, "access", fit.refused)
    // Without a limit reader there's nothing to wait for between these checks.
    const placed = this.deps.limited ? await this.roomFor(apex, fit.harness, allowed, input) : { harness: fit.harness }
    if ("refused" in placed) return this.refuse(op, "limited", placed.refused)
    const { harness, rerouted } = placed
    // A harness at its limit hands the Fin to one that offers what was asked, so a widened tier stays with its own harness.
    const fitted = harness === fit.harness ? fit : { harness, tier: allowed }
    const mode = childMode(this.deps.modes(harness), fitted.tier)
    if (!mode) return this.refuse(op, "access", `${this.deps.harnessLabel(harness)} runs on ${offered(this.deps.modes(harness))}, each above ${fitted.tier}, the most this ${FIN_WORD} may have. Start it on another harness.`)
    const tier = mode.tier
    const decided = await this.tuningOf(apex, harness, input, ruled)
    if ("refused" in decided) return this.refuse(op, "unknown-model", decided.refused)
    const note = [fitted.note, rerouted?.note, decided.note].filter(Boolean).join(" ")
    const tuned: Tuned = {
      ...decided,
      ...(note && { note }),
      ...(rerouted && { rerouted: rerouted.on }),
      ...(ruled && { rule: ruled.rule }),
    }
    const tree = this.rootOf(apex.thread)
    if ((input.after?.length ?? 0) > AFTER_LIMIT)
      return this.refuse(op, "conflict", `A start waits on at most ${AFTER_LIMIT} ${FIN_WORD}s; it names ${input.after!.length}. Name the last of a chain instead of each one.`)
    // What it starts after is read as the call made it; one of those that ends meanwhile is the queue's to tell (`tellHeld`).
    const after = this.afterOf(apex, input.after ?? [])
    if ("refused" in after) return this.refuse(op, after.refused, after.why)
    await Promise.all([this.readMac(), this.observe()])
    // From here to its place or its queue row nothing is awaited: every budget is checked and taken in one step, so two
    // starts deciding together never both take the last of one.
    if (start.cancelled) return this.refuse(op, "conflict", `Its ${APEX_WORD} stopped it before it started.`)
    // A queued spawn is one the tree has started (`treeCounts`): once the budget would refuse it, it never waits.
    const counts = this.treeCounts(tree)
    if (counts.started >= this.budget.started) {
      const queued = store.queuedSpawns().filter((spawn) => spawn.tree === tree && !store.edges().byOp(spawn.op)).length
      return this.refuse(op, "budget", `This tree started ${counts.started - queued} of its ${this.budget.started} Threads${queued ? ` and ${queued} more wait to` : ""}. Stop or finish some before starting more.`)
    }
    // It waits only as its Apex asked: for the Fins it starts after, or with `queue` for a place, behind every spawn that waits for one already.
    const where = placeOf(input.place)
    const working = this.working(where)
    const full = this.full(where)
    const waiting = this.waitingForRoom(where)
    const why = after.length ? undefined : counts.running >= this.budget.running ? "tree-running" : full || waiting > 0 ? "place-full" : undefined
    if (why && !input.queue)
      return this.refuse(op, "budget", why === "tree-running"
        ? `This tree runs ${counts.running} of its ${this.budget.running} Threads at once. Pass queue: true to start it when one ends.`
        : `${upper(full ?? `${working} ${FIN_WORD}s are at work here`)}${waiting ? ` and ${waiting} wait for one to end` : ""}.${this.elsewhere(where)} Pass queue: true to start it when one ends, or after: to start it after one of yours.`)
    if (why || after.length) {
      const record: QueuedStart = { lead: apex, input, tier, harness, tuned, ...(why && { why }), ...(after.length && { after }) }
      store.queueSpawn({ op, tree, record: JSON.stringify(record), at: this.now() })
      hostLog("agents", "start queued", { op, ...(why && { why }), ...(after.length && { after: after.map((ref) => ref.name).join(" ") }), running: counts.running, budget: this.budget.running, working, place: where })
      this.queueMoved([apex.thread], false)
      const answer = this.queuedAnswer(op, apex, false)
      // Its queue row stands for it now: the drain that takes the row makes it a record of its own.
      this.retire(start)
      void this.drain()
      return answer
    }
    // Its place, and its share of the tree's budgets, are its record's from the step that found them free.
    start.launching = { where, tree }
    return this.launch(op, { lead: apex, input, tier, harness, tuned }, start)
  }

  /**
   * The Fins a start names in `after`, the Apex's own or its spawns queued: those not finished yet, each once. One
   * that ended without finishing refuses the start now, so its Apex decides while it can.
   */
  private afterOf(apex: Apex, refs: readonly string[]): AfterRef[] | AgentRefused {
    const found = new Map<string, AfterRef>()
    for (const ref of refs) {
      const edge = this.resolve(apex, ref, false)
      if (edge) {
        const state = this.stateOf(edge)
        if (state.kind === "ended" && state.outcome !== "done")
          return { refused: "conflict", why: `${FIN_WORD} ${edge.name} ${state.outcome === "stopped" ? "was stopped" : "failed"}, so nothing starts after it: leave it out of after, or start it again first.` }
        if (state.kind !== "ended") found.set(edge.child, { name: edge.name, child: edge.child })
        continue
      }
      const name = finName(ref)
      const spawn = this.queuedOfApex(apex).find(({ spawn, queued }) => namedUuid(spawn.op) === ref || (queued.input.name ?? queued.input.title) === name)
      if (!spawn) return unknownFin(ref)
      found.set(spawn.spawn.op, { name: spawn.queued.input.name ?? spawn.queued.input.title ?? name, op: spawn.spawn.op })
    }
    return [...found.values()]
  }

  /** This Apex's spawns that wait, oldest first. */
  private queuedOfApex(apex: Pick<Apex, "thread">): { spawn: ReturnType<ThreadStore["queuedSpawns"]>[number]; queued: QueuedStart }[] {
    return (this.store()?.queuedSpawns() ?? []).flatMap((spawn) => {
      const queued = parseQueued(spawn.record)
      return queued?.lead.thread === apex.thread ? [{ spawn, queued }] : []
    })
  }

  /**
   * How a spawn's `after` stands now: a Fin done is finished; one failed or stopped, or a spawn of them that was
   * dropped or refused before it started, holds it; the rest it waits for.
   */
  private afterStand(queued: QueuedStart): AfterStand {
    const store = this.store()!
    const pending: string[] = []
    for (const ref of queued.after ?? []) {
      const edge = ref.child ? store.edges().of(ref.child) : ref.op ? store.edges().byOp(ref.op) : undefined
      if (!edge) {
        if (ref.op && store.queuedSpawns().some((spawn) => spawn.op === ref.op)) pending.push(ref.name)
        else return { pending, held: { name: ref.name, outcome: "stopped", reason: "it never started" } }
        continue
      }
      const state = this.stateOf(edge)
      if (state.kind === "ended" && state.outcome !== "done") {
        const session = store.thread(edge.child)?.sessions[0]
        return { pending, held: { name: edge.name, outcome: state.outcome, ...(state.reason && { reason: state.reason }), ...(session && { session }) } }
      }
      if (state.kind !== "ended") pending.push(edge.name)
    }
    return { pending }
  }

  /**
   * A spawn a Fin it was to start after didn't finish for: its Apex is told, to decide, and the spawn is dropped once
   * it heard (`AgentWakes`'s `delivered`). Told again by each host until then, under one id.
   */
  private tellHeld(op: string, queued: QueuedStart, held: NonNullable<AfterStand["held"]> | { refused: string }): void {
    const conversation = this.frontOf(queued.lead.thread, queued.lead.session)
    if (!conversation) return
    const name = queued.input.name ?? queued.input.title ?? "queued"
    const report: Report = {
      id: `${HELD_PREFIX}${op}`,
      child: ThreadIdSchema.parse(namedUuid(op)),
      status: "failed",
      summary: "refused" in held
        ? `It didn't start: ${held.refused.replace(/^It didn't start: /, "")} Start it again with agents_start if it should still run.`
        : `It didn't start: it was to start after ${held.name}, which ${held.outcome === "stopped" ? "was stopped" : "failed"}${held.reason ? ` (${held.reason})` : ""}. Start it again with agents_start, without after or after another ${FIN_WORD}, if it should still run.`,
      implicit: true,
      ownerGeneration: this.generation,
      at: this.now(),
    }
    this.wakes.notice(conversation, this.rootOf(queued.lead.thread), { id: `notice:${report.id}`, report, label: `"${name}" (${this.deps.harnessLabel(queued.harness)})`, fin: { name, harness: queued.harness }, from: ("session" in held && held.session) || queued.lead.session })
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
    if (input.scope === "crew") return this.crewOf(apex)
    if (input.scope === "apexes") return this.apexesOf(apex)
    const store = this.store()!
    const strips: AgentStrip[] = []
    const visit = (parent: string, under?: string) => {
      for (const edge of store.edges().children(parent)) {
        strips.push(this.strip(edge, under))
        if (input.scope === "tree") visit(edge.child, edge.name)
      }
      for (const { placeholder, queued } of this.heldFor(parent))
        strips.push({
          child: placeholder.child,
          name: placeholder.name,
          ...(under && { under }),
          harness: placeholder.asked.harness ?? this.harnessOf(placeholder),
          origin: placeholder.origin,
          state: { kind: "queued", ...queued },
          startedAt: placeholder.createdAt,
        })
    }
    visit(apex.thread)
    const counts = this.treeCounts(this.rootOf(apex.thread))
    return { children: strips, tree: { ...counts, of: { ...this.budget } } }
  }

  async read(caller: AgentCaller, input: AgentsReadInput): Promise<AgentsReadResult> {
    const apex = this.apexOf(caller)
    if ("refused" in apex) return apex
    const edge = this.resolve(apex, input.child, true)
    if (!edge) {
      const held = this.heldNamed(apex, input.child)
      if (!held) return unknownFin(input.child)
      const state: ChildState = { kind: "queued", ...held.queued }
      return { child: held.placeholder.child, name: held.placeholder.name, state, text: `Queued, not started yet: ${queuedWords(state)}. It has nothing to read until it starts.` }
    }
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
      ...(input.options?.length && { options: input.options.slice(0, ASK_OPTIONS).map((option) => ({ label: option.label.slice(0, 200), ...(option.detail && { detail: option.detail.slice(0, 600) }) })) }),
      ...(input.recommended !== undefined && input.recommended < (input.options?.length ?? 0) && { recommended: input.recommended }),
      ...(input.action && { action: input.action.slice(0, 400) }),
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
    if (input.to.startsWith(APEX_PREFIX)) return this.sendToApex(apex, input, began)
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
    const deliver = input.deliver ?? "queue"
    const sent = await this.deliver(edge, request, text, attachments, { kind: "agent", session: SessionIdSchema.parse(apex.session) }, deliver)
    if ("refused" in sent) return this.refuse(op, sent.refused, sent.why)
    const answer: AgentsSent = { child: edge.child, name: edge.name, request, delivery: sent.delivery, hears: sent.hears, ...(sent.deduped && { deduped: true as const }) }
    this.sent.set(op, answer)
    if (sent.delivery === "steer") this.steered.set(request, { text, attachments })
    if (input.forward) this.routes.forwarded += 1
    else this.routes.sent += 1
    hostLog("agents", "send", { op, child: edge.child, request, deliver, delivery: sent.delivery, forward: input.forward ?? false, ms: Math.round(performance.now() - began) })
    return answer
  }

  /**
   * A message to another of the person's Apexes: Mako's words, never the
   * person's, naming the Apex and Thread that sent it, after the other's turn
   * unless the sender steers it into a turn whose work is wrong. The turn that
   * answers it sends its reply back once, as the sender's wake
   * (`apexReplied`), which sends nothing on. At most `APEX_SENDS_PER_HOUR` go
   * from one Apex to another; a repeat of the key answers the first.
   */
  private async sendToApex(sender: Apex, input: AgentsSendInput, began: number): Promise<AgentsSendResult> {
    const op = `send:${sender.session}:${input.clientKey}`
    const kept = this.sent.get(op)
    if (kept) return { ...kept, deduped: true }
    const target = this.otherApexNamed(sender, input.to.slice(APEX_PREFIX.length))
    if ("refused" in target) return target
    const name = `${APEX_PREFIX}${target.title ?? target.thread}`
    const own = input.text?.trim()
    if (input.forward) return this.refuse(op, "conflict", `forward passes the person's message on to a ${FIN_WORD}: to another ${APEX_WORD}, write everything it needs as text.`)
    if (!own) return this.refuse(op, "conflict", "A message needs text.")
    if (input.deliver === "interrupt") return this.refuse(op, "conflict", `Another ${APEX_WORD}'s turn is its own to end: queue (the default), or steer when what it's doing now is wrong.`)
    const now = this.now()
    const pair = `${sender.thread}>${target.thread}`
    const recent = (this.apexSends.get(pair) ?? []).filter((at) => now - at < HOUR_MS)
    if (recent.length >= APEX_SENDS_PER_HOUR) {
      const minutes = Math.max(1, Math.ceil((recent[0]! + HOUR_MS - now) / 60_000))
      return this.refuse(op, "rate-limited", `${name} had ${APEX_SENDS_PER_HOUR} messages from this ${APEX_WORD} in the last hour; the next can go in ${minutes} min. agents_list with scope apexes says how it stands.`)
    }
    const conversation = target.conversation
    const ready = this.ready(conversation)
    if (ready === "gone") return this.refuse(op, "unavailable", `${name}'s conversation isn't on this device.`)
    const request = namedUuid(op)
    const senderTitle = this.store()!.thread(ThreadIdSchema.parse(sender.thread))?.title ?? (sender.conversation && this.deps.live.session(sender.conversation)?.title) ?? `Thread ${sender.thread}`
    const text = `${fromApex(senderTitle)}\n${apexNote(sender.thread)}\n\n${own}`
    const requests = [request]
    let sent: Delivered
    if (this.deps.live.held(conversation)?.requests.some((asked) => asked.id === request)) sent = { delivery: "queued", hears: `${name} already has it.`, deduped: true }
    else {
      this.deps.live.submit(conversation, request, text, [], undefined, undefined, undefined, { kind: "agent", session: SessionIdSchema.parse(sender.session) })
      const queued: Delivered = ready === "idle"
        ? { delivery: "turn", hears: `${name} takes it now, as its next turn.` }
        : { delivery: "queued", hears: `${name} hears it when its current turn ends, as its next message.` }
      sent = queued
      if (ready !== "idle" && input.deliver === "steer") {
        const running = this.deps.live.held(conversation)?.requests.find((asked) => asked.status === "dispatching")?.id
        const steered = await this.steerInto(conversation, name, request, text, [])
        if ("why" in steered) sent = { ...queued, hears: `${name} hears it when its current turn ends, as its next message: ${steered.why}` }
        else {
          sent = steered
          if (running) requests.push(running)
        }
      }
      recent.push(now)
      this.apexSends.set(pair, recent)
      const harness = this.deps.live.session(conversation)?.harness
      const ask: ApexAsk = { sender, conversation, requests, thread: target.thread, label: `"${target.title ?? target.thread}" (${harness ? this.deps.harnessLabel(harness) : APEX_WORD})`, fin: { name: target.title ?? target.thread, ...(harness && { harness }) } }
      for (const id of requests) this.apexAsks.set(`${conversation}:${id}`, ask)
    }
    const answer: AgentsSent = { child: target.thread, name, request, delivery: sent.delivery, hears: sent.hears, ...(sent.deduped && { deduped: true as const }) }
    this.sent.set(op, answer)
    hostLog("agents", "send apex", { op, to: target.thread, request, deliver: input.deliver ?? "queue", delivery: sent.delivery, ms: Math.round(performance.now() - began) })
    return answer
  }

  /**
   * An Apex answers what one of its Fins waits on, within its own access: the
   * person's access mode is the grant, so an Apex on full access answers its
   * Fins' approvals as the person would, and one on any mode answers their
   * questions, which grant nothing. Or it leaves the ask to the person.
   */
  async answer(caller: AgentCaller, input: AgentsAnswerInput): Promise<AgentsAnswerResult> {
    const began = performance.now()
    const apex = this.apexOf(caller)
    if ("refused" in apex) return apex
    const edge = this.resolve(apex, input.to, false)
    if (!edge) return unknownFin(input.to)
    const op = `answer:${apex.session}:${input.clientKey}`
    const kept = this.answers.get(op)
    if (kept) return { ...kept, deduped: true }
    const answered = await this.answerOnce({ kind: "apex", apex }, edge, op, input)
    const ms = Math.round(performance.now() - began)
    if ("refused" in answered) {
      if (answered.refused === "access") this.answerCounts.refused += 1
      hostLog("agents", "answer refused", { op, child: edge.child, refused: answered.refused, ms })
      return answered
    }
    this.answers.set(op, answered)
    this.answerCounts[answered.answered === "person" ? "passed" : "apex"] += 1
    hostLog("agents", "answer", { op, child: edge.child, answered: answered.answered, ...(answered.delivery && { delivery: answered.delivery }), ms })
    return answered
  }

  /**
   * The person answering one of an Apex's Fins from the Apex's Thread, on any
   * device: theirs to answer whatever the Apex's access, as its own Thread's
   * ask would be, and as their own words.
   */
  async respond(conversation: string, input: AgentsRespondInput): Promise<AgentsAnswerResult> {
    const began = performance.now()
    const placed = this.store()?.journalPlacement(conversation)
    if (!placed) return { refused: "unavailable", why: "That conversation isn't a Thread here." }
    const edge = this.resolve({ session: placed.session, thread: placed.thread, conversation }, input.fin, true)
    if (!edge) return unknownFin(input.fin)
    const op = `respond:${input.request}`
    const kept = this.answers.get(op)
    if (kept) return { ...kept, deduped: true }
    const state = this.stateOf(edge)
    const ask = state.kind === "blocked" ? state.ask : undefined
    const picked = input.option === undefined ? undefined : ask?.options?.[input.option]?.label
    const answered: AgentsAnswerResult = !ask || ask.id !== input.ask
      ? { refused: "conflict", why: `${edge.name} no longer waits on that: it was answered.` }
      : input.option !== undefined && !picked
        ? { refused: "conflict", why: `That isn't one of ${edge.name}'s options.` }
        : await this.answerOnce({ kind: "person" }, edge, op, { ...((picked ?? input.answer) && { answer: picked ?? input.answer }), ...(input.allow !== undefined && { allow: input.allow }) })
    const ms = Math.round(performance.now() - began)
    if ("refused" in answered) {
      hostLog("agents", "respond refused", { op, child: edge.child, refused: answered.refused, ms })
      return answered
    }
    this.answers.set(op, answered)
    this.answerCounts.person += 1
    hostLog("agents", "respond", { op, child: edge.child, answered: answered.answered, ...(answered.delivery && { delivery: answered.delivery }), ms })
    return answered
  }

  /**
   * What the person's row for `conversation` waits on of its Fins: the first
   * ask anywhere under its Thread that is theirs, and how many more wait
   * behind it. Only the Session they last wrote in says it.
   */
  personAsk(conversation: string): { fin: ThreadId; name: string; line: string; ask: FinAsk; more: number } | undefined {
    const store = this.store()
    const placed = store?.journalPlacement(conversation)
    if (!store || !placed || !store.edges().children(placed.thread).length) return undefined
    if (this.frontOf(placed.thread, placed.session) !== conversation) return undefined
    const asks: { edge: ThreadParent; question: string; ask: FinAsk }[] = []
    const look = (thread: string, depth: number) => {
      for (const edge of store.edges().children(thread)) {
        const state = this.stateOf(edge)
        if (state.kind === "blocked" && state.on !== "lead" && state.ask) asks.push({ edge, question: state.question, ask: state.ask })
        if (depth < 64) look(edge.child, depth + 1)
      }
    }
    look(placed.thread, 0)
    const first = asks[0]
    if (!first) return undefined
    // A harness's own ask in its words; the reason it's the person's is the Agents panel's to say.
    const finConversation = first.ask.kind === "report" ? undefined : this.conversationOf(first.edge.child)
    const line = (finConversation && this.deps.live.waitingOn(finConversation)?.line) || first.question
    return { fin: first.edge.child, name: first.edge.name, line, ask: first.ask, more: asks.length - 1 }
  }

  private async answerOnce(by: Answerer, edge: ThreadParent, op: string, input: Pick<AgentsAnswerInput, "answer" | "allow" | "person">): Promise<AgentsAnswered | AgentRefused> {
    const state = this.stateOf(edge)
    if (state.kind !== "blocked" || !state.ask)
      return { refused: "conflict", why: `${edge.name} isn't waiting on a question or an approval: agents_send gives it a message.` }
    const { ask } = state
    const done = (answered: AgentsAnswered["answered"], delivery?: FinDelivery): AgentsAnswered => ({ child: edge.child, name: edge.name, answered, ...(delivery && { delivery }) })
    if (input.person) {
      this.passToPerson(edge, ask, state.question)
      return done("person")
    }
    if (ask.kind === "report") {
      const words = input.answer?.trim()
      if (!words) return { refused: "conflict", why: "Its question needs an answer: one of its options by its label, or your own words." }
      const picked = ask.options?.find((option) => sameWords(option.label, words))
      const answer = answerText(state.question, picked?.label ?? words)
      const sent = by.kind === "apex"
        ? await this.deliver(edge, namedUuid(op), `${fromAgent(YOUR_APEX)}\n${answer}`, [], { kind: "agent", session: SessionIdSchema.parse(by.apex.session) }, "steer")
        : await this.deliver(edge, namedUuid(op), answer, [], undefined, "steer")
      return "refused" in sent ? sent : done("report", sent.delivery)
    }
    const tier = by.kind === "apex" ? this.tierOf(by.apex) : "full"
    if (ask.kind === "approval" && tier !== "full")
      return { refused: "access", why: `${edge.name}'s approval is the person's: this Thread is on ${tier}, and only an ${APEX_WORD} on full access answers its ${FIN_WORD}s' approvals. Leave it to them with person: true.` }
    const conversation = this.conversationOf(edge.child)
    const pending = conversation ? this.deps.live.pendingAsk(conversation) : undefined
    if (!conversation || !pending || pending.request !== ask.id) return { refused: "conflict", why: `${edge.name} no longer waits on that: it was answered.` }
    if (pending.gone) return { refused: "unavailable", why: `${edge.name}'s harness exited while it waited, so no answer reaches it: agents_send gives it a message to go on.` }
    const response = permissionAnswer(pending, input)
    if ("refused" in response) return response
    try {
      await this.deps.live.permission(conversation, pending.request, response)
    } catch (error) {
      return { refused: "unavailable", why: `${edge.name}'s harness didn't take the answer: ${errorMessage({ error })}` }
    }
    return done(ask.kind)
  }

  /** The Apex leaves a Fin's ask to the person: a report on the Fin that no Apex hears, with the ask's options. */
  private passToPerson(edge: ThreadParent, ask: FinAsk, question: string): void {
    const from = ask.kind === "report" ? this.latest.get(edge.child) : undefined
    this.keepReport(edge, {
      id: passedId(edge.child, ask.id),
      child: ThreadIdSchema.parse(edge.child),
      status: "needs-input",
      summary: from?.summary ?? `It waits: ${question}`,
      question: from?.question ?? question,
      ...(ask.options && { options: ask.options }),
      ...(ask.recommended !== undefined && { recommended: ask.recommended }),
      ...(ask.action && { action: ask.action }),
      for: "person",
      implicit: true,
      ownerGeneration: this.generation,
      at: this.now(),
    })
  }

  async stop(caller: AgentCaller, input: AgentsStopInput): Promise<AgentsStopResult> {
    const apex = this.apexOf(caller)
    if ("refused" in apex) return apex
    const store = this.store()!
    const why = input.reason ?? `its ${APEX_WORD} stopped it`
    const one = input.child === "all" ? undefined : this.resolve(apex, input.child, false)
    if (input.child !== "all" && !one) {
      const name = finName(input.child)
      const under = [...this.starts.values()].find((start) => start.thread === apex.thread && (start.name === name || (!start.name && start.asked === name) || namedUuid(start.op) === input.child))
      const waiting = this.queuedOfApex(apex).find(({ spawn, queued }) => namedUuid(spawn.op) === input.child || (queued.input.name ?? queued.input.title) === name || spawn.op === under?.op)
      if (!waiting && !under) return unknownFin(input.child)
      // One under way writes no edge, or ends at once if it wrote one: a stop is never undone by its start.
      if (under) this.cancel(under)
      if (waiting) this.store()?.unqueueSpawn(waiting.spawn.op)
      // Its Apex's conversations hear it go, and every other Apex's held Fins move up the line.
      this.queueMoved([apex.thread, ...this.holdingThreads()], false)
      hostLog("agents", "end", { op: waiting?.spawn.op ?? under!.op, outcome: "stopped", queued: true, ...(under && { underWay: true }) })
      // What was to start after it is its Apex's to decide now.
      void this.drain()
      return { stopped: [under?.name ?? under?.asked ?? waiting?.queued.input.name ?? waiting?.queued.input.title ?? name] }
    }
    const targets = one ? [one] : store.edges().children(apex.thread)
    const stopped = new Set<string>()
    // What waits and what's under way go first, so an end below doesn't start it.
    if (input.child === "all") {
      for (const start of this.starts.values()) {
        if (start.thread !== apex.thread) continue
        this.cancel(start)
        stopped.add(start.name ?? start.asked ?? start.op)
      }
      for (const spawn of store.queuedSpawns()) {
        const queued = parseQueued(spawn.record)
        if (queued?.lead.thread !== apex.thread) continue
        store.unqueueSpawn(spawn.op)
        if (!this.starts.has(spawn.op)) stopped.add(queued.input.name ?? queued.input.title ?? spawn.op)
        hostLog("agents", "end", { op: spawn.op, outcome: "stopped", queued: true })
      }
    }
    for (const edge of targets) if (await this.end(edge, why)) stopped.add(edge.name)
    this.queueMoved([apex.thread, ...this.holdingThreads()], false)
    return { stopped: [...stopped] }
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
    if (!store) return { fins: 0, running: 0, followed: 0, queued: 0, notices: 0, budget: this.budget, trees: [], routes: { ...this.routes }, answers: { ...this.answerCounts } }
    const edges = store.edges()
    const roots = new Set([...edges.all.map((edge) => this.rootOf(edge.parent)), ...store.queuedSpawns().map((spawn) => spawn.tree), ...[...this.starts.values()].flatMap((start) => (start.launching ? [start.launching.tree] : []))])
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
      answers: { ...this.answerCounts },
    }
  }

  dispose(): void {
    this.stopped = true
    this.stopRoomWatch()
    for (const timer of this.unanswered.values()) clearTimeout(timer)
    this.unanswered.clear()
    this.runs.dispose()
    this.wakes.dispose()
    for (const wake of this.waiters) wake()
    for (const hold of this.holds) hold.end()
  }

  // ── Starting ──

  /**
   * Starts a Fin for its record: its name, taken now beside every other record's of its Apex and every written edge,
   * is the record's until the record settles, so two launching side by side never take one.
   */
  private async launch(op: string, queued: QueuedStart, start: StartRecord): Promise<AgentsStartResult> {
    const store = this.store()!
    const { lead: apex, input, tier, harness } = queued
    const began = performance.now()
    const others = [...this.starts.values()].flatMap((other) => (other !== start && other.thread === apex.thread && other.name ? [other.name] : []))
    const name = uniqueName(input.name ?? input.title ?? input.brief.objective, new Set([...store.edges().children(apex.thread).map((edge) => edge.name), ...others]))
    start.name = name
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
        ...(input.fast !== undefined && { fast: input.fast }),
        ...(input.rule !== undefined && { rule: input.rule }),
        access: tier,
        ...(input.place && { place: input.place }),
        ...(input.workspace && { workspace: input.workspace }),
        ...(input.mode && { mode: input.mode }),
        ...(input.wake && { wake: input.wake }),
      },
      op,
      startedBy: { kind: "agent", session: SessionIdSchema.parse(apex.session) },
    }
    const decided = queued.tuned ?? await this.tuningOf(apex, harness, input)
    if ("refused" in decided) return this.refuse(op, "unknown-model", decided.refused)
    parent.tuned = { source: decided.source, ...(decided.note && { note: decided.note }), ...(decided.rerouted && { rerouted: decided.rerouted }), ...(decided.rule && { rule: decided.rule }) }
    const tuning = decided.settings
    const workspace = input.workspace
    const options: LiveStartOptions = {
      conversationId,
      // An Apex of its own starts Fins too: it reads the person's rules with its brief.
      initialRequest: { id: namedUuid(`${op}\nbrief`), text: [briefText(input.brief, name), ...(input.role === APEX_ROLE ? [this.policyLines().join("\n")] : [])].filter(Boolean).join("\n\n"), attachments: [] },
      title: input.title ?? name,
      modeId: childMode(this.deps.modes(harness), tier)?.id ?? accessModeId(tier),
      ...(tuning && { tuning }),
      ...(workspace && {
        worktree: true,
        ...(workspace.branch ? { worktreeStart: { kind: "branch" as const, branch: workspace.branch } } : workspace.base ? { worktreeStart: { kind: "from" as const, ref: workspace.base } } : {}),
      }),
      parent,
    }
    if (start.cancelled) return this.refuse(op, "conflict", `Its ${APEX_WORD} stopped it before it started.`)
    this.starting.add(op)
    this.forget(apex.thread)
    try {
      await this.deps.startLive(harness, cwd, options)
    } catch (error) {
      if (!store.edges().byOp(op)) {
        this.starting.delete(op)
        this.forget(apex.thread)
        if (start.cancelled) return this.refuse(op, "conflict", `Its ${APEX_WORD} stopped it before it started.`)
        return this.refuse(op, "unavailable", `It didn't start: ${errorMessage({ error })}`)
      }
      hostWarn("agents", "a Fin's start failed after its edge was written; it shows as failed", { op, error: errorMessage({ error }) })
    } finally {
      this.starting.delete(op)
    }
    const edge = store.edges().byOp(op)
    if (!edge) return this.refuse(op, "unavailable", `Its Thread was made without its edge; it was not started as a ${FIN_WORD}.`)
    // Stopped while its edge was being written: it ends now, as a stop would have.
    if (start.cancelled) {
      await this.end(edge, `its ${APEX_WORD} stopped it before it started`)
      return this.started(edge, apex, false)
    }
    this.conversations.set(edge.child, conversationId)
    this.childOf.set(conversationId, edge.child)
    hostLog("agents", "start admitted", { op, child: edge.child, harness, access: tier, ms: Math.round(performance.now() - began) })
    this.childMoved(edge, false)
    return this.started(edge, apex, false)
  }

  /**
   * What a Fin runs on (`resolveFinTuning`): what the spawn named, held to its
   * harness's catalog, else what the person uses there. The Apex's own model
   * counts only on the Apex's harness. Its folder doesn't change the catalog,
   * so the Apex's is read.
   */
  private async tuningOf(apex: Apex, harness: string, input: AgentsStartInput, ruled?: Ruled): Promise<Tuned | { refused: string }> {
    const cwd = input.cwd ?? (apex.conversation ? this.deps.live.session(apex.conversation)?.cwd : undefined)
    const choices: FinChoices = (cwd && await this.deps.finChoices?.(harness, cwd).catch((error) => {
      hostWarn("agents", "a Fin's catalog couldn't be read; its choice isn't held to it", { harness, error: errorMessage({ error }) })
      return undefined
    })) || { models: [] }
    const apexSettings = apex.conversation && this.deps.live.session(apex.conversation)?.harness === harness ? this.settingsOf(apex.conversation) : undefined
    const decided = resolveFinTuning({
      label: this.deps.harnessLabel(harness),
      models: choices.models,
      asked: { ...(input.model && { model: input.model }), ...(input.reasoning && { reasoning: input.reasoning }), ...(input.fast !== undefined && { fast: input.fast }) },
      // A rule's model is for its own harness: one named instead, or a harness at its limit, runs on its own choices.
      ...(ruled?.target.settings && ruled.target.harness === harness && { rule: { who: ruled.who, settings: ruled.target.settings } }),
      ...(choices.chosen && { chosen: choices.chosen }),
      ...(apexSettings && { apex: apexSettings }),
      ...(choices.used && { used: choices.used }),
      ...(choices.recommended && { recommended: choices.recommended }),
    })
    if ("refused" in decided) return decided
    const note = decided.notes.join(" ")
    hostLog("agents", "a Fin's model decided", { harness, source: decided.source, ...(decided.settings?.model && { model: decided.settings.model }), ...(note && { passedOver: true }) })
    return { ...(decided.settings && { settings: decided.settings }), source: decided.source, ...(note && { note }) }
  }

  /**
   * Where a Fin can run when `asked`'s account is at its limit: a start that named no harness or model goes to the
   * person's next harness (`harnessOrder`) that runs here at this access, is signed in and has room, and says so; one
   * that named it, or with nowhere to go, is refused with when the limit resets and what the person can do instead.
   * A limit that can't be read in `LIMIT_READ_MS` reads as room.
   */
  private async roomFor(apex: Apex, asked: string, tier: AccessTier, input: AgentsStartInput): Promise<{ harness: string; rerouted?: { note: string; on: NonNullable<Tuned["rerouted"]> } } | { refused: string }> {
    const limit = await this.limitOf(asked)
    if (!limit) return { harness: asked }
    const label = this.deps.harnessLabel(asked)
    const until = limit.until ?? undefined
    const now = this.now()
    const spent = `${label} is at its limit on ${limit.account}${until === undefined ? "" : ` until ${resetWords(until, now)}`}`
    const switchTo = limit.instead ? `${limit.instead}, another ${label} account, has room: the person can switch to it in Settings › Agents.` : ""
    const next = await this.nextHarness(asked, tier, input.cwd ?? (apex.conversation ? this.deps.live.session(apex.conversation)?.cwd : undefined))
    if (input.harness !== undefined || input.model !== undefined || !next) {
      const elsewhere = next ? `Leave harness and model out to start it on ${this.deps.harnessLabel(next)}, the person's next harness, or name another.` : "No other harness here has room either."
      return { refused: [`${spent}, so a ${FIN_WORD} there would stop at once.`, switchTo, elsewhere, until === undefined ? "" : "Or wait for the reset and start it then."].filter(Boolean).join(" ") }
    }
    hostLog("agents", "a Fin's harness is at its limit; it starts on the next", { from: asked, to: next, ...(until !== undefined && { until }) })
    return {
      harness: next,
      rerouted: {
        note: [`${spent}, so it runs on ${this.deps.harnessLabel(next)}, the person's next harness.`, switchTo].filter(Boolean).join(" "),
        on: { from: asked, ...(until !== undefined && { until }), ...(limit.instead && { instead: limit.instead }) },
      },
    }
  }

  /**
   * Where a Fin asked on `allowed` runs when `asked` offers no mode at or below
   * it, as Cursor offers only full: a start that named no harness, model or
   * rule goes to the person's next harness that offers `allowed`; otherwise,
   * or with none, it runs on `asked`'s least mode above `allowed` within its
   * Apex's own access (`modeWithin`). The start's note says which. Refused
   * only when every mode of the harness is wider than the Apex's own.
   */
  private async fitAccess(apex: Apex, asked: string, allowed: AccessTier, own: AccessTier, input: AgentsStartInput, ruled: Ruled | undefined): Promise<{ harness: string; tier: AccessTier; note?: string } | { refused: string }> {
    const modes = this.deps.modes(asked)
    if (childMode(modes, allowed)) return { harness: asked, tier: allowed }
    const label = this.deps.harnessLabel(asked)
    const offers = offered(modes)
    if (input.harness === undefined && input.model === undefined && !ruled) {
      const next = await this.nextHarness(asked, allowed, input.cwd ?? (apex.conversation ? this.deps.live.session(apex.conversation)?.cwd : undefined))
      if (next) {
        hostLog("agents", "a Fin's harness runs above its access; it starts on the next", { from: asked, to: next, access: allowed })
        return { harness: next, tier: allowed, note: `${label} runs only on ${offers}, above the ${allowed} it was asked on, so it runs on ${this.deps.harnessLabel(next)}, the person's next harness, on ${allowed}.` }
      }
    }
    const wider = modeWithin(modes, allowed, own)
    if (wider) {
      hostLog("agents", "a Fin's harness runs above its access; it runs on the harness's nearest", { harness: asked, asked: allowed, access: wider.tier })
      return { harness: asked, tier: wider.tier, note: `${label} runs only on ${offers}, so it runs on ${wider.tier} rather than the ${allowed} it was asked on, within this Thread's own ${own}.` }
    }
    return { refused: `${label} runs on ${offers}, each above ${allowed} and above this Thread's own ${own}, so a ${FIN_WORD} there would have more access than you. Name a harness that runs on ${allowed}, or leave harness out for the person's next one.` }
  }

  /** The first harness after `from` in the person's order that a Fin at `tier` can run on now. */
  private async nextHarness(from: string, tier: AccessTier, cwd: string | undefined): Promise<string | undefined> {
    const live = this.deps.harnesses()
    const order = (await this.deps.harnessOrder?.().catch(() => undefined)) ?? live
    for (const harness of [...order, ...live]) {
      if (harness === from || !live.includes(harness) || !childMode(this.deps.modes(harness), tier)) continue
      const signedIn = cwd ? ((await this.deps.finChoices?.(harness, cwd).catch(() => undefined))?.models.length ?? 0) > 0 : true
      if (signedIn && !(await this.limitOf(harness))) return harness
    }
    return undefined
  }

  private async limitOf(harness: string): Promise<HarnessLimit | undefined> {
    if (!this.deps.limited) return undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<undefined>((done) => { timer = setTimeout(() => done(undefined), LIMIT_READ_MS) })
    try {
      return await Promise.race([this.deps.limited(harness).catch((error) => {
        hostWarn("agents", "a harness's limit couldn't be read; it's taken as having room", { harness, error: errorMessage({ error }) })
        return undefined
      }), late])
    } finally {
      clearTimeout(timer)
    }
  }

  /** The model a conversation runs on now: the person's last choice in it, else what its harness reported, else what it started with. */
  private settingsOf(conversation: string): SessionSettings | undefined {
    const snapshot = this.deps.live.snapshot(conversation)
    if (!snapshot) return undefined
    const chosen = snapshot.requests.filter((request) => request.tuning?.model).at(-1)?.tuning
    const binding = snapshot.control?.bindings.find((candidate) => candidate.id === snapshot.control?.activeBindingId)
    return chosen ?? snapshot.session.settings ?? binding?.tuning
  }

  /**
   * Starts what waits, oldest first: each once the Fins it starts after finished, while its tree's budget and the
   * person's limit have room. One a Fin it was to start after didn't finish for is its Apex's to decide (`tellHeld`).
   */
  private async drain(): Promise<void> {
    const store = this.store()
    if (!store || this.stopped) return
    // An end during a drain is looked at by another, after it: a Fin that was to start after it doesn't wait for the watch.
    if (this.draining) return void (this.drainAgain = true)
    this.draining = true
    try {
      // Each place's own room: a device's count, or the cloud's plan and spend.
      // Counted once as the drain begins, plus what it starts: a Fin it launched isn't counted again as it comes up.
      const filled = new Map<string, number>()
      const working = new Map<string, number>()
      let totalStarted = 0
      const everywhere = this.workingEverywhere()
      for (const spawn of store.queuedSpawns()) {
        if (this.starts.has(spawn.op)) continue
        const queued = parseQueued(spawn.record)
        if (queued?.refused) {
          this.tellHeld(spawn.op, queued, { refused: queued.refused })
          continue
        }
        if (queued?.after?.length) {
          const stand = this.afterStand(queued)
          if (stand.held) this.tellHeld(spawn.op, queued, stand.held)
          if (stand.held || stand.pending.length) continue
        }
        const counts = this.treeCounts(spawn.tree)
        if (counts.running >= this.budget.running) continue
        // First come, first started: once a place is full, a later spawn of another tree doesn't go ahead of this one there.
        const where = placeOf(queued?.input.place)
        const started = filled.get(where) ?? 0
        if (!working.has(where)) working.set(where, this.working(where))
        if (this.overCeiling(everywhere + totalStarted) ?? placeFull(this.placeLimit(where), working.get(where)! + started)) continue
        totalStarted += 1
        filled.set(where, started + 1)
        // Taken off the queue once it started, or was refused: a host that dies between starts it again, as the same Fin.
        if (!queued || store.edges().byOp(spawn.op)) {
          store.unqueueSpawn(spawn.op)
          continue
        }
        hostLog("agents", "start released", { op: spawn.op, waitedMs: this.now() - spawn.at, ...(queued.after?.length && { after: queued.after.map((ref) => ref.name).join(" ") }) })
        // Each starts on its own record: one whose harness is slow to come up holds its place, never the queue behind it.
        const start = this.record(spawn.op, queued.lead.thread, queued.input.name ?? queued.input.title)
        start.launching = { where, tree: spawn.tree }
        start.answer = this.launch(spawn.op, queued, start)
        void start.answer
          .then((answer) => ("refused" in answer ? answer.why : undefined), (error: Error) => `It didn't start: ${errorMessage({ error })}`)
          .then((refused) => {
            // A host shutting down leaves the row as it stands: the next host takes it from the store.
            if (this.stopped) return void this.retire(start)
            // One its Apex stopped is gone; one that couldn't start stays, saying why, until its Apex has heard (`tellHeld`).
            if (refused && !start.cancelled && store.queuedSpawns().some((each) => each.op === spawn.op)) {
              hostWarn("agents", "a queued start couldn't start; its Apex is told", { op: spawn.op, why: refused })
              store.keepQueuedSpawn(spawn.op, JSON.stringify({ ...queued, refused: refused.slice(0, 2000) } satisfies QueuedStart))
            } else store.unqueueSpawn(spawn.op)
            // Its Apex hears it start or say why it couldn't; those still held moved up the line, their places, not their kind.
            this.queueMoved([queued.lead.thread], false)
            this.queueMoved(this.holdingThreads().filter((thread) => thread !== queued.lead.thread), true)
            // Its row is settled first, so the drain its place wakes sees it as it now stands.
            this.retire(start)
          })
      }
    } catch (error) {
      hostWarn("agents", "queued starts could not be released; they wait for the next end", { error: errorMessage({ error }) })
    } finally {
      this.draining = false
      if (this.drainAgain) {
        this.drainAgain = false
        void this.drain()
      }
    }
  }

  private started(edge: ThreadParent, apex: Apex, deduped: boolean): AgentsStarted {
    const state = this.stateOf(edge)
    const counts = this.treeCounts(this.rootOf(apex.thread))
    const conversation = this.conversationOf(edge.child)
    const reading = this.childReading(edge)
    const runsOn = reading.runsOn ? finTuningLine(reading.runsOn) : reading.model
    return {
      child: edge.child,
      name: edge.name,
      ...(conversation && { conversation }),
      state: state.kind,
      ...(runsOn && { runsOn }),
      ...(edge.tuned?.note && { note: edge.tuned.note }),
      ...(edge.tuned?.rule && { rule: ruleWords(edge.tuned.rule) }),
      ...(edge.tuned?.rerouted && { limited: { harness: edge.tuned.rerouted.from, ...(edge.tuned.rerouted.until !== undefined && { until: edge.tuned.rerouted.until }), ...(edge.tuned.rerouted.instead && { instead: edge.tuned.rerouted.instead }) } }),
      tree: { ...counts, of: { ...this.budget } },
      ...this.placeWords(),
      ...(deduped && { deduped: true as const }),
      next: afterStart(edge.asked.wake ?? "decisions"),
    }
  }

  /** This device's limit as it stands, and its load while it's busy, as every start's answer carries them. */
  private placeWords(): Pick<AgentsStarted, "atOnce" | "mac"> {
    const limit = this.placeLimit(HERE)
    return {
      ...(limit.place === "device" && { atOnce: { working: this.working(HERE), of: limit.atOnce } }),
      ...this.mac?.busy && { mac: `This Mac is busy (${this.mac.why}): it starts anyway, so run builds and test suites one at a time.` },
    }
  }

  private queuedAnswer(op: string, apex: Apex, deduped: boolean): AgentsStarted {
    const store = this.store()!
    const tree = this.rootOf(apex.thread)
    const queue = store.queuedSpawns().filter((spawn) => spawn.tree === tree)
    const queued = parseQueued(queue.find((spawn) => spawn.op === op)?.record ?? "")
    const counts = this.treeCounts(tree)
    const forRoom = queued?.why === "place-full"
    const where = placeOf(queued?.input.place)
    const forTheLimit = store.queuedSpawns().filter((spawn) => { const other = parseQueued(spawn.record); return other?.why === "place-full" && placeOf(other.input.place) === where })
    const ahead = Math.max(0, (forRoom ? forTheLimit : queue).findIndex((spawn) => spawn.op === op))
    const stand = queued?.after?.length ? this.afterStand(queued) : undefined
    const pending = stand?.pending ?? []
    return {
      name: queued?.input.name ?? queued?.input.title ?? "queued",
      state: "queued",
      why: stand?.held
        ? `It won't start: ${stand.held.name} ${stand.held.outcome === "stopped" ? "was stopped" : "failed"}, and you're told to decide.`
        : pending.length
          ? `It starts once ${pending.join(", ")} ${pending.length === 1 ? "finishes" : "finish"}; if one fails or is stopped it doesn't start, and you're woken to decide.`
          : forRoom
            ? `${upper(this.full(where) ?? "A place is free now")}; it starts when one ends (${ahead} ahead).`
            : `This tree runs ${counts.running} of its ${this.budget.running} at once; it starts when one ends (${ahead} ahead).`,
      ...(pending.length && { after: pending }),
      tree: { ...counts, of: { ...this.budget } },
      ...this.placeWords(),
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
    const waits = ended.status === "completed" ? this.waitsOn(edge, conversation) : undefined
    if (waits) {
      this.awaiting.set(edge.child, { conversation, request })
      hostLog("agents", "turn ended waiting", { op: edge.op, child: edge.child, on: waits })
      return this.childMoved(edge, false)
    }
    this.awaiting.delete(edge.child)
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

  /**
   * What a Fin whose turn ended still waits on, in words: its own Fins at
   * work or waiting, their reports still on their way to it, or the move into
   * its worktree it asked for, after which it carries on there. Its turn's end
   * isn't its result while any holds.
   */
  private waitsOn(edge: ThreadParent, conversation: string): string | undefined {
    const own = this.store()!.edges().children(edge.child).filter((child) => !child.closedAt && WAITED_ON.has(this.stateOf(child).kind))
    const parts: string[] = []
    if (own.length === 1) parts.push(`its ${FIN_WORD} ${own[0]!.name}`)
    else if (own.length) parts.push(`its ${own.length} ${FIN_WORD}s (${own.map((child) => child.name).join(", ")})`)
    if (!own.length && this.wakes.waits(conversation)) parts.push(`what its ${FIN_WORD}s reported, which comes to it next`)
    if (this.deps.movePending?.(conversation)) parts.push("its move into its own worktree")
    return parts.length ? parts.join(" and ") : undefined
  }

  /**
   * A Fin whose turn ended waiting: once it waits on nothing, isn't at work
   * and has no digest coming, that turn's reply is its result. One its Fins'
   * reports wake reports when that turn ends instead.
   */
  private checkAwaiting(edge: ThreadParent): void {
    const held = this.awaiting.get(edge.child)
    if (!held || edge.closedAt !== undefined) return
    if (this.ready(held.conversation) !== "idle" || this.wakes.waits(held.conversation) || this.waitsOn(edge, held.conversation)) return
    this.awaiting.delete(edge.child)
    this.turnEnded(edge, held.conversation, held.request)
  }

  /** A run Mako stopped outlived its kill: its Fin's row says so (`stuckWords`), and it keeps its place. */
  private runStuck(edge: ThreadParent): void {
    this.childMoved(this.store()?.edges().of(edge.child) ?? edge, false)
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
    const notice = this.noticeFor(edge, report, wake)
    if (!notice) return
    const conversation = this.frontOf(edge.parent, edge.parentSession)
    if (conversation) return this.wakes.notice(conversation, this.rootOf(edge.parent), notice)
    // An Apex whose turns a process Mako didn't start runs: the report waits unheard in the store until that process ends.
    const apex = this.store()!.edges().of(edge.parent)
    if (!apex?.run) return
    if (apex.run.ended) return void this.release(apex)
    hostLog("agents", "message held", { notice: notice.id, until: "its process exits" })
  }

  /** What a report is to its Apex: a notice, or nothing, and heard, when its route sends it elsewhere. */
  private noticeFor(edge: ThreadParent, report: Report, wake?: string): Notice | undefined {
    const store = this.store()!
    const route = report.for === "person" ? (report.told ? "apex" : "person") : reportRoute(edge.asked, report.status)
    if (route !== "apex") {
      store.markReportsDelivered([report.id], this.now())
      hostLog("agents", "report kept", { op: edge.op, report: report.id, status: report.status, to: route, wake: edge.asked.wake ?? "decisions" })
      return undefined
    }
    return {
      id: `notice:${edge.child}:${report.id}`,
      report,
      label: `"${edge.name}" (${this.deps.harnessLabel(this.harnessOf(edge))})`,
      fin: { name: edge.name, harness: this.harnessOf(edge) },
      from: store.thread(edge.child)?.sessions[0] ?? edge.parentSession,
      ...(wake && { wake }),
      ...(edge.asked.mode === "wait" && (report.status === "done" || report.status === "failed") && { settledOnly: true as const }),
    }
  }

  /**
   * A Fin that is an Apex of its own ended its process: its conversation opens
   * on Mako's live driver, and the reports its Fins left unheard wake it there
   * as any Apex's do. They're read from the store, so a process that ended
   * while no host ran is heard from the next one.
   */
  private async release(edge: ThreadParent): Promise<void> {
    const run = edge.run
    const store = this.store()
    if (!store || !run?.nativeId || this.releasing.has(edge.child)) return
    const edges = store.edges()
    const notices = store.undeliveredReports().flatMap(({ report, wake }) => {
      const child = edges.of(report.child)
      const notice = child?.parent === edge.child && report.status !== "progress" ? this.noticeFor(child, report, wake) : undefined
      return notice ? [notice] : []
    })
    if (!notices.length) return
    const path = this.deps.catalog.nativePath({ harness: run.harness, nativeId: run.nativeId })
    const ref = path ? this.deps.catalog.ref(path) : undefined
    if (!path || !ref?.cwd) {
      hostWarn("agents", "a held message has no session to resume; it waits unheard", { child: edge.child, notices: notices.length })
      return
    }
    const conversationId = namedUuid(`resume:${edge.child}:${run.nativeId}`)
    this.releasing.add(edge.child)
    try {
      await this.deps.startLive(run.harness, ref.cwd, { conversationId, resume: run.nativeId, threadPath: path })
      hostLog("agents", "held message released", { child: edge.child, notices: notices.length, conversation: conversationId })
      for (const notice of notices) this.wakes.notice(conversationId, this.rootOf(edge.child), notice)
    } catch (error) {
      hostWarn("agents", "a held message could not start its turn; it waits for the next start", { child: edge.child, error: errorMessage({ error }) })
    } finally {
      this.releasing.delete(edge.child)
    }
  }

  /**
   * Stops a Fin, once: its running turn, or its process group. The delegation
   * closes first, with why, so the turn the stop cuts short ends as stopped
   * rather than as a failure that wakes the Apex, which asked for it.
   */
  private async end(edge: ThreadParent, why: string): Promise<boolean> {
    const conversation = this.conversationOf(edge.child)
    // Stopped already: a turn or a message still going there is what a stop now ends.
    if (edge.closedAt) {
      if (!conversation || !(await this.halt(edge, conversation))) return false
      hostLog("agents", "end", { op: edge.op, child: edge.child, outcome: "stopped", why, again: true })
      this.childMoved(edge, false)
      void this.drain()
      return true
    }
    const store = this.store()!
    const closed = store.keepEdge({ ...edge, closedAt: this.now(), closedReason: why.slice(0, 2000) })
    // What waits looks again now; a Fin whose turn is still being cancelled holds its place until that's done (`occupies`).
    void this.drain()
    this.runs.stop(edge.child, why.slice(0, 2000))
    if (conversation) await this.halt(edge, conversation)
    hostLog("agents", "end", { op: edge.op, child: edge.child, outcome: "stopped", why })
    this.childMoved(closed, false)
    void this.drain()
    return true
  }

  /** A stopped Fin's turn stops and its waiting messages pause, as the person's Stop pauses them; whether either was there. */
  private async halt(edge: ThreadParent, conversation: string): Promise<boolean> {
    const status = this.deps.live.session(conversation)?.status
    const turn = status === "running" || status === "starting" || Boolean(this.deps.live.held(conversation)?.requests.some((request) => request.status === "dispatching"))
    if (turn) await this.deps.live.cancel(conversation).catch((error) => hostWarn("agents", "a Fin's turn could not be stopped", { op: edge.op, error: errorMessage({ error }) }))
    let paused = 0
    try {
      paused = this.deps.live.stopHolds(conversation)
    } catch (error) {
      hostWarn("agents", "a stopped Fin's messages couldn't be paused", { op: edge.op, error: errorMessage({ error }) })
    }
    return turn || paused > 0
  }

  // ── What a Fin shows ──

  /** What the Fin's Thread shows now, from whatever runs its current turn: one source at a time. */
  private childReading(edge: ThreadParent): ChildThread {
    const run = edge.run
    const conversation = this.conversationOf(edge.child)
    // A run Mako stopped is read from its process until that has exited (`AgentRuns.isTerminating`), whatever reads after it.
    if (run && (!run.ended || !conversation || this.runs.isTerminating(edge.child))) return this.runs.reading(edge.child) ?? { source: "followed", harness: run.harness }
    if (!conversation) return { source: "live", ...(this.starting.has(edge.op) && { starting: "launching" as const }) }
    const live = this.deps.live
    const session = live.session(conversation)
    if (!session) return { source: "live" }
    const held = live.held(conversation)
    const waiting = live.waitingOn(conversation)
    // A request sent and not yet answered is work, before its harness says it runs; one nothing will send isn't.
    const busy = live.atWork(conversation)
    const last = held?.requests.filter((request) => request.status !== "queued" && request.status !== "held").at(-1)
    // A turn that ended on its own Fins' work or its move is still at work, on that.
    const waits = !busy && !waiting && last?.status === "completed" ? this.waitsOn(edge, conversation) : undefined
    const working = busy || waits !== undefined
    const thread = this.store()?.thread(edge.child)
    const title = thread?.title ?? session.title
    const settings = this.settingsOf(conversation)
    const model = settings?.model
    const catalog = this.deps.catalogOf?.(session.harness)
    const runsOn = catalog && finTuningWords(catalog, settings)
    return {
      source: "live",
      conversation,
      session: thread?.sessions[0],
      ...(session.nativeId && { nativeId: session.nativeId }),
      ...(session.nativePath && { path: session.nativePath }),
      ...(title && { title }),
      harness: session.harness,
      ...(model && { model }),
      ...(runsOn && { runsOn }),
      ...((session.status === "starting" || this.starting.has(edge.op)) && { starting: "launching" as const }),
      ...(working && { working }),
      ...(waits ? { step: `Waiting for ${waits}`, awaiting: waits } : working && held && { step: lastStep(held.blocks.slice(-24), session.harness) }),
      ...(waiting && { waiting: this.waitingOf(edge, waiting.line, live.pendingAsk(conversation)) }),
      ...(!working && last?.status === "failed" && { ended: { outcome: "failed" as const, ...(last.error && { reason: last.error }), at: last.createdAt ?? edge.createdAt } }),
      ...(!working && last?.status === "interrupted" && last.interruption?.reason === "stopped" && { ended: { outcome: "stopped" as const, at: last.interruption.at } }),
      startedAt: edge.createdAt,
      ...(held?.activityAt && { updatedAt: held.activityAt }),
    }
  }

  /** What a Fin's harness waits on, as its state says it: whose it is (the line says why when it's the person's) and what answers it. */
  private waitingOf(edge: ThreadParent, line: string, pending: PendingAsk | undefined): NonNullable<ChildThread["waiting"]> {
    const ask = pending ? nativeAsk(pending) : undefined
    const why = this.personsBecause(edge, ask, line)
    return { question: why ? `${line} (yours to answer: ${why})` : line, on: !why ? "lead" : ask?.kind === "approval" ? "approval" : "person", ...(ask && { ask }) }
  }

  /**
   * Why a Fin's ask `line` is the person's, or undefined when it's its Apex's
   * alone: an Apex answers within its own access (a question on any, an
   * approval on full access), unless its spawn asked to hear only its result,
   * it left the ask to the person, or it hasn't answered in time.
   */
  private personsBecause(edge: ThreadParent, ask: FinAsk | undefined, line: string): string | undefined {
    if (reportRoute(edge.asked, "blocked") !== "apex") return `its ${APEX_WORD} hears only ${edge.asked.wake === "never" ? "what it reads" : "its result"}`
    if (this.passed(edge, ask)) return `its ${APEX_WORD} left it to you`
    if (this.belowFull(edge, ask)) return `its ${APEX_WORD} isn't on full access`
    const escalated = this.escalated.get(edge.child)
    return escalated?.line === line ? escalated.why : undefined
  }

  private passed(edge: ThreadParent, ask: FinAsk | undefined): boolean {
    return Boolean(ask && this.latest.get(edge.child)?.id === passedId(edge.child, ask.id))
  }

  /** The Apex's tier when `ask` is an approval and the Apex isn't on full access, so can't answer it. */
  private belowFull(edge: ThreadParent, ask: FinAsk | undefined): AccessTier | undefined {
    if (ask?.kind !== "approval") return undefined
    const parent = this.frontOf(edge.parent, edge.parentSession)
    const tier = (parent ? this.tierOfConversation(parent) : undefined) ?? "ask"
    return tier === "full" ? undefined : tier
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
    // A place it let go of is the next waiting Fin's at once, whether or not how it reads changed: a Fin shown stopped
    // lets go only when its harness or its process has actually stopped (`occupies`).
    const holds = this.occupies(edge)
    const held = this.occupying.has(edge.child)
    if (holds) this.occupying.add(edge.child)
    else this.occupying.delete(edge.child)
    const released = held && !holds
    const before = this.entries.get(edge.child)
    this.entries.delete(edge.child)
    const entry = this.entryOf(edge)
    if (before && JSON.stringify(before) === JSON.stringify(entry)) {
      this.entries.set(edge.child, before)
      if (released) void this.drain()
      return
    }
    this.rosters.delete(edge.parent)
    const kindChanged = !before || before.state.kind !== entry.state.kind || before.stoppable !== entry.stoppable
    for (const conversation of this.conversationsOfThread(edge.parent)) this.deps.live.childrenChanged(conversation, progressOnly && !kindChanged)
    this.askApex(edge)
    if (kindChanged) {
      this.checkHolds(edge.child)
      // A Fin waiting on its own Fins reads from them: its entry follows, and its result may be in.
      const above = this.store()?.edges().of(edge.parent)
      if (above) {
        this.childMoved(above, false)
        this.checkAwaiting(above)
      }
    }
    if (released || (before && before.state.kind === "working" && entry.state.kind !== "working")) void this.drain()
  }

  private checkHolds(child: string): void {
    for (const hold of this.holds) if (hold.child === child) hold.check()
  }

  /**
   * A Fin's harness waits on a question or an approval: the Apex hears it as
   * `blocked`, keyed by what it waits on, told whether it may answer. One it
   * may answer that it leaves for `APEX_ANSWER_MS` goes to the person too
   * (`escalate`), so no ask sits on an Apex busy with a long turn of its own.
   */
  private askApex(edge: ThreadParent): void {
    const conversation = this.conversationOf(edge.child)
    const waiting = conversation ? this.deps.live.waitingOn(conversation) : undefined
    if (!conversation || !waiting) {
      this.asked.delete(edge.child)
      this.unwatch(edge.child)
      return
    }
    if (this.asked.get(edge.child) === waiting.line) return
    this.asked.set(edge.child, waiting.line)
    this.unwatch(edge.child)
    const pending = this.deps.live.pendingAsk(conversation)
    const ask = pending ? nativeAsk(pending) : undefined
    const why = this.personsBecause(edge, ask, waiting.line)
    hostLog("agents", "ask routed", { op: edge.op, child: edge.child, ask: ask?.kind ?? waiting.for, to: why ? "person" : "apex" })
    const asked = {
      child: ThreadIdSchema.parse(edge.child),
      status: "blocked" as const,
      summary: `It waits: ${waiting.line}`,
      ...(ask?.options && { options: ask.options }),
      implicit: true as const,
      ownerGeneration: this.generation,
    }
    if (why) {
      const tier = this.belowFull(edge, ask)
      if (tier && reportRoute(edge.asked, "blocked") === "apex" && !this.passed(edge, ask))
        this.keepReport(edge, { ...asked, id: personsId(edge.child, waiting.line), question: personsApproval(waiting.line, tier), for: "person", told: true, at: this.now() })
      return
    }
    this.keepReport(edge, { ...asked, id: `report:${edge.child}:waiting:${namedUuid(waiting.line)}`, question: apexAsk(waiting.line, ask?.kind === "approval"), at: this.now() })
    const line = waiting.line
    const timer = setTimeout(() => this.escalate(edge.child, line, ask), this.deps.apexAnswerMs ?? APEX_ANSWER_MS)
    timer.unref()
    this.unanswered.set(edge.child, timer)
  }

  private unwatch(child: string): void {
    clearTimeout(this.unanswered.get(child))
    this.unanswered.delete(child)
    this.escalated.delete(child)
  }

  /**
   * The Apex left its Fin's ask `line` unanswered past `APEX_ANSWER_MS`: the
   * person is asked too, through every surface that reads the Fin's state
   * (the Inbox, a notification, the phone), and the Apex hears that they
   * were, and that it may still answer. A digest still waiting with the
   * first notice gives way to this one.
   */
  private escalate(child: string, line: string, ask: FinAsk | undefined): void {
    this.unanswered.delete(child)
    if (this.stopped || this.asked.get(child) !== line) return
    const store = this.store()
    const edge = store?.edges().of(child)
    if (!store || !edge || edge.closedAt !== undefined) return
    const ms = this.deps.apexAnswerMs ?? APEX_ANSWER_MS
    const within = waitWords(ms)
    const front = this.frontOf(edge.parent, edge.parentSession)
    const busy = front !== undefined && this.ready(front) === "queue"
    this.escalated.set(child, { line, why: `its ${APEX_WORD} ${busy ? "is mid-turn and " : ""}didn't answer within ${within}` })
    hostLog("agents", "ask escalated", { op: edge.op, child, after: ms, busy })
    const first = `report:${child}:waiting:${namedUuid(line)}`
    if (front && this.wakes.withdraw(front, `notice:${child}:${first}`)) store.markReportsDelivered([first], this.now())
    this.keepReport(edge, {
      id: personsId(child, line),
      child: ThreadIdSchema.parse(child),
      status: "blocked",
      summary: `It waits: ${line}`,
      question: apexAsk(line, ask?.kind === "approval", `you ${busy ? "are mid-turn and " : ""}didn't answer within ${within}`),
      ...(ask?.options && { options: ask.options }),
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
      ...(reading.runsOn && { runsOn: finTuningLine(reading.runsOn) }),
      ...(edge.tuned?.rule && { rule: ruleWords(edge.tuned.rule) }),
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
    return sessionAccessTier(this.deps.live.session(conversation))
  }

  private harnessOf(edge: ThreadParent): string {
    return edge.run?.harness ?? edge.asked.harness ?? "unknown"
  }

  private rootOf(thread: string): string {
    return this.store()?.ancestors(thread).at(-1) ?? thread
  }

  /** How a tree stands against its budgets: Threads at work now, and Threads it started. */
  /** This Mac's load now, every tree's working Fins counted; undefined without a reading of it. */
  private async readMac(): Promise<MacLoad | undefined> {
    const reading = await this.deps.capacity?.read().catch((error: Error) => {
      hostWarn("agents", "this Mac's load couldn't be read; a start says nothing of it", { error: errorMessage({ error }) })
      return undefined
    })
    this.mac = reading ? macLoad(reading, this.working(HERE)) : undefined
    return this.mac
  }

  /** The person's Fins at work in one place, every tree's, with the queued starts launching there. */
  private working(where: string): number {
    return (this.store()?.edges().all ?? []).filter((edge) => placeOf(edge.asked.place) === where && this.occupies(edge)).length + this.unwritten((launch) => launch.where === where)
  }

  /** Queued starts launching that have no edge yet, so nothing else counts them. */
  private unwritten(which: (launch: { where: string; tree: string }) => boolean): number {
    const edges = this.store()?.edges()
    let count = 0
    for (const start of this.starts.values()) if (start.launching && which(start.launching) && !edges?.byOp(start.op)) count += 1
    return count
  }

  /** A place has more room: its capacity rose, or the person raised a number. What waits goes now. */
  capacityChanged(): void {
    void this.drain()
  }

  /** What a place's Fins at once are held to: a device's own count, or the cloud's plan and spend (`placeFull`). */
  private placeLimit(where: string): FinPlaceLimit {
    if (where === "cloud") return { place: "cloud", ...this.deps.cloudLimits?.() }
    return { place: "device", atOnce: this.deps.finLimit?.() ?? FIN_LIMIT }
  }

  /** Why a place takes no more now, with `more` already starting there; undefined while it has room. */
  private full(where: string, more = 0): string | undefined {
    return this.overCeiling(this.workingEverywhere() + more) ?? placeFull(this.placeLimit(where), this.working(where) + more)
  }

  /** The places a start may name that have room now, as a refused start offers them: " The cloud has room: pass place: cloud." */
  private elsewhere(where: string): string {
    const open = (this.deps.places?.() ?? [HERE]).filter((place) => place !== where && !this.full(place))
    if (!open.length) return ""
    const named = open.map((place) => (place === HERE ? "this device" : place === "cloud" ? "the cloud" : place.slice("device:".length)))
    return ` ${upper(named.join(" and "))} ${open.length === 1 ? "has" : "have"} room: pass place: ${open.join(" or ")}.`
  }

  /** The person's ceiling across every place, when `working` Fins fill it. */
  private overCeiling(working: number): string | undefined {
    const ceiling = this.deps.finCeiling?.()
    return ceiling !== undefined && working >= ceiling ? `${working} of the person's ${ceiling} ${FIN_WORD}s at once across every place are at work` : undefined
  }

  private workingEverywhere(): number {
    return (this.store()?.edges().all ?? []).filter((edge) => this.occupies(edge)).length + this.unwritten(() => true)
  }

  /** This device's Fins at work and their harnesses, for its capacity. */
  private async observe(): Promise<void> {
    if (!this.deps.observeCapacity) return
    const mix: Record<string, number> = {}
    for (const edge of this.store()?.edges().all ?? [])
      if (placeOf(edge.asked.place) === HERE && this.occupies(edge)) mix[this.harnessOf(edge)] = (mix[this.harnessOf(edge)] ?? 0) + 1
    await this.deps.observeCapacity(Object.values(mix).reduce((sum, count) => sum + count, 0), mix).catch((error: Error) =>
      hostWarn("agents", "this device's capacity couldn't be read; it keeps its last", { error: errorMessage({ error }) }))
  }

  /** A Fin at work holds a place against the budgets; one only waiting for its own Fins or its move holds none, or they'd wait for it. */
  /**
   * Whether a Fin holds a place: by its run's own life, never by how it reads. From its launch until its harness has
   * finished, or finished cancelling, it holds one; a Fin shown stopped whose turn is still being cancelled still does.
   * One only waiting for its own Fins or its move, or on a question, holds none, or its Fins would wait for it.
   */
  private occupies(edge: ThreadParent): boolean {
    if (this.starting.has(edge.op)) return true
    const reading = this.childReading(edge)
    if (reading.starting) return true
    return reading.working === true && reading.awaiting === undefined && reading.waiting === undefined
  }

  /** Spawns waiting for room in a place, every tree's; with none named, in every place. */
  private waitingForRoom(where?: string): number {
    return this.store()?.queuedSpawns().filter((spawn) => {
      const queued = parseQueued(spawn.record)
      return queued?.why === "place-full" && (where === undefined || placeOf(queued.input.place) === where)
    }).length ?? 0
  }

  /**
   * How a tree stands against its budgets: Threads at work now, and Threads it started, each start counted once
   * whether it's a written edge, a queue row, or a record under way between them (`StartRecord`).
   */
  private treeCounts(root: string): TreeCounts {
    const store = this.store()
    if (!store) return { running: 0, started: 0 }
    let running = 0
    const started = new Set<string>()
    const visit = (parent: string, depth: number) => {
      if (depth > 10_000) return
      for (const edge of store.edges().children(parent)) {
        started.add(edge.op)
        if (this.occupies(edge)) running += 1
        visit(edge.child, depth + 1)
      }
    }
    visit(root, 0)
    for (const spawn of store.queuedSpawns()) if (spawn.tree === root) started.add(spawn.op)
    for (const start of this.starts.values()) if (start.launching?.tree === root) started.add(start.op)
    return { running: running + this.unwritten((launch) => launch.tree === root), started: started.size }
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
    return this.heldFor(thread).map(({ placeholder, queued }) => childEntry(placeholder, { source: "live", queued }, {}))
  }

  /** Spawns held for a parent, each as the edge it becomes once it starts, with why it waits and how many are ahead. */
  private heldFor(thread: string): Array<{ op: string; placeholder: ThreadParent; queued: { reason: QueueReason; ahead: number; after?: string[]; held?: string; refused?: string } }> {
    const store = this.store()
    if (!store) return []
    const spawns = store.queuedSpawns()
    return spawns.flatMap((spawn, at) => {
      const queued = parseQueued(spawn.record)
      if (queued?.lead.thread !== thread) return []
      const reason: QueueReason = queued.why ?? "tree-running"
      const ahead = spawns.slice(0, at).filter((other) => (reason === "place-full" ? parseQueued(other.record)?.why === "place-full" : other.tree === spawn.tree)).length
      const stand = queued.after?.length ? this.afterStand(queued) : undefined
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
      return [{ op: spawn.op, placeholder, queued: { reason, ahead, ...(stand?.pending.length && { after: stand.pending }), ...(stand?.held && { held: stand.held.name }), ...(queued.refused && { refused: queued.refused }) } }]
    })
  }

  /** A held spawn of the Apex's, by name or by the ID its Fin will have. */
  private heldNamed(apex: Apex, ref: string): { op: string; placeholder: ThreadParent; queued: { reason: QueueReason; ahead: number; after?: string[]; held?: string; refused?: string } } | undefined {
    const name = finName(ref)
    return this.heldFor(apex.thread).find(({ placeholder }) => placeholder.child === ref || placeholder.name === name)
  }

  /**
   * The queue moved for these parents: a spawn held, released or dropped. Their rosters are read again and their
   * conversations hear it, as they do when an edge moves, so the sidebar, pips and crew card show a held Fin at once.
   */
  private queueMoved(threads: Iterable<string>, progressOnly: boolean): void {
    if (this.stopped) return
    for (const thread of new Set(threads)) {
      this.forget(thread)
      for (const conversation of this.conversationsOfThread(thread)) this.deps.live.childrenChanged(conversation, progressOnly)
    }
  }

  /** Every parent with a spawn held now. */
  private holdingThreads(): string[] {
    return (this.store()?.queuedSpawns() ?? []).flatMap((spawn) => parseQueued(spawn.record)?.lead.thread ?? [])
  }

  private ready(conversation: string): ParentReady {
    const session = this.deps.live.session(conversation)
    if (!session) return "gone"
    // A stopped Fin hears its own Fins' news once it's resumed (`reopen`), not as turns of a Fin its Apex paused.
    const child = this.childOfConversation(conversation)
    if (child && this.store()?.edges().of(child)?.closedAt !== undefined) return "queue"
    if (!this.deps.live.atWork(conversation)) return "idle"
    return this.deps.live.steersAtStep(conversation) ? "steer" : "queue"
  }

  private steer(conversation: string, id: string, text: string): Promise<boolean> | false {
    const running = this.deps.live.held(conversation)?.requests.find((request) => request.status === "dispatching")
    if (!running) return false
    return this.deps.live.act(conversation, { kind: "steer", id, requestId: running.id, text, attachments: [] }, "native").then(
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
   * A message into a child's Thread: an idle one takes it as its next turn, and a working one as `want` says, after its
   * turn, into it, or by stopping it first. The same Thread whether it's at work, idle or done, so a finished child
   * takes a follow-up where its work is. `hears` says when the child hears it, as the child's own harness takes a
   * message, whatever harness the sender runs on.
   */
  private async deliver(stopped: ThreadParent, request: string, text: string, attachments: PromptAttachment[], actor: Actor | undefined, want: FinDeliver): Promise<Delivered | AgentRefused> {
    const before = this.conversationOf(stopped.child)
    const repeat = before ? this.deps.live.held(before)?.requests.find((asked) => asked.id === request) : undefined
    if (repeat) return repeat.status === "queued" || repeat.status === "held"
      ? { delivery: "queued", hears: `${stopped.name} hears it when its current turn ends, as its next message.`, deduped: true }
      : { delivery: "turn", hears: `${stopped.name} already has it.`, deduped: true }
    if (before && this.deps.archived?.(before))
      return { refused: "conflict", why: `${stopped.name} was archived, which ends its work for good: start a new ${FIN_WORD} with agents_start, or the person can restore it, after which a message resumes it.` }
    const resumed = await this.resumeAccount(stopped)
    const edge = this.reopen(stopped, "a message")
    const taken = edge.run && (!edge.run.ended || !this.conversationOf(edge.child)) ? await this.takeOver(edge) : undefined
    if (taken && "refused" in taken) return taken
    const message = [text, resumed, taken?.cut ? HANDED_OVER_NOTE : undefined].filter(Boolean).join("\n\n")
    const conversation = this.conversationOf(edge.child)
    const ready = conversation ? this.ready(conversation) : "gone"
    if (!conversation || ready === "gone") return { refused: "unavailable", why: `${edge.name}'s conversation isn't on this device.` }
    const name = edge.name
    const held = this.deps.live.held(conversation)?.requests.find((asked) => asked.id === request)
    if (held)
      return held.status === "queued" || held.status === "held"
        ? { delivery: "queued", hears: `${name} hears it when its current turn ends, as its next message.`, deduped: true }
        : { delivery: "turn", hears: `${name} already has it.`, deduped: true }
    const queue = (why?: string): Delivered => {
      this.deps.live.submit(conversation, request, message, attachments, undefined, undefined, undefined, actor)
      this.resumeFin(conversation, request)
      return ready === "idle"
        ? { delivery: "turn", hears: `${name} takes it now, as its next turn.` }
        : { delivery: "queued", hears: `${name} hears it when its current turn ends, as its next message${why ? `: ${why}` : "."}` }
    }
    if (taken) {
      queue()
      return { delivery: "turn", hears: `${taken.cut ? `Mako stopped ${name}'s run and resumed` : "Mako resumed"} its session here; ${name} takes it as its next turn.` }
    }
    if (ready === "idle") return queue()
    if (want === "interrupt") {
      if (!this.deps.live.interrupt(conversation, request, text, attachments, actor))
        return queue(`it had no turn running to stop, and something was already queued ahead of this.`)
      this.resumeFin(conversation, request)
      return { delivery: "interrupt", hears: `Mako stopped ${name}'s turn; this message starts its next one, ahead of anything queued for it.` }
    }
    if (want === "queue") return queue()
    const queued = queue()
    const steered = await this.steerInto(conversation, name, request, text, attachments)
    return "why" in steered ? { ...queued, hears: `${name} hears it when its current turn ends, as its next message: ${steered.why}` } : steered
  }

  /**
   * What a stopped or failed Fin reads beneath the message that resumes it
   * (`finResumedText`): when and why it stopped, and what moved in its
   * checkout and on the branch it goes into since. Undefined for a Fin that
   * didn't end that way.
   */
  private async resumeAccount(edge: ThreadParent): Promise<string | undefined> {
    const state = this.stateOf(edge)
    if (state.kind !== "ended" || (state.outcome !== "stopped" && state.outcome !== "failed")) return undefined
    const reading = this.childReading(edge)
    const at = (state.outcome === "stopped" ? edge.closedAt : this.latest.get(edge.child)?.at) ?? reading.ended?.at ?? edge.closedAt ?? edge.createdAt
    const conversation = this.conversationOf(edge.child)
    const path = reading.path ?? (edge.run?.nativeId ? this.deps.catalog.nativePath({ harness: edge.run.harness, nativeId: edge.run.nativeId }) : undefined)
    const cwd = (conversation ? this.deps.live.session(conversation)?.cwd : undefined) ?? (path ? this.deps.catalog.ref(path)?.cwd : undefined)
    const [checkout, branches] = cwd ? await Promise.all([checkoutSince(cwd, at), branchSince(cwd, at)]) : [[], []]
    return finResumedText({ how: state.outcome, at, ...(state.reason && { reason: state.reason }), now: this.now(), checkout, branches })
  }

  /**
   * Stopping a Fin pauses it: whatever next reaches it (`why`) opens its
   * delegation again, in the same Session, so its turns report and wake its
   * Apex as before. The edge as it stands after.
   */
  private reopen(edge: ThreadParent, why: string): ThreadParent {
    if (edge.closedAt === undefined) return edge
    const store = this.store()!
    const open = store.reopenEdge(edge.child, this.now()) ?? edge
    hostLog("agents", "resumed after stop", { op: edge.op, child: edge.child, by: why, stoppedFor: this.now() - edge.closedAt })
    this.forget(edge.parent)
    this.childMoved(open, false)
    return open
  }

  /**
   * A message reached a Fin (`first`): what its stop or an exit paused goes
   * on behind it, its Apex's messages and its own Fins' digests, since
   * nobody presses Resume on a Fin's queue; a paused one first in line would
   * hold every message behind it. Then the digests that waited for a stopped
   * Fin to resume (`ready`).
   */
  private resumeFin(conversation: string, first: string): void {
    const paused = (this.deps.live.held(conversation)?.requests ?? []).filter((request) =>
      request.status === "held" && !request.signIn && !request.wake && !request.retry && !request.editing && request.actor?.kind === "agent")
    if (paused.length) {
      try {
        this.deps.live.resumeHeld(conversation, paused.map((request) => request.id), first)
        hostLog("agents", "resumed", { conversation, first, requests: paused.length })
      } catch (error) {
        hostWarn("agents", "a Fin's paused messages wait for Resume", { conversation, error: errorMessage({ error }) })
      }
    }
    this.wakes.settled(conversation)
  }

  /**
   * A Fin whose turns a process Mako didn't start runs, or ran: a message goes
   * on in its own Session on Mako's live driver, which drives it from then on.
   * A run still going is stopped first, since a headless run takes nothing
   * until it exits; its last step may be cut short (`cut`), which the message
   * tells it. Later messages steer or queue as any Fin's do.
   */
  private async takeOver(edge: ThreadParent): Promise<{ cut: boolean } | AgentRefused> {
    const run = edge.run!
    const store = this.store()!
    const path = run.nativeId ? this.deps.catalog.nativePath({ harness: run.harness, nativeId: run.nativeId }) : undefined
    const ref = path ? this.deps.catalog.ref(path) : undefined
    if (!run.nativeId || !path || !ref?.cwd) return { refused: "unavailable", why: `${edge.name}'s session isn't on this device yet, so no message can reach it.` }
    if (!this.deps.harnesses().includes(run.harness))
      return { refused: "unavailable", why: `${this.deps.harnessLabel(run.harness)} has no live driver here to resume ${edge.name}'s session with a message: its report reaches you when it ends.` }
    if (run.ended && this.runs.reading(edge.child)?.working)
      return { refused: "unavailable", why: `${edge.name}'s session is being written by a process Mako lost track of, so it can't be resumed here: link that process with agents_link, or try again once it's quiet.` }
    let cut = false
    if (!run.ended) {
      if (run.device !== store.deviceId || !run.process) return { refused: "unavailable", why: `${edge.name} runs in a process on another device, which takes no message until it exits.` }
      if (!(await this.runs.handOver(edge.child))) return { refused: "unavailable", why: `${edge.name}'s process didn't stop, so its session can't take a message yet.` }
      cut = true
    }
    const conversationId = namedUuid(`resume:${edge.child}:${run.nativeId}`)
    const apex = this.frontOf(edge.parent, edge.parentSession)
    const mode = childMode(this.deps.modes(run.harness), (apex ? this.tierOfConversation(apex) : undefined) ?? "ask")
    try {
      await this.deps.startLive(run.harness, ref.cwd, { conversationId, resume: run.nativeId, threadPath: path, ...(mode && { modeId: mode.id }) })
    } catch (error) {
      return { refused: "unavailable", why: `${edge.name}'s session didn't open here${cut ? " after its run was stopped" : ""}: ${errorMessage({ error })}` }
    }
    this.conversations.set(edge.child, conversationId)
    this.childOf.set(conversationId, edge.child)
    hostLog("agents", "run taken over", { op: edge.op, child: edge.child, harness: run.harness, cut, conversation: conversationId })
    return { cut }
  }

  /**
   * Steers a message already queued for a working child (`steer-queued`, as the window steers a queued message) into
   * its running turn. Refused, then or later, it stays where it was queued, so what was sent after it still comes
   * after; taken, it leaves the queue; never confirmed, it isn't sent again. A harness can hold a steer until what runs
   * returns (Cursor, its subagent): the call answers after `STEER_WAIT_MS` and `STEER_ANSWER_MS` at most, before that.
   * `why` when it never went into the turn, so it waits for the turn's end.
   */
  private async steerInto(conversation: string, name: string, request: string, text: string, attachments: PromptAttachment[]): Promise<Delivered | { why: string }> {
    const steering = this.deps.live.steering(conversation)
    const harness = this.deps.harnessLabel(this.deps.live.session(conversation)?.harness ?? "unknown")
    if (!steering) return { why: `${harness} takes no message into a running turn.` }
    const deadline = Date.now() + STEER_WAIT_MS
    const turn = () => this.deps.live.held(conversation)?.requests.find((asked) => asked.status === "dispatching" && asked.nativeRun)
    while (!turn() && Date.now() < deadline && this.deps.live.session(conversation)?.status !== "ready") await new Promise((resolve) => setTimeout(resolve, 50))
    const running = turn()
    if (!running) return { why: "its turn hadn't started yet." }
    const action = Promise.resolve().then(() => this.deps.live.act(conversation, { kind: "steer-queued", id: namedUuid(`steer:${request}`), requestId: running.id, queuedRequestId: request, text, attachments }, "native"))
    const answered = await Promise.race([
      action.then((taken) => taken.state, (error) => ({ kind: "refused" as const, reason: errorMessage({ error }) })),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), Math.max(0, deadline - Date.now()) + STEER_ANSWER_MS)),
    ])
    const unconfirmed = (reason: string): Delivered => ({ delivery: "steer", hears: `${harness} didn't confirm ${name} took it (${reason}); Mako won't send it again, so look for it in ${name}'s next report before sending it once more.` })
    if (!answered)
      return { delivery: "steer", hears: `${harness} holds it until what ${name} is running now returns, then ${name} hears it${steering.answersOnEnd ? "; if its turn ends first, it goes as its next message" : ""}.` }
    if (answered.kind === "refused") {
      // Refused before its harness heard it, it's still queued; one whose action took it from the queue has an unknown outcome.
      const status = this.deps.live.held(conversation)?.requests.find((asked) => asked.id === request)?.status
      return status === "queued" || status === "held" ? { why: `it couldn't go into its running turn (${answered.reason})` } : unconfirmed(answered.reason)
    }
    if (answered.kind === "not-accepted")
      return { delivery: "queued", hears: `${harness} didn't take it into ${name}'s running turn, so ${name} hears it when that turn ends, as its next message.` }
    if (answered.kind === "uncertain" || answered.kind === "failed") return unconfirmed(answered.reason)
    return { delivery: "steer", hears: `${name} hears it ${steering.hears} (${harness}).` }
  }

  /** The message the Apex's turn answers: its newest from the person, with what came with it. */
  private personsMessage(apex: Apex): LiveRequest | undefined {
    const requests = apex.conversation ? this.deps.live.held(apex.conversation)?.requests ?? [] : []
    const own = requests.filter((request) => !request.actor || request.actor.kind === "person")
    return own.find((request) => request.status === "dispatching") ?? own.at(-1)
  }

  /** A Fin's Apex as it stands, and the other open Fins it started, as its front-door note names them: no transcript is read. */
  private crewOf(fin: Apex): AgentsCrew | AgentRefused {
    const store = this.store()!
    const edge = store.edges().of(fin.thread)
    if (!edge) return { refused: "no-parent", why: `This Thread has no ${APEX_WORD}: scope crew is for a ${FIN_WORD}. Leave scope out for this Thread's own ${FIN_WORD}s.` }
    this.sync()
    const conversation = this.frontOf(edge.parent, edge.parentSession)
    const session = conversation ? this.deps.live.session(conversation) : undefined
    const ready = conversation ? this.ready(conversation) : "gone"
    const working = ready === "steer" || ready === "queue"
    const held = working && conversation ? this.deps.live.held(conversation) : undefined
    const step = held && session ? lastStep(held.blocks.slice(-24), session.harness) : undefined
    const title = session?.title ?? store.thread(ThreadIdSchema.parse(edge.parent))?.title
    const above = store.edges().of(edge.parent)
    return {
      you: edge.name,
      apex: {
        ...(title && { title }),
        ...(session && { harness: this.deps.harnessLabel(session.harness) }),
        working,
        ...(step && { step }),
        ...(above && { asked: noteLine(above.asked.brief.objective, 160) }),
      },
      crew: store.edges().children(edge.parent).filter((other) => other.child !== edge.child && !other.closedAt).map((other) => crewMate(this.frontDoorChild(other))),
    }
  }

  /** The person's other Apexes open here, each as it stands, from typed state: reading one never wakes it. */
  private apexesOf(caller: Apex): AgentsApexes {
    return { apexes: this.otherApexes(caller).map((other) => this.otherApex(other)) }
  }

  /** Every tree's top Apex but the caller's own whose conversation is open on this host, with the conversation that speaks for it. */
  private otherApexes(caller: Apex): OtherApexRef[] {
    const store = this.store()!
    this.sync()
    const roots = new Set(store.edges().all.map((edge) => this.rootOf(edge.parent)))
    roots.delete(this.rootOf(caller.thread))
    return [...roots].flatMap((thread) => {
      const record = store.thread(ThreadIdSchema.parse(thread))
      const first = record?.sessions[0]
      const conversation = first && this.frontOf(thread, first)
      if (!conversation || !this.deps.live.held(conversation)) return []
      const title = record.title ?? this.deps.live.session(conversation)?.title
      return [{ thread, conversation, ...(title && { title }) }]
    })
  }

  /** Another Apex by its title or Thread, as `scope: apexes` lists them; a title two share is refused with their Threads. */
  private otherApexNamed(caller: Apex, ref: string): OtherApexRef | AgentRefused {
    const others = this.otherApexes(caller)
    const words = ref.trim().toLowerCase()
    const found = others.filter((other) => other.thread === ref.trim() || other.title?.trim().toLowerCase() === words)
    if (found.length === 1) return found[0]!
    if (found.length) return { refused: "unknown-apex", why: `${found.length} ${APEX_WORD}es are titled ${ref}: name one as apex:<Thread ID>: ${found.map((other) => other.thread).join(", ")}.` }
    const listed = others.map((other) => `${APEX_PREFIX}${other.title ?? other.thread}`).join(", ")
    return { refused: "unknown-apex", why: `No other ${APEX_WORD} of the person's open here is ${ref}${listed ? `; they are ${listed}` : ""}. agents_list with scope apexes shows them.` }
  }

  private otherApex(other: OtherApexRef): OtherApex {
    const store = this.store()!
    const { thread, conversation } = other
    const session = this.deps.live.session(conversation)
    const ready = this.ready(conversation)
    const working = ready === "steer" || ready === "queue"
    const held = working ? this.deps.live.held(conversation) : undefined
    const step = held && session ? lastStep(held.blocks.slice(-24), session.harness) : undefined
    const branch = store.worktrees().find((worktree) => worktree.thread === thread)?.branch
    const open = store.edges().children(thread).filter((edge) => !edge.closedAt).map((edge) => ({ edge, state: this.stateOf(edge) }))
      .sort((a, b) => CHILD_GROUPS.indexOf(childGroup(a.state)) - CHILD_GROUPS.indexOf(childGroup(b.state)))
    const fins = open.slice(0, APEX_DIGEST_FINS).map(({ edge, state }) => ({ name: edge.name, line: this.digestLine(edge, state) }))
    const said = this.lastReply(conversation)
    return {
      thread,
      ...(other.title && { title: other.title }),
      ...(session && { harness: this.deps.harnessLabel(session.harness) }),
      working,
      ...(step && { step }),
      ...(session?.cwd && { folder: session.cwd }),
      ...(branch && { branch }),
      fins: rollup(this.roster(conversation)),
      digest: { fins, ...(open.length > fins.length && { more: open.length - fins.length }), ...(said && { said }) },
    }
  }

  /** A Fin in another Apex's digest: its last report, or before one, its state. */
  private digestLine(edge: ThreadParent, state: ChildState): string {
    const latest = this.latest.get(edge.child)
    if (latest) return `${latest.status}: ${noteLine(reportPhase(latest) ?? latest.status, 160)}`
    const line = childLine(state)
    return line ? `${state.kind}: ${noteLine(line, 160)}` : state.kind
  }

  /** The first paragraph of what a conversation's agent said as its last finished turn ended. */
  private lastReply(conversation: string): string | undefined {
    const last = this.deps.live.held(conversation)?.requests.filter((request) => request.status === "completed").at(-1)
    const text = last ? this.deps.live.turnReply(conversation, last.id)?.text.trim() : undefined
    return text ? firstParagraph(text) : undefined
  }

  /** The turn that answers another Apex's message ended: its reply goes to that Apex once, as a wake of its own. */
  private apexReplied(conversation: string, request: string): void {
    const ask = this.apexAsks.get(`${conversation}:${request}`)
    if (!ask) return
    for (const id of ask.requests) this.apexAsks.delete(`${conversation}:${id}`)
    const reply = this.deps.live.turnReply(conversation, request)
    const done = reply?.request?.status === "completed"
    const said = reply?.text.trim() || (done ? "It ended its turn without a reply." : reply?.request?.error ?? "Its turn ended before it answered.")
    const front = this.frontOf(ask.sender.thread, ask.sender.session) ?? ask.sender.conversation
    const from = this.store()?.journalPlacement(conversation)?.session
    if (!front || !from) return
    this.wakes.notice(front, this.rootOf(ask.sender.thread), {
      id: `notice:reply:${conversation}:${request}`,
      report: { id: `reply:${conversation}:${request}`, child: ThreadIdSchema.parse(ask.thread), status: done ? "done" : "failed", summary: said.slice(0, 16_000), ownerGeneration: this.generation, at: this.now() },
      label: ask.label,
      fin: ask.fin,
      from,
      reply: true,
    })
    hostLog("agents", "apex replied", { conversation, request, to: ask.sender.thread, done })
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

  /** A spawn left the queue without starting: its Apex's roster drops it. */
  private unqueued(op: string, thread: string): void {
    this.store()?.unqueueSpawn(op)
    this.queueChanged(thread)
  }

  /** A spawn of this Apex's queue changed: its roster is read again, and its conversations hear it (`queueMoved`). */
  private queueChanged(thread: string): void {
    this.queueMoved([thread], false)
  }

  /** Its Apex heard that a Fin it was to start after didn't finish (`tellHeld`): it's the Apex's to start again. */
  private dropHeld(op: string): void {
    const spawn = this.store()?.queuedSpawns().find((queued) => queued.op === op)
    const queued = spawn && parseQueued(spawn.record)
    if (!queued) return
    hostLog("agents", "end", { op, outcome: "stopped", queued: true, why: queued.refused ? "it couldn't start" : "a Fin it was to start after didn't finish" })
    this.unqueued(op, queued.lead.thread)
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

/** Who answers a Fin's ask: its Apex, within its access, or the person, whose ask it is. */
type Answerer = { kind: "apex"; apex: Apex } | { kind: "person" }

/** The tiers a harness's modes run on, in words: "full", "ask, edits, full". */
function offered(modes: readonly LiveSessionMode[] | undefined): string {
  return (modes ?? []).flatMap((mode) => mode.access ? [mode.access] : []).join(", ")
}

/** The report that tells an Apex its Fin's ask `line` is the person's too. */
function personsId(child: string, line: string): string {
  return `report:${child}:to-person:${namedUuid(line)}`
}

/** A wait in words: "a minute", "2 minutes", "30 seconds". */
function waitWords(ms: number): string {
  if (ms >= 60_000) {
    const minutes = Math.round(ms / 60_000)
    return minutes === 1 ? "a minute" : `${minutes} minutes`
  }
  const seconds = Math.max(1, Math.round(ms / 1000))
  return seconds === 1 ? "a second" : `${seconds} seconds`
}

/** The report that leaves an ask to the person, one per ask. */
function passedId(child: string, ask: string): string {
  return `report:${child}:person:${namedUuid(ask)}`
}

function sameWords(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

/** A harness's ask as a Fin's: an approval's options, or its one open question's. */
function nativeAsk(pending: PendingAsk): FinAsk {
  const options = pending.kind === "approval"
    ? pending.options.map((option) => ({ label: option.name.slice(0, 200) }))
    : pending.questions.length === 1
      ? pending.questions[0]!.options.map((option) => ({ label: option.label.slice(0, 200), ...(option.description && { detail: option.description.slice(0, 600) }) }))
      : []
  return { kind: pending.kind, id: pending.request, ...(options.length && { options: options.filter((option) => option.label).slice(0, ASK_OPTIONS) }) }
}

/**
 * An answer as its harness takes it: an approval's option (one named by its
 * label, else its allow-once or refuse-once by `allow`), or the one open
 * question's answer, an option's value when it names one.
 */
function permissionAnswer(pending: PendingAsk, input: Pick<AgentsAnswerInput, "answer" | "allow">): LivePermissionResponse | AgentRefused {
  const words = input.answer?.trim()
  if (pending.kind === "approval") {
    const named = words ? pending.options.find((option) => sameWords(option.name, words)) : undefined
    const by = (kind: "allow" | "reject") => pending.options.find((option) => option.kind === `${kind}_once`) ?? pending.options.find((option) => option.kind?.startsWith(kind))
    const option = named ?? (input.allow === undefined ? undefined : by(input.allow ? "allow" : "reject"))
    if (!option) return { refused: "conflict", why: `It asks for an approval: say allow: true or false, or name one of its options: ${pending.options.map((each) => each.name).join(", ")}.` }
    const feedback = !named && input.allow === false && words && pending.feedbackOption === option.optionId ? words : undefined
    return { kind: "choice", optionId: option.optionId, ...(feedback && { feedback }) }
  }
  if (pending.questions.length !== 1)
    return { refused: "conflict", why: `It asks ${pending.questions.length} questions at once, which only its Thread answers: leave them to the person with person: true.` }
  const question = pending.questions[0]!
  if (!words) return { refused: "conflict", why: "Its question needs an answer: one of its options by its label, or your own words." }
  const picked = question.options.find((option) => sameWords(option.label, words))
  if (!picked && question.options.length && !question.allowOther)
    return { refused: "conflict", why: `Its question takes one of its options: ${question.options.map((option) => option.label).join(", ")}.` }
  return { kind: "answers", answers: { [question.id]: [picked ? picked.value ?? picked.label : words] } }
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

/** A Fin as another Fin of its Apex reads it: the person's words to it directly stay its own. */
function crewMate(fin: FrontDoorChild): CrewMate {
  return { name: fin.name, harness: fin.harness, state: fin.state, topic: fin.topic, ...(fin.branch && { branch: fin.branch }), ...(fin.report && { report: fin.report }) }
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
