/**
 * Every session on this machine, from every harness, kept current.
 *
 * Speed comes from doing strictly bounded work at each layer:
 *
 *   * **Scan** stats files and re-peeks only the ones whose size or mtime
 *     moved — a thousand unchanged sessions cost a thousand stats and zero
 *     reads. The peek cache persists across runs, so a cold start with a
 *     warm cache does no reading at all.
 *   * **Watch** puts one recursive watcher on each harness root and re-peeks
 *     the native session file that changed, debounced per path. A sidecar
 *     write (Grok's `summary.json`) maps back to that file so one session
 *     cannot occupy two rows. Opening a Codex session in a terminal, another
 *     app, anywhere — shows up here within a debounce interval, because the
 *     file is the source of truth and the file is what is watched.
 *   * **Follow** tails one open thread by byte offset: a streaming agent
 *     costs one positional read of only the appended bytes per flush.
 */

import { existsSync, realpathSync, watch, watchFile, unwatchFile, type FSWatcher, type Stats } from "node:fs"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, join, sep } from "node:path"
import {
  parseCache,
  CATALOG_CACHE_VERSION,
  type CacheEntry,
} from "./catalog-cache.js"
import { translatorBuild } from "./translator.js"
import { pageOf, ThreadView, VIEW_MIN_DECODE_MS, ViewCache, type SessionView } from "./view-cache.js"
import { isReplyEntry, type Entry } from "./entries.js"
import {
  threadIdentity,
  type Thread,
  type ThreadPage,
  type ThreadPageOptions,
  type ThreadRef,
} from "./format.js"
import {
  SessionUnreadable,
  type NativeFile,
  type SessionFollower,
  type SessionProvider,
  type SessionUpdate,
} from "./providers/types.js"
import { SessionArchive, type EvictionPolicy } from "./archive.js"
import { boundedChildren, type ChildTranscript, type ChildTranscripts } from "./children.js"
import { NativeStores, ReadOnlyStoreError } from "./read-only-sqlite.js"
import { DECODE_ASIDE_BYTES, type AsideJob, type DecodeAside } from "./decode-aside.js"
import type { FollowStart } from "./jsonl.js"
import { RecordCapture } from "./record-capture.js"
import { RecordReads, RESTORED, type ReadBack } from "./record-reads.js"
import { RecordStore } from "./record-store.js"
import { readOriginal, type EntryOriginal } from "./record-original.js"
import { streamOwner, streamsRoot } from "./record-streams.js"
import { FolderWatches, type RootWatch } from "./root-watch.js"

export type CatalogEvent =
  | { type: "added"; ref: ThreadRef }
  | { type: "updated"; ref: ThreadRef }
  | { type: "removed"; path: string }

/** One follow of a thread. `reload`, where the follower can take one, pages the session again instead of a whole read in this process. */
interface FollowListener {
  entries: (entries: Entry[], replaced: boolean, replaceFrom?: number) => void
  reload?: () => void
}

interface FollowState {
  listeners: Set<FollowListener>
  follower: SessionFollower | null
  fromByte: number
  baselineCount: number | null
  unobserve?: () => void
}

interface RefreshState {
  requested: boolean
  forceMetadata?: boolean
  promise: Promise<void>
}

/**
 * How often a moving session's children are listed again for the archive.
 * Listing reads links only, but for a session of a hundred thousand Devin
 * nodes that is seconds; a child's own capture still settles like any
 * session's.
 */
const CHILD_CAPTURE_MS = 60_000
/** Sessions whose last read a follow can take over from: the viewer's, and what was read beside it since. */
const OPENED_KEPT = 8
/**
 * What the views a catalog holds in memory weigh at most, compressed: the
 * sessions that decode too fast to be worth a file, and every session of a
 * catalog that writes nothing.
 */
const MEMORY_VIEW_BYTES = 192 * 1024 * 1024
/**
 * The most characters of a session the archive translates whole, in the
 * sync daemon's 128 MB heap. A larger session's records are kept in the
 * record store, which reads it back as its harness wrote it.
 */
const ARCHIVE_MAX_CHARS = 8 * 1024 * 1024

/** Below this a record translates faster than a preview helps. */
const PREVIEW_MIN_BYTES = 4 * 1024 * 1024
/** Tail windows a preview widens through until one holds a prompt. */
const PREVIEW_WINDOWS = [2, 8, 24].map((mb) => mb * 1024 * 1024)

const WATCH_DEBOUNCE_MS = 24
const POLL_FILES_MS = 1000
/**
 * A refresh waits for writes to settle, but never longer than this many
 * settle windows after the first write of a burst. An agent streaming into
 * a store writes continuously; a pure trailing debounce would refresh only
 * when it paused.
 */
const WATCH_MAX_SETTLE_WINDOWS = 4
const CACHE_SAVE_DEBOUNCE_MS = 2000

/** Discovery cadence even when directory notifications silently disappear. */
const DISCOVERY_RECONCILE_MS = 30_000
/**
 * How often files that changed recently are stat-ed while watching. A
 * watcher can miss a burst of appends to a session another app is writing,
 * and a row that stays at its first few kilobytes for an hour is what that
 * looks like. Recent files are few, so this is a handful of stats.
 */
const ACTIVE_RECONCILE_MS = 15_000
const ACTIVE_WINDOW_MS = 2 * 3600_000

async function forEachConcurrent<T>(
  values: T[],
  limit: number,
  visit: (value: T) => Promise<void>
): Promise<void> {
  const iterator = values.values()
  const worker = async () => {
    while (true) {
      const item = iterator.next()
      if (item.done) return
      await visit(item.value)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, worker)
  )
}

/** The repository each folder is in, found once per catalog; a folder outside one is its own. */
class WorkspaceRoots {
  private roots = new Map<string, string>()

  of(cwd: string | undefined): string | undefined {
    if (!cwd) return undefined
    const cached = this.roots.get(cwd)
    if (cached) return cached
    let path = cwd
    try {
      path = realpathSync(cwd)
    } catch {
      while (path.length > 1 && /[\\/]$/.test(path)) path = path.slice(0, -1)
    }
    let cursor = path
    while (cursor !== dirname(cursor)) {
      if (existsSync(join(cursor, ".git"))) {
        this.roots.set(cwd, cursor)
        return cursor
      }
      cursor = dirname(cursor)
    }
    this.roots.set(cwd, path)
    return path
  }

  /** `ref`, naming the workspace its folder is in. */
  ref(ref: ThreadRef | null): ThreadRef | null {
    if (!ref) return null
    const workspace = this.of(ref.cwd)
    return workspace && workspace !== ref.workspace ? { ...ref, workspace } : ref
  }

  thread(thread: Thread | null): Thread | null {
    if (!thread) return null
    const ref = this.ref(thread.ref)
    return ref === thread.ref || !ref ? thread : { ...thread, ref }
  }
}

async function refined(
  provider: SessionProvider,
  ref: ThreadRef,
  fromByte: number,
  workspaces: WorkspaceRoots
): Promise<ThreadRef> {
  if (!provider.refine) return ref
  const next = await provider.refine(ref, fromByte).catch(() => ref)
  return workspaces.ref(next) ?? ref
}

const UNREADABLE = Symbol("unreadable")

/**
 * The provider's peek, or UNREADABLE for a store a writer held. That answer
 * commits nothing: the row stays as it was and keeps the stale stamp, so
 * the next write or active sweep reads the file again. Committed as null,
 * it announced a live session removed, and the archive's copy stood in for
 * it until the next peek.
 */
async function peeked(
  provider: SessionProvider,
  file: NativeFile,
  workspaces: WorkspaceRoots
): Promise<ThreadRef | null | typeof UNREADABLE> {
  try {
    return workspaces.ref(await provider.peek(file))
  } catch (error) {
    return error instanceof SessionUnreadable ? UNREADABLE : null
  }
}

/**
 * A tail window can start after the line that named the model its first
 * turns ran on; those turns take the thread's model until the window names
 * one itself. The model goes where a whole read puts it: on each reply's
 * first entry, since a named entry opens a reply.
 */
function withLeadingModel(entries: Entry[], model: string | undefined): Entry[] {
  if (!model) return entries
  const named = entries.findIndex((entry) => isReplyEntry(entry) && entry.model)
  const until = named === -1 ? entries.length : named
  return entries.map((entry, index) => {
    const opens = isReplyEntry(entry) && !entry.model && !(index > 0 && isReplyEntry(entries[index - 1]!))
    return index < until && opens ? { ...entry, model } : entry
  })
}

/** Whether a write at `path` re-runs this provider's discovery or refreshes the one file. */
function rescansFor(provider: SessionProvider, path: string): boolean {
  return provider.rescanRoot?.(path) ?? false
}

/** A child transcript's stamp: its reader's, else the file's own. */
async function childStamp(provider: SessionProvider, path: string): Promise<NativeFile | null> {
  const stamp = await nativeFileOf(provider, path)
  if (stamp) return stamp
  const info = await stat(path).catch(() => null)
  return info?.isFile() ? { path, bytes: info.size, mtimeMs: info.mtimeMs } : null
}

/** The stat facts the catalog compares, from the provider when it knows better than `stat`. */
async function nativeFileOf(
  provider: SessionProvider,
  path: string
): Promise<NativeFile | null> {
  if (provider.stat) return provider.stat(path).catch(() => null)
  const info = await stat(path).catch(() => null)
  return info?.isFile()
    ? { path, bytes: info.size, mtimeMs: info.mtimeMs }
    : null
}

/**
 * Whether a refreshed ref says anything new to a listener. Byte growth
 * counts: the desk reads it as a session moving under another app. The
 * revision does not: a WAL checkpoint or a sidecar rewrite with the same
 * content is a reason to re-peek, never a reason to make every client
 * re-sort its rail.
 */
function refMoved(previous: ThreadRef | null | undefined, next: ThreadRef): boolean {
  if (!previous) return true
  const visible = (ref: ThreadRef) => ({ ...ref, revision: undefined })
  return JSON.stringify(visible(previous)) !== JSON.stringify(visible(next))
}

export class SessionCatalog {
  private providers: SessionProvider[]
  private pollTimer: NodeJS.Timeout | null = null
  private activeTimer: NodeJS.Timeout | null = null
  private byPath = new Map<string, CacheEntry>()
  private orderedRefs: ThreadRef[] | null = null
  private cachePath?: string
  private cacheLoaded = false
  private preparation: Promise<void> | null = null
  private saveTimer: NodeJS.Timeout | null = null
  private folders = new FolderWatches()
  private watchers = new Map<string, RootWatch>()
  /**
   * Roots that don't exist yet, by the folder they'll appear in. Codex makes
   * `archived_sessions` at its first archive; waiting for the next discovery
   * sweep showed that session as lost for up to half a minute.
   */
  private awaited = new Map<string, FSWatcher>()
  private polls = new Map<string, (current: Stats, previous: Stats) => void>()
  private discovering: Promise<void> | null = null
  private watching = false
  private stopped = false
  private observations = new Map<string, {
    targets: Set<string>
    changed: (current: Stats, previous: Stats) => void
  }>()
  private pending = new Map<string, { since: number; timer: NodeJS.Timeout }>()
  private listeners = new Set<(event: CatalogEvent) => void>()
  private follows = new Map<string, FollowState>()
  private refreshes = new Map<string, RefreshState>()
  private rescans = new Map<string, RefreshState>()
  private scans = new Set<Promise<ThreadRef[]>>()
  private fullScans = 0
  private reconciling: Promise<void> | null = null
  /** The sessions last served, newest last, by path: a read in the background never takes the one a window is about to follow. */
  private opened = new Map<string, {
    throughByte: number
    entryCount: number
    /** What was served, which a follow of a reader that continues decodes takes over from. */
    view: SessionView
  }>()
  /** Decodes running, by path and stamp, which a second ask for the same one shares. */
  private decoding = new Map<string, Promise<{ view: SessionView; decoded?: Thread } | null>>()
  private workspaces = new WorkspaceRoots()
  /** `translatorBuild()`, given or hashed on the first page this catalog serves. */
  private translator?: string
  /** How this build stamps a store format it sets (`storeWriter`). */
  private writer?: string

  private archive: SessionArchive | null = null
  /** Takes each session the harness writes into the record store at `recordsPath`. */
  private records: RecordCapture | null = null
  /** The store's streams folder, whose writes are captures of their sessions too. */
  private streams: string | null = null
  /** When each parent's children were last noted for the archive, and the notings still running. */
  private childCaptures = new Map<string, number>()
  private childNotes = new Set<Promise<void>>()
  private readonly readOnly: boolean
  /** Sessions as this build decoded them, at `viewsPath`. */
  private views: ViewCache | null = null
  private viewsPath: string | null = null
  /** Whether the harness stores are read strictly (`NativeStores.strict`), as a decode aside reads them too; strictly when no `readBack` says. */
  private readonly strictStores: boolean
  /** Decodes of large records, each in a child process that writes its view. */
  private aside: DecodeAside | null = null
  /** Sessions decoded too fast to keep on disk, or decoded by a catalog that writes nothing. */
  private memoryViews: ViewCache
  /** The record store capture writes, and sessions read back from it. */
  private recordStore: RecordStore | null = null
  /** Where each session last read back from the record store was restored, which its entries' records name. */
  private readonly restoredFrom = new Map<string, string>()
  private recordReads: RecordReads | null = null

  /**
   * `translator` is `translatorBuild()` for a process that makes many
   * catalogs: it hashes the package's code, which costs a catalog's first
   * page more than reading the page.
   */
  constructor(
    providers: SessionProvider[],
    options: {
      cachePath?: string
      archivePath?: string
      recordsPath?: string
      /** Where decoded sessions are kept (`makoViews()`); none are without it. */
      viewsPath?: string
      /** The readers `providers` were made by, to read a session from the record store once its harness forgets it. */
      readBack?: ReadBack
      /** The home the providers read under, which record keys are relative to; the user's by default. */
      recordsHome?: string
      eviction?: EvictionPolicy
      readOnly?: boolean
      translator?: string
      /** How this build stamps a store format it sets (`storeWriter`): the record store's. */
      writer?: string
      /**
       * Large records decode in a child process (`DecodeAside`), for a
       * catalog with `viewsPath`. Each of `providers` must be the one
       * `SAVED_HISTORY_READERS` makes at its index, which the child makes
       * again.
       */
      decodeAside?: DecodeAside
    } = {}
  ) {
    this.providers = providers
    this.cachePath = options.cachePath
    this.readOnly = options.readOnly ?? false
    this.strictStores = options.readBack?.stores.strict ?? true
    this.translator = options.translator
    if (options.archivePath)
      this.archive = new SessionArchive(options.archivePath, options.eviction, { readOnly: this.readOnly })
    this.writer = options.writer
    if (options.recordsPath && !this.readOnly) this.records = this.openRecords(options.recordsPath, options.recordsHome, options.readBack)
    const build = () => this.translator ??= translatorBuild()
    if (options.viewsPath) {
      this.views = new ViewCache(options.viewsPath, build)
      this.viewsPath = options.viewsPath
      this.aside = options.decodeAside ?? null
    }
    this.memoryViews = new ViewCache(null, build, MEMORY_VIEW_BYTES)
  }

  /**
   * Null, with a warning, when the store can't be opened or is in a newer
   * build's format: one this build may read (`RecordStore.access`) is still
   * read back from and restored from, with nothing captured into it; one it
   * can't read is left as it is, and the catalog serves without it.
   */
  private openRecords(folder: string, home: string | undefined, readBack: ReadBack | undefined): RecordCapture | null {
    try {
      // Records are read back into the private restored home only; a harness's own store is never written.
      const store = new RecordStore(folder, new NativeStores(true, join(folder, RESTORED)), { writer: this.writer })
      if (readBack) {
        this.recordStore = store
        this.recordReads = new RecordReads(store, join(folder, RESTORED), readBack.readers, readBack.stores, home ?? homedir())
      }
      if (store.access === "read") {
        // A newer Mako's format this build may read: it lists and restores what the store holds, and writes nothing to it.
        console.warn("Session records read only: the store is in a newer Mako's format, so nothing is captured until this build is updated")
        if (!readBack) void store.close()
        return null
      }
      const streams = streamsRoot(folder)
      const capture = new RecordCapture(store, async (ref) => (await this.ownerOf(ref.path)?.records(ref.path)) ?? null, {
        home,
        streams,
        onError: (ref, message) => console.error("Session record capture failed", ref.path, message),
      })
      this.streams = streams
      return capture
    } catch (error) {
      console.warn("Session records off:", error instanceof Error ? error.message : error)
      return null
    }
  }

  /** Run the archive's eviction policy; 0 without an archive. */
  evictArchive(now = new Date()): Promise<number> {
    return this.archive?.evict(now) ?? Promise.resolve(0)
  }

  /**
   * Record a peek of `file`. `seen` is the entry the caller read before it
   * peeked: a newer entry committed since then wins the race. Against the
   * entry it started from, an older stamp is simply the file now — a lock
   * released, a file restored — and refusing it would re-peek forever.
   */
  private commit(file: NativeFile, ref: ThreadRef | null, seen: CacheEntry | undefined): boolean {
    const current = this.byPath.get(file.path)
    if (
      current &&
      current !== seen &&
      (current.mtimeMs > file.mtimeMs ||
        (current.mtimeMs === file.mtimeMs && current.bytes > file.bytes))
    )
      return false
    this.orderedRefs = null
    const entry: CacheEntry = {
      bytes: file.bytes,
      mtimeMs: file.mtimeMs,
      revision: file.revision,
      ref,
    }
    const peek = this.ownerOf(file.path)?.peekVersion
    if (peek !== undefined) entry.peek = peek
    this.byPath.set(file.path, entry)
    return true
  }

  /**
   * The cached entry for a path, unless the provider's peek rule moved since
   * it was written: that entry is stale in what it says about the row, not
   * in its bytes, so it is dropped and the file is peeked again.
   */
  private cachedEntry(path: string, provider: SessionProvider): CacheEntry | undefined {
    const cached = this.byPath.get(path)
    if (!cached) return undefined
    if ((cached.peek ?? 0) !== (provider.peekVersion ?? 0)) {
      this.byPath.delete(path)
      return undefined
    }
    return cached
  }

  /* ------------------------------------------------------------ scanning */

  /**
   * Reconcile the catalog with disk. Returns every known session, newest
   * first. By default emits nothing — scan is for building state; watch is
   * for changes — but periodic discovery passes `emitChanges` so its
   * rescans behave like watch events.
   */
  scan(options: { emitChanges?: boolean } = {}): Promise<ThreadRef[]> {
    if (this.stopped) return Promise.resolve(this.list())
    const task = this.scanOnce(options)
    this.scans.add(task)
    void task.then(() => this.scans.delete(task), () => this.scans.delete(task))
    return task
  }

  /** Hydrate saved metadata before serving, without discovering native stores. */
  prepare(): Promise<void> {
    this.preparation ??= (async () => {
      await this.loadCache()
      await this.archive?.load()
      if (this.stopped) throw new Error("The session catalog stopped")
    })()
    return this.preparation
  }

  private async scanOnce(options: { emitChanges?: boolean }): Promise<ThreadRef[]> {
    this.fullScans += 1
    await this.prepare()
    this.orderedRefs = null
    const seen = new Set<string>()
    const unavailable = new Set<SessionProvider>()
    await Promise.all(
      this.providers.map(async (provider) => {
        const files = await provider.discover().catch(() => null)
        if (!files) { unavailable.add(provider); return }
        await forEachConcurrent(files, 4, async (file) => {
          seen.add(file.path)
          const cached = this.cachedEntry(file.path, provider)
          if (
            cached &&
            cached.bytes === file.bytes &&
            cached.mtimeMs === file.mtimeMs &&
            cached.revision === file.revision
          ) {
            if (cached.ref) this.capture(cached.ref)
            return
          }
          const ref = await peeked(provider, file, this.workspaces)
          if (ref === UNREADABLE || !this.commit(file, ref, cached)) return
          if (ref) this.capture(ref)
          if (options.emitChanges) {
            if (ref) this.emit({ type: cached?.ref ? "updated" : "added", ref })
            else if (cached?.ref) this.emit({ type: "removed", path: file.path })
          }
        })
      })
    )
    for (const path of this.byPath.keys()) {
      const owner = this.ownerOf(path)
      if (seen.has(path) || (owner && unavailable.has(owner))) continue
      const existing = await stat(path).catch(() => null)
      if (!existing) {
        this.forget(path)
        if (options.emitChanges) this.emit({ type: "removed", path })
      }
    }
    this.scheduleSave()
    return this.list()
  }

  get count(): number {
    return this.orderedRefs?.length ?? this.list().length
  }

  get metrics() {
    return { fullScans: this.fullScans, watchers: this.watchers.size, observations: this.observations.size }
  }

  /** The known sessions, newest first, optionally narrowed to a workspace. */
  list(filter: { cwd?: string; harness?: string } = {}): ThreadRef[] {
    const unfiltered = !filter.cwd && !filter.harness
    if (unfiltered && this.orderedRefs) return this.orderedRefs.slice()
    const refs: ThreadRef[] = []
    const admit = (ref: ThreadRef | null) => {
      if (!ref) return
      if (filter.harness && ref.harness !== filter.harness) return
      if (filter.cwd && ref.cwd !== filter.cwd) return
      refs.push(this.workspaces.ref(ref) ?? ref)
    }
    for (const entry of this.byPath.values()) admit(entry.ref)
    // Sessions whose native store forgot them. The archive did not.
    if (this.archive) {
      const live = new Set(this.byPath.keys())
      for (const ref of this.archive.orphans(live)) admit(ref)
    }
    // One session, one row — whatever the path. Symlinked roots and the
    // archive can each present the same conversation twice; identity is the
    // harness's own session id unless the provider says one id names two
    // stores. Live beats archived, the harness's own record beats a client's
    // copy, and newest beats older.
    const byIdentity = new Map<string, ThreadRef>()
    for (const ref of refs) {
      const key = threadIdentity(ref)
      const held = byIdentity.get(key)
      const rank = (candidate: ThreadRef) => [candidate.archived ? 0 : 1, candidate.clientCopy ? 0 : 1] as const
      const [heldLive, heldOwn] = held ? rank(held) : [0, 0]
      const [live, own] = rank(ref)
      if (
        !held ||
        live > heldLive ||
        (live === heldLive && (own > heldOwn || (own === heldOwn && (ref.updatedAt ?? "") > (held.updatedAt ?? ""))))
      ) {
        byIdentity.set(key, ref)
      }
    }
    const ordered = [...byIdentity.values()].sort((a, b) =>
      (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "")
    )
    if (unfiltered) this.orderedRefs = ordered
    return unfiltered ? ordered.slice() : ordered
  }

  /** Full translation of one session, via whichever store owns its path. */
  async open(path: string, trackForFollow = true): Promise<Thread | null> {
    const served = await this.served(path)
    if (!served) return null
    const thread = served.decoded ?? served.view.thread()
    const shown = thread.ref === served.ref ? thread : { ...thread, ref: served.ref }
    if (trackForFollow) this.track(path, served.view)
    return shown
  }

  /**
   * The session at `path` for the archive to keep: null for one past
   * `ARCHIVE_MAX_CHARS` while the record store captures its records.
   */
  private async archivable(path: string): Promise<Thread | null> {
    const served = await this.served(path)
    if (!served) return null
    if (this.records && (served.view.chars ?? 0) > ARCHIVE_MAX_CHARS) return null
    const thread = served.decoded ?? served.view.thread()
    return thread.ref === served.ref ? thread : { ...thread, ref: served.ref }
  }

  /**
   * The session at `path` as this build decodes it: its view of the store's
   * current stamp, decoding the session when there's none. A store that
   * can't answer (deleted, pruned, gone with a machine) leaves the record
   * store's copy, which decodes as the original did, and last the archive's
   * translation. `decoded` is the thread when this call decoded it.
   */
  private async served(path: string): Promise<{ view: SessionView; ref: ThreadRef; decoded?: Thread } | null> {
    const provider = this.ownerOf(path)
    const stamp = provider ? await nativeFileOf(provider, path) : null
    const native = provider && stamp ? await this.viewOf(provider, path, stamp) : provider ? await this.unstamped(provider, path) : null
    if (native) {
      this.restoredFrom.delete(path)
      const ref = this.workspaces.ref(native.view.ref) ?? native.view.ref
      return { ...native, ref }
    }
    const restored = await this.restored(path)
    if (restored) return restored
    const archived = this.archive ? await this.archive.read(path) : null
    return archived && { view: new ThreadView(archived, this.translator ??= translatorBuild()), ref: archived.ref, decoded: archived }
  }

  /**
   * The session last read at `path`, read back from the record store: as it
   * last was, or as Mako had captured it by `asOf`.
   */
  private async restored(path: string, asOf?: number): Promise<{ view: SessionView; ref: ThreadRef; decoded?: Thread } | null> {
    const reads = this.recordReads
    const session = reads && this.recordStore?.sessionAt(path)
    if (!reads || !session) return null
    const restored = await reads.read({ ...session, path }, asOf).catch((error) => {
      console.warn("A session could not be read back from its records", path, error instanceof Error ? error.message : error)
      return null
    })
    if (!restored) return null
    const stamp = await nativeFileOf(restored.provider, restored.path)
    const found = stamp ? await this.viewOf(restored.provider, restored.path, stamp) : await this.unstamped(restored.provider, restored.path)
    if (!found) return null
    // A reading as of a time is that span alone; what follows `path` is the session as it is.
    if (asOf === undefined) this.restoredFrom.set(path, restored.path)
    const ref = this.workspaces.ref({ ...found.view.ref, path, archived: true }) ?? found.view.ref
    return { ...found, ref }
  }

  /**
   * Takes the session at `path` into the record store now. True once the
   * store holds its records, so the session can be read back from them
   * whatever its harness does with its own.
   */
  async hold(path: string): Promise<boolean> {
    if (!this.records) return false
    const ref = this.byPath.get(path)?.ref ?? (await this.open(path, false))?.ref
    if (!ref || ref.archived) return false
    return this.records.hold(ref)
  }

  /**
   * The view of `path` this build made of `stamp`, in memory or on disk, or
   * a new one decoded now. A decode slower than `VIEW_MIN_DECODE_MS` is kept
   * on disk, a faster one (or any, for a catalog that writes nothing) in
   * memory. Two asks for one stamp share its decode.
   */
  private viewOf(provider: SessionProvider, path: string, stamp: NativeFile): Promise<{ view: SessionView; decoded?: Thread } | null> {
    const key = `${path}\0${stamp.bytes}\0${stamp.mtimeMs}\0${stamp.revision ?? ""}`
    const running = this.decoding.get(key)
    if (running) return running.then((found) => found && { view: found.view })
    const decode = (async () => {
      const kept = (await this.memoryViews.view(path, stamp)) ?? (await this.views?.view(path, stamp).catch(() => null))
      if (kept) return { view: kept }
      // A record that only grew continues the last decode of it, from its last turn.
      const readFrom = provider.readFrom?.bind(provider)
      const grown = readFrom && this.views && !this.readOnly
        ? await this.views.continued(path, stamp, (from, after) => readFrom(path, from, after)).catch((error) => {
            console.warn("A session's view could not be continued", path, error instanceof Error ? error.message : error)
            return null
          })
        : null
      if (grown) return { view: grown }
      const aside = await this.decodedAside(provider, path, stamp)
      if (aside !== undefined) return aside
      const started = performance.now()
      const thread = await provider.read(path).catch(() => null)
      if (!thread) return null
      const decodeMs = performance.now() - started
      const disk = this.views && !this.readOnly && decodeMs >= VIEW_MIN_DECODE_MS ? this.views : null
      const written = disk && await disk.write(path, stamp, thread, decodeMs).then(() => disk.view(path, stamp)).catch((error) => {
        console.warn("A session's view could not be kept", path, error instanceof Error ? error.message : error)
        return null
      })
      if (written) return { view: written, decoded: thread }
      await this.memoryViews.write(path, stamp, thread, decodeMs)
      const held = await this.memoryViews.view(path, stamp)
      return held && { view: held, decoded: thread }
    })()
    this.decoding.set(key, decode)
    void decode.finally(() => this.decoding.delete(key)).catch(() => undefined)
    return decode
  }

  /**
   * The view of a large record decoded in a child process, which keeps what
   * the decode holds out of this one. Undefined where it decodes here: a
   * small record, a catalog that keeps no views, or no child could start.
   */
  private async decodedAside(provider: SessionProvider, path: string, stamp: NativeFile): Promise<{ view: SessionView } | null | undefined> {
    const reader = this.providers.indexOf(provider)
    if (!this.aside || !this.views || !this.viewsPath || this.readOnly || reader < 0 || !(await this.decodesLarge(provider, path, stamp))) return undefined
    const job: AsideJob = { reader, path, stamp: { bytes: stamp.bytes, mtimeMs: stamp.mtimeMs }, viewsPath: this.viewsPath, translator: this.translator ??= translatorBuild(), strict: this.strictStores }
    if (stamp.revision !== undefined) job.stamp.revision = stamp.revision
    const decoded = await this.aside.decode(job)
    if (!decoded.ok) {
      if (!decoded.started) return undefined
      console.warn("A session could not be decoded", path, decoded.error)
      return null
    }
    const view = await this.views.view(path, stamp)
    return view && { view }
  }

  /** Whether a whole decode of the session is too large to hold in this process: its own rows where its store holds others, else its record. */
  private async decodesLarge(provider: SessionProvider, path: string, stamp: NativeFile): Promise<boolean> {
    if (stamp.storeBytes === undefined) return stamp.bytes >= DECODE_ASIDE_BYTES
    if (stamp.storeBytes < DECODE_ASIDE_BYTES) return false
    const own = provider.recordBytes ? await provider.recordBytes(path).catch(() => null) : null
    return (own ?? stamp.storeBytes) >= DECODE_ASIDE_BYTES
  }

  /** A session its store gives no stamp for, which no view can be kept of: decoded for each ask. */
  private async unstamped(provider: SessionProvider, path: string): Promise<{ view: SessionView; decoded: Thread } | null> {
    const thread = await provider.read(path).catch(() => null)
    return thread && { view: new ThreadView(thread, this.translator ??= translatorBuild()), decoded: thread }
  }

  /** Where a follow of `path` picks up after what was just served of it. */
  private track(path: string, view: SessionView): void {
    this.opened.delete(path)
    this.opened.set(path, { throughByte: view.checkpoint ?? view.ref.bytes ?? 0, entryCount: view.total, view })
    const oldest = this.opened.keys().next().value
    if (this.opened.size > OPENED_KEPT && oldest !== undefined) this.opened.delete(oldest)
  }

  /**
   * Where a follower takes over from `view`: its decode's resume point, so
   * the follower decodes the last turn again as the view's decoder did
   * rather than starting mid-turn at its checkpoint. Null for a view with
   * none, or one closed since.
   */
  private followStart(path: string, view: SessionView): FollowStart | null {
    const point = view.resume
    if (!point || point.entry > view.total || this.restoredFrom.has(path)) return null
    try {
      return { point, after: point.entry > 0 ? view.at(point.entry - 1)?.id : undefined, entries: view.entries(point.entry) }
    } catch {
      return null
    }
  }

  async page(
    path: string,
    before?: number,
    limit = 100,
    options: ThreadPageOptions = {}
  ): Promise<ThreadPage | null> {
    if (options.preview) return this.preview(path, limit, options)
    const served = options.asOf !== undefined ? await this.restored(path, options.asOf) : options.stale ? await this.stale(path) : await this.served(path)
    if (!served) return null
    if (!options.stale && options.asOf === undefined) this.track(path, served.view)
    const { view, ref } = served
    const slice = view.page(before, limit, options)
    const page: ThreadPage = {
      ref,
      entries: slice.entries,
      start: slice.start,
      total: view.total,
      hasEarlier: slice.start > 0,
      translator: view.translator,
    }
    if (view.checkpoint !== undefined) page.checkpoint = view.checkpoint
    if (view.unread) page.unread = view.unread
    return page
  }

  /** `ThreadPageOptions.stale`: this build's view when there is one, else one an earlier build made of the same stamp. Never decodes. */
  private async stale(path: string): Promise<{ view: SessionView; ref: ThreadRef } | null> {
    const provider = this.ownerOf(path)
    const stamp = provider ? await nativeFileOf(provider, path) : null
    if (!stamp) return null
    const view =
      (await this.memoryViews.view(path, stamp)) ??
      (await this.views?.view(path, stamp).catch(() => null)) ??
      (await this.views?.view(path, stamp, false).catch(() => null))
    return view ? { view, ref: this.workspaces.ref(view.ref) ?? view.ref } : null
  }

  /** Whether this build's view of `stamp` is at hand, so the whole session pages at once. */
  private async warm(path: string, stamp: NativeFile): Promise<boolean> {
    return Boolean((await this.memoryViews.view(path, stamp)) ?? (await this.views?.view(path, stamp).catch(() => null)))
  }

  /**
   * The newest exchanges of a large record, translated from its tail alone.
   * The window starts mid-record, so the page begins at the first prompt it
   * holds: an exchange cut at its top would show tool results without the
   * calls that made them. Null when the session's view is warm, the record
   * is small or not append-only, or no window holds a prompt.
   */
  private async preview(
    path: string,
    limit: number,
    options: ThreadPageOptions
  ): Promise<ThreadPage | null> {
    const provider = this.ownerOf(path)
    const ref = this.byPath.get(path)?.ref
    if (!provider || (!provider.tail && !provider.recent) || !ref) return null
    const stamp = await nativeFileOf(provider, path)
    if (!stamp || stamp.bytes < PREVIEW_MIN_BYTES) return null
    if (await this.warm(path, stamp)) return null
    for (const window of PREVIEW_WINDOWS) {
      if (window >= stamp.bytes) return null
      const entries = provider.recent
        ? await provider.recent(path, window)
        : (await provider.tail?.(path, stamp.bytes - window))?.entries
      if (!entries) return null
      const prompt = entries.findIndex((entry) => entry.type === "user")
      if (prompt === -1) continue
      const aligned = withLeadingModel(entries.slice(prompt), ref.model)
      const slice = pageOf(aligned, aligned.length, limit, options)
      return {
        ref,
        entries: slice.entries,
        start: slice.start,
        total: aligned.length,
        hasEarlier: true,
        preview: true,
        translator: this.translator ??= translatorBuild(),
      }
    }
    return null
  }

  /** One entry whole, by id, for what a trimmed page left out. */
  async entry(path: string, id: string): Promise<Entry | null> {
    return (await this.served(path))?.view.entry(id) ?? null
  }

  /**
   * The bytes an entry was read from, by its id: from the harness's own
   * record, or from the record store's copy once the harness has deleted the
   * session. No parts for an entry that names no record (one the archive
   * kept from an earlier build); null when the session or the entry is gone.
   */
  async original(path: string, id: string): Promise<EntryOriginal | null> {
    const entry = await this.entry(path, id)
    if (!entry) return null
    if (!entry.record) return { kept: false, parts: [] }
    const restored = this.restoredFrom.get(path)
    return readOriginal(restored ?? path, entry.record, restored !== undefined)
  }

  /* ------------------------------------------------------------ watching */

  /**
   * Watch every harness root. Events fire for sessions created or grown by
   * *anything* — this app, the harness's own CLI, another wrapper entirely.
   */
  startWatching(): void {
    if (this.watching || this.stopped) return
    this.watching = true
    this.refreshWatchRoots()
    this.ensurePolling()
    for (const [path, follow] of this.follows) this.observeFollow(path, follow)
    if (!this.activeTimer) {
      this.activeTimer = setInterval(() => {
        void this.reconcileActive()
      }, ACTIVE_RECONCILE_MS)
      this.activeTimer.unref?.()
    }
  }

  /** Directory events are hints. Periodic discovery also finds previously
   * unknown sessions when the OS silently drops events. One sweep at a time. */
  reconcileDiscovery(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (this.discovering) return this.discovering
    this.discovering = (async () => {
      if (this.watching) this.refreshWatchRoots()
      await this.scan({ emitChanges: true })
    })().finally(() => { this.discovering = null })
    return this.discovering
  }

  private refreshWatchRoots(): void {
    const polls = new Set(this.providers.flatMap(provider => provider.pollFiles?.() ?? []))
    for (const [file, changed] of this.polls) {
      if (polls.has(file)) continue
      unwatchFile(file, changed)
      this.polls.delete(file)
    }
    for (const file of polls) {
      if (this.polls.has(file)) continue
      const changed = (current: Stats, previous: Stats) => {
        if (this.stopped || (current.mtimeMs === previous.mtimeMs && current.size === previous.size && current.ino === previous.ino)) return
        this.noticed(file)
      }
      watchFile(file, { persistent: false, interval: POLL_FILES_MS }, changed)
      this.polls.set(file, changed)
    }
    const roots = new Set(this.providers.flatMap(provider => provider.watchRoots?.() ?? provider.roots()))
    if (this.streams) roots.add(this.streams)
    for (const [root, watcher] of this.watchers) {
      if (roots.has(root) && existsSync(root)) continue
      watcher.close()
      this.watchers.delete(root)
    }
    for (const [root, waiting] of this.awaited) {
      if (roots.has(root) && !existsSync(root)) continue
      waiting.close()
      this.awaited.delete(root)
    }
    for (const root of roots) {
      if (!existsSync(root)) {
        this.awaitRoot(root)
        continue
      }
      if (this.watchers.has(root)) continue
      try {
        const watcher = this.folders.watchRoot(root, (path) => {
          if (this.watchers.get(root) !== watcher) return
          if (root === this.streams) this.streamed(path)
          else this.noticed(path)
        }, () => {
          if (this.watchers.get(root) !== watcher) return
          this.watchers.delete(root)
          watcher.close()
        })
        this.watchers.set(root, watcher)
      } catch {
        // Discovery still runs; retry registration on the next sweep.
      }
    }
  }

  private awaitRoot(root: string): void {
    const parent = dirname(root)
    if (this.awaited.has(root) || !existsSync(parent)) return
    try {
      const waiting = watch(parent, { persistent: false }, (_event, name) => {
        if (this.stopped || this.awaited.get(root) !== waiting) return
        if (name !== null && name !== basename(root)) return
        if (!existsSync(root)) return
        this.refreshWatchRoots()
        void this.reconcileDiscovery()
      })
      waiting.on("error", () => {
        waiting.close()
        if (this.awaited.get(root) === waiting) this.awaited.delete(root)
      })
      this.awaited.set(root, waiting)
    } catch {
      // The next discovery sweep finds it instead.
    }
  }

  /**
   * Stat every followed or recently updated file and refresh the ones the
   * watcher did not report. Bounded to the active set; a full scan stays the
   * job of periodic discovery.
   */
  reconcileActive(now = Date.now()): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (this.reconciling) return this.reconciling
    this.reconciling = this.reconcileActiveOnce(now).finally(() => {
      this.reconciling = null
    })
    return this.reconciling
  }

  private async reconcileActiveOnce(now: number): Promise<void> {
    const since = new Date(now - ACTIVE_WINDOW_MS).toISOString()
    const candidates: string[] = []
    for (const [path, entry] of this.byPath) {
      if (this.follows.has(path) || (entry.ref?.updatedAt ?? "") >= since)
        candidates.push(path)
    }
    await forEachConcurrent(candidates, 4, async (path) => {
      const provider = this.ownerOf(path)
      if (!provider || rescansFor(provider, path)) return
      const cached = this.byPath.get(path)
      const file = await nativeFileOf(provider, path)
      if (this.stopped) return
      if (!cached || !file) return
      if (
        cached.bytes === file.bytes &&
        cached.mtimeMs === file.mtimeMs &&
        cached.revision === file.revision
      )
        return
      await this.refresh(provider, path)
    })
  }

  onEvent(listener: (event: CatalogEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Live entries for one open thread. For append-only stores the callback
   * receives only what was appended after `fromByte`; for stores that
   * rewrite in place (Cursor's SQLite) it receives the whole translated
   * conversation with `replaced` set, and the caller swaps rather than
   * appends. Where an update could only come from reading a large session
   * whole, a follow every caller gave `onReload` ends with it instead: the
   * caller pages the session again, decoded out of this process, and
   * follows from there. Returns an unsubscribe.
   */
  follow(
    path: string,
    fromByte: number,
    onEntries: (
      entries: Entry[],
      replaced: boolean,
      replaceFrom?: number
    ) => void,
    onReload?: () => void
  ): () => void {
    const provider = this.ownerOf(path)
    const served = this.opened.get(path)
    const opened = served?.throughByte === fromByte ? served : null
    const known = this.follows.get(path)
    const start = !known && opened && provider?.readFrom && provider.createFollower ? this.followStart(path, opened.view) : null
    const state = known ?? {
      listeners: new Set(),
      follower: provider ? this.makeFollower(provider, path, fromByte, start ?? undefined) : null,
      fromByte,
      baselineCount: start ? start.point.entry : (opened?.entryCount ?? null),
    }
    if (opened) this.opened.delete(path)
    const listener: FollowListener = onReload ? { entries: onEntries, reload: onReload } : { entries: onEntries }
    state.listeners.add(listener)
    this.follows.set(path, state)
    // A selected conversation can be followed before broad discovery finishes.
    if (!this.stopped) this.observeFollow(path, state)
    return () => {
      state.listeners.delete(listener)
      if (state.listeners.size === 0 && this.follows.get(path) === state) {
        state.unobserve?.()
        this.follows.delete(path)
      }
    }
  }

  /** Directory notifications can silently stop arriving. Reconcile only
   * followed physical sources, once per distinct file, without parsing
   * unchanged stores or registering more recursive directory watchers. */
  private observeFollow(path: string, follow: FollowState): void {
    if (follow.unobserve) return
    const provider = this.ownerOf(path)
    if (!provider) return
    const files = new Set(provider.observationPaths?.(path) ?? [path])
    for (const file of files) {
      let observation = this.observations.get(file)
      if (!observation) {
        const targets = new Set<string>()
        const changed = (current: Stats, previous: Stats) => {
          if (this.stopped || (current.nlink === 0 && previous.nlink === 0)) return
          for (const target of targets) this.noticed(file, target)
        }
        observation = { targets, changed }
        this.observations.set(file, observation)
        watchFile(file, { persistent: false, interval: 500 }, changed)
      }
      observation.targets.add(path)
    }
    follow.unobserve = () => {
      for (const file of files) {
        const observation = this.observations.get(file)
        if (!observation) continue
        observation.targets.delete(path)
        if (observation.targets.size === 0) {
          unwatchFile(file, observation.changed)
          this.observations.delete(file)
        }
      }
      follow.unobserve = undefined
    }
  }

  /**
   * Delete a native session through its provider and drop it from the
   * catalog. Refuses a path no provider owns or one it cannot remove.
   */
  async remove(path: string): Promise<boolean> {
    if (this.readOnly) throw new ReadOnlyStoreError("The session catalog")
    const provider = this.ownerOf(path)
    if (!provider?.remove) return false
    if (!(await provider.remove(path))) return false
    await Promise.all([this.memoryViews.remove(path), this.views?.remove(path)])
    this.follows.get(path)?.unobserve?.()
    this.follows.get(path)?.listeners.clear()
    this.follows.delete(path)
    if (this.forget(path)) {
      this.scheduleSave()
      this.emit({ type: "removed", path })
    }
    return true
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.watching = false
    this.aside?.stop()
    for (const follow of this.follows.values()) {
      follow.unobserve?.()
      follow.listeners.clear()
    }
    this.follows.clear()
    for (const watcher of this.watchers.values()) watcher.close()
    this.watchers.clear()
    for (const waiting of this.awaited.values()) waiting.close()
    this.awaited.clear()
    for (const [file, changed] of this.polls) unwatchFile(file, changed)
    this.polls.clear()
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    if (this.activeTimer) {
      clearInterval(this.activeTimer)
      this.activeTimer = null
    }
    for (const held of this.pending.values()) clearTimeout(held.timer)
    this.pending.clear()
    await Promise.allSettled([
      this.preparation,
      ...this.childNotes,
      ...this.scans,
      this.discovering,
      this.reconciling,
      ...[...this.refreshes.values()].map(state => state.promise),
      ...[...this.rescans.values()].map(state => state.promise),
      this.views?.settled(),
      this.memoryViews.settled(),
    ])
    this.views?.close()
    this.memoryViews.close()
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
      // Awaited: a host stopping for a restart exits right after this, and an
      // unawaited write lost the whole cache, so the next start re-peeked
      // every file.
      await this.saveCache()
    }
    try {
      await Promise.all([this.archive?.stop(), this.records?.stop()])
    } finally {
      for (const provider of this.providers) provider.close?.()
    }
  }

  /* ------------------------------------------------------------ internals */

  private ensurePolling(): void {
    if (this.stopped || this.pollTimer) return
    this.pollTimer = setInterval(() => {
      void this.reconcileDiscovery()
    }, DISCOVERY_RECONCILE_MS)
    this.pollTimer.unref?.()
  }

  private ownerOf(path: string): SessionProvider | null {
    for (const provider of this.providers) {
      if (
        provider
          .roots()
          .some((root) => path.startsWith(`${root}/`) || path === root)
      ) {
        return provider
      }
    }
    return null
  }

  /**
   * A driver wrote a session's stream: capture the session, as a write to its
   * records would. A stream of a session the catalog hasn't found yet is
   * taken with it when it is.
   */
  private streamed(path: string): void {
    const owner = this.streams && streamOwner(this.streams, path)
    if (!owner || this.stopped) return
    for (const entry of this.byPath.values()) {
      if (entry.ref?.harness === owner.harness && entry.ref.nativeId === owner.nativeId) {
        this.records?.wrote(entry.ref)
        return
      }
    }
  }

  private noticed(path: string, followedTarget?: string): void {
    if (this.stopped) return
    // SQLite's shared-memory file changes when anyone reads, the catalog
    // included; a write always moves the database or its WAL as well.
    if (path.endsWith("-shm")) return
    const provider = this.ownerOf(followedTarget ?? path)
    if (!provider) return
    const mapped = followedTarget ?? provider.watchTarget?.(path)
    if (mapped === null) return
    const target = mapped ?? path
    const rescan = rescansFor(provider, target)
    // A write to a shared database can have moved any of that provider's
    // sessions, and only that provider's: Cursor Desktop writing state.vscdb
    // once dropped a Codex thread on screen with every keystroke.
    this.memoryViews.forgetWhere(rescan ? (held) => this.ownerOf(held) === provider : (held) => held === target)
    // Shared-database stores have no per-session file to stat: any write
    // under the root re-runs that provider's discovery, coalesced under
    // one key so a burst costs one rescan. Sidecar writes coalesce under
    // the native file so summary.json and updates.jsonl cannot race.
    const key = rescan
      ? `rescan:${provider.harness}:${provider.roots()[0]}`
      : target
    const settle = provider.rescanDebounceMs ?? WATCH_DEBOUNCE_MS
    const now = Date.now()
    const held = this.pending.get(key)
    if (held) clearTimeout(held.timer)
    const since = held?.since ?? now
    // Wait for the burst to settle, but a store an agent streams into never
    // settles: fire by the deadline regardless and let the next write start
    // another window.
    const delay = Math.max(
      0,
      Math.min(settle, since + settle * WATCH_MAX_SETTLE_WINDOWS - now)
    )
    const sidecar = target !== path
    this.pending.set(key, {
      since,
      timer: setTimeout(() => {
        this.pending.delete(key)
        if (rescan) void this.rescanProvider(provider)
        else void this.refresh(provider, target, sidecar)
      }, delay),
    })
  }

  private rescanProvider(provider: SessionProvider): Promise<void> {
    const key = provider.harness
    const active = this.rescans.get(key)
    if (active) {
      active.requested = true
      return active.promise
    }
    const state: RefreshState = { requested: false, promise: Promise.resolve() }
    state.promise = (async () => {
      try {
        do {
          state.requested = false
          await this.rescanProviderOnce(provider)
          if (state.requested) {
            await new Promise((resolve) =>
              setTimeout(
                resolve,
                provider.rescanDebounceMs ?? WATCH_DEBOUNCE_MS
              )
            )
          }
        } while (state.requested && !this.stopped)
      } finally {
        if (this.rescans.get(key) === state) this.rescans.delete(key)
      }
    })()
    this.rescans.set(key, state)
    return state.promise
  }

  /** Re-discover one provider's synthetic files; diff against the cache. */
  private async rescanProviderOnce(provider: SessionProvider): Promise<void> {
    const files = await provider.discover().catch(() => null)
    if (!files) return // An unavailable store is not an empty store.
    const seen = new Set<string>()
    for (const file of files) {
      seen.add(file.path)
      const cached = this.cachedEntry(file.path, provider)
      const follow = this.follows.get(file.path)
      const followed = (follow?.listeners.size ?? 0) > 0
      const unchanged = Boolean(
        cached &&
        cached.bytes === file.bytes &&
        cached.mtimeMs === file.mtimeMs &&
        cached.revision === file.revision
      )
      // A follower may have a finer-grained cursor than the catalog stamp. Plain rereaders do not.
      if (unchanged && (!followed || !follow?.follower)) continue
      if (!unchanged) {
        const ref = await peeked(provider, file, this.workspaces)
        if (ref === UNREADABLE || !this.commit(file, ref, cached)) continue
        if (ref) {
          if (refMoved(cached?.ref, ref))
            this.emit({ type: cached?.ref ? "updated" : "added", ref })
          else this.capture(ref)
        } else if (cached?.ref) this.emit({ type: "removed", path: file.path })
      }
      if (follow && follow.listeners.size > 0) {
        if (!follow.follower) {
          follow.follower = this.makeFollower(
            provider,
            file.path,
            follow.fromByte
          )
        }
        if (follow.follower) {
          const update = await follow.follower.next(this.wholeLimit(follow)).catch(() => null)
          if (update?.reload) this.reload(file.path, follow)
          else if (update && (update.replace || update.entries.length > 0)) {
            await this.deliverFollowerUpdate(
              provider,
              file.path,
              follow,
              update
            )
          }
        } else {
          const thread = await this.readWhole(provider, file.path, file, follow)
          if (thread) {
            this.deliver(follow, {
              entries: thread.entries,
              nextByte: file.bytes,
              replace: true,
              replaceFrom: 0,
            })
          }
        }
      }
    }
    const roots = provider.roots()
    for (const path of this.byPath.keys()) {
      if (
        roots.some(
          (root) => path === root || path.startsWith(`${root}${sep}`)
        ) &&
        !seen.has(path)
      ) {
        this.forget(path)
        this.emit({ type: "removed", path })
      }
    }
    this.scheduleSave()
  }

  private refresh(
    provider: SessionProvider,
    path: string,
    forceMetadata = false
  ): Promise<void> {
    const active = this.refreshes.get(path)
    if (active) {
      active.requested = true
      if (forceMetadata) active.forceMetadata = true
      return active.promise
    }
    const state: RefreshState = {
      requested: false,
      forceMetadata,
      promise: Promise.resolve(),
    }
    state.promise = (async () => {
      try {
        do {
          state.requested = false
          const refreshMetadata = Boolean(state.forceMetadata)
          state.forceMetadata = false
          await this.refreshOnce(provider, path, refreshMetadata)
        } while (state.requested && !this.stopped)
      } finally {
        if (this.refreshes.get(path) === state) this.refreshes.delete(path)
      }
    })()
    this.refreshes.set(path, state)
    return state.promise
  }

  private async refreshOnce(
    provider: SessionProvider,
    path: string,
    forceMetadata = false
  ): Promise<void> {
    const file = await nativeFileOf(provider, path)
    if (!file) {
      if (this.forget(path)) {
        this.scheduleSave()
        this.emit({ type: "removed", path })
      }
      return
    }
    const cached = this.cachedEntry(path, provider)
    const follow = this.follows.get(path)
    const unchanged =
      cached &&
      cached.bytes === file.bytes &&
      cached.mtimeMs === file.mtimeMs &&
      cached.revision === file.revision
    if (
      unchanged &&
      !forceMetadata &&
      (!follow?.follower || follow.follower.offset >= file.bytes)
    )
      return
    if (unchanged && forceMetadata) {
      if (!cached) return
      const previous = cached.ref
      const ref = previous
        ? await refined(provider, previous, cached.bytes, this.workspaces)
        : await peeked(provider, file, this.workspaces)
      if (ref === UNREADABLE || !this.commit(file, ref, cached)) return
      this.scheduleSave()
      if (ref) {
        const same =
          previous &&
          previous.title === ref.title &&
          previous.model === ref.model &&
          previous.cwd === ref.cwd &&
          previous.updatedAt === ref.updatedAt
        if (!same) this.emit({ type: previous ? "updated" : "added", ref })
      } else if (previous) {
        this.emit({ type: "removed", path })
      }
      return
    }

    // An appended file keeps its identity, so the cached ref is reused with
    // fresh size and time. That shortcut is only safe once the peek found
    // what it names the row by: a session captured before its first prompt
    // was written (a fresh Codex rollout is one metadata line) would
    // otherwise stay untitled for its whole life. Providers with a separate
    // title store refine the reused ref so a late native name still lands.
    const grew = cached && file.bytes > cached.bytes
    const previous = cached && grew ? cached.ref : null
    const reusable =
      cached && previous && previous.title !== undefined && previous.model !== undefined
        ? { ref: previous, fromByte: cached.bytes }
        : null
    // A grown file is newer by mtime, but a provider that reads activity
    // from content keeps its stamp until `refine` finds a message in the
    // appended bytes: Claude Code's exit-time bookkeeping is growth too.
    const ref = reusable
      ? await refined(
          provider,
          provider.activityFromContent
            ? { ...reusable.ref, bytes: file.bytes }
            : {
                ...reusable.ref,
                bytes: file.bytes,
                updatedAt: new Date(file.mtimeMs).toISOString(),
              },
          reusable.fromByte,
          this.workspaces
        )
      : await peeked(provider, file, this.workspaces)
    if (ref === UNREADABLE || !this.commit(file, ref, cached)) return
    this.scheduleSave()
    if (ref) {
      if (refMoved(cached?.ref, ref))
        this.emit({ type: cached?.ref ? "updated" : "added", ref })
      else this.capture(ref)
    } else if (cached?.ref) this.emit({ type: "removed", path })

    if (!follow || follow.listeners.size === 0) return
    if (!follow.follower)
      follow.follower = this.makeFollower(provider, path, follow.fromByte)
    if (follow.follower) {
      if (!provider.createFollower && file.bytes < follow.follower.offset) {
        const thread = await this.readWhole(provider, path, file, follow)
        if (thread === undefined) return
        follow.follower = this.makeFollower(provider, path, file.bytes)
        if (thread) {
          follow.baselineCount = thread.entries.length
          this.deliver(follow, {
            entries: thread.entries,
            nextByte: file.bytes,
            replace: true,
          })
        }
        return
      }
      const committed = this.byPath.get(path)
      const update = await follow.follower.next(this.wholeLimit(follow)).catch(() => null)
      if (update?.reload) {
        this.reload(path, follow)
        return
      }
      if (update?.reset && grew && cached.ref) {
        const resetRef = await peeked(provider, file, this.workspaces)
        if (resetRef !== UNREADABLE && this.commit(file, resetRef, committed) && resetRef)
          this.emit({ type: "updated", ref: resetRef })
      }
      if (update && (update.replace || update.entries.length > 0)) {
        await this.deliverFollowerUpdate(provider, path, follow, update)
      }
      return
    }

    const thread = await this.readWhole(provider, path, file, follow)
    if (thread)
      this.deliver(follow, {
        entries: thread.entries,
        nextByte: file.bytes,
        replace: true,
      })
  }

  private async deliverFollowerUpdate(
    provider: SessionProvider,
    path: string,
    follow: FollowState,
    update: SessionUpdate
  ): Promise<void> {
    if (update.reset) {
      follow.baselineCount = 0
      this.deliver(follow, update)
      return
    }
    if (update.replace && follow.baselineCount !== null) {
      this.deliver(follow, {
        ...update,
        replaceFrom: Math.max(
          0,
          follow.baselineCount + (update.replaceFrom ?? 0)
        ),
      })
      return
    }
    if (update.replace) {
      const stamp = await nativeFileOf(provider, path)
      const thread = stamp ? await this.readWhole(provider, path, stamp, follow) : await provider.read(path).catch(() => null)
      if (thread) {
        this.deliver(follow, {
          ...update,
          entries: thread.entries,
          replaceFrom: 0,
        })
      }
      return
    }
    this.deliver(follow, update)
  }

  private makeFollower(
    provider: SessionProvider,
    path: string,
    fromByte: number,
    start?: FollowStart
  ): SessionFollower | null {
    if (provider.createFollower) return provider.createFollower(path, fromByte, start)
    if (!provider.tail) return null
    let offset = fromByte
    return {
      get offset() {
        return offset
      },
      async next() {
        const result = await provider.tail!(path, offset)
        offset = Math.max(offset, result.nextByte)
        return { entries: result.entries, nextByte: offset, replace: false }
      },
    }
  }

  private deliver(follow: FollowState, update: SessionUpdate): void {
    for (const listener of follow.listeners)
      listener.entries(update.entries, update.replace, update.replaceFrom)
  }

  /** The size past which `follow`'s follower reloads rather than read the session whole here: only where every listener can reload and a page can decode out of this process. */
  private wholeLimit(follow: FollowState): number | undefined {
    if (!this.aside || !this.views || !this.viewsPath || this.readOnly) return undefined
    for (const listener of follow.listeners) if (!listener.reload) return undefined
    return DECODE_ASIDE_BYTES
  }

  /** The session read whole for `follow`, or undefined where it reloaded instead. */
  private async readWhole(provider: SessionProvider, path: string, file: NativeFile, follow: FollowState): Promise<Thread | null | undefined> {
    if (this.wholeLimit(follow) !== undefined && (await this.decodesLarge(provider, path, file))) {
      this.reload(path, follow)
      return undefined
    }
    return provider.read(path).catch(() => null)
  }

  /** End `follow` for its listeners to page the session again and follow it from there. */
  private reload(path: string, follow: FollowState): void {
    follow.unobserve?.()
    if (this.follows.get(path) === follow) this.follows.delete(path)
    const listeners = [...follow.listeners]
    follow.listeners.clear()
    follow.follower = null
    for (const listener of listeners) listener.reload?.()
  }

  private capture(ref: ThreadRef): void {
    if (this.stopped) return
    if (ref.archived || ref.locked || !this.archive) return
    // A child agent is never a row, so it is noted when its parent's new
    // revision is, at most once in `CHILD_CAPTURE_MS` while the parent keeps
    // moving: a session the archive already holds as it is lists nothing.
    if (!this.archive.note(ref, () => this.archivable(ref.path))) return
    const now = Date.now()
    if (now - (this.childCaptures.get(ref.path) ?? -Infinity) < CHILD_CAPTURE_MS) return
    this.childCaptures.delete(ref.path)
    this.childCaptures.set(ref.path, now)
    const oldest = this.childCaptures.keys().next().value
    if (this.childCaptures.size > 256 && oldest !== undefined) this.childCaptures.delete(oldest)
    const noting = this.captureChildren(ref).catch(() => {})
    this.childNotes.add(noting)
    void noting.finally(() => this.childNotes.delete(noting))
  }

  /**
   * Note each located child of a session the archive just captured. Its
   * copy is keyed by the child's own path and carries its link to the
   * parent, so a child the harness later drops stays listed and readable
   * under it; an observed agent roster plays no part.
   */
  private async captureChildren(parent: ThreadRef): Promise<void> {
    const provider = this.ownerOf(parent.path)
    const archive = this.archive
    if (!provider?.children || !archive) return
    for (const child of (await provider.children(parent.path)) ?? []) {
      const path = child.path
      if (!path) continue
      const stamp = await childStamp(provider, path)
      if (!stamp) continue
      const link: NonNullable<ThreadRef["childOf"]> = { nativeId: parent.nativeId, path: parent.path }
      if (child.toolId) link.toolId = child.toolId
      if (child.state.kind === "complete") link.ended = true
      const ref: ThreadRef = { harness: parent.harness, nativeId: child.nativeId, path, bytes: stamp.bytes, updatedAt: new Date(stamp.mtimeMs).toISOString(), childOf: link }
      if (stamp.revision) ref.revision = stamp.revision
      if (child.title) ref.title = child.title
      if (child.model) ref.model = child.model
      if (child.startedAt) ref.startedAt = child.startedAt
      if (parent.cwd) ref.cwd = parent.cwd
      archive.note(ref, async () => {
        const thread = await this.archivable(path)
        return thread && { ...thread, ref: { ...thread.ref, childOf: link } }
      })
    }
  }

  /**
   * The child agents a session started, as its harness's reader links them,
   * and those only Mako's archive still keeps. Lists links and stamps; a
   * child's transcript is read only when its `path` is opened, through
   * `open`, `page` and `follow` like any session's.
   */
  async children(path: string): Promise<ChildTranscripts | null> {
    const provider = this.ownerOf(path)
    const kept = this.archive?.childrenOf(path) ?? []
    let ref = this.byPath.get(path)?.ref ?? this.archive?.kept(path)
    if (!ref && provider) {
      const file = await nativeFileOf(provider, path)
      const peek = file ? await peeked(provider, file, this.workspaces) : null
      ref = peek && peek !== UNREADABLE ? peek : undefined
    }
    if (!ref) return null
    const parent = { harness: ref.harness, nativeId: ref.nativeId, path }
    if (!provider?.children && !kept.length)
      return { parent, children: [], unsupported: `${provider?.displayName ?? ref.harness} records no child agents Mako can read.` }
    // A store a writer holds rejects (`SessionUnreadable`) rather than list no children.
    const listed = (provider?.children ? await provider.children(path) : null) ?? []
    const byId = new Map(listed.map((child) => [child.nativeId, child]))
    for (const copy of kept) {
      const native = byId.get(copy.nativeId)
      if (native && native.state.kind !== "missing") continue
      const child: ChildTranscript = {
        ...native,
        nativeId: copy.nativeId,
        path: copy.path,
        archived: true,
        state: copy.childOf?.ended
          ? { kind: "complete" }
          : { kind: "partial", reason: "Only Mako's archive keeps this agent now, as it stood when saved; it hadn't ended then." },
      }
      if (copy.childOf?.toolId) child.toolId = copy.childOf.toolId
      if (copy.title && !child.title) child.title = copy.title
      if (copy.updatedAt) child.updatedAt = copy.updatedAt
      byId.set(copy.nativeId, child)
    }
    return { parent, ...boundedChildren([...byId.values()]) }
  }

  private forget(path: string): boolean {
    this.orderedRefs = null
    return this.byPath.delete(path)
  }

  private emit(event: CatalogEvent): void {
    if (this.stopped) return
    // `list` goes on serving a record its store dropped from the archive, so
    // the event says the same: announced as removed, the row vanished and a
    // reload brought it back.
    const kept = event.type === "removed" ? this.archive?.kept(event.path) : undefined
    if (kept) event = { type: "updated", ref: this.workspaces.ref(kept) ?? kept }
    // Archive once the writer releases its lock. Re-translating a giant live
    // conversation on every checkpoint competes with the agent writing it.
    if (event.type === "added" || event.type === "updated") {
      if (this.archive) this.capture(event.ref)
      this.records?.wrote(event.ref)
    }
    for (const listener of this.listeners) listener(event)
  }

  /* ------------------------------------------------------------ cache */

  private async loadCache(): Promise<void> {
    if (this.cacheLoaded || !this.cachePath) {
      this.cacheLoaded = true
      return
    }
    this.cacheLoaded = true
    try {
      const raw = await readFile(this.cachePath, "utf8")
      const entries = parseCache(raw)
      if (entries) {
        this.byPath = entries
        this.orderedRefs = null
      }
    } catch {
      // No cache yet, or an unreadable one: the scan simply peeks everything.
    }
  }

  private scheduleSave(): void {
    if (this.stopped || !this.cachePath || this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.saveCache()
    }, CACHE_SAVE_DEBOUNCE_MS)
  }

  private async saveCache(): Promise<void> {
    if (!this.cachePath) return
    try {
      await mkdir(dirname(this.cachePath), { recursive: true })
      const entries: Record<string, CacheEntry> = {}
      for (const [path, entry] of this.byPath) entries[path] = entry
      await writeFile(
        this.cachePath,
        JSON.stringify({ version: CATALOG_CACHE_VERSION, entries }),
        "utf8"
      )
    } catch {
      // A failed cache write costs the next start a re-peek, nothing more.
    }
  }
}
