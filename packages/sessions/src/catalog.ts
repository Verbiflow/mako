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
import { dirname, join, sep } from "node:path"
import {
  parseCache,
  CATALOG_CACHE_VERSION,
  type CacheEntry,
} from "./catalog-cache.js"
import { translatorBuild } from "./translator.js"
import {
  entryChars,
  threadIdentity,
  trimToolOutput,
  type BlockAddress,
  type EntryBlock,
  type Thread,
  type ThreadEntry,
  type ThreadPage,
  type ThreadPageOptions,
  type ThreadRef,
} from "./format.js"
import type {
  NativeFile,
  SessionFollower,
  SessionProvider,
  SessionUpdate,
} from "./providers/types.js"
import { SessionArchive } from "./archive.js"

export type CatalogEvent =
  | { type: "added"; ref: ThreadRef }
  | { type: "updated"; ref: ThreadRef }
  | { type: "removed"; path: string }

interface FollowState {
  listeners: Set<
    (entries: ThreadEntry[], replaced: boolean, replaceFrom?: number) => void
  >
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

interface HeldThread {
  bytes: number
  mtimeMs: number
  revision?: string
  thread: Thread
}

/**
 * Translated threads kept warm, bounded by the native bytes behind them: a
 * large thread's entries are tens of megabytes of objects, but most sessions
 * are a few megabytes, and switching back to one should not translate it
 * again. A reader never translates more than 64 MB of one record.
 */
const THREAD_CACHE_SIZE = 16
const THREAD_CACHE_BYTES = 192 * 1024 * 1024
const TRANSLATED_BYTES_CAP = 64 * 1024 * 1024

/** Below this a record translates faster than a preview helps. */
const PREVIEW_MIN_BYTES = 4 * 1024 * 1024
/** Tail windows a preview widens through until one holds a prompt. */
const PREVIEW_WINDOWS = [2, 8, 24].map((mb) => mb * 1024 * 1024)

const WATCH_DEBOUNCE_MS = 24
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
const workspaceRoots = new Map<string, string>()

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

function workspaceOf(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined
  const cached = workspaceRoots.get(cwd)
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
      workspaceRoots.set(cwd, cursor)
      return cursor
    }
    cursor = dirname(cursor)
  }
  workspaceRoots.set(cwd, path)
  return path
}

async function refined(
  provider: SessionProvider,
  ref: ThreadRef,
  fromByte: number
): Promise<ThreadRef> {
  if (!provider.refine) return ref
  const next = await provider.refine(ref, fromByte).catch(() => ref)
  return withWorkspace(next) ?? ref
}

function withWorkspace(ref: ThreadRef | null): ThreadRef | null {
  if (!ref) return null
  const workspace = workspaceOf(ref.cwd)
  return workspace && workspace !== ref.workspace ? { ...ref, workspace } : ref
}

/** A run of entries and the index of its first entry in the thread. */
interface PageSlice {
  entries: ThreadEntry[]
  start: number
}

/**
 * At most `limit` entries ending at `end`, tool output cut to its head, and
 * earlier entries dropped once the page holds `maxChars`; the newest entry
 * always stays.
 */
function pageSlice(
  all: ThreadEntry[],
  end: number,
  limit: number,
  options: ThreadPageOptions
): PageSlice {
  const size = Math.min(200, Math.max(1, limit))
  let start = Math.max(0, end - size)
  let entries = all.slice(start, end)
  if (options.toolOutputChars !== undefined)
    entries = trimToolOutput(entries, options.toolOutputChars)
  if (options.maxChars !== undefined && entries.length > 1) {
    let chars = 0
    let keep = entries.length
    while (keep > 0) {
      chars += entryChars(entries[keep - 1]!)
      if (chars > options.maxChars && keep < entries.length) break
      keep -= 1
    }
    if (keep > 0) {
      entries = entries.slice(keep)
      start += keep
    }
  }
  return { entries, start }
}

/**
 * A tail window can start after the line that named the model its first
 * turns ran on; those turns take the thread's model until the window names
 * one itself.
 */
function withLeadingModel(entries: ThreadEntry[], model: string | undefined): ThreadEntry[] {
  if (!model) return entries
  const named = entries.findIndex((entry) => entry.kind === "assistant" && entry.model)
  const until = named === -1 ? entries.length : named
  return entries.map((entry, index) =>
    index < until && entry.kind === "assistant" && !entry.model ? { ...entry, model } : entry
  )
}

function withThreadWorkspace(thread: Thread | null): Thread | null {
  if (!thread) return null
  const ref = withWorkspace(thread.ref)
  return ref === thread.ref || !ref ? thread : { ...thread, ref }
}

/** Whether a write at `path` re-runs this provider's discovery or refreshes the one file. */
function rescansFor(provider: SessionProvider, path: string): boolean {
  return provider.rescanRoot?.(path) ?? false
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
  private watchers = new Map<string, FSWatcher>()
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
  private opened: {
    path: string
    throughByte: number
    entryCount: number
  } | null = null
  /**
   * Translated threads by path, newest last, held while the store they came
   * from is unchanged. The viewer reopens what the rail last showed, and a
   * preview opens another beside it; re-translating a 3.7 GB Codex tail
   * costs 135 ms every time, and a cached open costs nothing.
   */
  private threadCache = new Map<string, HeldThread>()

  private archive: SessionArchive | null = null

  constructor(
    providers: SessionProvider[],
    options: { cachePath?: string; archivePath?: string } = {}
  ) {
    this.providers = providers
    this.cachePath = options.cachePath
    if (options.archivePath)
      this.archive = new SessionArchive(options.archivePath)
  }

  private commit(file: NativeFile, ref: ThreadRef | null): boolean {
    const current = this.byPath.get(file.path)
    if (
      current &&
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
          const ref = withWorkspace(await provider.peek(file).catch(() => null))
          if (!this.commit(file, ref)) return
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
      refs.push(withWorkspace(ref) ?? ref)
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
    // stores. Live beats archived; newest beats older.
    const byIdentity = new Map<string, ThreadRef>()
    for (const ref of refs) {
      const key = threadIdentity(ref)
      const held = byIdentity.get(key)
      if (
        !held ||
        (held.archived && !ref.archived) ||
        (Boolean(held.archived) === Boolean(ref.archived) &&
          (ref.updatedAt ?? "") > (held.updatedAt ?? ""))
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
    const provider = this.ownerOf(path)
    // Opening a conversation must see external writes even before the watcher
    // catches up. Validate only this store, using provider-owned revision facts.
    const stamp = provider ? await nativeFileOf(provider, path) : null
    const held = this.threadCache.get(path)
    const cached =
      held &&
      stamp &&
      held.bytes === stamp.bytes &&
      held.mtimeMs === stamp.mtimeMs &&
      held.revision === stamp.revision
        ? held.thread
        : null
    if (held && !cached) this.threadCache.delete(path)
    const native =
      cached ??
      withThreadWorkspace(
        provider ? await provider.read(path).catch(() => null) : null
      )
    if (native) {
      if (stamp) {
        // Re-insert so the map's order is recency.
        this.threadCache.delete(path)
        this.threadCache.set(path, {
          bytes: stamp.bytes,
          mtimeMs: stamp.mtimeMs,
          revision: stamp.revision,
          thread: native,
        })
        let bytes = 0
        for (const held of this.threadCache.values())
          bytes += Math.min(held.bytes, TRANSLATED_BYTES_CAP)
        while (
          this.threadCache.size > 1 &&
          (this.threadCache.size > THREAD_CACHE_SIZE || bytes > THREAD_CACHE_BYTES)
        ) {
          const oldest = this.threadCache.keys().next().value
          if (oldest === undefined) break
          bytes -= Math.min(this.threadCache.get(oldest)?.bytes ?? 0, TRANSLATED_BYTES_CAP)
          this.threadCache.delete(oldest)
        }
      }
      if (trackForFollow) {
        this.opened = {
          path,
          throughByte: native.checkpoint ?? native.ref.bytes ?? 0,
          entryCount: native.entries.length,
        }
      }
      return native
    }
    // The native store cannot answer — deleted, pruned, or gone with a
    // machine. The archive is exactly for this moment.
    return this.archive ? this.archive.read(path) : null
  }

  async page(
    path: string,
    before?: number,
    limit = 100,
    options: ThreadPageOptions = {}
  ): Promise<ThreadPage | null> {
    if (options.preview) return this.preview(path, limit, options)
    const thread = await this.open(path)
    if (!thread) return null
    const total = thread.entries.length
    const end = Math.min(total, Math.max(0, before ?? total))
    const slice = pageSlice(thread.entries, end, limit, options)
    return {
      ref: thread.ref,
      checkpoint: thread.checkpoint,
      entries: slice.entries,
      start: slice.start,
      total,
      hasEarlier: slice.start > 0,
      translator: translatorBuild(),
    }
  }

  /**
   * The newest exchanges of a large record, translated from its tail alone.
   * The window starts mid-record, so the page begins at the first prompt it
   * holds: an exchange cut at its top would show tool results without the
   * calls that made them. Null when the full thread is warm, the record is
   * small or not append-only, or no window holds a prompt.
   */
  private async preview(
    path: string,
    limit: number,
    options: ThreadPageOptions
  ): Promise<ThreadPage | null> {
    const provider = this.ownerOf(path)
    const ref = this.byPath.get(path)?.ref
    if (!provider?.tail || !ref) return null
    const stamp = await nativeFileOf(provider, path)
    if (!stamp || stamp.bytes < PREVIEW_MIN_BYTES) return null
    const held = this.threadCache.get(path)
    if (held && held.bytes === stamp.bytes && held.mtimeMs === stamp.mtimeMs && held.revision === stamp.revision)
      return null
    for (const window of PREVIEW_WINDOWS) {
      if (window >= stamp.bytes) return null
      const { entries } = await provider.tail(path, stamp.bytes - window)
      const prompt = entries.findIndex((entry) => entry.kind === "user")
      if (prompt === -1) continue
      const aligned = withLeadingModel(entries.slice(prompt), ref.model)
      const slice = pageSlice(aligned, aligned.length, limit, options)
      return {
        ref,
        entries: slice.entries,
        start: slice.start,
        total: aligned.length,
        hasEarlier: true,
        preview: true,
        translator: translatorBuild(),
      }
    }
    return null
  }

  /** One complete block of an assistant entry, for what a trimmed page left out. */
  async block(path: string, at: BlockAddress): Promise<EntryBlock | null> {
    const thread = await this.open(path, false)
    const entry = thread?.entries[at.entry]
    if (entry?.kind !== "assistant") return null
    return entry.blocks[at.block] ?? null
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
    const roots = new Set(this.providers.flatMap(provider => provider.roots()))
    for (const [root, watcher] of this.watchers) {
      if (roots.has(root) && existsSync(root)) continue
      watcher.close()
      this.watchers.delete(root)
    }
    for (const root of roots) {
      if (this.watchers.has(root) || !existsSync(root)) continue
      try {
        const watcher = watch(root, { recursive: true }, (_event, filename) => {
          if (this.watchers.get(root) !== watcher || !filename) return
          this.noticed(`${root}/${filename.toString()}`)
        })
        watcher.on("error", () => {
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
   * appends. Returns an unsubscribe.
   */
  follow(
    path: string,
    fromByte: number,
    onEntries: (
      entries: ThreadEntry[],
      replaced: boolean,
      replaceFrom?: number
    ) => void
  ): () => void {
    const provider = this.ownerOf(path)
    const opened =
      this.opened?.path === path && this.opened.throughByte === fromByte
        ? this.opened
        : null
    const state = this.follows.get(path) ?? {
      listeners: new Set(),
      follower: provider ? this.makeFollower(provider, path, fromByte) : null,
      fromByte,
      baselineCount: opened?.entryCount ?? null,
    }
    if (opened) this.opened = null
    state.listeners.add(onEntries)
    this.follows.set(path, state)
    // A selected conversation can be followed before broad discovery finishes.
    if (!this.stopped) this.observeFollow(path, state)
    return () => {
      state.listeners.delete(onEntries)
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
    const provider = this.ownerOf(path)
    if (!provider?.remove) return false
    if (!(await provider.remove(path))) return false
    this.threadCache.delete(path)
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
    for (const follow of this.follows.values()) {
      follow.unobserve?.()
      follow.listeners.clear()
    }
    this.follows.clear()
    for (const watcher of this.watchers.values()) watcher.close()
    this.watchers.clear()
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
      ...this.scans,
      this.discovering,
      this.reconciling,
      ...[...this.refreshes.values()].map(state => state.promise),
      ...[...this.rescans.values()].map(state => state.promise),
    ])
    this.threadCache.clear()
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
      // Awaited: a host stopping for a restart exits right after this, and an
      // unawaited write lost the whole cache, so the next start re-peeked
      // every file.
      await this.saveCache()
    }
    try {
      await this.archive?.stop()
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

  private noticed(path: string, followedTarget?: string): void {
    if (this.stopped) return
    const provider = this.ownerOf(followedTarget ?? path)
    if (!provider) return
    const mapped = followedTarget ?? provider.watchTarget?.(path)
    if (mapped === null) return
    const target = mapped ?? path
    const rescan = rescansFor(provider, target)
    // A write to a shared database can have moved any of that provider's
    // threads, and only that provider's: Cursor Desktop writing state.vscdb
    // once dropped a cached Codex thread with every keystroke.
    if (rescan) {
      for (const path of this.threadCache.keys()) {
        if (this.ownerOf(path) === provider) this.threadCache.delete(path)
      }
    } else this.threadCache.delete(target)
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
        const ref = withWorkspace(await provider.peek(file).catch(() => null))
        if (!this.commit(file, ref)) continue
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
          const update = await follow.follower.next().catch(() => null)
          if (update && (update.replace || update.entries.length > 0)) {
            await this.deliverFollowerUpdate(
              provider,
              file.path,
              follow,
              update
            )
          }
        } else {
          const thread = await provider.read(file.path).catch(() => null)
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
        ? await refined(provider, previous, cached.bytes)
        : withWorkspace(await provider.peek(file).catch(() => null))
      if (!this.commit(file, ref)) return
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
          reusable.fromByte
        )
      : withWorkspace(await provider.peek(file).catch(() => null))
    if (!this.commit(file, ref)) return
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
        const thread = await provider.read(path).catch(() => null)
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
      const update = await follow.follower.next().catch(() => null)
      if (update?.reset && grew && cached.ref) {
        const resetRef = withWorkspace(
          await provider.peek(file).catch(() => null)
        )
        if (this.commit(file, resetRef) && resetRef)
          this.emit({ type: "updated", ref: resetRef })
      }
      if (update && (update.replace || update.entries.length > 0)) {
        await this.deliverFollowerUpdate(provider, path, follow, update)
      }
      return
    }

    const thread = await provider.read(path).catch(() => null)
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
      const thread = await provider.read(path).catch(() => null)
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
    fromByte: number
  ): SessionFollower | null {
    if (provider.createFollower) return provider.createFollower(path, fromByte)
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
      listener(update.entries, update.replace, update.replaceFrom)
  }

  private capture(ref: ThreadRef): void {
    if (this.stopped) return
    if (!ref.archived && !ref.locked)
      this.archive?.note(ref, () => this.open(ref.path, false))
  }

  private forget(path: string): boolean {
    this.orderedRefs = null
    return this.byPath.delete(path)
  }

  private emit(event: CatalogEvent): void {
    if (this.stopped) return
    // Archive once the writer releases its lock. Re-translating a giant live
    // conversation on every checkpoint competes with the agent writing it.
    if (this.archive && (event.type === "added" || event.type === "updated")) {
      this.capture(event.ref)
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
