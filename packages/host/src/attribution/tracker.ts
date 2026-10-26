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
} from "@mako/protocol"
import { join } from "node:path"
import { contentRef, decodeText, hasher, isText, READ_LIMIT, secretPath, STORE_LIMIT } from "./content.js"
import { attribute, authorOf, claim, Evidence, LEAD_MS, TRAIL_MS, type Interval, type ObservedChange } from "./evidence.js"
import { WorkingSets } from "./working-set.js"
import { JournalStore, wholeChange, type FileState, type StatRow, type StoredActivity, type StoredEntry, type StoredRoot } from "./journal-store.js"
import { diffLines, splitLines } from "./line-diff.js"
import { applyHunks, BASE, baseMap, onlyBase, presentLines, presentRuns, rebase, UNKNOWN, withKnownWriters, withWriter, writers, type Run } from "./line-map.js"
import { FootprintReader, type FootprintOptions } from "./footprint-reader.js"
import type { FootprintTurn } from "./footprint.js"
import { untrackable, within } from "./paths.js"
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
  /** The most kept content may take, compressed. Default 2 GB. */
  budgetBytes?: number
  /** Where a turn's footprint is read from (the home folder and temporary folders), and what the host knows to leave out. */
  footprint?: FootprintOptions
  /** A change heard live came out uncertain while these Sessions were running: their child agents' records may name its author. */
  uncertain?(sessions: ReadonlySet<string>): void
  /** An agent this host doesn't run, working now where `path` (absolute, in `root`) is, in a few words; undefined when there's none. */
  outsider?(path: string, root: string): string | undefined
  /** One line per flush, at most every `LOG_EVERY_MS`, and every slow one. Paths, never content. */
  log?(message: string, facts: Readonly<Record<string, string | number | boolean>>): void
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
const DAY_MS = 86_400_000
/** A command's named paths the journal keeps, for the Thread's working set. */
const STORED_NAMED = 64

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
  stats: Map<string, StatRow>
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
  headTimer?: ReturnType<typeof setTimeout>
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
  private reattributing = false
  /** Reads that may still name an open change's author. */
  private holds = 0
  /** Each turn's footprint outside the tracked roots, and the machine's learned churn. */
  readonly footprints?: FootprintReader
  private readonly flushes: Flush[] = []
  private logged = 0
  private unlogged: Flush[] = []
  private closed = false
  /** The last entry's number. */
  private seq: number

  private constructor(ports: TrackerPorts, options: TrackerOptions, store: JournalStore) {
    this.ports = ports
    this.options = options
    this.store = store
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
    for (const root of roots) {
      const resumed = previous.then(() => tracker.resumeOrLetGo(root))
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

  private now(): number {
    return this.ports.clock.now()
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
      if (!this.states.has(known.id)) await this.resume({ ...known, carry: root.carry })
      return
    }
    if (known) this.store.forgetRoot(known.id)
    const repo = (await this.options.repository?.(root.path)) ?? null
    const mark = await this.ports.events.mark().catch(() => null)
    const head = repo ? await repo.head() : null
    const stored: StoredRoot = { ...root, repository: Boolean(repo), head, mark, seenAt: this.now(), trackedAt: this.now(), active: true }
    const state = this.state(stored, repo, new Map(), new Map())
    await this.listen(state)
    await this.queue(state, () => this.baseline(state))
  }

  async untrack(id: string): Promise<void> {
    const state = this.states.get(id)
    if (!state) return
    this.states.delete(id)
    this.unlisten(state)
    await state.chain
    this.store.forgetRoot(id)
  }

  private state(root: StoredRoot, repo: TrackerRepository | null, stats: Map<string, StatRow>, files: Map<string, FileState>): RootState {
    const state: RootState = { root, repo, stats, files, tracked: new Set(), pending: new Map(), adopted: new Set(), firstHeard: 0, chain: Promise.resolve(), muted: false, recent: [], headSeq: this.seq }
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
    await this.listen(state)
    const from = root.seenAt
    const history = root.mark ? await this.ports.events.since(root.mark, root.path).catch(() => null) : null
    const gap = this.store.openGap(root.id, from, "restart")
    state.gap = { id: gap, from, reason: "restart" }
    // HEAD first, so what a checkout or pull wrote while no host ran is read as the base it is.
    if (repo) await this.queue(state, async () => {
      state.moved = await this.checkHead(state)
    })
    try {
      if (history?.complete) {
        const paths = history.paths.filter((path) => within(root.path, path) && path !== root.path).map((path) => relative(root.path, path))
        for (const path of paths) if (!isGitPath(path)) state.pending.set(path, "history")
        await this.queue(state, async () => {
          await this.flush(state)
          this.store.closeGap(gap, this.now())
          state.gap = undefined
        })
      } else await this.queue(state, () => this.rescan(state))
    } finally {
      state.moved = undefined
    }
  }

  private async listen(state: RootState): Promise<void> {
    state.watch = await this.ports.events.watch(state.root.path, {
      changed: (paths) => this.heard(state, paths),
      lost: (reason) => this.lost(state, reason),
      heard: () => {
        if (!state.muted) return
        state.muted = false
        void this.queue(state, () => this.rescan(state))
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
  }

  private heard(state: RootState, paths: readonly string[]): void {
    // A state replaced for its root, however that came about, journals nothing more.
    if (this.closed || this.states.get(state.root.id) !== state) return
    let head = false
    for (const raw of paths) {
      const path = raw.startsWith("/") ? relative(state.root.path, raw) : raw
      if (!path || path.startsWith("..")) continue
      if (isGitPath(path)) {
        if (GIT_HEAD.test(path)) head = true
        continue
      }
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
    if (this.closed) return
    if (reason === "gone") {
      // A root that went away (a removed worktree) is forgotten, not rescanned into a delete for every file.
      void this.ports.fs.stat(state.root.path).then((stat) => {
        if (stat?.kind === "directory") return this.lost(state, "dropped")
        this.log("root gone", { root: state.root.path })
        return this.untrack(state.root.id)
      })
      return
    }
    if (reason === "muted") state.muted = true
    if (!state.gap) {
      const from = state.root.seenAt
      state.gap = { id: this.store.openGap(state.root.id, from, reason), from, reason }
    }
    if (reason !== "muted") void this.queue(state, () => this.rescan(state))
  }

  private headMoved(state: RootState): void {
    if (!state.repo) return
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

  /** Every file under the root, compared against the stat cache: what lost events may have hidden. */
  private async rescan(state: RootState): Promise<void> {
    const started = this.now()
    const paths = await this.ports.fs.walk(state.root.path, (path) => untrackable(path, false) && !state.tracked.has(path))
    for (const path of paths) if (!state.pending.has(path)) state.pending.set(path, "rescan")
    for (const path of state.stats.keys()) if (!state.pending.has(path)) state.pending.set(path, "rescan")
    await this.flush(state)
    if (state.gap) {
      this.store.closeGap(state.gap.id, this.now())
      state.gap = undefined
    }
    this.log("rescan", { root: state.root.path, files: paths.length, ms: this.now() - started })
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
    await mapLimit(batch, PARALLEL, async ([path, how]) => {
      // Never stat, let alone walk, what is never tracked.
      if (untrackable(path, state.tracked.has(path))) return
      const stat = await this.ports.fs.stat(join(state.root.path, path))
      if (stat?.kind === "directory") {
        for (const inner of await this.ports.fs.walk(join(state.root.path, path), (child) => untrackable(`${path}/${child}`, state.tracked.has(`${path}/${child}`))))
          expanded.set(`${path}/${inner}`, how)
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
    // Changes found after lost events could have happened any time in the gap, which memory may no longer hold.
    const gapEvidence = state.gap && prepared.some(({ how }) => how !== "event") ? evidenceOf(this.store.activityBetween(state.gap.from - TRAIL_MS, at), this.evidence.worked) : undefined
    this.store.transaction(() => {
      for (const { item, how, before } of prepared) {
        const t = performance.now()
        const from = renamed.get(item.path)
        const seq = this.record(state, item, how, undefined, at, before, from, how === "event" ? undefined : gapEvidence)
        if (seq) timing.entries++
        const spent = performance.now() - t
        if (spent > slowest) {
          slowest = spent
          timing.slowest = item.path
        }
      }
      state.root.seenAt = at
      this.store.saveRoot(state.root)
    })
    timing.writeMs = performance.now() - started
    timing.lagMs = this.now() - heardAt
    this.flushed(timing)
    this.scheduleMark(state)
    this.scheduleSettle()
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
    const changedAt = item.stat && !from ? Math.min(at, Math.max(at - SETTLE_MS, millis(item.stat.mtimeNs))) : at
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
    const change: ObservedChange = {
      path: join(root.path, path),
      from: from ? join(root.path, from) : undefined,
      kind,
      changedAt,
      refs: { before: before.ref, after: afterRef },
      lost: state.gap && how !== "event" ? { from: state.gap.from, to: at } : undefined,
      before: beforeText,
      after: afterText,
      root: root.path,
    }
    // Its modification time isn't when it was written: a copy that kept an old one, one ahead of the clock, or one rounded to the second.
    if (written === undefined || written > at || at - written > TRAIL_MS || item.stat!.mtimeNs % 1_000_000_000n === 0n) change.heard = at
    const outsider = how === "event" && !given ? this.options.outsider?.(change.path, root.path) : undefined
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
   * entry wrote. Returns what the move changed, by path: the new commit's
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
    const paths = new Set([...moved, ...state.files.keys()])
    const committed = new Map<string, Uint8Array | null>()
    const earlier = new Map<string, Uint8Array | null>()
    await mapLimit([...paths], PARALLEL, async (path) => {
      committed.set(path, await repo.read(head, path))
      const row = state.stats.get(path)
      if (!state.files.has(path) && row && !row.ref && previous) earlier.set(path, await repo.read(previous, path))
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
    this.store.transaction(() => {
      for (const path of paths) {
        const bytes = committed.get(path) ?? null
        const ref = keep(path, bytes)
        const file = state.files.get(path)
        const row = state.stats.get(path)
        if (!file) {
          if (!row) continue
          // A clean file's content is the commit it was clean against; pin it before the base moves.
          const old = row.ref ? this.store.blob(row.ref) : earlier.get(path)
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
        const current = file.current ? this.store.blob(file.current) : undefined
        const before = file.base ? this.store.blob(file.base) : new Uint8Array()
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
    this.log("base moved", { root: root.path, from: previous ?? "none", to: head, files: paths.size, ms: this.now() - started })
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
    this.reattribute()
  }

  /** A write Mako begins, from `at` (another host on this device says when its own began); `end` takes when it ended the same way. */
  mako(input: MakoWrite, at = this.now()): MakoWriting & { end(at?: number): void } {
    const write = MakoWriteSchema.parse(input)
    const interval = this.evidence.makoStart(write, at)
    return {
      end: (ended: number = this.now()) => {
        interval.end = Math.max(at, ended)
        this.reattribute()
      },
    }
  }

  /** A write Mako reports once it's done, such as a Git command it ran. */
  makoWrote(input: MakoWrite, startedAt: number, endedAt: number): void {
    const write = MakoWriteSchema.parse(input)
    this.evidence.makoStart(write, startedAt).end = Math.max(startedAt, endedAt)
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

  /** New evidence can change the author of a change not yet settled. */
  private reattribute(): void {
    if (this.reattributing || !this.pending.size) return
    this.reattributing = true
    queueMicrotask(() => {
      this.reattributing = false
      if (this.closed) return
      for (const pending of this.pending.values()) {
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
    })
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
    if (this.holds && !force) return
    const now = this.now()
    for (const pending of this.pending.values()) {
      if (!force && (now - pending.change.changedAt < SETTLE_MS || !this.evidence.quietSince(pending.change.changedAt, now))) continue
      this.store.updateAuthor(pending.seq, pending.author, true)
      this.pending.delete(pending.seq)
    }
    if (!this.pending.size) this.evidence.prune(now - SETTLE_MS)
  }

  async settled(): Promise<void> {
    await this.resuming
    for (;;) {
      const states = [...this.states.values()]
      for (const state of states) {
        clearTimeout(state.timer)
        clearTimeout(state.headTimer)
        if (state.headTimer || state.gitSince !== undefined) void this.queue(state, () => this.gitMoved(state))
        else if (state.pending.size) void this.queue(state, () => this.flush(state))
        state.headTimer = undefined
      }
      await Promise.all(states.map((state) => state.chain))
      await this.footprints?.settled()
      await new Promise((resolve) => setImmediate(resolve))
      if (states.every((state) => !state.pending.size)) return
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
   * baseline. Returns the paths let go.
   */
  async letGoIdle(): Promise<string[]> {
    const before = this.now() - (this.options.retentionMs ?? 14 * DAY_MS)
    const changed = this.store.lastChanged()
    const worked = this.store.lastWorked(this.now()).filter(({ at }) => at >= before)
    const idle = [...this.states.values()].filter(({ root, pending, gap }) =>
      root.trackedAt < before && (changed.get(root.id) ?? 0) < before && !pending.size && !gap &&
      !worked.some(({ folder }) => within(root.path, folder) || within(folder, root.path)))
    for (const { root } of idle) await this.untrack(root.id)
    const paths = idle.map(({ root }) => root.path)
    if (paths.length) this.log("let go of idle roots", { roots: paths.length, paths: paths.join(", ").slice(0, 500) })
    return paths
  }

  /** Drop kept content past the retention window and over the budget. */
  collect(): { dropped: number; bytes: number } {
    const retention = this.options.retentionMs ?? 14 * DAY_MS
    return this.store.collect(this.now() - retention, this.options.budgetBytes ?? 2 * 1024 ** 3)
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
    clearTimeout(this.settleTimer)
    for (const state of this.states.values()) this.unlisten(state)
    await Promise.all([...this.states.values()].map((state) => state.chain))
    this.settle(true)
    this.store.transaction(() => {
      for (const state of this.states.values()) {
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
