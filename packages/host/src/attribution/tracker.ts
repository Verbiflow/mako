import {
  ActivityMarkSchema,
  MakoWriteSchema,
  ReportedCallSchema,
  TrackedRootSchema,
  type ActivityMark,
  type Attribution,
  type AttributionTracker,
  type Author,
  type ChangeKind,
  type ContentRef,
  type FootprintEntry,
  type Gap,
  type JournalEntry,
  type LineRun,
  type LossReason,
  type MakoWrite,
  type MakoWriting,
  type ObservedBy,
  type ReportedCall,
  type ReportedEffect,
  type RootPath,
  type TrackedRoot,
  type TrackerFileStat,
  type TrackerPorts,
} from "@mako/protocol/attribution"
import { join } from "node:path"
import { inSlices, StepsStopped } from "@mako/sessions/slices"
import { HourCounts } from "../base/hour-counts.js"
import type { RescanFootprint } from "../contracts/mako-footprint.js"
import { contentRef, decodeText, hasher, isText, READ_LIMIT, secretPath, STORE_LIMIT } from "./content.js"
import { attribute, authorOf, claim, Evidence, LEAD_MS, reaches as reachesChange, TRAIL_MS, type Interval, type ObservedChange, type Reach } from "./evidence.js"
import { WorkingSets } from "./working-set.js"
import { StatCache } from "./stat-cache.js"
import { collectPlanOffThread, JournalReader } from "./journal-reader.js"
import { JournalStore, wholeChange, type FileState, type Recency, type StatRow, type ActivityKey, type Collected, type Row, type StoredActivity, type StoredEntry, type StoredRoot } from "./journal-store.js"
import { diffLines, splitLines } from "./line-diff.js"
import { applyHunks, BASE, baseMap, onlyBase, presentLines, presentRuns, rebase, UNKNOWN, withKnownWriters, withWriter, writers, type Run } from "./line-map.js"
import { FootprintReader, type FootprintOptions } from "./footprint-reader.js"
import type { FootprintTurn } from "./footprint.js"
import { untrackable, within } from "./paths.js"
import { ranTexts, SCRIPT_LIMIT } from "./scripts.js"
import { lagSummary } from "./status.js"
import { writtenLines } from "./written.js"

/** What the tracker needs of Git for a root that is a repository; a root that isn't one tracks without it. */
export interface TrackerRepository {
  /** The commit checked out; null before the first commit. */
  head(): Promise<string | null>
  /** Files Git tracks, untracked files it doesn't ignore, and tracked files that differ from HEAD, relative to the root. */
  inventory(): Promise<{ tracked: string[]; untracked: string[]; changed: string[] }>
  /** Of `paths`, those Git ignores. */
  ignored(paths: readonly string[]): Promise<Set<string>>
  /** What Git ignores under the root: a folder it ignores whole once, ending in `/`, without what's in it; else single files. A repository without it is walked whole. */
  ignoredEntries?(): Promise<string[]>
  /** A file's content at a commit; null when it isn't there. */
  read(commit: string, path: string): Promise<Uint8Array | null>
  /** Paths that differ between two commits; every path at `to` when `from` is null. */
  changed(from: string | null, to: string): Promise<string[]>
  /** HEAD moving where the root's own watch can't hear it, such as a linked worktree's Git folder. */
  watchHead?(moved: () => void): { close(): void }
}

export interface TrackerOptions {
  repository?(root: string): Promise<TrackerRepository | null>
  /** How long content no uncommitted line needs is kept. Default 14 days. */
  retentionMs?: number
  /** How long a root nobody changed or worked around stays awake before it sleeps (`sleepIdle`). Default 6 hours. */
  sleepAfterMs?: number
  /** The most kept content may take, compressed. Default 2 GB. */
  budgetBytes?: number
  /** Where a turn's footprint is read from (the home folder and temporary folders), and what the host knows to leave out. */
  footprint?: FootprintOptions
  /** A change heard live came out uncertain while these Sessions were running: their child agents' records may name its author. */
  uncertain?(sessions: ReadonlySet<string>): void
  /** An agent this host doesn't run, working now where `path` (absolute, in `root`) is, in a few words; undefined when there's none. */
  outsider?(path: string, root: string): string | undefined | Promise<string | undefined>
  /** One line per flush, at most every `LOG_EVERY_MS`, and every slow one. Paths, never content. */
  log?(message: string, facts: Readonly<Record<string, string | number | boolean>>): void
  /**
   * How late the watcher delivers now. A change heard that late is still
   * dated by its modification time, and what ran is kept that much longer
   * for it to reach.
   */
  deliveryLagMs?(): number
}

/** Events for a root are gathered this long before they're read, so a burst is one flush. */
const DEBOUNCE_MS = 8
/** A steady stream still flushes this often. */
const MAX_DELAY_MS = 30
/** Files stat-ed and read at once. */
const PARALLEL = 32
/** A change stays open to new evidence this long, and until every call that spans it has ended. */
export const SETTLE_MS = 10_000
/** A stat cached within this of the file's own modification can't tell a later write in the same tick. */
const RACY_NS = 2_000_000_000n
/** The system's history position is saved this often while changes come in. */
const MARK_EVERY_MS = 60_000
/** A HEAD check waits for Git to finish writing. */
const HEAD_DEBOUNCE_MS = 150
/** Files heard while Git writes wait at most this long for the HEAD check, however long Git keeps writing. */
const HEAD_HOLD_MS = 2_000
/** Entries heard this long before Git's own files moved may be what it wrote: Git writes the files first, HEAD and the index last. */
const GIT_LOOKBACK_MS = 2_000
/** Entries kept in memory for telling what Git wrote, per root, at most. */
const RECENT_KEPT = 4096
const LOG_EVERY_MS = 10_000
const SLOW_FLUSH_MS = 50
/** Attribution holds the host's one thread at most this long a turn, give or take one change per job, before sockets and timers get one. */
const SLICE_MS = 8
const yieldTurn = () => new Promise<void>((resolve) => setImmediate(resolve))
/** A tracker's sliced jobs under way: each root's journaling, a reattribution pass, settling. */
interface Slicing {
  jobs: number
}

/**
 * One job's share of a turn. A turn wakes every job waiting on it back to
 * back, so their slices add up: each takes `SLICE_MS` split between them,
 * and at least one unit of work.
 */
class Slice {
  private started = performance.now()
  private open = true
  private readonly slicing: Slicing

  constructor(slicing: Slicing) {
    this.slicing = slicing
    slicing.jobs++
  }

  get spent(): boolean {
    return performance.now() - this.started >= SLICE_MS / Math.max(1, this.slicing.jobs)
  }

  async next(): Promise<void> {
    await yieldTurn()
    this.restart()
  }

  /** A turn of its own began. */
  restart(): void {
    this.started = performance.now()
  }

  done(): void {
    if (this.open) this.slicing.jobs--
    this.open = false
  }
}
const DAY_MS = 86_400_000
/** A command's named paths the journal keeps, for the Thread's working set. */
const STORED_NAMED = 64
/** While losses keep coming, each rescan waits at least this long after the last, doubling per loss up to `RESCAN_MAX_MS`. */
const RESCAN_MIN_MS = 2_000
const RESCAN_MAX_MS = 10 * 60_000
/** A loss this long after the last rescan is rescanned at once. */
const RESCAN_QUIET_MS = 15 * 60_000
/** After each rescan, any root's next waits this many times as long as it ran: rescans take at most a twentieth of the time. */
const RESCAN_REST = 19
/** Blobs dropped in one transaction of a collection: the owner's other writes wait no longer than that. */
const COLLECT_BATCH = 200
/** Rows of activity scanned at once for what changed in a gap: about 15 ms on a journal the size of the person's. */
const ACTIVITY_PAGE = 2_000
/** How long a root nobody changed or worked around stays awake: it sleeps after, and the next turn there wakes it. */
const SLEEP_AFTER_MS = 6 * 60 * 60_000
/** How many times `whatWasHeard` journals what flushing turned up (a folder that came stands for its files) before it answers. */
const HEARD_PASSES = 3
/** Spacing past which a root is reported as rescanned less often because its losses keep coming. */
const BACKED_OFF_MS = 60_000

interface Flush {
  at: number
  files: number
  entries: number
  /** From the first event heard to the journal's commit. */
  lagMs: number
  statMs: number
  hashMs: number
  diffMs: number
  writeMs: number
  slowest?: string
}

interface RootState {
  root: StoredRoot
  repo: TrackerRepository | null
  stats: StatCache
  files: Map<string, FileState>
  /** Paths Git tracked when tracking began, the only ones kept in build folders. */
  tracked: Set<string>
  watch?: { close(): void }
  headWatch?: { close(): void }
  pending: Map<string, ObservedBy>
  /** Paths Git ignores that a Thread's own write named, not yet journaled: those are kept like any file. */
  adopted: Set<string>
  firstHeard: number
  timer?: ReturnType<typeof setTimeout>
  /** Every flush and HEAD check for the root, one after another. */
  chain: Promise<void>
  /** Lost events not yet rescanned. */
  gap?: { id: number; from: number; reason: Gap["reason"] }
  muted: boolean
  /** What Git ignored when last asked, and how many times a `.gitignore`, Git's exclude file, the index or HEAD had moved by then. */
  ignored?: GitIgnored & { moves: number }
  /** Times a `.gitignore`, Git's exclude file, the index or HEAD moved: a listing taken at fewer is stale. */
  ignoreMoves: number
  /** The next rescan for lost events: waiting out its spacing, on the queue, running, or wanted again once the running one ends. */
  rescanTimer?: ReturnType<typeof setTimeout>
  rescanQueued: boolean
  rescanning: boolean
  rescanAgain: boolean
  /** When the last rescan ended, and the spacing the next one keeps after it. */
  rescannedAt: number
  rescanEvery: number
  losses: HourCounts
  headTimer?: ReturnType<typeof setTimeout>
  /**
   * Asleep: not watched, its stat cache and tracked paths let go (`sleep`), its uncommitted files kept. It's still
   * tracked: the next `track` wakes it as a restart resumes it, from its history or a rescan since it fell asleep.
   */
  asleep?: boolean
  /** How many times `track` asked for this root: a sleep it asked during, while the watch was closed, doesn't go ahead. */
  tracks: number
  /**
   * When Git's own files (HEAD, the index, a branch) began moving, until the
   * HEAD check that follows: file flushes wait for it, so what a checkout,
   * pull or rebase wrote is read against the commit it wrote.
   */
  gitSince?: number
  /** What the HEAD move just checked changed, by path: the new commit's content, null where it has none. The flush held behind it takes a file holding exactly that as its base. */
  moved?: Map<string, ContentRef | null>
  /** The newest entries, a few seconds' worth, oldest first: what Git may have written before HEAD moved. */
  recent: { seq: number; path: string; at: number }[]
  /** The last entry before the base last moved: a clean file brought back to a version after it gets that version's writers back. */
  headSeq: number
  /** The history position taken last, saved once the next is taken: by then everything before it has been heard. */
  markTaken?: { mark: string; at: number }
  markTimer?: ReturnType<typeof setTimeout>
}

/** What Git ignores in a root, as `ignoredEntries` lists it: folders it ignores whole, and single files, relative to the root. */
interface GitIgnored {
  folders: Set<string>
  files: Set<string>
}

/** Whether Git ignores `path`: it's listed, or it's inside a folder Git ignores whole. */
function ignoredByGit(ignored: GitIgnored, path: string): boolean {
  if (ignored.files.has(path) || ignored.folders.has(path)) return true
  for (let at = path.lastIndexOf("/"); at > 0; at = path.lastIndexOf("/", at - 1)) if (ignored.folders.has(path.slice(0, at))) return true
  return false
}

/** Whether `glob` may match `path` or something under it: always, for one that starts with a wildcard. */
function mayReach(glob: string, path: string): boolean {
  if (globMatch(glob, path)) return true
  const star = glob.indexOf("*")
  const literal = star < 0 ? glob : glob.slice(0, star)
  return literal.startsWith(`${path}/`) || `${path}/`.startsWith(literal)
}

/** A change whose author may still improve, with the texts its evidence is checked against. */
interface Pending {
  seq: number
  change: ObservedChange
  author: Attribution
  /** Marked as Git's (`StoredEntry.git`) until a call is found to have named the file. */
  git?: boolean
}

/** What one flush found for one path. */
interface Observed {
  path: string
  kind: "gone" | "file"
  stat?: TrackerFileStat
  bytes?: Uint8Array
  ref?: ContentRef
  text?: boolean
}

const mapLimit = async <T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> => {
  const out: R[] = []
  let next = 0
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await run(items[i]!)
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

const sameFile = (one: TrackerFileStat, other: TrackerFileStat) =>
  one.dev === other.dev && one.ino === other.ino && one.size === other.size && one.mtimeNs === other.mtimeNs && one.ctimeNs === other.ctimeNs
/** The same content as the stat cache recorded: a status change alone (a `chmod`) leaves these as they were. */
const sameContent = (row: StatRow, stat: TrackerFileStat) => row.dev === stat.dev && row.ino === stat.ino && row.size === stat.size && row.mtimeNs === stat.mtimeNs
const sameStat = (row: StatRow, stat: TrackerFileStat) =>
  row.dev === stat.dev && row.ino === stat.ino && row.size === stat.size && row.mtimeNs === stat.mtimeNs && row.ctimeNs === stat.ctimeNs

const relative = (root: string, path: string) => path.slice(root.length + 1)
/** The file a tool puts in a folder it owns as a cache (https://bford.info/cachedir/). */
const CACHE_TAG = "CACHEDIR.TAG"
const nanos = (ms: number) => BigInt(Math.round(ms)) * 1_000_000n
const millis = (ns: bigint) => Number(ns / 1_000_000n)

const isGitPath = (path: string) => path === ".git" || path.startsWith(".git/")

/** Under `.git/`, what moves when HEAD or the index does; objects and locks don't. */
const GIT_HEAD = /^\.git\/(HEAD|index|packed-refs|ORIG_HEAD|logs\/HEAD|refs\/heads\/)/

/**
 * The laptop's tracker: one journal over every tracked root, fed by the
 * watcher, with each change's author from the evidence the host reports.
 * Everything it reads of the machine goes through its ports, so the same
 * engine runs over a fake file system in the conformance suite.
 */
export class LaptopTracker implements AttributionTracker {
  readonly store: JournalStore
  /** Reads too big for this thread, on a worker of their own. */
  private readonly reader: JournalReader
  private readonly ports: TrackerPorts
  private readonly options: TrackerOptions
  private readonly states = new Map<string, RootState>()
  /** Each folder's `track` under way, by path, and each root `open` is still resuming. */
  private readonly tracking = new Map<string, Promise<void>>()
  /** The roots `open` resumes, one after another, after it returns. */
  private resuming: Promise<void> = Promise.resolve()
  /** Set by `close`: no root starts resuming after it. */
  private closing = false
  readonly evidence: Evidence
  private readonly pending = new Map<number, Pending>()
  private settleTimer?: ReturnType<typeof setTimeout>
  private readonly slicing: Slicing = { jobs: 0 }
  /** A backlog settling: its share of each turn, and its next slice. */
  private settleSlice?: Slice
  private settleNext?: ReturnType<typeof setImmediate>
  private reattribution?: Promise<void>
  /** The reaches the pass under way weighs, and the last seq it got to. */
  private round?: { reaches: readonly Reach[]; done: number }
  /** Reads that may still name an open change's author. */
  private holds = 0
  /** Reads under way of what reported commands ran (`readScripts`). */
  private readonly scriptReads = new Set<Promise<void>>()
  /** Each turn's footprint outside the tracked roots, and the machine's learned churn. */
  readonly footprints?: FootprintReader
  private readonly flushes: Flush[] = []
  private logged = 0
  private unlogged: Flush[] = []
  private closed = false
  /** The rescans for lost events, each root's in turn (`rescanTurn`), and the rests between them that `settled` wakes. */
  private rescanTurns: Promise<void> = Promise.resolve()
  private readonly waking = new Set<() => void>()
  private settling = 0
  private readonly rescans = { done: new HourCounts(), files: new HourCounts(), ms: new HourCounts() }
  /** The last entry's number. */
  private seq: number

  private constructor(ports: TrackerPorts, options: TrackerOptions, store: JournalStore) {
    this.ports = ports
    this.options = options
    this.store = store
    this.reader = new JournalReader(store.path)
    this.evidence = new Evidence(new WorkingSets((thread) => store.activityOfThread(thread)))
    this.seq = store.lastSeq()
    if (options.footprint)
      this.footprints = new FootprintReader({
        ports,
        store,
        tracked: () => [...this.states.values()].map((state) => state.root.path),
        options: options.footprint,
        log: (message, facts) => this.log(message, facts),
      })
  }

  get journal(): string {
    return this.store.id
  }

  /**
   * Open the journal in `ports.storage` and resume every root it tracked,
   * catching up from the system's history. The journal is open as soon as
   * its file is: catching a large checkout up takes a minute and more, and
   * the turns that run meanwhile must still be heard. The roots resume one
   * after another behind it; `track` on one waits for its resume, and
   * `settled` for them all.
   */
  static async open(ports: TrackerPorts, options: TrackerOptions = {}): Promise<LaptopTracker> {
    const store = JournalStore.open(join(ports.storage, "journal.sqlite"), { device: ports.device })
    const tracker = new LaptopTracker(ports, options, store)
    const roots = store.roots().filter((root) => root.active)
    const lastSeen = Math.max(0, ...roots.map((root) => root.seenAt))
    // Whatever was running when the last host stopped ran until it was last seen.
    if (lastSeen) store.closeOpenActivity(lastSeen)
    let previous = Promise.resolve()
    const quiet = tracker.now() - (options.sleepAfterMs ?? SLEEP_AFTER_MS)
    for (const root of roots) {
      // Unseen for longer than a root stays awake (it was asleep when the host stopped, or the host was away that
      // long): it starts asleep, and the next turn there wakes it.
      const resumed = previous.then(() => (root.seenAt < quiet ? tracker.restOrLetGo(root) : tracker.resumeOrLetGo(root)))
      tracker.tracking.set(root.path, resumed)
      void resumed.then(() => {
        if (tracker.tracking.get(root.path) === resumed) tracker.tracking.delete(root.path)
      })
      previous = resumed
    }
    tracker.resuming = previous
    return tracker
  }

  /** Resume a root `open` found; one that can't be watched again (its folder went while the host was away) is let go. */
  private async resumeOrLetGo(root: StoredRoot): Promise<void> {
    if (this.closing) return
    try {
      await this.resume(root)
    } catch (error) {
      this.states.get(root.id)?.watch?.close()
      this.states.delete(root.id)
      this.store.forgetRoot(root.id)
      this.options.log?.("a root could not be resumed", { root: root.path, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** A root `open` found long unseen, kept asleep; one whose folder went is let go, as a resume would. */
  private async restOrLetGo(root: StoredRoot): Promise<void> {
    if (this.closing) return
    if ((await this.ports.fs.stat(root.path))?.kind !== "directory") {
      this.store.forgetRoot(root.id)
      this.options.log?.("a root could not be resumed", { root: root.path, error: "The folder is gone." })
      return
    }
    const files = new Map(this.store.files().filter((file) => file.root === root.id).map((file) => [file.path, file]))
    this.state(root, null, new StatCache(), files).asleep = true
  }

  private now(): number {
    return this.ports.clock.now()
  }

  private lateMs(): number {
    return Math.max(0, this.options.deliveryLagMs?.() ?? 0)
  }

  /**
   * Track a root. Calls for one folder while one is under way wait for it,
   * since the root is stored only once its baseline is: two would each watch
   * the folder and journal every change twice.
   */
  track(input: TrackedRoot): Promise<void> {
    const root = TrackedRootSchema.parse(input)
    const running = this.tracking.get(root.path)
    if (running) return running.catch(() => undefined).then(() => this.track(root))
    const started = this.startTracking(root).finally(() => this.tracking.delete(root.path))
    this.tracking.set(root.path, started)
    return started
  }

  private async startTracking(root: TrackedRoot): Promise<void> {
    const known = this.store.roots().find((stored) => stored.id === root.id || stored.path === root.path)
    if (known?.active && known.path === root.path) {
      const state = this.states.get(known.id)
      if (state) state.tracks++
      if (!state || state.asleep) {
        if (state?.asleep) this.log("woke a root", { root: known.path, sleptMs: this.now() - known.seenAt })
        await this.resume({ ...known, carry: root.carry })
      }
      return
    }
    if (known) this.store.forgetRoot(known.id)
    const repo = (await this.options.repository?.(root.path)) ?? null
    const mark = await this.ports.events.mark().catch(() => null)
    const head = repo ? await repo.head() : null
    const stored: StoredRoot = { ...root, repository: Boolean(repo), head, mark, seenAt: this.now(), trackedAt: this.now(), active: true }
    const state = this.state(stored, repo, new StatCache(), new Map())
    await this.listen(state)
    await this.queue(state, () => this.baseline(state))
  }

  async untrack(id: string): Promise<void> {
    const state = this.states.get(id)
    if (!state) return
    this.states.delete(id)
    this.unlisten(state)
    await state.chain
    // Nothing is tracked here after this, so nothing more can be lost.
    if (state.gap) this.store.closeGap(state.gap.id, this.now())
    this.store.forgetRoot(id)
  }

  private state(root: StoredRoot, repo: TrackerRepository | null, stats: StatCache, files: Map<string, FileState>): RootState {
    const state: RootState = {
      root, repo, stats, files, tracked: new Set(), pending: new Map(), adopted: new Set(), firstHeard: 0, chain: Promise.resolve(), muted: false, recent: [], headSeq: this.seq,
      ignoreMoves: 0, rescanQueued: false, rescanning: false, rescanAgain: false, rescannedAt: -Infinity, rescanEvery: 0, losses: new HourCounts(), tracks: 0,
    }
    const replaced = this.states.get(root.id)
    if (replaced) this.unlisten(replaced)
    this.states.set(root.id, state)
    return state
  }

  private async resume(root: StoredRoot): Promise<void> {
    if ((await this.ports.fs.stat(root.path))?.kind !== "directory") throw new Error("The folder is gone.")
    const repo = root.repository ? ((await this.options.repository?.(root.path)) ?? null) : null
    const files = new Map(this.store.files().filter((file) => file.root === root.id).map((file) => [file.path, file]))
    const state = this.state(root, repo, this.store.stats(root.id), files)
    for (const path of state.stats.keys()) state.tracked.add(path)
    const from = root.seenAt
    const gap = this.store.openGap(root.id, from, "restart")
    state.gap = { id: gap, from, reason: "restart" }
    /*
     * The catch-up is the first task on the root's queue, so nothing the new
     * watch says is acted on before the history is read: the system reports
     * a change made just before the watch started up to seconds late, as a
     * live event, and that change belongs to the gap, not to whatever runs
     * now. A watch that starts deaf rescans after it.
     */
    const listening = this.listen(state)
    const caughtUp = this.queue(state, async () => {
      // A root that can't be watched again is let go, from `listening` below.
      if (!(await listening.then(() => true, () => false))) {
        this.store.closeGap(gap, this.now())
        return
      }
      const history = root.mark ? await this.ports.events.since(root.mark, root.path).catch(() => null) : null
      try {
        // HEAD first, so what a checkout or pull wrote while no host ran is read as the base it is.
        if (repo) state.moved = await this.headChecked(state)
        await this.settleCommitted(state)
        if (history?.complete) {
          const paths = history.paths.filter((path) => within(root.path, path) && path !== root.path).map((path) => relative(root.path, path))
          for (const path of paths) if (!isGitPath(path)) state.pending.set(path, "history")
          await this.flush(state)
          this.store.closeGap(gap, this.now())
          state.gap = undefined
        } else await this.rescan(state)
      } finally {
        state.moved = undefined
      }
    })
    await listening
    await caughtUp
  }

  private async listen(state: RootState): Promise<void> {
    state.watch = await this.ports.events.watch(state.root.path, {
      changed: (paths) => this.heard(state, paths),
      lost: (reason) => this.lost(state, reason),
      heard: () => {
        if (!state.muted) return
        state.muted = false
        this.rescanSoon(state)
      },
    })
    state.headWatch = state.repo?.watchHead?.(() => this.headMoved(state))
  }

  private unlisten(state: RootState): void {
    state.watch?.close()
    state.headWatch?.close()
    clearTimeout(state.timer)
    clearTimeout(state.headTimer)
    clearTimeout(state.markTimer)
    clearTimeout(state.rescanTimer)
    state.rescanTimer = undefined
  }

  private heard(state: RootState, paths: readonly string[]): void {
    // A state replaced for its root, however that came about, journals nothing more; nor one asleep, which its wake catches up.
    if (this.closed || state.asleep || this.states.get(state.root.id) !== state) return
    let head = false
    for (const raw of paths) {
      const path = raw.startsWith("/") ? relative(state.root.path, raw) : raw
      if (!path || path.startsWith("..")) continue
      if (isGitPath(path)) {
        if (GIT_HEAD.test(path)) head = true
        else if (path === ".git/info/exclude") state.ignoreMoves++
        continue
      }
      if (path === ".gitignore" || path.endsWith("/.gitignore")) state.ignoreMoves++
      if (!state.pending.has(path)) state.pending.set(path, "event")
    }
    if (head) this.headMoved(state)
    if (!state.pending.size) return
    if (!state.firstHeard) state.firstHeard = this.now()
    // Git is writing: its files are read once the HEAD check knows what it wrote.
    if (state.gitSince !== undefined) return
    clearTimeout(state.timer)
    const wait = Math.max(0, Math.min(DEBOUNCE_MS, state.firstHeard + MAX_DELAY_MS - this.now()))
    state.timer = setTimeout(() => void this.queue(state, () => this.flush(state)), wait)
  }

  private lost(state: RootState, reason: LossReason): void {
    if (this.closed || state.asleep) return
    if (reason === "gone") {
      // A root that went away (a removed worktree) is forgotten, not rescanned into a delete for every file.
      void this.ports.fs.stat(state.root.path).then((stat) => {
        if (stat?.kind === "directory") return this.lost(state, "dropped")
        this.log("root gone", { root: state.root.path })
        return this.untrack(state.root.id)
      })
      return
    }
    state.losses.add(1, this.now())
    if (reason === "muted") state.muted = true
    if (!state.gap) {
      const from = state.root.seenAt
      state.gap = { id: this.store.openGap(state.root.id, from, reason), from, reason }
    }
    if (reason !== "muted") this.rescanSoon(state)
  }

  /**
   * Rescan for lost events, one at a time: losses heard while one waits are
   * its own, one heard while it runs gets one more after it. While losses
   * keep coming (a degraded fseventsd) each next rescan waits twice as
   * long after the last, up to ten minutes; a loss after a quiet while is
   * rescanned at once. The gap stays open meanwhile, so what changed in it
   * is attributed as found in it. Roots take turns (see `rescanTurn`).
   */
  private rescanSoon(state: RootState): void {
    if (this.closed || state.asleep || this.states.get(state.root.id) !== state) return
    if (state.rescanning) {
      state.rescanAgain = true
      return
    }
    if (state.rescanTimer || state.rescanQueued) return
    const now = this.now()
    state.rescanEvery = now - state.rescannedAt > RESCAN_QUIET_MS ? 0 : Math.min(RESCAN_MAX_MS, Math.max(RESCAN_MIN_MS, state.rescanEvery * 2))
    const wait = state.rescannedAt + state.rescanEvery - now
    if (wait > 0) state.rescanTimer = setTimeout(() => this.rescanNow(state), wait)
    else this.rescanNow(state)
  }

  private rescanNow(state: RootState): void {
    clearTimeout(state.rescanTimer)
    state.rescanTimer = undefined
    state.rescanQueued = true
    void this.rescanTurn(() => {
      if (this.closed || this.states.get(state.root.id) !== state) {
        state.rescanQueued = false
        return Promise.resolve()
      }
      return this.queue(state, () => {
        state.rescanQueued = false
        return this.rescan(state)
      })
    })
  }

  /**
   * Rescans for lost events across roots, one at a time, each followed by a
   * rest `RESCAN_REST` times its length: when every root loses events at
   * once, as when fseventsd falls behind, the walks and stats come one root
   * after another instead of all together, at a bounded share of the disk.
   * `settled` cuts the rest short.
   */
  private rescanTurn(run: () => Promise<void>): Promise<void> {
    const turn = this.rescanTurns.then(async () => {
      const started = performance.now()
      await run()
      const rest = Math.min(RESCAN_MAX_MS, (performance.now() - started) * RESCAN_REST)
      if (this.settling || rest < 1) return
      await new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(timer)
          this.waking.delete(wake)
          resolve()
        }
        const timer = setTimeout(wake, rest)
        this.waking.add(wake)
      })
    })
    this.rescanTurns = turn.catch(() => {})
    return turn
  }

  private headMoved(state: RootState): void {
    if (!state.repo || state.asleep) return
    state.ignoreMoves++
    state.gitSince ??= this.now()
    clearTimeout(state.timer)
    clearTimeout(state.headTimer)
    const wait = Math.max(0, Math.min(HEAD_DEBOUNCE_MS, state.gitSince + HEAD_HOLD_MS - this.now()))
    state.headTimer = setTimeout(() => void this.queue(state, () => this.gitMoved(state)), wait)
  }

  /**
   * Git's own files moved: check HEAD, read the files held behind the check,
   * and mark what Git put back as Git's. A checkout or pull writes the new
   * commit's content, which becomes the file's base, not a change; a stash,
   * a reset or `checkout -- file` puts back a version the journal or the
   * base already has, which is Git's unless a call named the file.
   */
  private async gitMoved(state: RootState): Promise<void> {
    clearTimeout(state.headTimer)
    state.headTimer = undefined
    const since = (state.gitSince ?? this.now()) - GIT_LOOKBACK_MS
    state.gitSince = undefined
    try {
      state.moved = await this.checkHead(state)
      await this.flush(state)
    } finally {
      state.moved = undefined
    }
    this.markGit(state, since)
  }

  /** Entries since `since` that only put back content Git holds (the base again, or an earlier version), whose file no call named: Git's. */
  private markGit(state: RootState, since: number): void {
    const recent = state.recent.filter((item) => item.at >= since)
    if (!recent.length) return
    const latest = new Map(recent.map((item) => [item.path, item.seq]))
    this.store.transaction(() => {
      for (const item of recent) {
        const author = this.authorOf(item.seq)
        if (!author || author.certainty === "exact" || author.certainty === "named" || author.certainty === "mako") continue
        const based = latest.get(item.path) === item.seq && !state.files.has(item.path)
        if (!based && this.store.entry(item.seq)?.restores === undefined) continue
        this.store.markGit(item.seq, true)
        const pending = this.pending.get(item.seq)
        if (pending) pending.git = true
      }
    })
  }

  private queue(state: RootState, run: () => Promise<void>): Promise<void> {
    const next = state.chain.then(run, run).catch((error: Error) => {
      this.options.log?.("a change could not be journaled", { root: state.root.path, error: error.message })
    })
    state.chain = next
    return next
  }

  /** `checkHead`, its failure logged: the files are read regardless, against the base as it stood. */
  private headChecked(state: RootState): Promise<Map<string, ContentRef | null> | undefined> {
    return this.checkHead(state).catch((error: Error) => {
      this.options.log?.("a change could not be journaled", { root: state.root.path, error: error.message })
      return undefined
    })
  }

  /**
   * Every file under the root, compared against the stat cache: what lost
   * events may have hidden. HEAD first, as on a restart: a commit made
   * meanwhile leaves every file as its stat says, so only the check finds
   * it. A caller that checked already holds what moved.
   */
  private async rescan(state: RootState): Promise<void> {
    const started = this.now()
    const checking = Boolean(state.repo) && !state.moved
    state.rescanning = true
    if (checking) state.moved = await this.headChecked(state)
    try {
      await this.settleCommitted(state)
      // What Git ignores is never walked: a folder of reference clones or build output holds far more files than the checkout.
      const ignored = await this.gitIgnored(state, true)
      const carry = state.root.carry ?? []
      const skip = (path: string) => (untrackable(path, false) && !state.tracked.has(path)) || Boolean(ignored && ignoredByGit(ignored, path) && !carry.some((glob) => mayReach(glob, path)))
      const paths = await this.ports.fs.walk(state.root.path, skip)
      for (const path of paths) if (!state.pending.has(path)) state.pending.set(path, "rescan")
      for (const path of state.stats.keys()) if (!state.pending.has(path)) state.pending.set(path, "rescan")
      await this.flush(state)
      if (state.gap) {
        this.store.closeGap(state.gap.id, this.now())
        state.gap = undefined
      }
      const ms = this.now() - started
      this.rescans.done.add(1, this.now())
      this.rescans.files.add(paths.length, this.now())
      this.rescans.ms.add(ms, this.now())
      this.log("rescan", { root: state.root.path, files: paths.length, ms, everyMs: state.rescanEvery })
    } finally {
      if (checking) state.moved = undefined
      state.rescanning = false
      state.rescannedAt = this.now()
      if (state.rescanAgain) {
        state.rescanAgain = false
        this.rescanSoon(state)
      }
    }
  }

  /**
   * Files the journal holds as created though HEAD has them exactly as they
   * are: a commit took them before the journal read them (a file Git ignored
   * until the commit that named it, by a build whose HEAD check didn't read
   * the disk). They're clean, and nobody's change.
   */
  private async settleCommitted(state: RootState): Promise<void> {
    const { repo, root } = state
    const head = root.head
    if (!repo || !head) return
    const created = [...state.files.values()].filter((file) => file.base === null && file.current !== null)
    if (!created.length) return
    const clean: string[] = []
    await mapLimit(created, PARALLEL, async (file) => {
      const bytes = await repo.read(head, file.path).catch(() => null)
      if (bytes && contentRef(bytes) === file.current) clean.push(file.path)
    })
    if (!clean.length) return
    this.store.transaction(() => {
      for (const path of clean) {
        state.files.delete(path)
        this.store.deleteFile(root.id, path)
        const row = state.stats.get(path)
        if (!row) continue
        state.stats.set(path, { ...row, ref: null })
        this.store.saveStat(root.id, path, state.stats.get(path)!)
      }
    })
    this.log("committed files settled", { root: root.path, files: clean.length })
  }

  /**
   * What Git ignores in the root, listed again when a `.gitignore`, Git's
   * exclude file, the index or HEAD moved since, or when `fresh` asks;
   * undefined for a folder that isn't a repository, or when Git can't say,
   * and then every path is read as before.
   */
  private async gitIgnored(state: RootState, fresh = false): Promise<GitIgnored | undefined> {
    const { repo } = state
    if (!repo?.ignoredEntries) return undefined
    if (!fresh && state.ignored?.moves === state.ignoreMoves) return state.ignored
    const moves = state.ignoreMoves
    try {
      const folders = new Set<string>()
      const files = new Set<string>()
      for (const entry of await repo.ignoredEntries()) {
        if (entry.endsWith("/")) folders.add(entry.slice(0, -1))
        else files.add(entry)
      }
      state.ignored = { folders, files, moves }
    } catch (error) {
      this.log("ignored files could not be listed", { root: state.root.path, error: error instanceof Error ? error.message : String(error) })
      state.ignored = undefined
    }
    return state.ignored
  }

  /**
   * Of what the watch heard, paths never read: inside what Git ignores, not
   * a file the journal keeps, a Thread's own write named, or a folder holding
   * one (its deletion is theirs), and out of every `carry` glob's reach.
   */
  private unreadIn(state: RootState, ignored: GitIgnored): (path: string) => boolean {
    const carry = state.root.carry ?? []
    const holding = new Set<string>()
    for (const known of [...state.stats.keys(), ...state.adopted])
      if (ignoredByGit(ignored, known)) for (let at = known.lastIndexOf("/"); at > 0; at = known.lastIndexOf("/", at - 1)) holding.add(known.slice(0, at))
    return (path) =>
      !state.stats.has(path) && !state.adopted.has(path) && !state.tracked.has(path) && !holding.has(path) && ignoredByGit(ignored, path) && !carry.some((glob) => mayReach(glob, path))
  }

  /** The root's content when tracking began: Git's view of a repository, every file's content for a folder. */
  private async baseline(state: RootState): Promise<void> {
    const { root, repo } = state
    const started = this.now()
    if (repo) {
      const { tracked, untracked, changed } = await repo.inventory()
      for (const path of tracked) state.tracked.add(path)
      const dirty = new Set(changed)
      const keep = (path: string, git: boolean) => !untrackable(path, git)
      await mapLimit(tracked.filter((path) => keep(path, true) && !dirty.has(path)), PARALLEL, async (path) => {
        const stat = await this.ports.fs.stat(join(root.path, path))
        if (stat?.kind === "file") state.stats.set(path, this.row(stat, null))
      })
      const carried = untracked.filter((path) => keep(path, false))
      const changes = [...changed.filter((path) => keep(path, true)), ...carried]
      const observed = await mapLimit(changes, PARALLEL, async (path) => {
        const bytes = dirty.has(path) && root.head ? await repo.read(root.head, path) : null
        return { item: await this.observe(state, path), before: bytes ? { ref: contentRef(bytes), bytes } : { ref: null } }
      })
      this.store.transaction(() => {
        for (const { item, before } of observed) {
          if (item.kind === "gone" && !before.ref) continue
          this.record(state, item, "baseline", { certainty: "ambiguous", candidates: [], reason: "before-tracking" }, this.now(), before)
        }
        for (const [path, row] of state.stats) this.store.saveStat(root.id, path, row)
        this.store.saveRoot(root)
      })
    } else {
      const paths = await this.ports.fs.walk(root.path, (path) => untrackable(path, false))
      const observed = await mapLimit(paths, PARALLEL, (path) => this.observe(state, path))
      this.store.transaction(() => {
        for (const item of observed) {
          if (item.kind !== "file" || !item.stat || !item.ref) continue
          if (item.bytes && !secretPath(item.path) && item.bytes.byteLength <= STORE_LIMIT) this.store.putBlob(item.ref, item.bytes, this.now())
          state.stats.set(item.path, this.row(item.stat, item.ref))
          this.store.saveStat(root.id, item.path, state.stats.get(item.path)!)
        }
        this.store.saveRoot(root)
      })
    }
    this.log("tracking", { root: root.path, files: state.stats.size, changed: state.files.size, ms: this.now() - started })
    if (state.pending.size) await this.flush(state)
  }

  private row(stat: TrackerFileStat, ref: ContentRef | null): StatRow {
    return { dev: stat.dev, ino: stat.ino, size: stat.size, mode: stat.mode, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs, ref, checkedNs: nanos(this.now()) }
  }

  /** Stat a path and, when it's a file, read and hash it. */
  private async observe(state: RootState, path: string, stat?: TrackerFileStat | null): Promise<Observed> {
    const absolute = join(state.root.path, path)
    const found = stat === undefined ? await this.ports.fs.stat(absolute) : stat
    if (found?.kind !== "file") return { path, kind: "gone" }
    if (found.size > READ_LIMIT && this.ports.fs.stream) {
      // Too large to keep or diff: hashed a piece at a time, never held whole.
      const hash = hasher()
      try {
        for await (const piece of this.ports.fs.stream(absolute)) hash.update(piece)
      } catch {
        return { path, kind: "gone" }
      }
      return { path, kind: "file", stat: found, ref: hash.digest(), text: false }
    }
    const bytes = await this.ports.fs.read(absolute)
    if (!bytes) return { path, kind: "gone" }
    return { path, kind: "file", stat: found, bytes, ref: contentRef(bytes), text: isText(bytes) && !secretPath(path) }
  }

  /**
   * Whether the disk holds exactly `bytes` at `path` (nothing, for null):
   * its stat when it does, null for a file that's gone as it should be,
   * undefined when it holds anything else or is too large to compare.
   */
  private async holding(state: RootState, path: string, bytes: Uint8Array | null): Promise<TrackerFileStat | null | undefined> {
    const absolute = join(state.root.path, path)
    const stat = await this.ports.fs.stat(absolute)
    if (!bytes) return stat ? undefined : null
    if (stat?.kind !== "file" || stat.size !== bytes.byteLength || stat.size > READ_LIMIT) return undefined
    const disk = await this.ports.fs.read(absolute)
    return disk && contentRef(disk) === contentRef(bytes) ? stat : undefined
  }

  /** The file's content before this change, as the journal knows it. */
  private async previous(state: RootState, path: string): Promise<{ ref: ContentRef | null; bytes?: Uint8Array }> {
    const file = state.files.get(path)
    if (file) return { ref: file.current, bytes: file.current ? this.store.blob(file.current) : undefined }
    const row = state.stats.get(path)
    if (!row) return { ref: null }
    if (row.ref) return { ref: row.ref, bytes: this.store.blob(row.ref) }
    if (state.repo && state.root.head) {
      const bytes = await state.repo.read(state.root.head, path)
      if (bytes) return { ref: contentRef(bytes), bytes }
    }
    return { ref: null }
  }

  /** Read every pending path, and journal what changed. */
  private async flush(state: RootState): Promise<void> {
    clearTimeout(state.timer)
    state.timer = undefined
    if (!state.pending.size) return
    const heardAt = state.firstHeard || this.now()
    state.firstHeard = 0
    const batch = [...state.pending]
    state.pending.clear()
    const timing: Flush = { at: this.now(), files: batch.length, entries: 0, lagMs: 0, statMs: 0, hashMs: 0, diffMs: 0, writeMs: 0 }
    let started = performance.now()
    // A folder that went or came stands for every file under it.
    const expanded = new Map<string, ObservedBy>()
    const stats = new Map<string, TrackerFileStat | null>()
    const ignored = batch.some(([path]) => !state.stats.has(path)) ? await this.gitIgnored(state) : undefined
    const unread = ignored ? this.unreadIn(state, ignored) : () => false
    await mapLimit(batch, PARALLEL, async ([path, how]) => {
      // Never stat, let alone walk, what is never tracked, nor what Git ignores.
      if (untrackable(path, state.tracked.has(path)) || unread(path)) return
      const stat = await this.ports.fs.stat(join(state.root.path, path))
      if (stat?.kind === "directory") {
        const skip = (child: string) => untrackable(`${path}/${child}`, state.tracked.has(`${path}/${child}`)) || unread(`${path}/${child}`)
        for (const inner of await this.ports.fs.walk(join(state.root.path, path), skip)) expanded.set(`${path}/${inner}`, how)
      } else {
        expanded.set(path, how)
        stats.set(path, stat)
      }
      if (!stat && !state.stats.has(path)) for (const known of state.stats.keys()) if (known.startsWith(`${path}/`)) expanded.set(known, how)
    })
    await mapLimit([...expanded.keys()].filter((path) => !stats.has(path)), PARALLEL, async (path) => {
      stats.set(path, await this.ports.fs.stat(join(state.root.path, path)))
    })
    const candidates: string[] = []
    const unknown: string[] = []
    for (const path of expanded.keys()) {
      if (untrackable(path, state.tracked.has(path))) continue
      const row = state.stats.get(path)
      const stat = stats.get(path)
      if (!row) {
        if (stat?.kind === "file") unknown.push(path)
        continue
      }
      if (stat?.kind === "file" && sameStat(row, stat) && row.checkedNs > row.mtimeNs + RACY_NS) continue
      candidates.push(path)
    }
    if (unknown.length) {
      const own = await this.outsideNested(state, unknown)
      const ignored = state.repo ? await this.ignoredOf(state.repo, own) : new Set<string>()
      for (const path of own) if (!ignored.has(path) || this.carried(state, path) || (state.adopted.has(path) && (await this.adoptable(state, path)))) candidates.push(path)
    }
    for (const path of expanded.keys()) state.adopted.delete(path)
    timing.statMs = performance.now() - started
    started = performance.now()
    const observed = await mapLimit(candidates, PARALLEL, (path) => this.observe(state, path, stats.get(path)))
    timing.hashMs = performance.now() - started
    // What each path held before, as the journal knows it: a clean file's is its base commit's.
    const previous = new Map<string, { ref: ContentRef | null; bytes?: Uint8Array }>()
    await mapLimit(observed, PARALLEL, async (item) => {
      previous.set(item.path, await this.previous(state, item.path))
    })
    // Same content gone from one path and come at another, in one burst: a rename.
    const gone = new Map<ContentRef, Observed>()
    // What a HEAD move wrote is taken as the new base, path by path: never a rename.
    for (const item of observed) {
      const ref = previous.get(item.path)?.ref
      if (item.kind === "gone" && state.stats.has(item.path) && ref && !state.moved?.has(item.path)) gone.set(ref, item)
    }
    const renamed = new Map<string, string>()
    for (const item of observed)
      if (item.kind === "file" && !state.stats.has(item.path) && item.ref && gone.has(item.ref) && !state.moved?.has(item.path)) {
        renamed.set(item.path, gone.get(item.ref)!.path)
        gone.delete(item.ref)
      }
    // The same file at a new path by the file ID the stat cache keeps, though its content changed in the same burst (`git mv`, then an edit).
    const goneFiles = new Map<string, Observed>()
    const paired = new Set(renamed.values())
    for (const item of observed) {
      const row = state.stats.get(item.path)
      if (item.kind === "gone" && row && !paired.has(item.path) && !state.moved?.has(item.path)) goneFiles.set(`${row.dev}:${row.ino}`, item)
    }
    if (goneFiles.size)
      for (const item of observed) {
        if (item.kind !== "file" || !item.stat || state.stats.has(item.path) || renamed.has(item.path) || state.moved?.has(item.path)) continue
        const id = `${item.stat.dev}:${item.stat.ino}`
        const from = goneFiles.get(id)
        if (!from) continue
        renamed.set(item.path, from.path)
        goneFiles.delete(id)
      }
    const consumed = new Set(renamed.values())
    started = performance.now()
    const prepared: { item: Observed; how: ObservedBy; before: { ref: ContentRef | null; bytes?: Uint8Array } }[] = []
    for (const item of observed) {
      if (consumed.has(item.path)) continue
      const from = renamed.get(item.path)
      prepared.push({ item, how: expanded.get(item.path) ?? "event", before: previous.get(from ?? item.path) ?? (await this.previous(state, from ?? item.path)) })
    }
    timing.diffMs = performance.now() - started
    started = performance.now()
    const at = this.now()
    let slowest = 0
    // Changes found after lost events could have happened any time in the gap, which memory may no longer hold: the
    // journal's activity is read for the stretch they could have happened in, a page at a time between other work.
    const lostFrom = state.gap ? this.lostFrom(state, prepared, renamed, at) : undefined
    const gapEvidence = lostFrom !== undefined ? evidenceOf(await this.activityOverlapping(lostFrom - TRAIL_MS, at), this.evidence.worked) : undefined
    // A remote owner asks its host for current session context before taking the SQLite write transaction.
    const outsiders = this.options.outsider ? new Map(await Promise.all(prepared.filter(({ how }) => how === "event").map(async ({ item }) =>
      [item.path, await this.options.outsider!(join(state.root.path, item.path), state.root.path)] as const))) : new Map<string, string | undefined>()
    // A burst (a build's output, a copied folder) is journaled a slice at a time: each change is attributed as it's recorded.
    const slice = new Slice(this.slicing)
    try {
      for (let index = 0; ; ) {
        const begun = performance.now()
        this.store.transaction(() => {
          for (let first = true; index < prepared.length && (first || !slice.spent); first = false, index++) {
            const { item, how, before } = prepared[index]!
            const t = performance.now()
            const from = renamed.get(item.path)
            const seq = this.record(state, item, how, undefined, at, before, from, how === "event" ? undefined : gapEvidence, outsiders.get(item.path))
            if (seq) timing.entries++
            const spent = performance.now() - t
            if (spent > slowest) {
              slowest = spent
              timing.slowest = item.path
            }
          }
          if (index < prepared.length) return
          state.root.seenAt = at
          this.store.saveRoot(state.root)
        })
        if (index >= prepared.length) break
        timing.writeMs += performance.now() - begun
        await slice.next()
        started = performance.now()
      }
    } finally {
      slice.done()
    }
    timing.writeMs += performance.now() - started
    timing.lagMs = this.now() - heardAt
    this.flushed(timing)
    this.scheduleMark(state)
    this.scheduleSettle()
    // A change proved as it was recorded can make a later one there someone else's.
    this.reattribute()
  }

  /**
   * The earliest a change found after lost events could have happened, of those `record` will attribute: a file
   * whose content changed (or that moved), found by a rescan rather than heard. Each is attributed only by the
   * activity overlapping its own lost span (`lostSpan`, bounded by its modification time) and its own time, so
   * reading the whole gap's activity, days of it after a long one, read nothing more: on the person's journal
   * (175,857 calls and turns) it held the host's loop for 2.7 s. Undefined when none needs it.
   */
  private lostFrom(state: RootState, prepared: readonly { item: Observed; how: ObservedBy; before: { ref: ContentRef | null } }[], renamed: ReadonlyMap<string, string>, at: number): number | undefined {
    const gap = state.gap
    if (!gap) return undefined
    let earliest: number | undefined
    for (const { item, how, before } of prepared) {
      if (how === "event") continue
      const from = renamed.get(item.path)
      if (!from && before.ref === (item.kind === "file" ? item.ref : null)) continue
      const written = item.stat && !from ? millis(item.stat.mtimeNs) : undefined
      const span = lostSpan(gap.from, at, written)
      // Content from before the gap is put on nobody by its timing.
      if (span === "before") continue
      const changedAt = written === undefined ? at : Math.min(at, Math.max(at - SETTLE_MS - this.lateMs(), written))
      earliest = Math.min(earliest ?? Infinity, span.from, changedAt)
    }
    return earliest
  }

  /**
   * The journal's activity overlapping `[from, to]`, read by the journal's reader off this thread, then parsed a page
   * at a time. Where the reader can't (it failed, or took too long), found and read here a page at a time instead.
   */
  private async activityOverlapping(from: number, to: number): Promise<StoredActivity[]> {
    let rows: readonly Row[] | undefined
    try {
      rows = await this.reader.activityOverlapping(from, to)
    } catch (error) {
      this.log("the journal's reader couldn't read; reading here", { error: error instanceof Error ? error.message : String(error) })
    }
    const found: StoredActivity[] = []
    if (rows) {
      for (let first = 0; first < rows.length; first += ACTIVITY_PAGE) {
        if (first) await new Promise<void>((resolve) => setImmediate(resolve))
        found.push(...this.store.activityOfRows(rows.slice(first, first + ACTIVITY_PAGE)))
      }
      return found
    }
    let after: ActivityKey | undefined
    for (;;) {
      const page = this.store.activityTimes(after, ACTIVITY_PAGE)
      const overlapping = page.filter((item) => item.start <= to && (item.end === null || item.end >= from))
      if (overlapping.length) found.push(...this.store.activityOfKeys(overlapping))
      if (page.length < ACTIVITY_PAGE) return found
      after = page.at(-1)
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }

  /** The paths not inside a repository nested in this root (a submodule): those are its files, not this root's. */
  private async outsideNested(state: RootState, paths: readonly string[]): Promise<string[]> {
    const nested = new Map<string, Promise<boolean>>()
    const holdsGit = (folder: string) => {
      let found = nested.get(folder)
      if (!found) nested.set(folder, (found = this.ports.fs.stat(join(state.root.path, folder, ".git")).then((stat) => stat !== null, () => false)))
      return found
    }
    const inside = await mapLimit(paths, PARALLEL, async (path) => {
      for (let at = path.lastIndexOf("/"); at > 0; at = path.lastIndexOf("/", at - 1)) if (await holdsGit(path.slice(0, at))) return true
      return false
    })
    return paths.filter((_, index) => !inside[index])
  }

  /** Which paths Git ignores; a batch Git refuses as a whole is asked path by path, and a path it still refuses is left out. */
  private async ignoredOf(repo: TrackerRepository, paths: readonly string[]): Promise<Set<string>> {
    try {
      return await repo.ignored(paths)
    } catch (error) {
      this.log("ignore check refused; asking path by path", { paths: paths.length, error: error instanceof Error ? error.message : String(error) })
      const each = await mapLimit(paths, PARALLEL, (path) => repo.ignored([path]).then((found) => found.has(path), () => true))
      return new Set(paths.filter((_, index) => each[index]))
    }
  }

  private carried(state: RootState, path: string): boolean {
    return (state.root.carry ?? []).some((glob) => globMatch(glob, path))
  }

  /** Whether an ignored file a Thread wrote by name is kept: never a secret, nor anything in a folder a tool marked as its cache (`CACHEDIR.TAG`). */
  private async adoptable(state: RootState, path: string): Promise<boolean> {
    if (secretPath(path)) return false
    for (let at = path.lastIndexOf("/"); at > 0; at = path.lastIndexOf("/", at - 1)) {
      const tag = await this.ports.fs.stat(join(state.root.path, path.slice(0, at), CACHE_TAG)).catch(() => null)
      if (tag) return false
    }
    return true
  }

  /** Ignored files a call's own writes named, in the roots that hold them: each is looked at again and kept. Every other file events or a rescan find. */
  private adopt(call: ReportedCall): void {
    if (call.status === "refused") return
    const written = new Map<RootState, string[]>()
    for (const effect of call.effects) {
      if ("seen" in effect && effect.seen) continue
      const path = effect.kind === "rename" ? effect.to : effect.kind === "create" || effect.kind === "write" || effect.kind === "modify" ? effect.path : undefined
      if (!path) continue
      for (const state of this.states.values()) {
        if (state.asleep) continue
        if (!state.repo || !within(state.root.path, path) || path === state.root.path) continue
        const own = relative(state.root.path, path)
        if (!state.stats.has(own) && !untrackable(own, state.tracked.has(own))) written.set(state, [...(written.get(state) ?? []), own])
      }
    }
    for (const [state, paths] of written)
      void this.queue(state, async () => {
        const ignored = await this.ignoredOf(state.repo!, paths)
        for (const path of ignored) {
          state.adopted.add(path)
          if (!state.pending.has(path)) state.pending.set(path, "event")
        }
        if (ignored.size) this.heard(state, [])
      })
  }

  /**
   * Journal one observed path: an entry when its content changed, the stat
   * cache either way. Runs inside the flush's transaction. Returns the entry's
   * number, or 0 when nothing changed.
   */
  private record(
    state: RootState,
    item: Observed,
    how: ObservedBy,
    given: Attribution | undefined,
    at: number,
    known?: { ref: ContentRef | null; bytes?: Uint8Array },
    from?: string,
    evidence: Evidence = this.evidence,
    outsider?: string,
  ): number {
    const { root } = state
    const path = item.path
    const row = state.stats.get(path)
    const file = state.files.get(from ?? path)
    // What a checkout, pull or rebase wrote: the new commit's content, now this file's base, and nobody's change.
    const taken = !from && state.moved?.has(path) && state.moved.get(path) === (item.kind === "file" ? item.ref : null)
    if (item.kind === "gone") {
      if (!row && !file) return 0
      state.stats.delete(path)
      this.store.deleteStat(root.id, path)
    } else {
      const ref = item.ref!
      state.stats.set(path, this.row(item.stat!, taken ? null : ref))
      this.store.saveStat(root.id, path, state.stats.get(path)!)
      if (from) {
        state.stats.delete(from)
        this.store.deleteStat(root.id, from)
      }
    }
    if (taken) {
      if (file) {
        state.files.delete(path)
        this.store.deleteFile(root.id, path)
      }
      return 0
    }
    const before = known ?? { ref: file?.current ?? row?.ref ?? null }
    const afterRef = item.kind === "file" ? item.ref! : null
    if (before.ref === afterRef && !from) return 0
    const kind: ChangeKind = from ? "rename" : item.kind === "gone" ? "delete" : before.ref === null ? "create" : "modify"
    if (kind === "delete" && !file && !row) return 0
    const secret = secretPath(path)
    const afterBytes = item.bytes
    const stored = Boolean(afterBytes && !secret && afterBytes.byteLength <= STORE_LIMIT)
    if (stored) this.store.putBlob(afterRef!, afterBytes!, at)
    const text = Boolean(item.kind === "file" ? item.text : file?.text ?? true) && !secret && (before.ref === null || before.bytes !== undefined ? isTextBytes(before.bytes) : false)
    const beforeText = text && before.bytes ? decodeText(before.bytes) : before.ref === null ? "" : undefined
    const afterText = text && afterBytes ? decodeText(afterBytes) : item.kind === "gone" ? "" : undefined
    // A write's own time is its modification time; a rename keeps the old one, so it's when it was heard.
    const late = this.lateMs()
    const changedAt = item.stat && !from ? Math.min(at, Math.max(at - SETTLE_MS - late, millis(item.stat.mtimeNs))) : at
    // The chain starts at the file's first change since its base: keep the base's content.
    if (before.ref && before.bytes && !secret && before.bytes.byteLength <= STORE_LIMIT) this.store.putBlob(before.ref, before.bytes, at)
    const baseSeq = this.seq
    const seq = baseSeq + 1
    const fresh = (base: ContentRef | null): FileState => ({
      root: root.id,
      path,
      base,
      baseSeq,
      current: before.ref,
      text: text && beforeText !== undefined,
      map: text && beforeText !== undefined ? baseMap(splitLines(beforeText).length) : [],
    })
    // A renamed file starts at its new path with no base there, its lines keeping their writers.
    const state0: FileState = from
      ? { ...(file ?? fresh(null)), path, base: null, map: (file ?? fresh(null)).map.filter((run) => !run.del) }
      : (file ?? fresh(before.ref))
    const written = item.stat && !from ? millis(item.stat.mtimeNs) : undefined
    const lost = state.gap && how !== "event" ? lostSpan(state.gap.from, at, written) : undefined
    // Content already there before the gap began: written where the watch never read (a file Git ignored until a commit named it), so nothing running in the gap made it.
    if (lost === "before") given ??= { certainty: "ambiguous", candidates: [], reason: "lost-events" }
    const change: ObservedChange = {
      path: join(root.path, path),
      from: from ? join(root.path, from) : undefined,
      kind,
      changedAt,
      refs: { before: before.ref, after: afterRef },
      lost: lost === "before" ? { from: state.gap!.from, to: at } : lost,
      before: beforeText,
      after: afterText,
      root: root.path,
    }
    // Its modification time isn't when it was written: a copy that kept an old one, one ahead of the clock, or one rounded to the second.
    if (written === undefined || written > at || at - written > TRAIL_MS + late || item.stat!.mtimeNs % 1_000_000_000n === 0n) change.heard = at
    if (outsider) change.outsider = outsider
    const author = given ?? attribute(change, evidence)
    if (author.certainty === "exact") evidence.proved(author.author, change.path, change.changedAt)
    // Content back to what an earlier version had brings back that version's authors.
    // A clean file brought back to a version it had since the base last moved (a stash popped) gets that version's writers back.
    const restored = afterRef ? this.restored(file || from ? state0 : { ...state0, baseSeq: state.headSeq }, afterRef) : undefined
    let map: Run[] | undefined
    let lines: { added: number; removed: number } | undefined
    if (state0.text && text && beforeText !== undefined && afterText !== undefined) {
      const hunks = diffLines(splitLines(beforeText), splitLines(afterText))
      lines = { added: hunks.reduce((sum, hunk) => sum + hunk.added, 0), removed: hunks.reduce((sum, hunk) => sum + hunk.removed, 0) }
      map = restored ? restored.map : applyHunks(state0.map, hunks, seq)
    }
    const settled = how !== "event" || author.certainty === "mako"
    const inserted = this.store.insertEntry({
      at,
      changedAt,
      root: root.id,
      path,
      kind,
      from,
      before: before.ref,
      after: afterRef,
      size: item.stat?.size,
      text: Boolean(map),
      added: lines?.added,
      removed: lines?.removed,
      stored,
      observed: how,
      gap: state.gap && how !== "event" ? state.gap.id : undefined,
      restores: restored?.seq,
      author,
      settled,
      map,
    })
    if (inserted !== seq) throw new Error(`The journal numbered an entry ${inserted}, not ${seq}.`)
    this.seq = seq
    state.recent.push({ seq, path, at })
    while (state.recent.length > RECENT_KEPT || state.recent[0]!.at < at - GIT_LOOKBACK_MS - HEAD_HOLD_MS) state.recent.shift()
    const next: FileState = { ...state0, current: afterRef, text: Boolean(map), map: map ?? [] }
    if (from) {
      // The old path keeps its base, now deleted by this entry.
      const old = file ?? fresh(before.ref)
      const gone: FileState = { ...old, path: from, current: null, map: old.text ? applyHunks(old.map, [{ a: 0, removed: presentLines(old.map), b: 0, added: 0 }], seq) : [] }
      if (gone.base === null) {
        state.files.delete(from)
        this.store.deleteFile(root.id, from)
      } else {
        state.files.set(from, gone)
        this.store.saveFile(gone)
      }
    }
    const clean = next.current === next.base && (!next.text || onlyBase(next.map)) && !from
    if (clean) {
      state.files.delete(path)
      this.store.deleteFile(root.id, path)
    } else {
      state.files.set(path, next)
      this.store.saveFile(next)
    }
    if (!settled) this.pending.set(seq, { seq, change, author })
    if (!settled && reconcilable(author) && this.options.uncertain) {
      const sessions = evidence.sessionsAt(change.changedAt, change.path)
      if (sessions.size) queueMicrotask(() => this.options.uncertain?.(sessions))
    }
    return seq
  }

  /** The version of this file's chain `ref` brings back, with its line map: the base, or an earlier entry's. */
  private restored(file: FileState, ref: ContentRef): { seq?: number; map: Run[] } | undefined {
    if (file.text && ref === file.base) return { map: baseMap(presentRuns(file.map).reduce((sum, run) => sum + (run.ins === 0 ? run.length : 0), 0) + deadBase(file.map)) }
    if (ref === file.current) return undefined
    const earlier = this.store.chain(file.root, file.path, file.baseSeq).reverse().find((entry) => entry.after === ref && entry.map)
    return earlier ? { seq: earlier.seq, map: earlier.map! } : undefined
  }

  /**
   * Whether HEAD moved; if so, the base of every file the move touched is
   * the new commit's content. A file with changes keeps its uncommitted
   * lines and records who wrote each line the commit took; a clean file the
   * move left behind (a soft reset) now differs from its base by lines no
   * entry wrote. A file the disk already holds at the commit's content,
   * though the journal knew it otherwise, is Git's write whose events
   * haven't come yet (a busy watcher can deliver them seconds after Git's
   * own): it is the new base now, so however late they come they journal
   * nothing. Returns what the move changed, by path: the new commit's
   * content, null where it has none.
   */
  private async checkHead(state: RootState): Promise<Map<string, ContentRef | null> | undefined> {
    const { repo, root } = state
    if (!repo) return
    const head = await repo.head()
    if (head === root.head || !head) return
    const previous = root.head
    const started = this.now()
    const moved = await repo.changed(previous, head)
    const touched = new Set(moved)
    const paths = new Set([...moved, ...state.files.keys()])
    const committed = new Map<string, Uint8Array | null>()
    const earlier = new Map<string, Uint8Array | null>()
    const written = new Map<string, TrackerFileStat | null>()
    await mapLimit([...paths], PARALLEL, async (path) => {
      const bytes = await repo.read(head, path)
      committed.set(path, bytes)
      const row = state.stats.get(path)
      if (!state.files.has(path) && row && !row.ref && previous) earlier.set(path, await repo.read(previous, path))
      if (!touched.has(path)) return
      const disk = await this.holding(state, path, bytes)
      if (disk !== undefined) written.set(path, disk)
    })
    const at = this.now()
    const keep = (path: string, bytes: Uint8Array | null | undefined): ContentRef | null => {
      if (!bytes) return null
      const ref = contentRef(bytes)
      if (bytes.byteLength <= STORE_LIMIT && !secretPath(path)) this.store.putBlob(ref, bytes, at)
      return ref
    }
    const save = (next: FileState) => {
      const clean = next.current === next.base && (!next.text || onlyBase(next.map))
      if (clean) {
        state.files.delete(next.path)
        this.store.deleteFile(root.id, next.path)
      } else {
        state.files.set(next.path, next)
        this.store.saveFile(next)
      }
    }
    // The contents the transaction reads, read off this thread first: on a big journal each read waits on the disk.
    const wanted: ContentRef[] = []
    for (const path of paths) {
      const file = state.files.get(path)
      const row = state.stats.get(path)
      if (file) wanted.push(...[file.current, file.base].filter((ref): ref is ContentRef => Boolean(ref)))
      else if (row?.ref) wanted.push(row.ref)
    }
    const fetched = await this.reader.blobs(wanted).catch(() => new Map<string, Uint8Array>())
    const blob = (ref: ContentRef) => fetched.get(ref) ?? this.store.blob(ref)
    let landed = 0
    this.store.transaction(() => {
      for (const path of paths) {
        const bytes = committed.get(path) ?? null
        const ref = keep(path, bytes)
        const file = state.files.get(path)
        const row = state.stats.get(path)
        const disk = written.get(path)
        const based = earlier.get(path)
        const was = file ? file.current : row ? row.ref ?? (based ? contentRef(based) : null) : null
        if (disk !== undefined && was !== ref) {
          // What the flush held behind this check would take as the new base, taken now.
          if (disk) {
            state.stats.set(path, this.row(disk, null))
            this.store.saveStat(root.id, path, state.stats.get(path)!)
          } else if (row) {
            state.stats.delete(path)
            this.store.deleteStat(root.id, path)
          }
          if (file) {
            state.files.delete(path)
            this.store.deleteFile(root.id, path)
          }
          landed++
          continue
        }
        if (!file) {
          if (!row) continue
          // A clean file's content is the commit it was clean against; pin it before the base moves.
          const old = row.ref ? blob(row.ref) : earlier.get(path)
          const current = row.ref ?? keep(path, old)
          if (current === ref) continue
          if (current !== row.ref) {
            state.stats.set(path, { ...row, ref: current })
            this.store.saveStat(root.id, path, state.stats.get(path)!)
          }
          const text = Boolean(old && bytes && isText(old) && isText(bytes) && !secretPath(path))
          const known = text && current ? this.store.committedAuthors(root.id, path, current) : undefined
          const map = text ? withKnownWriters(applyHunks(baseMap(splitLines(decodeText(bytes!)).length), diffLines(splitLines(decodeText(bytes!)), splitLines(decodeText(old!))), UNKNOWN), known) : []
          save({ root: root.id, path, base: ref, baseSeq: this.seq, current, text, map })
          continue
        }
        const current = file.current ? blob(file.current) : undefined
        const before = file.base ? blob(file.base) : new Uint8Array()
        // A file the commit doesn't have (one Git doesn't track yet, or whose deletion the disk didn't take) rebases onto nothing: every line it has stays uncommitted.
        if (file.text && current && before && (!bytes || isText(bytes))) {
          const known = file.base ? this.store.committedAuthors(root.id, path, file.base) : undefined
          const rebased = rebase(file.map, splitLines(decodeText(current)), splitLines(decodeText(before)), bytes ? splitLines(decodeText(bytes)) : [], known)
          if (ref) this.store.saveCommit(root.id, head, path, at, rebased.authors, ref)
          save({ ...file, base: ref, baseSeq: this.seq, map: rebased.map })
        } else if (file.text && !file.current && !bytes) {
          // Deleted, and the commit took the deletion.
          save({ ...file, base: null, baseSeq: this.seq, map: [] })
        } else save({ ...file, base: ref, baseSeq: this.seq, text: false, map: [] })
        // A clean tracked file's content is its base; the stat cache need not keep a copy.
        const after = state.stats.get(path)
        if (after && after.ref === ref && !state.files.has(path)) {
          state.stats.set(path, { ...after, ref: null })
          this.store.saveStat(root.id, path, state.stats.get(path)!)
        }
      }
      root.head = head
      this.store.saveRoot(root)
    })
    state.headSeq = this.seq
    for (const path of paths) state.tracked.add(path)
    this.log("base moved", { root: root.path, from: previous ?? "none", to: head, files: paths.size, landed, ms: this.now() - started })
    return new Map(moved.map((path) => {
      const bytes = committed.get(path)
      return [path, bytes ? contentRef(bytes) : null]
    }))
  }

  private scheduleMark(state: RootState): void {
    if (state.markTimer || this.closed) return
    state.markTimer = setTimeout(() => {
      state.markTimer = undefined
      void this.ports.events.mark().then((mark) => {
        if (!mark || !this.states.has(state.root.id)) return
        // Everything heard before the previous mark has been journaled by now; save that one.
        const safe = state.markTaken
        state.markTaken = { mark, at: this.now() }
        const lag = lagSummary(this.flushes)
        if (lag) this.store.setMeta("lag", JSON.stringify(lag))
        if (!safe) return
        state.root.mark = safe.mark
        this.store.saveRoot(state.root)
      }, () => {})
    }, MARK_EVERY_MS)
    state.markTimer.unref?.()
  }

  activity(input: ActivityMark): void {
    const mark = ActivityMarkSchema.parse(input)
    const interval = this.evidence.mark(mark)
    this.store.saveActivity({ ...storedActivity(interval), ...(mark.run && { run: mark.run }) })
    this.footprints?.activity(mark)
    this.reattribute()
  }

  reported(input: ReportedCall): void {
    const parsed = ReportedCallSchema.parse(input)
    this.evidence.report(parsed)
    this.footprints?.reported(parsed)
    // A hook's bounds and the stream's effects for one call come apart; the activity keeps both.
    const call = this.evidence.reportOf(parsed.session, parsed.call) ?? parsed
    const span = this.evidence.callSpan(call)
    this.store.saveActivity({
      kind: "call",
      id: call.call,
      session: call.session,
      thread: call.thread,
      turn: call.turn,
      checkout: call.checkout,
      named: [],
      start: span?.start ?? this.now(),
      end: span?.end ?? null,
      status: call.status,
      // A file the harness only saw change while the call ran is no work of its own.
      effects: call.effects.filter((effect) => !("seen" in effect && effect.seen)).map((effect) =>
        effect.kind === "rename" ? { kind: "rename", from: effect.from, to: effect.to }
          : effect.kind === "command" ? { kind: "command", command: effect.command.slice(0, 500), cwd: effect.cwd, exitCode: effect.exitCode, ...effect.named?.length && { named: effect.named.slice(0, STORED_NAMED) } }
            : { kind: effect.kind, path: effect.path }),
    })
    this.adopt(parsed)
    this.readScripts(call)
    this.reattribute()
  }

  /**
   * Read what the call's commands ran (`ranTexts`), once a report first
   * carries them: each script as it was when the call started, so the files
   * its text names are the call's as its command line's are.
   */
  private readScripts(call: ReportedCall): void {
    if (call.status === "refused" || this.evidence.ranBy(call.session, call.call)) return
    const commands = call.effects.flatMap((effect) => (effect.kind === "command" ? [effect] : []))
    const start = this.evidence.callSpan(call)?.start
    if (!commands.length || start === undefined) return
    this.evidence.ran(call.session, call.call, [])
    const release = this.hold()
    const reading = (async () => {
      for (const effect of commands) this.evidence.ran(call.session, call.call, await ranTexts(effect.command, effect.cwd, (path) => this.scriptAt(path, call.session, start)))
    })()
      .catch((error: Error) => this.options.log?.("a command's scripts could not be read", { error: error.message }))
      .finally(() => {
        release()
        this.scriptReads.delete(reading)
        this.reattribute()
      })
    this.scriptReads.add(reading)
  }

  /**
   * A script's text as it was when a command of `session` that ran it
   * started at `start`, or undefined when that can't be known. Where the
   * journal tracks it, its content must be the version the journal last
   * recorded (the same file, size and modification time, nothing heard
   * since), written before the command started; a status change alone, such
   * as `chmod +x`, moves no content. Elsewhere its modification and
   * status-change times must both be before the start: a write, a rename into
   * its place and a `touch` all move the latter. A start is heard up to
   * `LEAD_MS` late, so a version written in those moments counts only when
   * the journal puts it on a call of the same session heard to end by then:
   * one session's calls are heard in the order they ran. The read itself
   * must see the same file throughout.
   */
  private async scriptAt(path: string, session: string, start: number): Promise<string | null | undefined> {
    if (secretPath(path)) return undefined
    const before = await this.ports.fs.stat(path)
    if (!before) return null
    if (before.kind !== "file" || before.size > SCRIPT_LIMIT) return undefined
    const modified = millis(before.mtimeNs)
    // The innermost tracked root holding it: a repository inside a tracked project folder is its own.
    let state: RootState | undefined
    for (const item of this.states.values()) if (within(item.root.path, path) && path !== item.root.path && (!state || item.root.path.length > state.root.path.length)) state = item
    if (!state) {
      if (Math.max(modified, millis(before.ctimeNs)) >= start - LEAD_MS) return undefined
    } else {
      const asked = relative(state.root.path, path)
      // A file system that ignores case finds `makefile` as `Makefile`: the cache keeps the name as written, and the same file by its inode.
      const own = state.stats.has(asked) ? asked : [...state.stats.keys()].find((key) => key.toLowerCase() === asked.toLowerCase() && state.stats.get(key)?.ino === before.ino) ?? asked
      const row = state.stats.get(own)
      const last = this.store.last(state.root.id, own)
      const written = Math.max(modified, last?.changedAt ?? -Infinity)
      if (state.pending.has(own) || !row || !sameContent(row, before) || written >= start) return undefined
      if (written >= start - LEAD_MS && !(last && this.endedBefore(this.authorOf(last.seq), session, start))) return undefined
    }
    const bytes = await this.ports.fs.read(path)
    const after = await this.ports.fs.stat(path)
    if (!bytes || !after || !sameFile(before, after) || !isText(bytes)) return undefined
    return decodeText(bytes)
  }

  /** Whether `author` is a call of `session` heard to end by `start`. */
  private endedBefore(author: Attribution | null, session: string, start: number): boolean {
    if ((author?.certainty !== "exact" && author?.certainty !== "named") || author.author.session !== session || !author.author.call) return false
    const report = this.evidence.reportOf(session, author.author.call)
    const end = report && this.evidence.callSpan(report)?.end
    return end !== undefined && end !== null && end <= start
  }

  /** A write Mako begins, from `at` (another host on this device says when its own began); `end` takes when it ended the same way. */
  mako(input: MakoWrite, at = this.now()): MakoWriting & { end(at?: number): void } {
    const write = MakoWriteSchema.parse(input)
    const interval = this.evidence.makoStart(write, at)
    this.reattribute()
    return {
      end: (ended: number = this.now()) => {
        this.evidence.makoEnd(interval, ended)
        this.reattribute()
      },
    }
  }

  /** A write Mako reports once it's done, such as a Git command it ran. */
  makoWrote(input: MakoWrite, startedAt: number, endedAt: number): void {
    const write = MakoWriteSchema.parse(input)
    this.evidence.makoStart(write, startedAt, endedAt)
    this.reattribute()
  }

  /**
   * Keep every open change open while something that may name its author
   * is being read (a child agent's record); the returned function lets go.
   */
  hold(): () => void {
    this.holds++
    let held = true
    return () => {
      if (!held) return
      held = false
      this.holds--
    }
  }

  /**
   * Calls read back from a session's record, whose live reports never
   * reached the changes they made: a child agent's, one from before Mako
   * followed the session, one from a session that never ran in Mako. A
   * change still uncertain whose content one of them proves becomes that
   * call's, and lines one of them wrote that a change left uncertain become
   * its own, a later call's over an earlier one's. Authors only get surer.
   */
  async reconcile(input: readonly ReportedCall[]): Promise<{ entries: number; lines: number }> {
    const calls = input.map((call) => ReportedCallSchema.parse(call)).filter((call) => call.status !== "refused" && call.effects.some(writesContent))
    const total = { entries: 0, lines: 0 }
    if (!calls.length) return total
    // Untimed calls first, in their record's order; then by start.
    calls.sort((left, right) => (left.startedAt ?? -Infinity) - (right.startedAt ?? -Infinity))
    for (const state of this.states.values()) {
      const effects = new Map<string, { call: ReportedCall; effect: ReportedEffect }[]>()
      for (const call of calls)
        for (const effect of call.effects) {
          if (!writesContent(effect) || !within(state.root.path, effect.path) || effect.path === state.root.path) continue
          const path = relative(state.root.path, effect.path)
          effects.set(path, [...(effects.get(path) ?? []), { call, effect }])
        }
      if (!effects.size) continue
      await this.queue(state, async () => {
        this.store.transaction(() => {
          for (const [path, found] of effects) {
            total.entries += this.reconcileEntries(state, path, found)
            total.lines += this.reconcileLines(state, path, found)
          }
        })
      })
    }
    if (total.entries || total.lines) this.log("reconciled", { calls: calls.length, ...total })
    return total
  }

  /** The file's uncertain changes whose content one of these effects proves, made that call's. */
  private reconcileEntries(state: RootState, path: string, found: readonly { call: ReportedCall; effect: ReportedEffect }[]): number {
    const file = state.files.get(path)
    if (!file) return 0
    let count = 0
    for (const entry of this.store.chain(state.root.id, path, wholeChange(file) ? 0 : file.baseSeq)) {
      if (entry.path !== path || entry.observed === "reconciled" || (entry.kind !== "create" && entry.kind !== "modify")) continue
      if (!reconcilable(this.authorOf(entry.seq))) continue
      const text = (ref: ContentRef | null) => {
        if (!ref) return ""
        const bytes = this.store.blob(ref)
        return bytes && isText(bytes) ? decodeText(bytes) : undefined
      }
      const change: ObservedChange = { path: join(state.root.path, path), kind: entry.kind, changedAt: entry.changedAt, before: text(entry.before), after: text(entry.after), root: state.root.path }
      if (change.before === undefined || change.after === undefined) continue
      for (const { call, effect } of found) {
        if (!withinCall(call, entry.changedAt, this.now())) continue
        const claimed = claim([effect], change)
        if (!claimed?.proven) continue
        this.reauthor(entry.seq, { certainty: "exact", author: callAuthor(call), effect: claimed.effect })
        count++
        break
      }
    }
    return count
  }

  /** The file's present lines these effects wrote, left uncertain by the changes that wrote them, made each call's own. */
  private reconcileLines(state: RootState, path: string, found: readonly { call: ReportedCall; effect: ReportedEffect }[]): number {
    let file = state.files.get(path)
    if (!file?.text || !file.current) return 0
    const bytes = this.store.blob(file.current)
    if (!bytes || !isText(bytes)) return 0
    const current = splitLines(decodeText(bytes))
    if (presentLines(file.map) !== current.length) return 0
    const writer = writers(file.map)
    /** Each uncertain entry's time; undefined for one that isn't uncertain. */
    const open = new Map<number, number | undefined>()
    const eligible = (line: number, call: ReportedCall) => {
      const seq = writer[line]!
      if (seq === UNKNOWN) return true
      // An open change's own evidence may still prove it whole.
      if (seq <= 0 || this.pending.has(seq)) return false
      if (!open.has(seq)) {
        const entry = this.store.entry(seq)
        open.set(seq, entry && reconcilable(entry.author) ? (entry.observed === "baseline" ? Infinity : entry.changedAt) : undefined)
      }
      const changedAt = open.get(seq)
      // A call can't have written lines a change left there before it started.
      return changedAt !== undefined && (call.startedAt === undefined || changedAt >= call.startedAt - LEAD_MS)
    }
    const claimedBy = new Map<number, ReportedCall>()
    for (const { call, effect } of found) for (const line of writtenLines(effect, current)) if (eligible(line, call)) claimedBy.set(line, call)
    const byCall = new Map<ReportedCall, Set<number>>()
    for (const [line, call] of claimedBy) byCall.set(call, (byCall.get(call) ?? new Set()).add(line))
    let count = 0
    const at = this.now()
    for (const [call, lines] of byCall) {
      const seq = this.seq + 1
      const map = withWriter(file.map, lines, seq)
      const inserted = this.store.insertEntry({
        at,
        changedAt: Math.min(at, call.endedAt ?? call.startedAt ?? at),
        root: state.root.id,
        path,
        kind: "modify",
        before: file.current,
        after: file.current,
        size: bytes.byteLength,
        text: true,
        added: lines.size,
        removed: 0,
        stored: true,
        observed: "reconciled",
        author: { certainty: "named", author: callAuthor(call), by: "content" },
        settled: true,
        map,
      })
      if (inserted !== seq) throw new Error(`The journal numbered an entry ${inserted}, not ${seq}.`)
      this.seq = seq
      file = { ...file, map }
      state.files.set(path, file)
      this.store.saveFile(file)
      count += lines.size
    }
    return count
  }

  /** A surer author for an entry: settled now, since nothing outranks what proved it. */
  private reauthor(seq: number, author: Attribution): void {
    this.pending.delete(seq)
    this.store.updateAuthor(seq, author, true)
    if (author.certainty === "exact") {
      const entry = this.store.entry(seq)
      const state = entry && this.states.get(entry.root)
      if (entry && state) this.evidence.proved(author.author, join(state.root.path, entry.path), entry.changedAt)
      this.reattribute()
    }
  }

  /**
   * Text files with uncommitted lines nobody is sure of, which a session's
   * record could still name: absolute paths, each with its tracked root and
   * the time of its oldest such change, 0 when it was there before tracking
   * or its writer was never seen.
   */
  unsureFiles(): Map<string, { root: string; since: number }> {
    const out = new Map<string, { root: string; since: number }>()
    const times = new Map<number, number | undefined>()
    for (const state of this.states.values())
      for (const file of state.files.values()) {
        if (!file.text) continue
        let since: number | undefined
        for (const run of presentRuns(file.map)) {
          if (run.ins === BASE) continue
          if (!times.has(run.ins)) {
            const entry = run.ins === UNKNOWN ? undefined : this.store.entry(run.ins)
            times.set(run.ins, run.ins === UNKNOWN ? 0 : entry && reconcilable(this.authorOf(run.ins)) ? (entry.observed === "baseline" ? 0 : entry.changedAt) : undefined)
          }
          const at = times.get(run.ins)
          if (at !== undefined) since = Math.min(since ?? at, at)
        }
        if (since !== undefined) out.set(join(state.root.path, file.path), { root: state.root.path, since })
      }
    return out
  }

  /** Whether any open change is still uncertain. */
  unsure(): boolean {
    for (const pending of this.pending.values()) if (reconcilable(pending.author)) return true
    return false
  }

  /** An entry's author as it stands, settled or not. */
  authorOf(seq: number): Attribution | null {
    return this.pending.get(seq)?.author ?? this.store.author(seq) ?? null
  }

  /**
   * New evidence can change the author of a change not yet settled: each
   * change its reach takes in is attributed again, in seq order, a slice at
   * a time. Evidence that comes during a pass is taken by the next one.
   */
  private reattribute(): void {
    if (this.closed || this.reattribution) return
    if (!this.pending.size) {
      // Nothing open for it to change; a change heard later is attributed against all of it.
      this.evidence.takeReaches()
      return
    }
    if (!this.evidence.reaching().length) return
    this.reattribution = (async () => {
      // Evidence comes in bursts (a hook's bounds, then the stream's report of the same call): one pass takes the burst.
      await yieldTurn()
      const slice = new Slice(this.slicing)
      try {
        for (let reaches = this.evidence.takeReaches(); reaches.length && !this.closed; reaches = this.evidence.takeReaches()) {
          this.round = { reaches, done: 0 }
          for (const pending of this.pending.values()) {
            if (slice.spent) {
              await slice.next()
              if (this.closed) return
            }
            this.round.done = pending.seq
            if (!this.pending.has(pending.seq) || !reaches.some((reach) => reachesChange(reach, pending.change, pending.author))) continue
            const author = attribute(pending.change, this.evidence)
            if (author.certainty === "exact") this.evidence.proved(author.author, pending.change.path, pending.change.changedAt)
            if (JSON.stringify(author) === JSON.stringify(pending.author)) continue
            pending.author = author
            this.store.updateAuthor(pending.seq, author, false)
            // A call that named the file ran the Git command that wrote it: its work, as `git checkout -- file` is.
            if (pending.git && (author.certainty === "exact" || author.certainty === "named")) {
              pending.git = false
              this.store.markGit(pending.seq, false)
            }
          }
        }
      } finally {
        slice.done()
      }
    })()
      .catch((error: Error) => this.log("reattribution failed", { error: error.message }))
      .finally(() => {
        this.reattribution = undefined
        this.round = undefined
        // Evidence that came as the last round ended, or a proof one made, is the next pass's.
        this.reattribute()
      })
  }

  /** Whether evidence not yet weighed may still change this change's author. */
  private stale(pending: Pending): boolean {
    const round = this.round
    if (round && pending.seq > round.done && round.reaches.some((reach) => reachesChange(reach, pending.change, pending.author))) return true
    return this.evidence.reaching().some((reach) => reachesChange(reach, pending.change, pending.author))
  }

  private scheduleSettle(): void {
    if (this.settleTimer || !this.pending.size || this.closed) return
    this.settleTimer = setTimeout(() => {
      this.settleTimer = undefined
      this.settle()
      this.scheduleSettle()
    }, SETTLE_MS / 4)
    this.settleTimer.unref?.()
  }

  /** Settle what the clock says no new evidence can reach; a simulation calls it after moving its clock. */
  sweep(): void {
    this.settle()
  }

  /** Close every change no new evidence can reach. */
  private settle(force = false): void {
    clearImmediate(this.settleNext)
    this.settleNext = undefined
    const slice = this.settleSlice ?? new Slice(this.slicing)
    this.settleSlice = undefined
    if ((this.holds || this.closed) && !force) return slice.done()
    const now = this.now()
    const live = this.evidence.liveSince(now)
    let stale = false
    let more = false
    this.store.transaction(() => {
      for (const pending of this.pending.values()) {
        if (!force && (now - pending.change.changedAt < SETTLE_MS || pending.change.changedAt + TRAIL_MS >= live)) continue
        // Only a change whose author has weighed all the evidence settles: the rest wait for their pass, not for every pass to end.
        if (!force && this.stale(pending)) {
          stale = true
          continue
        }
        this.store.updateAuthor(pending.seq, pending.author, true)
        this.pending.delete(pending.seq)
        if (!force && slice.spent) {
          more = true
          break
        }
      }
    })
    // A backlog settles a slice at a time.
    if (more) {
      this.settleSlice = slice
      this.settleNext = setImmediate(() => {
        slice.restart()
        this.settle()
      })
    } else slice.done()
    if (stale) this.reattribute()
    if (!more && !this.pending.size) this.evidence.prune(now - SETTLE_MS - this.lateMs())
  }

  /**
   * Every change heard so far journaled. With `rescans: false` (a turn's
   * count), only what was heard: a rescan waiting out its spacing keeps
   * waiting, and a root rescanning now isn't waited for. A turn ends about
   * once a minute on a busy Mac. Each ended turn used to rescan every root
   * that had lost events, back to back with no rest, and wait until none was
   * left. While fseventsd stayed behind, that could go on for good: the
   * shared journal's caller gave up at 15 s, and the walks and the stat
   * cache's writes held the host's loop.
   */
  async settled(options: { rescans?: boolean } = {}): Promise<void> {
    if (options.rescans === false) return this.whatWasHeard()
    await this.resuming
    this.settling++
    try {
      for (;;) {
        const states = [...this.states.values()]
        for (const state of states) {
          clearTimeout(state.timer)
          clearTimeout(state.headTimer)
          if (state.headTimer || state.gitSince !== undefined) void this.queue(state, () => this.gitMoved(state))
          else if (state.pending.size) void this.queue(state, () => this.flush(state))
          state.headTimer = undefined
          // A rescan waiting out its spacing, or its turn behind another root's rest, runs now.
          if (state.rescanTimer) this.rescanNow(state)
        }
        for (const wake of this.waking) wake()
        await this.rescanTurns
        await Promise.all(states.map((state) => state.chain))
        await Promise.all(this.scriptReads)
        await this.footprints?.settled()
        while (this.reattribution) await this.reattribution
        await new Promise((resolve) => setImmediate(resolve))
        if (!this.reattribution && states.every((state) => !state.pending.size && !state.rescanTimer && !state.rescanQueued)) return
      }
    } finally {
      this.settling--
    }
  }

  /** What was heard journaled, rescans left to their own pace: a root rescanning now is passed over, its changes found by the rescan. */
  private async whatWasHeard(): Promise<void> {
    await this.resuming
    for (let pass = 0; pass < HEARD_PASSES; pass++) {
      const runs: Promise<void>[] = []
      for (const state of this.states.values()) {
        if (state.rescanning) continue
        if (state.headTimer || state.gitSince !== undefined) {
          clearTimeout(state.timer)
          clearTimeout(state.headTimer)
          state.headTimer = undefined
          runs.push(this.queue(state, () => this.gitMoved(state)))
        } else if (state.pending.size) {
          clearTimeout(state.timer)
          runs.push(this.queue(state, () => this.flush(state)))
        }
      }
      if (!runs.length) break
      await Promise.all(runs)
    }
    await Promise.all(this.scriptReads)
    await this.footprints?.settled()
    while (this.reattribution) await this.reattribution
  }

  /** How often roots were rescanned for lost events in the last hour, and which are rescanned less often because their losses keep coming. */
  rescanReading(): RescanFootprint {
    const now = this.now()
    const states = [...this.states.values()]
    return {
      roots: states.length,
      lastHour: this.rescans.done.lastHour(now),
      filesLastHour: this.rescans.files.lastHour(now),
      msLastHour: this.rescans.ms.lastHour(now),
      lossesLastHour: states.reduce((sum, state) => sum + state.losses.lastHour(now), 0),
      backedOff: states.filter((state) => state.rescanEvery >= BACKED_OFF_MS && now - state.rescannedAt <= RESCAN_QUIET_MS)
        .map((state) => ({ root: state.root.path, everyMs: state.rescanEvery })),
    }
  }

  changes(after: number, limit = 1000): JournalEntry[] {
    return this.store.entries(after, limit).map((entry) => this.entry(entry))
  }

  entry(entry: StoredEntry): JournalEntry {
    return {
      journal: this.store.id,
      seq: entry.seq,
      at: entry.at,
      changedAt: entry.changedAt,
      root: entry.root,
      path: entry.path,
      kind: entry.kind,
      from: entry.from,
      before: entry.before,
      after: entry.after,
      size: entry.size,
      text: entry.text,
      lines: entry.added !== undefined && entry.removed !== undefined ? { added: entry.added, removed: entry.removed } : undefined,
      stored: entry.stored,
      observed: entry.observed,
      gap: entry.gap,
      restores: entry.restores,
      author: this.pending.get(entry.seq)?.author ?? entry.author,
      settled: entry.settled,
      ...(entry.git && { git: true as const }),
    }
  }

  blame(root: string, path: RootPath): LineRun[] | null {
    const file = this.states.get(root)?.files.get(path)
    if (!file) {
      const state = this.states.get(root)
      if (state?.asleep) return this.store.hasStat(root, path) ? [] : null
      return state?.stats.has(path) ? [] : null
    }
    if (!file.text) return null
    const authors = new Map<number, Attribution | null>()
    const author = (seq: number) => {
      if (seq <= 0) return null
      if (!authors.has(seq)) authors.set(seq, this.authorOf(seq))
      return authors.get(seq) ?? null
    }
    return presentRuns(file.map).map((run) => ({ start: run.start, length: run.length, entry: run.ins > 0 ? run.ins : null, author: author(run.ins) }))
  }

  footprint(thread: string): FootprintEntry[] {
    return this.store.footprint("thread", thread)
  }

  /** What each of a Thread's turns read outside the roots, kept and left out, oldest first. */
  footprintTurns(thread: string): FootprintTurn[] {
    return this.store.footprintTurns(thread)
  }

  gaps(): Gap[] {
    return this.store.gaps()
  }

  stored(ref: ContentRef): boolean {
    return this.store.hasBlob(ref)
  }

  /** The tracked roots and what the tracker holds for each, for queries. */
  rootStates(): ReadonlyMap<string, { root: StoredRoot; files: ReadonlyMap<string, FileState>; stats: ReadonlyMap<string, StatRow> }> {
    return this.states
  }

  /** Recent flushes, newest last, for status. */
  recent(): readonly Flush[] {
    return this.flushes
  }

  /**
   * Let go of roots idle past the retention window: tracked that long ago,
   * nothing journaled there since, and no Thread working in or around them.
   * Their watches close and their stat cache goes; their entries stay until
   * collected. A turn or a move there tracks the root again, from a fresh
   * baseline. A root with lost events not yet rescanned is let go too: on a
   * Mac where they're lost every few minutes, one always has some. Returns
   * the paths let go.
   */
  async letGoIdle(): Promise<string[]> {
    const before = this.now() - (this.options.retentionMs ?? 14 * DAY_MS)
    // Where Threads worked is read only for a root nobody changed lately: on most passes there's none.
    // The tracker closing (its host stopping) ends it at its next step, letting go of nothing: the next pass looks again.
    const stopping = () => this.closing || this.store.closed
    let read: Recency
    try {
      read = await inSlices(this.store.recency(this.now(), (changed) => this.idle({ changed, worked: new Map() }, before).length > 0), undefined, stopping)
    } catch (error) {
      if (error instanceof StepsStopped) return []
      throw error
    }
    const paths: string[] = []
    for (const state of this.idle(read, before)) {
      if (stopping()) break
      // Other work ran since the reading, and runs while each root is let go: what was journaled or began there since
      // keeps it. Nothing stops between this reading and `untrack` taking the root out of `states`.
      if (this.states.get(state.root.id) !== state || !this.idle(this.store.recencySince(read.mark, this.now()), before).includes(state)) continue
      await this.untrack(state.root.id)
      paths.push(state.root.path)
    }
    if (paths.length) this.log("let go of idle roots", { roots: paths.length, paths: paths.join(", ").slice(0, 500) })
    return paths
  }

  /** The roots tracked before `before` that `read` says nobody changed since, with no Thread working in or around them since. */
  private idle(read: Pick<Recency, "changed" | "worked">, before: number): RootState[] {
    const recent = [...read.worked].filter(([, at]) => at >= before).map(([folder]) => folder)
    return [...this.states.values()].filter(({ root, pending }) => root.trackedAt < before && (read.changed.get(root.id) ?? 0) < before && !pending.size &&
      !recent.some((folder) => within(root.path, folder) || within(folder, root.path)))
  }

  /**
   * Let roots sleep that nobody changed or worked in or around for `sleepAfterMs` (6 hours): their watches close and
   * their stat caches and tracked paths go, the bulk of what the tracker holds (on the person's Mac on 2026-11-12, 154
   * roots and a million stat rows, most of them finished Threads' worktrees). Their uncommitted files stay, so what
   * they answer stays. Each stays tracked: the next turn there, or a move or a status of its checkout, wakes it as a
   * restart resumes a root, its changes since read from the system's history or found by a rescan. Returns the paths.
   */
  async sleepIdle(): Promise<string[]> {
    const before = this.now() - (this.options.sleepAfterMs ?? SLEEP_AFTER_MS)
    const stopping = () => this.closing || this.store.closed
    const awake = (states: RootState[]) => states.filter((state) => !state.asleep)
    let read: Recency
    try {
      read = await inSlices(this.store.recency(this.now(), (changed) => awake(this.idle({ changed, worked: new Map() }, before)).length > 0), undefined, stopping)
    } catch (error) {
      if (error instanceof StepsStopped) return []
      throw error
    }
    const paths: string[] = []
    for (const state of awake(this.idle(read, before))) {
      if (stopping()) break
      if (this.states.get(state.root.id) !== state || !this.idle(this.store.recencySince(read.mark, this.now()), before).includes(state)) continue
      if (await this.sleep(state, () => this.idle(this.store.recencySince(read.mark, this.now()), before).includes(state))) paths.push(state.root.path)
    }
    if (paths.length) this.log("roots asleep", { roots: paths.length, asleep: [...this.states.values()].filter((item) => item.asleep).length, paths: paths.join(", ").slice(0, 500) })
    return paths
  }

  /** Whether a root is asleep (`sleepIdle`): tracked, not watched, woken by `track`. */
  asleep(path: string): boolean {
    for (const state of this.states.values()) if (state.root.path === path) return Boolean(state.asleep)
    return false
  }

  /**
   * Put one quiet root to sleep; false when something under way there keeps it awake. Its watch closes first, and
   * what it heard is journaled, so the root is checked again once that's done: a turn that started there meanwhile
   * (`track` asked, or `stillIdle` no longer holds) keeps it awake, its watch open again and what changed while it was
   * closed found by a rescan.
   */
  private async sleep(state: RootState, stillIdle: () => boolean): Promise<boolean> {
    const busy = () => Boolean(state.asleep || state.gap || state.pending.size || state.rescanning || state.rescanQueued || state.rescanTimer || state.headTimer ||
      state.gitSince !== undefined || this.tracking.has(state.root.path))
    if (busy()) return false
    const tracks = state.tracks
    const closedAt = this.now()
    this.unlisten(state)
    state.watch = undefined
    state.headWatch = undefined
    await state.chain
    // What the watch heard before it closed is journaled first: nothing it said is left for a wake to find again.
    if (state.pending.size) await this.queue(state, () => this.flush(state))
    if (this.closed || this.states.get(state.root.id) !== state) return false
    if (busy() || state.tracks !== tracks || !stillIdle()) {
      // Asked for while the watch was closed: it stays awake, and what it didn't hear meanwhile is lost events.
      state.root.seenAt = closedAt
      await this.listen(state).catch((error: Error) => this.log("a root could not be watched again", { root: state.root.path, error: error.message }))
      this.lost(state, "dropped")
      return false
    }
    state.asleep = true
    state.root.seenAt = this.now()
    this.store.saveRoot(state.root)
    state.stats = new StatCache()
    state.tracked = new Set()
    state.adopted = new Set()
    state.recent = []
    state.ignored = undefined
    state.markTaken = undefined
    return true
  }

  /** Drop kept content past the retention window and over the budget. */
  collect(): { dropped: number; bytes: number } {
    const retention = this.options.retentionMs ?? 14 * DAY_MS
    return this.store.collect(this.now() - retention, this.options.budgetBytes ?? 2 * 1024 ** 3)
  }

  /**
   * `collect`, its reading on a worker with a connection of its own and its deletes here a batch at a time, leaving
   * this thread free: what this connection writes meanwhile is kept whatever the reading found. At most
   * `COLLECT_MOST` blobs a pass.
   */
  async collectOffThread(): Promise<Collected & { ms: number }> {
    const started = performance.now()
    const retainAfter = this.now() - (this.options.retentionMs ?? 14 * DAY_MS)
    this.store.touching()
    try {
      const plan = await collectPlanOffThread(this.store.path, retainAfter, this.options.budgetBytes ?? 2 * 1024 ** 3)
      let dropped = 0
      let bytes = 0
      for (let first = 0; first < plan.refs.length && !this.closed; first += COLLECT_BATCH) {
        if (first) await new Promise<void>((resolve) => setImmediate(resolve))
        const batch = this.store.dropPlanned(plan.refs.slice(first, first + COLLECT_BATCH))
        dropped += batch.dropped
        bytes += batch.bytes
      }
      if (!this.closed) this.store.dropOld(retainAfter)
      return { dropped, bytes, ms: Math.round(performance.now() - started) }
    } finally {
      this.store.untouched()
    }
  }


  private flushed(flush: Flush): void {
    this.flushes.push(flush)
    if (this.flushes.length > 200) this.flushes.shift()
    if (!this.options.log) return
    const facts = (item: Flush) => ({
      files: item.files, entries: item.entries, lagMs: Math.round(item.lagMs), statMs: round(item.statMs), hashMs: round(item.hashMs),
      diffMs: round(item.diffMs), writeMs: round(item.writeMs), slowest: item.slowest ?? "",
    })
    if (flush.lagMs > SLOW_FLUSH_MS) this.log("slow flush", facts(flush))
    this.unlogged.push(flush)
    if (this.now() - this.logged < LOG_EVERY_MS) return
    this.logged = this.now()
    const batch = this.unlogged
    this.unlogged = []
    this.log("journaled", {
      flushes: batch.length,
      files: batch.reduce((sum, item) => sum + item.files, 0),
      entries: batch.reduce((sum, item) => sum + item.entries, 0),
      maxLagMs: Math.round(Math.max(...batch.map((item) => item.lagMs))),
      hashMs: round(batch.reduce((sum, item) => sum + item.hashMs, 0)),
      diffMs: round(batch.reduce((sum, item) => sum + item.diffMs + item.writeMs, 0)),
    })
  }

  private log(message: string, facts: Readonly<Record<string, string | number | boolean>>): void {
    this.options.log?.(message, facts)
  }

  async close(): Promise<void> {
    if (this.closed) return
    // The root resuming now finishes; the rest resume when the journal next opens.
    this.closing = true
    await this.settled()
    this.closed = true
    this.footprints?.close()
    this.reader.close()
    clearTimeout(this.settleTimer)
    for (const state of this.states.values()) this.unlisten(state)
    await Promise.all([...this.states.values()].map((state) => state.chain))
    this.settle(true)
    this.store.transaction(() => {
      for (const state of this.states.values()) {
        // One asleep keeps when it fell asleep: its wake reads what changed since then.
        if (state.asleep) continue
        state.root.seenAt = this.now()
        this.store.saveRoot(state.root)
      }
    })
    this.states.clear()
    this.store.close()
  }
}

const round = (ms: number) => Math.round(ms * 100) / 100

function isTextBytes(bytes: Uint8Array | undefined): boolean {
  return bytes === undefined || isText(bytes)
}

/** Uncertain enough for content read back from a record to name its author: never a person's save Mako saw, nor a call's proven or named change. */
function reconcilable(author: Attribution | null): boolean {
  if (!author) return false
  return author.certainty === "window" || author.certainty === "ambiguous" || (author.certainty === "person" && author.via === "no-activity")
}

/** Create, write or modify with the content or edits it wrote, not a file the harness only saw change. */
function writesContent(effect: ReportedEffect): effect is Extract<ReportedEffect, { kind: "create" | "write" | "modify" }> {
  if ("seen" in effect && effect.seen) return false
  if (effect.kind === "create" || effect.kind === "write") return effect.content !== undefined
  return effect.kind === "modify" && (effect.patch !== undefined || Boolean(effect.edits?.length))
}

/** Whether a change at `at` falls in the call's span; any time, for a call whose record keeps none. */
function withinCall(call: ReportedCall, at: number, now: number): boolean {
  if (call.startedAt === undefined) return true
  return call.startedAt - LEAD_MS <= at && at <= (call.endedAt ?? now) + TRAIL_MS
}

function callAuthor(call: ReportedCall): Author {
  return authorOf(call, call.call)
}

/** A modification time this close is a write's own, give or take a file system that keeps whole seconds. */
const MTIME_SLACK_MS = 1_000

/**
 * When a change found after lost events was made: any time in the gap, or
 * when its file was written if its modification time says so, within the
 * gap; `before` when that time is older than the gap.
 */
function lostSpan(from: number, at: number, written: number | undefined): { from: number; to: number } | "before" {
  if (written === undefined || written > at + MTIME_SLACK_MS) return { from, to: at }
  if (written < from - TRAIL_MS) return "before"
  return { from: Math.max(from, written - MTIME_SLACK_MS), to: Math.min(at, written + MTIME_SLACK_MS) }
}

function deadBase(map: readonly Run[]): number {
  return map.reduce((sum, run) => sum + (run.ins === 0 && run.del ? run.length : 0), 0)
}

/** Evidence rebuilt from the journal's activity, for a stretch memory may no longer hold. */
function evidenceOf(activity: readonly StoredActivity[], worked: WorkingSets): Evidence {
  const evidence = new Evidence(worked)
  for (const item of activity) {
    const mark = { kind: item.kind, id: item.id, thread: item.thread, session: item.session, turn: item.turn, checkout: item.checkout, cwd: item.cwd, named: item.named }
    evidence.mark({ ...mark, edge: "start", at: item.start })
    if (item.end !== null) evidence.mark({ ...mark, edge: "end", at: item.end })
  }
  return evidence
}

function storedActivity(interval: Interval): StoredActivity {
  return {
    kind: interval.kind,
    id: interval.id,
    session: interval.session,
    thread: interval.thread,
    turn: interval.turn,
    checkout: interval.checkout,
    cwd: interval.cwd,
    label: interval.label,
    named: interval.named,
    record: interval.record,
    start: interval.start,
    end: interval.end,
  }
}

/** `*` within a folder, `**` across folders, as a recipe's `carry` writes them. */
export function globMatch(glob: string, path: string): boolean {
  const pattern = glob
    .split("**")
    .map((part) => part.split("*").map((piece) => piece.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*"))
    .join(".*")
  return new RegExp(`^${pattern}(/.*)?$`).test(path)
}

export { LEAD_MS, TRAIL_MS }
