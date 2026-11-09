import { open, readFile } from "node:fs/promises"
import { join } from "node:path"
import type { ThreadRef } from "@mako/sessions"
import type { Entry } from "@mako/sessions/entries"
import { identifyTool, toolPhrase } from "@mako/sessions/tool-identity"
import type { HostJobs, JobDemand } from "../base/host-jobs.js"
import { hostLog, hostWarn } from "../base/host-log.js"
import { markedProcesses, processesHolding, processFolders, type MarkedProcess } from "../base/marked-processes.js"
import { processIdentityMatches, processStartedAt } from "../base/process-liveness.js"
import { errorMessage } from "../base/error-message.js"
import type { AgentRefused, ChildOrigin, ChildRole, ChildThread, FollowedRun, ThreadParent } from "../contracts/agents.js"
import { internalDiscoveredRun } from "../contracts/agents.js"
import { SESSION_VARIABLE } from "../contracts/agent-tools.js"
import type { HostEvent } from "../contracts/host-events-boot.js"
import { SessionIdSchema, type Actor } from "../contracts/thread-identity.js"
import { uniqueName, type ThreadCatalog, type ThreadStore } from "../threads/index.js"

/** At most one tail read per run this often: a Session can write many times a second. */
export const READ_EVERY_MS = 500
/** Tail reads a second across every run this host follows: each is a page the catalog's reader decodes. */
export const TAIL_READS_PER_SECOND = 24

/** How often one run's tail is read while `following` runs go: every half second, slower past the shared budget. */
export function tailReadEvery(following: number): number {
  return Math.max(READ_EVERY_MS, Math.ceil((following / TAIL_READS_PER_SECOND) * 1_000))
}
/** How often the processes of the runs on this device are checked, while there are any. */
const LIVENESS_MS = 2_000
/** Entries a tail read takes: enough to reach the last step past a run of text. */
const TAIL_ENTRIES = 24
/** Entries a page reads when counting a Session's calls from its start. */
const COUNT_PAGE = 500
const STEP_CHARS = 160
const SUMMARY_CHARS = 280
/** A Session newer than this, unplaced, is looked for among the processes a conversation started. */
const DISCOVER_MS = 10 * 60_000
/** How far a process's start can be from its Session's, to be the process that wrote it. */
const DISCOVER_START_MS = 60_000
/** A stopped run gets this long before its process group is killed. */
export const STOP_GRACE_MS = 5_000
/** How often a stopped run's exit is looked for; how long past its kill before Mako says it couldn't stop it; and how often after. */
const GONE_EVERY_MS = 50
const GONE_AFTER_KILL_MS = 2_000
const STUCK_EVERY_MS = 1_000
/**
 * How long a run's Session stays quiet after its process went before the run
 * is declared ended: a chat resumed in a new process (to hand it a message)
 * writes the same Session, and isn't over.
 */
export const END_CONFIRM_MS = 10_000

export type RunEnd = NonNullable<FollowedRun["ended"]>

/** What the follower read of a run: its Session as the catalog lists it, and its process. */
interface RunReading {
  session?: { path: string; updatedAt?: number; title?: string }
  activity?: "active" | "needs-input" | "open"
  alive?: boolean
  step?: string
  toolUses?: number
}

/** What a new Session's process is found by: the marked processes, the files and folders they hold, their starts. */
export interface ProcessReads {
  marked(variable: string, signal: AbortSignal): Promise<MarkedProcess[]>
  holding(file: string, pids: readonly number[], signal: AbortSignal): Promise<Set<number>>
  folders(pids: readonly number[], signal: AbortSignal): Promise<Map<number, string>>
  startedAt(pid: number, signal: AbortSignal): Promise<number>
  /** Whether `pid` is still the process that started at `startedAt`; it throws when that can't be read. */
  matches?(pid: number, startedAt: number, signal: AbortSignal): Promise<boolean>
}

/** How many times a link reads a running process's start before it says it can't. */
const PROCESS_READ_TRIES = 3

export const PROCESS_READS: ProcessReads = {
  marked: markedProcesses,
  holding: processesHolding,
  folders: processFolders,
  startedAt: processStartedAt,
  matches: (pid, startedAt, signal) => processIdentityMatches({ pid, startedAt, exact: true, signal }),
}

export interface AgentRunsDeps {
  store(): ThreadStore | undefined
  catalog: Pick<ThreadCatalog, "nativePath" | "ref" | "page" | "activity" | "subscribe" | "announce"> & Partial<Pick<ThreadCatalog, "readRef">>
  jobs: HostJobs
  /** Whether `harness` has a CLI a conversation's shell can run, so a Session of it can be one started there. */
  runs(harness: string): boolean
  /**
   * Whether this native session is a conversation's own (one Mako runs, or the Session of one): never a followed
   * run. `marker` is the Session a process that holds it names, whose own harness may not have named it yet.
   */
  conversationOwns(ref: Pick<ThreadRef, "harness" | "nativeId" | "sessionId">, marker?: string): boolean
  /** A followed child's reading changed; `progressOnly` when only a step or a count did. */
  changed(edge: ThreadParent, progressOnly: boolean): void
  /** A followed run ended, once: written to its edge before this is called. */
  ended(edge: ThreadParent, ended: RunEnd): void
  /** A run Mako stopped outlived its kill: its process still runs, so its Fin says so (`stuckWords`) and keeps its place. */
  stuck?(edge: ThreadParent): void
  processes?: ProcessReads
  now?(): number
}

interface Followed {
  edge: ThreadParent
  reading: RunReading
  /** Entries of its Session counted into `reading.toolUses`, from its start. */
  counted: number
  lastRead: number
  timer?: NodeJS.Timeout
  inFlight: boolean
  again: boolean
  /** Its process's identity was checked against its start this host's life: after that, a signal says it runs. */
  checked: boolean
  /** When its process was first seen gone and when its Session was last written then, while its end waits to be confirmed by a quiet Session. */
  gone?: { at: number; written: number }
  /** This host saw its process run: one gone before that ended while no host watched. */
  seenAlive?: true
}

/** What a link or a discovery takes in. */
export interface RunAdoption {
  parentSession: string
  ref: ThreadRef
  origin: Extract<ChildOrigin, "linked" | "discovered">
  process?: FollowedRun["process"]
  name?: string
  role?: ChildRole
  startedBy: Actor
}

/**
 * The children whose turns a process Mako didn't start runs (`discovered`,
 * `linked`, and #286's migrated runs): a harness CLI a Thread's shell ran,
 * found by the Session its environment names (`SESSION_VARIABLE`), or one the
 * Thread names. Each is followed the same way whatever its harness: through
 * its own Session as the catalog lists it (the step its tail shows, the
 * calls it made) and through its process, whose end is written to its edge
 * once, with how it went. A run that ended while no host watched says so
 * when the next host reads it: the exit status #286's wrapper wrote, else
 * what its Session last shows. Nothing reads a run's output as it goes: the
 * catalog already watches every Session.
 */
export class AgentRuns {
  private readonly deps: AgentRunsDeps
  private readonly followed = new Map<string, Followed>()
  /**
   * Runs Mako stopped whose processes haven't exited yet, by child: shown stopped, their end written, but still at
   * work on the machine, so each holds its place until its process group, the same process by pid and start, is gone.
   */
  private readonly terminating = new Map<string, NonNullable<FollowedRun["process"]>>()
  private readonly byNative = new Map<string, string>()
  private readonly byPath = new Map<string, string>()
  private readonly demand: JobDemand
  private readonly abort = new AbortController()
  private readonly cancelJob: () => void
  private readonly unsubscribe: () => void
  private readonly discovering = new Set<string>()
  private discoveries: Promise<void> = Promise.resolve()
  private seen: unknown
  private stopped = false
  private readonly originsRead = new Set<string>()
  private readonly originRecovery: Promise<void>

  constructor(deps: AgentRunsDeps) {
    this.deps = deps
    this.demand = deps.jobs.demand("followed agent runs on this device")
    this.cancelJob = deps.jobs.every("follow agent runs", LIVENESS_MS, () => this.check(), { firstAfterMs: 0, needs: [this.demand] })
    this.unsubscribe = deps.catalog.subscribe((event) => this.catalogEvent(event))
    this.sync()
    this.originRecovery = this.recoverOrigins()
  }

  /** Before replaying old decisions, read native origin from historical discoveries, past catalog startup/cache timing. */
  reconciled(): Promise<void> {
    return this.originRecovery
  }

  private async recoverOrigins(): Promise<void> {
    const store = this.deps.store()
    const read = this.deps.catalog.readRef
    if (!store || !read) return
    for (const edge of store.edges().all) {
      const run = edge.run
      if (edge.origin !== "discovered" || !run || run.nativeAgent?.kind === "agent") continue
      const path = run.nativeId && this.deps.catalog.nativePath({ harness: run.harness, nativeId: run.nativeId }) ||
        store.thread(edge.child)?.sessions.flatMap((session) => store.sessionContents(session).natives).find((native) => native.harness === run.harness)?.path
      const ref = path ? await read(path).catch(() => null) : undefined
      if (this.stopped) return
      const current = store.edges().of(edge.child)
      if (current && ref?.harness === run.harness && ref.nativeId === run.nativeId) this.reconcile(current, ref)
      this.originsRead.add(edge.child)
    }
    // The native origin can be unavailable. That is not evidence of an internal reviewer: real failures remain visible.
    this.seen = undefined
    this.sync()
  }

  /** Settles once every new Session's search for the process that started it, begun so far, has ended. */
  discovered(): Promise<void> {
    return this.discoveries
  }

  /** What a followed child's Thread shows now; undefined for a child no process of its own runs. */
  reading(child: string): ChildThread | undefined {
    const followed = this.followed.get(child)
    if (!followed) return undefined
    const { edge, reading } = followed
    const run = edge.run!
    // An end is written once, but a Session written since, and lately, says the run goes on in a process Mako lost.
    const written = Date.parse((reading.session && this.deps.catalog.ref(reading.session.path)?.updatedAt) || "")
    const revived = run.ended !== undefined && run.ended.kind !== "stopped" && written > run.ended.at && this.now() - written < END_CONFIRM_MS
    const ended = revived ? undefined : run.ended
    // The Thread's own name (a link's) before its Session's, which is its first prompt's line.
    const title = this.deps.store()?.thread(edge.child)?.title ?? reading.session?.title
    return {
      source: "followed",
      ...(run.nativeId && { nativeId: run.nativeId }),
      ...(reading.session && { path: reading.session.path }),
      ...(title && { title }),
      harness: run.harness,
      ...(!ended && { working: revived || reading.alive !== false || reading.activity === "active" }),
      // Stopped and shown so, but its process still exits: it's at work on the machine until it has.
      ...(this.terminating.has(child) && { working: true }),
      ...(!ended && reading.step && { step: reading.step }),
      ...(!ended && reading.activity === "needs-input" && { waiting: { question: "It waits for an answer in its own terminal.", on: "person" as const } }),
      ...(ended && { ended: { outcome: ended.kind === "unknown" ? "unknown" : ended.kind, ...(ended.detail && { reason: ended.detail }), at: ended.at } }),
      ...((ended?.toolUses ?? reading.toolUses) && { toolUses: ended?.toolUses ?? reading.toolUses }),
      startedAt: run.startedAt,
      ...(reading.session?.updatedAt && { updatedAt: reading.session.updatedAt }),
    }
  }

  /** Whether a followed run still runs: a message to it waits for its process to end (`held`). */
  running(child: string): boolean {
    const followed = this.followed.get(child)
    return Boolean(followed && !followed.edge.run?.ended)
  }

  /** How many followed runs share the tail reads. */
  following(): number {
    let count = 0
    for (const followed of this.followed.values()) if (!followed.edge.run?.ended) count += 1
    return count
  }

  /** Takes in a run as a child: its Session's Thread gets an edge under the parent Session's Thread. */
  async adopt(input: RunAdoption): Promise<ThreadParent | AgentRefused> {
    const store = this.requireStore()
    const latest = this.deps.catalog.ref(input.ref.path)
    const ref = latest?.harness === input.ref.harness && latest.nativeId === input.ref.nativeId ? latest : input.ref
    if (input.ref.nativeAgent?.kind === "internal-review" || this.internal(ref))
      return { refused: "unsupported", why: "That native session is an internal approval review, not a delegated Fin." }
    const kept = store.edges().byRun(ref.harness, ref.nativeId)
    const parent = store.sessionPlacement(SessionIdSchema.parse(input.parentSession))
    if (!parent) return { refused: "no-parent", why: "This Thread isn't in the Thread store yet." }
    if (kept && kept.parent !== parent.thread) return { refused: "conflict", why: "That session already works for another Thread." }
    // Discovery finds a run its link already named, maybe by another of its processes (a wrapper's child): that edge stands.
    if (kept) return input.origin === "linked" ? this.relink(kept, input) : kept
    const child = store.place(ref, input.startedBy).thread
    if (child === parent.thread || store.ancestors(parent.thread).includes(child))
      return { refused: "cycle", why: "That session is this Thread or one of its Apexes." }
    if (store.edges().of(child)) return { refused: "conflict", why: "That session's Thread is already a Fin of an Apex." }
    const started = Date.parse(ref.startedAt ?? "")
    const startedAt = Number.isFinite(started) ? started : this.now()
    const name = uniqueName(input.name ?? ref.title ?? ref.harness, new Set(store.edges().children(parent.thread).map((edge) => edge.name)))
    const edge = store.keepEdge({
      child,
      parent: parent.thread,
      parentSession: SessionIdSchema.parse(input.parentSession),
      name,
      role: input.role ?? "worker",
      origin: input.origin,
      asked: { brief: { objective: (ref.title ?? ref.harness).slice(0, 2_000) }, harness: ref.harness },
      op: `${input.origin}:${ref.harness}:${ref.nativeId}`,
      startedBy: input.startedBy,
      createdAt: startedAt,
      run: {
        harness: ref.harness,
        nativeId: ref.nativeId,
        device: store.deviceId,
        ...(input.process && { process: input.process }),
        startedAt,
        ...(ref.nativeAgent && { nativeAgent: ref.nativeAgent }),
      },
    })
    if (internalDiscoveredRun(edge)) return { refused: "unsupported", why: "That native session is a previously identified internal approval review." }
    if (input.name) store.keepThreadTitle(edge.child, input.name)
    hostLog("agents", "edge written", { op: edge.op, child: edge.child, parent: edge.parent, origin: input.origin, harness: ref.harness })
    this.originsRead.add(edge.child)
    this.sync()
    const followed = this.followed.get(edge.child) ?? this.follow(edge)
    this.byPath.set(ref.path, edge.child)
    followed.reading = { ...followed.reading, session: sessionOf(ref.path, ref), ...activityOf(this.deps.catalog.activity()[ref.path]) }
    this.deps.catalog.announce(ref.path)
    if (input.process) {
      followed.checked = true
      followed.seenAlive = true
      followed.reading = { ...followed.reading, alive: true }
      void this.read(followed)
    } else await this.settle(followed)
    if (store.edges().internalRuns.some((internal) => internal.child === edge.child))
      return { refused: "unsupported", why: "That native session was identified as an internal approval review during adoption." }
    this.deps.changed(followed.edge, false)
    return followed.edge
  }

  /**
   * A run linked again: the same Fin, now followed through the process the
   * link names, since a chat resumed in a new process (to hand it a message)
   * is the same run. An end already written stands: a new process of an
   * ended run is refused, and a message (`agents_send`) resumes it instead.
   */
  private relink(kept: ThreadParent, input: RunAdoption): ThreadParent | AgentRefused {
    const store = this.requireStore()
    if (input.name) store.keepThreadTitle(kept.child, input.name)
    const run = kept.run
    const process = input.process
    if (!run || !process || (run.process?.pid === process.pid && run.process.startedAt === process.startedAt)) return kept
    if (run.ended)
      return { refused: "conflict", why: `That run already ended (${run.ended.kind}); Mako doesn't follow a new process of it. agents_send gives it a message, which resumes its session here.` }
    const edge = store.keepRun(kept, { ...run, process })
    if (!edge) return { refused: "conflict", why: "That run changed while it was being linked." }
    const followed = this.followed.get(edge.child) ?? this.follow(edge)
    this.moved(followed, edge, "a new link")
    return edge
  }

  /** A run now runs in another process: followed there, and its end no longer awaited. */
  private moved(followed: Followed, edge: ThreadParent, by: string): void {
    hostLog("agents", "run moved to a new process", { child: edge.child, from: followed.edge.run?.process?.pid ?? null, to: edge.run?.process?.pid ?? null, by })
    followed.edge = edge
    followed.checked = true
    followed.gone = undefined
    followed.reading = { ...followed.reading, alive: true }
    this.wantChecks()
    this.deps.changed(edge, false)
  }

  /**
   * The pid a link names, checked to run on this device now: nothing once it's gone. A read that fails while the
   * process runs says nothing of the process (`ps` ran past its limit at load 15), so it's read again, and what it
   * can't be read after `PROCESS_READ_TRIES` is thrown, for the link to say.
   */
  async processOf(pid: number): Promise<FollowedRun["process"] | undefined> {
    const reads = this.deps.processes ?? PROCESS_READS
    for (let tries = 1; ; tries++) {
      try {
        return { pid, startedAt: await reads.startedAt(pid, this.abort.signal) }
      } catch (error) {
        if (!signalable(pid)) return undefined
        if (tries === PROCESS_READ_TRIES) throw error
      }
    }
  }

  /** Stops a followed run on this device: its whole process group, killed after `STOP_GRACE_MS`. */
  stop(child: string, detail?: string): boolean {
    this.sync()
    const followed = this.followed.get(child)
    const run = followed?.edge.run
    const store = this.deps.store()
    if (!followed || !run || !store || run.ended || !run.process || run.device !== store.deviceId) return false
    const process = run.process
    const at = this.now()
    this.terminating.set(child, process)
    // Its end and its stopping are kept together: a host that dies before its process does leaves the next one to finish the stop.
    this.end(followed, { at, kind: "stopped", ...(detail && { detail }), ...(followed.reading.toolUses && { toolUses: followed.reading.toolUses }) }, { stopping: { at } })
    if (followed.edge.run?.stopping?.at !== at) { this.terminating.delete(child); return false }
    void this.untilGone(child, process, at)
    return true
  }

  /** Whether a run Mako stopped is still exiting: it reads as at work, and holds its place, until it has. */
  isTerminating(child: string): boolean {
    return this.terminating.has(child)
  }

  /**
   * Stops a stopped run's process and waits for it to exit, then lets its place go: its Fin's entry moves, and what
   * waits for the place hears it then. It's signalled only while it's proven the same process (`identity`): SIGTERM
   * at once, SIGKILL `STOP_GRACE_MS` after its stop. A host can't wait on a process it didn't spawn, so it looks every
   * `GONE_EVERY_MS`, and only an exit it has seen lets the place go. A process whose identity can't be read keeps its
   * place unsignalled, its Fin saying Mako couldn't confirm it stopped, and one that outlives its kill keeps its place,
   * its Fin saying Mako couldn't stop it; either is looked at every `STUCK_EVERY_MS` until it settles. A host that
   * shuts down leaves the stop to the next one.
   */
  private async untilGone(child: string, process: NonNullable<FollowedRun["process"]>, since: number): Promise<void> {
    const killAt = since + STOP_GRACE_MS
    let termed = false
    let killed = false
    const kept = this.followed.get(child)?.edge.run?.stopping
    let stuck = kept?.stuck === true
    let unconfirmed = kept?.unconfirmed === true
    while (!this.stopped) {
      const identity = await this.identity(process)
      // A host that shut down during that read leaves the stop to the next one, its store closed with it.
      if (this.stopped) return
      this.sync()
      const current = this.deps.store()?.edges().of(child)?.run
      if (this.terminating.get(child) !== process || !current || current.process?.pid !== process.pid || current.process.startedAt !== process.startedAt || current.stopping?.at !== since) return
      // Another process's pid now: a pid isn't reused while its group lives, so the group under that id is the new one's.
      // Gone: only once nothing of its group is left either.
      if (identity === "other" && (signalable(process.pid) || !groupRuns(process.pid))) break
      const now = this.now()
      if (identity === "same") {
        if (!termed) signalGroup(process.pid, "SIGTERM")
        termed = true
        if (!killed && now >= killAt) {
          killed = true
          signalGroup(process.pid, "SIGKILL")
        }
      }
      if (unconfirmed !== (identity === "unknown")) {
        unconfirmed = identity === "unknown"
        this.keepStopping(child, { unconfirmed })
      }
      if (!stuck && killed && now >= killAt + GONE_AFTER_KILL_MS) {
        stuck = true
        this.keepStopping(child, { stuck })
        hostWarn("agents", "a stopped run outlived its kill; it keeps its place until it exits", { child, pid: process.pid })
      }
      await new Promise((resolve) => setTimeout(resolve, stuck || unconfirmed ? STUCK_EVERY_MS : GONE_EVERY_MS))
    }
    if (this.stopped) return
    if (this.terminating.get(child) === process) this.terminating.delete(child)
    const followed = this.followed.get(child)
    const store = this.deps.store()
    if (!followed || !store) return
    const edge = store.edges().of(child)
    if (!edge) return
    const run = edge.run
    if (run?.stopping) {
      const rest: FollowedRun = { ...run }
      delete rest.stopping
      try {
        const kept = store.keepRun(edge, rest)
        if (!kept) return
        followed.edge = kept
      } catch (error) {
        hostWarn("agents", "a stopped run's exit could not be kept", { child, error: errorMessage({ error }) })
      }
    }
    this.deps.changed(followed.edge, false)
  }

  /**
   * Whether a stopped run's pid is still its process: "same" only when its start time is read and matches, the one
   * answer that lets Mako signal it; "other" when it's gone or another process holds the pid; "unknown" when that
   * can't be read, or there's no start time to compare, which keeps its place and signals nothing.
   */
  private async identity(process: NonNullable<FollowedRun["process"]>): Promise<"same" | "other" | "unknown"> {
    if (process.startedAt === undefined) return signalable(process.pid) ? "unknown" : "other"
    const matches = this.deps.processes?.matches ?? PROCESS_READS.matches!
    return matches(process.pid, process.startedAt, this.abort.signal).then(
      (same) => (same ? "same" : "other"),
      () => "unknown",
    )
  }

  /** How a stop stands, kept so the next host knows and its Fin says so: stuck past its kill, or not confirmed. */
  private keepStopping(child: string, patch: { stuck?: boolean; unconfirmed?: boolean }): void {
    const followed = this.followed.get(child)
    const store = this.deps.store()
    const edge = store?.edges().of(child)
    const run = edge?.run
    if (!followed || !store || !edge || !run) return
    const was = run.stopping
    const stuck = patch.stuck ?? was?.stuck === true
    const unconfirmed = patch.unconfirmed ?? was?.unconfirmed === true
    try {
      const kept = store.keepRun(edge, { ...run, stopping: { at: was?.at ?? this.now(), ...(stuck && { stuck: true as const }), ...(unconfirmed && { unconfirmed: true as const }) } })
      if (!kept) return
      followed.edge = kept
    } catch (error) {
      hostWarn("agents", "a stop's standing could not be kept", { child, error: errorMessage({ error }) })
    }
    if (patch.unconfirmed) hostWarn("agents", "a stopped run's process can't be confirmed as its own; it keeps its place, unsignalled", { child, pid: run.process?.pid })
    this.deps.stuck?.(followed.edge)
  }

  /**
   * Stops a followed run so its Session can go on in a conversation Mako
   * drives: its end written as `stopped` (which reports nothing), and settled
   * once its process has exited, so two processes never write the Session.
   * False when Mako can't stop it here or it outlived its kill.
   */
  async handOver(child: string): Promise<boolean> {
    const followed = this.followed.get(child)
    const process = followed?.edge.run?.process
    const pid = process?.pid
    if (pid === undefined || !this.stop(child, "Mako stopped it to hand it a message; its session goes on in a conversation here.")) return false
    const deadline = Date.now() + STOP_GRACE_MS + 2_000
    while (signalable(pid)) {
      if (Date.now() > deadline) return false
      await new Promise((resolve) => setTimeout(resolve, 100))
      const current = this.deps.store()?.edges().of(child)?.run?.process
      if (this.stopped || this.followed.get(child) !== followed || current?.pid !== pid || current.startedAt !== process?.startedAt) return false
    }
    return !this.stopped && this.followed.get(child) === followed && this.deps.store()?.edges().of(child) !== undefined
  }

  /** The last entries of a followed child's Session, for `agents_read`. */
  async tail(child: string, entries: number): Promise<readonly Entry[]> {
    const followed = this.followed.get(child), run = followed?.edge.run
    const path = followed?.reading.session?.path
    if (!followed || !path || !this.current(followed, run)) return []
    const page = await this.deps.catalog.page(path, undefined, entries).catch(() => null)
    if (!this.current(followed, run) || (page && !this.observed(followed, page.ref))) return []
    return page?.entries ?? []
  }

  dispose(): void {
    this.stopped = true
    this.abort.abort()
    this.cancelJob()
    this.unsubscribe()
    for (const followed of this.followed.values()) clearTimeout(followed.timer)
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private requireStore(): ThreadStore {
    const store = this.deps.store()
    if (!store) throw new Error("Children need the Thread store, which didn't open.")
    return store
  }

  /** Follows what the store keeps: an edge another host wrote, or changed, is taken in here. */
  private sync(): void {
    const store = this.deps.store()
    if (!store || this.stopped) return
    const edges = store.edges()
    if (edges === this.seen) return
    this.seen = edges
    const kept = new Set<string>()
    for (const original of edges.all) {
      const run = original.run
      const path = run?.nativeId ? this.deps.catalog.nativePath({ harness: run.harness, nativeId: run.nativeId }) : undefined
      const edge = this.reconcile(original, path ? this.deps.catalog.ref(path) : undefined)
      if (!edge.run) continue
      if (internalDiscoveredRun(edge)) continue
      if (edge.origin === "discovered" && edge.run.nativeAgent?.kind !== "agent" && this.deps.catalog.readRef && !this.originsRead.has(edge.child)) continue
      kept.add(edge.child)
      const followed = this.followed.get(edge.child)
      if (!followed) this.follow(edge)
      else if (JSON.stringify(followed.edge) !== JSON.stringify(edge)) {
        followed.edge = edge
        this.index(followed)
        this.deps.changed(edge, false)
      }
    }
    for (const followed of this.followed.values()) if (!kept.has(followed.edge.child)) {
      this.unfollow(followed)
    }
    this.wantChecks()
  }

  /** Reconcile old discovered edges through provider facts, without stopping the native session or deleting history. */
  private reconcile(edge: ThreadParent, ref: ThreadRef | undefined): ThreadParent {
    if (!edge.run || !ref?.nativeAgent || edge.run.harness !== ref.harness || edge.run.nativeId !== ref.nativeId || JSON.stringify(edge.run.nativeAgent) === JSON.stringify(ref.nativeAgent)) return edge
    return this.requireStore().keepEdge({ ...edge, run: { ...edge.run, nativeAgent: ref.nativeAgent } })
  }

  private internal(ref: ThreadRef): boolean {
    return ref.nativeAgent?.kind === "internal-review" || (this.deps.store()?.edges().internalRuns.some((edge) => edge.run?.harness === ref.harness && edge.run.nativeId === ref.nativeId) ?? false)
  }

  /** The follow instance and run object fence local callbacks; persisted identity fences other owners' replacements. */
  private current(followed: Followed, run: FollowedRun | undefined): ThreadParent | undefined {
    if (this.stopped || !run || this.followed.get(followed.edge.child) !== followed || followed.edge.run !== run) return undefined
    const edge = this.deps.store()?.edges().of(followed.edge.child), kept = edge?.run
    if (!edge || !kept || edge.op !== followed.edge.op || edge.parent !== followed.edge.parent || edge.parentSession !== followed.edge.parentSession || edge.closedAt !== followed.edge.closedAt || kept.harness !== run.harness || kept.nativeId !== run.nativeId || kept.device !== run.device || kept.startedAt !== run.startedAt || kept.process?.pid !== run.process?.pid || kept.process?.startedAt !== run.process?.startedAt || kept.ended?.at !== run.ended?.at || kept.ended?.kind !== run.ended?.kind || kept.stopping?.at !== run.stopping?.at) return undefined
    return edge
  }

  private observed(followed: Followed, ref: ThreadRef): boolean {
    const current = this.current(followed, followed.edge.run)
    if (!current) return false
    followed.edge = this.reconcile(current, ref)
    if (!internalDiscoveredRun(followed.edge)) return true
    this.unfollow(followed)
    this.wantChecks()
    this.deps.changed(followed.edge, false)
    return false
  }

  private unfollow(followed: Followed): void {
    const child = followed.edge.child
    clearTimeout(followed.timer)
    this.followed.delete(child)
    this.terminating.delete(child)
    for (const [key, value] of this.byNative) if (value === child) this.byNative.delete(key)
    for (const [key, value] of this.byPath) if (value === child) this.byPath.delete(key)
  }

  private follow(edge: ThreadParent): Followed {
    const followed: Followed = { edge, reading: {}, counted: 0, lastRead: 0, inFlight: false, again: false, checked: false }
    this.followed.set(edge.child, followed)
    this.index(followed)
    // A stop the last host didn't see through: its process holds its place from now, before anything is drained,
    // until this host has seen it exit, killing it in its turn once its grace is up.
    const run = edge.run
    if (run?.stopping && run.process && run.device === this.deps.store()?.deviceId && !this.terminating.has(edge.child)) {
      this.terminating.set(edge.child, run.process)
      void this.untilGone(edge.child, run.process, run.stopping.at)
    }
    this.wantChecks()
    if (followed.reading.session && !edge.run?.ended) void this.read(followed)
    return followed
  }

  private index(followed: Followed): void {
    const run = followed.edge.run
    if (!run?.nativeId) return
    this.byNative.set(nativeKey(run.harness, run.nativeId), followed.edge.child)
    if (followed.reading.session) return
    const path = this.deps.catalog.nativePath({ harness: run.harness, nativeId: run.nativeId })
    if (!path) return
    const ref = this.deps.catalog.ref(path)
    this.byPath.set(path, followed.edge.child)
    followed.reading = { ...followed.reading, session: sessionOf(path, ref), ...activityOf(this.deps.catalog.activity()[path]) }
  }

  /** Writes how the run ended, once: an end already kept stands. */
  private end(followed: Followed, ended: RunEnd, more: Partial<FollowedRun> = {}): void {
    const store = this.deps.store()
    const run = followed.edge.run
    const current = this.current(followed, run)
    if (!store || !run || run.ended || !current?.run) return
    try {
      const kept = store.keepRun(current, { ...current.run, ...more, ended })
      if (!kept) return
      followed.edge = kept
    } catch (error) {
      hostWarn("agents", "a followed run's end could not be kept", { child: followed.edge.child, error: errorMessage({ error }) })
      return
    }
    this.wantChecks()
    this.deps.changed(followed.edge, false)
    if (followed.edge.run?.ended) this.deps.ended(followed.edge, followed.edge.run.ended)
  }

  /** The process check runs only while a run on this device has no end. */
  private wantChecks(): void {
    const device = this.deps.store()?.deviceId
    let wanted = false
    for (const followed of this.followed.values()) {
      const run = followed.edge.run
      if (run && !run.ended && run.process && run.device === device) wanted = true
    }
    this.demand.set(wanted)
  }

  private async check(): Promise<void> {
    this.sync()
    const device = this.deps.store()?.deviceId
    for (const followed of this.followed.values()) {
      const run = followed.edge.run
      if (!run || run.ended || !run.process || run.device !== device) continue
      const alive = await this.alive(followed, run.process).catch(() => true)
      if (!this.current(followed, run)) continue
      if (alive) {
        followed.gone = undefined
        followed.seenAlive = true
      }
      else if (!(await this.endConfirmed(followed)) || !this.current(followed, run)) continue
      if (alive !== followed.reading.alive) {
        followed.reading = { ...followed.reading, alive }
        this.deps.changed(followed.edge, false)
      }
      if (!alive) await this.settle(followed)
    }
  }

  /**
   * Its process went: whether the run has ended. One that exited under #286's
   * wrapper says so. Otherwise a Session written since runs on: in a process
   * of its Apex's shell that holds it, followed there, or one Mako can't name
   * yet. Only a Session quiet for `END_CONFIRM_MS` after the process went has
   * ended.
   */
  private async endConfirmed(followed: Followed): Promise<boolean> {
    const run = followed.edge.run!
    if (!this.current(followed, run)) return false
    if (run.runDir) return true
    const now = this.now()
    const path = followed.reading.session?.path
    const written = Date.parse((path && this.deps.catalog.ref(path)?.updatedAt) || "") || 0
    followed.gone ??= { at: now, written }
    if (written > followed.gone.written) {
      const successor = await this.successor(followed).catch(() => undefined)
      const store = this.deps.store()
      const current = this.current(followed, run)
      if (!current?.run || current.closedAt !== undefined || current.run.ended) return false
      if (successor && store) {
        const kept = store.keepRun(current, { ...current.run, process: successor })
        if (kept) this.moved(followed, kept, "its session")
        return false
      }
    }
    return now - Math.max(followed.gone.at, written) >= END_CONFIRM_MS
  }

  /** Another process of its Apex's shell that holds its Session's file: the same chat, resumed. */
  private async successor(followed: Followed): Promise<FollowedRun["process"] | undefined> {
    const run = followed.edge.run
    const path = followed.reading.session?.path
    const gone = followed.edge.run?.process?.pid
    if (!path) return undefined
    const reads = this.deps.processes ?? PROCESS_READS
    const marked = (await reads.marked(SESSION_VARIABLE, this.abort.signal))
      .filter((process) => process.value === followed.edge.parentSession && process.pid !== gone)
    if (!this.current(followed, run)) return undefined
    if (!marked.length) return undefined
    const holding = await reads.holding(path, marked.map((process) => process.pid), this.abort.signal)
    if (!this.current(followed, run)) return undefined
    const found = marked.find((process) => holding.has(process.pid))
    if (!found) return undefined
    const startedAt = await reads.startedAt(found.pid, this.abort.signal).catch(() => undefined)
    if (!this.current(followed, run)) return undefined
    return { pid: found.pid, ...(startedAt !== undefined && { startedAt }) }
  }

  private async alive(followed: Followed, process: NonNullable<FollowedRun["process"]>): Promise<boolean> {
    const run = followed.edge.run
    if (followed.checked) return signalable(process.pid)
    const alive = await processIdentityMatches({ pid: process.pid, startedAt: process.startedAt, exact: process.startedAt !== undefined, signal: this.abort.signal })
    if (this.current(followed, run)) followed.checked = true
    return alive
  }

  /** Its process has gone: how it went, from the status #286's wrapper wrote, else from what its Session last shows. */
  private async settle(followed: Followed): Promise<void> {
    const run = followed.edge.run
    if (!run || !this.current(followed, run)) return
    const status = run.runDir ? await readFile(join(run.runDir, "exit"), "utf8").then((text) => Number(text.trim()), () => undefined) : undefined
    if (!this.current(followed, run)) return
    await this.read(followed)
    if (!this.current(followed, run)) return
    const last = await this.lastEntries(followed)
    if (!this.current(followed, run)) return
    const summary = finalSummary(last)
    const toolUses = followed.reading.toolUses
    const at = this.now()
    const counted = toolUses ? { toolUses } : {}
    if (status === 0) return this.end(followed, { at, kind: "done", ...(summary && { detail: summary }), ...counted })
    if (status !== undefined && Number.isFinite(status)) {
      const error = run.runDir ? await lastLine(join(run.runDir, "errors.log")) : undefined
      if (!this.current(followed, run)) return
      return this.end(followed, { at, kind: "failed", detail: `It exited with code ${status}${error ? `: ${error}` : "."}`, ...counted })
    }
    if (summary && last.at(-1)?.type === "text") return this.end(followed, { at, kind: "done", detail: summary, ...counted })
    const detail = followed.seenAlive ? "Its process ended without saying how it went." : "Its process ended while Mako wasn't running: a quit, a crash, or this Mac shutting down or restarting."
    this.end(followed, { at, kind: "unknown", detail, ...counted })
  }

  private async lastEntries(followed: Followed): Promise<readonly Entry[]> {
    const run = followed.edge.run
    const path = followed.reading.session?.path
    if (!path) return []
    const page = await this.deps.catalog.page(path, undefined, TAIL_ENTRIES).catch(() => null)
    if (!this.current(followed, run) || (page && !this.observed(followed, page.ref))) return []
    return page?.entries ?? []
  }

  private catalogEvent(event: HostEvent): void {
    if (this.stopped) return
    if (event.type === "thread-activity") {
      const child = this.byPath.get(event.path)
      const followed = child ? this.followed.get(child) : undefined
      if (!followed) return
      const activity = activityOf(event.activity ?? undefined).activity
      if (activity === followed.reading.activity) return
      followed.reading = { ...followed.reading, activity }
      this.deps.changed(followed.edge, false)
      return
    }
    if (event.type === "thread-ref") return this.refChanged(event.ref)
    if (event.type === "threads") {
      for (const followed of this.followed.values()) if (!followed.reading.session) this.index(followed)
      for (const ref of event.threads) this.refChanged(ref)
    }
  }

  private refChanged(ref: ThreadRef): void {
    if (this.internal(ref) && this.deps.store()?.edges().internalRuns.some((edge) => edge.run?.harness === ref.harness && edge.run.nativeId === ref.nativeId)) return
    const original = this.deps.store()?.edges().byRun(ref.harness, ref.nativeId)
    if (original && internalDiscoveredRun(this.reconcile(original, ref))) {
      const followed = this.followed.get(original.child)
      if (followed) this.unfollow(followed)
      this.wantChecks()
      this.deps.changed(original, false)
      return
    }
    const child = this.byNative.get(nativeKey(ref.harness, ref.nativeId)) ?? this.byPath.get(ref.path)
    const followed = child ? this.followed.get(child) : undefined
    if (followed) {
      const edge = this.reconcile(followed.edge, ref)
      if (internalDiscoveredRun(edge)) {
        this.unfollow(followed)
        this.wantChecks()
        this.deps.changed(edge, false)
        return
      }
      followed.edge = edge
      if (followed.reading.session?.path !== ref.path) {
        this.byPath.set(ref.path, followed.edge.child)
        followed.reading = { ...followed.reading, session: sessionOf(ref.path, ref) }
      }
      this.schedule(followed)
      return
    }
    if (ref.nativeAgent?.kind === "internal-review" || ref.parent || ref.childOf || !this.deps.runs(ref.harness)) return
    const started = Date.parse(ref.startedAt ?? "")
    if (!Number.isFinite(started) || this.now() - started > DISCOVER_MS) return
    this.discover(ref, started)
  }

  /** A new Session a conversation's shell started: the marked process that holds it, or that started with it in its folder. */
  private discover(ref: ThreadRef, started: number): void {
    const key = nativeKey(ref.harness, ref.nativeId)
    if (this.discovering.has(key)) return
    this.discovering.add(key)
    this.discoveries = this.discoveries.then(async () => {
      if (this.stopped || this.deps.conversationOwns(ref)) return
      const reads = this.deps.processes ?? PROCESS_READS
      const marked = await reads.marked(SESSION_VARIABLE, this.abort.signal)
      if (!marked.length) return
      const pids = marked.map((process) => process.pid)
      const holding = await reads.holding(ref.path, pids, this.abort.signal)
      let found = marked.find((process) => holding.has(process.pid))
      let startedAt: number | undefined
      if (!found) {
        const folders = await reads.folders(pids, this.abort.signal)
        let best: number | undefined
        for (const process of marked) {
          if (folders.get(process.pid) !== ref.cwd) continue
          const at = await reads.startedAt(process.pid, this.abort.signal).catch(() => undefined)
          if (at === undefined || Math.abs(at - started) > DISCOVER_START_MS || (best !== undefined && at < best)) continue
          best = at
          found = process
        }
        startedAt = best
      }
      if (!found) return
      startedAt ??= await reads.startedAt(found.pid, this.abort.signal).catch(() => undefined)
      // A conversation's own harness carries the marker too, and writes its new Session before its driver names it.
      if (this.stopped || this.deps.conversationOwns(ref, found.value) || !this.deps.store()?.conversationsOf(found.value).length) return
      const adopted = await this.adopt({
        parentSession: found.value,
        ref,
        origin: "discovered",
        process: { pid: found.pid, ...(startedAt !== undefined && { startedAt }) },
        startedBy: { kind: "agent", session: SessionIdSchema.parse(found.value) },
      })
      if ("refused" in adopted) hostLog("agents", "a run its shell started was not taken in", { harness: ref.harness, refused: adopted.refused })
    }).catch((error) => {
      if (!this.stopped) hostWarn("agents", "a new session's process could not be read", { harness: ref.harness, error: errorMessage({ error }) })
    }).finally(() => this.discovering.delete(key))
  }

  /** A tail read soon, at most `tailReadEvery` apart for each run. */
  private schedule(followed: Followed): void {
    if (followed.inFlight) {
      followed.again = true
      return
    }
    if (followed.timer) return
    const wait = followed.lastRead + tailReadEvery(this.following()) - this.now()
    if (wait <= 0) {
      void this.read(followed)
      return
    }
    followed.timer = setTimeout(() => {
      followed.timer = undefined
      void this.read(followed)
    }, wait)
    followed.timer.unref()
  }

  /** Reads its Session's tail: the step it shows and the calls made since the last read. */
  private async read(followed: Followed): Promise<void> {
    let run = followed.edge.run
    const path = followed.reading.session?.path
    if (!path || !this.current(followed, run)) return
    followed.inFlight = true
    followed.lastRead = this.now()
    try {
      const page = await this.deps.catalog.page(path, undefined, TAIL_ENTRIES)
      if (!page || !this.current(followed, run) || !this.observed(followed, page.ref)) return
      run = followed.edge.run
      let toolUses = followed.reading.toolUses ?? 0
      if (page.start > followed.counted) toolUses += await this.countBefore(path, followed.counted, page.start)
      if (!this.current(followed, run)) return
      const from = Math.max(followed.counted, page.start)
      for (const entry of page.entries.slice(from - page.start)) if (entry.type === "tool") toolUses += 1
      followed.counted = Math.max(followed.counted, page.start + page.entries.length)
      const step = lastStep(page.entries, followed.edge.run?.harness ?? page.ref.harness)
      const updatedAt = Date.parse(page.ref.updatedAt ?? "")
      followed.reading = {
        ...followed.reading,
        session: { path, ...(Number.isFinite(updatedAt) && { updatedAt }), ...(page.ref.title && { title: page.ref.title }) },
        ...(step && { step }),
        ...(toolUses && { toolUses }),
      }
      this.deps.changed(followed.edge, true)
    } catch (error) {
      if (!this.stopped) hostWarn("agents", "a followed run's session could not be read", { child: followed.edge.child, error: errorMessage({ error }) })
    } finally {
      followed.inFlight = false
      if (followed.again) {
        followed.again = false
        this.schedule(followed)
      }
    }
  }

  /** Calls among entries `[from, to)`, read a page at a time: once for each run, when the host first reads it. */
  private async countBefore(path: string, from: number, to: number): Promise<number> {
    let count = 0
    let before = to
    while (before > from && !this.stopped) {
      const page = await this.deps.catalog.page(path, before, Math.min(COUNT_PAGE, before - from))
      if (!page || !page.entries.length) break
      for (const [index, entry] of page.entries.entries()) if (page.start + index >= from && entry.type === "tool") count += 1
      before = page.start
    }
    return count
  }
}

function nativeKey(harness: string, nativeId: string): string {
  return `${harness}\n${nativeId}`
}

function sessionOf(path: string, ref: ThreadRef | undefined): NonNullable<RunReading["session"]> {
  const updatedAt = Date.parse(ref?.updatedAt ?? "")
  return { path, ...(Number.isFinite(updatedAt) && { updatedAt }), ...(ref?.title && { title: ref.title }) }
}

function activityOf(activity: { status: "active" | "needs-input" | "open" } | undefined): Pick<RunReading, "activity"> {
  return { activity: activity?.status }
}

function clip(text: string, limit: number): string {
  const line = text.replace(/\s+/g, " ").trim()
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line
}

/** What its Session last shows it doing, worded as the transcript's tool rows are (`identifyTool`). */
export function lastStep(entries: readonly Entry[], harness: string): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!
    if (entry.type === "tool") {
      const identity = identifyTool({ harness, name: entry.name, input: entry.input, acpKind: entry.toolKind, title: entry.title })
      return clip(toolPhrase(identity, entry.status === "pending" || entry.status === "running"), STEP_CHARS)
    }
    if (entry.type === "thinking") return "Thinking"
    if (entry.type === "text" && entry.text.trim()) return clip(entry.text.replace(/^[#>*\-\s]+/, ""), STEP_CHARS)
    // A message and nothing after it: the turn has begun, and nothing has come of it yet.
    if (entry.type === "user") return "Thinking"
  }
  return undefined
}

/** The start of its last reply, which a finished run shows as how it went. */
function finalSummary(entries: readonly Entry[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!
    if (entry.type === "text" && entry.text.trim()) return clip(entry.text.replace(/^[#>*\-\s]+/, ""), SUMMARY_CHARS)
    if (entry.type === "user") return undefined
  }
  return undefined
}

async function lastLine(file: string): Promise<string | undefined> {
  const handle = await open(file, "r").catch(() => undefined)
  if (!handle) return undefined
  try {
    const { size } = await handle.stat()
    const length = Math.min(size, 4_096)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, size - length)
    const line = buffer.toString("utf8").split("\n").map((part) => part.trim()).filter(Boolean).at(-1)
    return line ? clip(line, 400) : undefined
  } finally {
    await handle.close()
  }
}

function signalable(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM"
  }
}

/** Whether any process of the group `pid` leads still runs; false for one that leads none. */
function groupRuns(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM"
  }
}

/** Its process group when it leads one, else the process alone. */
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
    return
  } catch {
    // Not a group leader: a run its own shell started.
  }
  try {
    process.kill(pid, signal)
  } catch {
    // Already gone.
  }
}
