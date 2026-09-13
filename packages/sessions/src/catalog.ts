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

import { existsSync, realpathSync, watch, type FSWatcher } from "node:fs"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { dirname, join, sep } from "node:path"
import {
  parseCache,
  CATALOG_CACHE_VERSION,
  type CacheEntry,
} from "./catalog-cache.js"
import {
  threadIdentity,
  type Thread,
  type ThreadEntry,
  type ThreadPage,
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
}

interface RefreshState {
  requested: boolean
  forceMetadata?: boolean
  promise: Promise<void>
}

const WATCH_DEBOUNCE_MS = 24
const CACHE_SAVE_DEBOUNCE_MS = 2000

/** Rescan cadence where recursive watching is unavailable. Stat-only. */
const POLL_FALLBACK_MS = 30_000
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

function withThreadWorkspace(thread: Thread | null): Thread | null {
  if (!thread) return null
  const ref = withWorkspace(thread.ref)
  return ref === thread.ref || !ref ? thread : { ...thread, ref }
}

export class SessionCatalog {
  private providers: SessionProvider[]
  private pollTimer: NodeJS.Timeout | null = null
  private activeTimer: NodeJS.Timeout | null = null
  private byPath = new Map<string, CacheEntry>()
  private orderedRefs: ThreadRef[] | null = null
  private cachePath?: string
  private cacheLoaded = false
  private saveTimer: NodeJS.Timeout | null = null
  private watchers: FSWatcher[] = []
  private pending = new Map<string, NodeJS.Timeout>()
  private listeners = new Set<(event: CatalogEvent) => void>()
  private follows = new Map<string, FollowState>()
  private refreshes = new Map<string, RefreshState>()
  private rescans = new Map<string, RefreshState>()
  private opened: {
    path: string
    throughByte: number
    entryCount: number
  } | null = null
  private threadCache: {
    path: string
    bytes: number
    mtimeMs: number
    revision?: string
    thread: Thread
  } | null = null

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
   * for changes — but the polling fallback (platforms without recursive
   * watch) passes `emitChanges` so its rescans behave like watch events.
   */
  async scan(options: { emitChanges?: boolean } = {}): Promise<ThreadRef[]> {
    await this.loadCache()
    await this.archive?.load()
    this.orderedRefs = null
    const seen = new Set<string>()
    await Promise.all(
      this.providers.map(async (provider) => {
        const files = await provider.discover().catch((): NativeFile[] => [])
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
      if (seen.has(path)) continue
      const existing = await stat(path).catch(() => null)
      if (!existing) this.forget(path)
    }
    this.scheduleSave()
    return this.list()
  }

  get count(): number {
    return this.orderedRefs?.length ?? this.list().length
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
    const stamp = this.byPath.get(path)
    const held = this.threadCache
    const cached =
      held &&
      stamp &&
      held.path === path &&
      held.bytes === stamp.bytes &&
      held.mtimeMs === stamp.mtimeMs &&
      held.revision === stamp.revision
        ? held.thread
        : null
    const provider = this.ownerOf(path)
    const native =
      cached ??
      withThreadWorkspace(
        provider ? await provider.read(path).catch(() => null) : null
      )
    if (native) {
      if (stamp && !cached) {
        this.threadCache = {
          path,
          bytes: stamp.bytes,
          mtimeMs: stamp.mtimeMs,
          revision: stamp.revision,
          thread: native,
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
    limit = 100
  ): Promise<ThreadPage | null> {
    const thread = await this.open(path)
    if (!thread) return null
    const total = thread.entries.length
    const end = Math.min(total, Math.max(0, before ?? total))
    const size = Math.min(200, Math.max(1, limit))
    const start = Math.max(0, end - size)
    return {
      ref: thread.ref,
      checkpoint: thread.checkpoint,
      entries: thread.entries.slice(start, end),
      start,
      total,
      hasEarlier: start > 0,
    }
  }

  /* ------------------------------------------------------------ watching */

  /**
   * Watch every harness root. Events fire for sessions created or grown by
   * *anything* — this app, the harness's own CLI, another wrapper entirely.
   */
  startWatching(): void {
    if (this.watchers.length > 0) return
    let unwatchable = false
    for (const provider of this.providers) {
      for (const root of provider.roots()) {
        if (!existsSync(root)) continue // Not installed: nothing to watch.
        try {
          const watcher = watch(
            root,
            { recursive: true },
            (_event, filename) => {
              if (!filename) return
              this.noticed(`${root}/${filename.toString()}`)
            }
          )
          watcher.on("error", () => this.ensurePolling())
          this.watchers.push(watcher)
        } catch {
          // Recursive watching is unavailable on some platforms and network
          // volumes. Those roots fall back to the polling rescan below.
          unwatchable = true
        }
      }
    }
    if (unwatchable) this.ensurePolling()
    if (!this.activeTimer) {
      this.activeTimer = setInterval(() => {
        void this.reconcileActive()
      }, ACTIVE_RECONCILE_MS)
      this.activeTimer.unref?.()
    }
  }

  /**
   * Stat every followed or recently updated file and refresh the ones the
   * watcher did not report. Bounded to the active set; a full scan stays the
   * job of the polling fallback.
   */
  async reconcileActive(now = Date.now()): Promise<void> {
    const since = new Date(now - ACTIVE_WINDOW_MS).toISOString()
    const candidates: string[] = []
    for (const [path, entry] of this.byPath) {
      if (this.follows.has(path) || (entry.ref?.updatedAt ?? "") >= since)
        candidates.push(path)
    }
    await forEachConcurrent(candidates, 4, async (path) => {
      const provider = this.ownerOf(path)
      if (!provider || provider.rescanRoot) return
      const cached = this.byPath.get(path)
      const info = await stat(path).catch(() => null)
      if (!cached || !info?.isFile()) return
      if (cached.bytes === info.size && cached.mtimeMs === info.mtimeMs) return
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
    return () => {
      state.listeners.delete(onEntries)
      if (state.listeners.size === 0) this.follows.delete(path)
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
    if (this.threadCache?.path === path) this.threadCache = null
    this.follows.delete(path)
    if (this.forget(path)) {
      this.scheduleSave()
      this.emit({ type: "removed", path })
    }
    return true
  }

  async stop(): Promise<void> {
    for (const watcher of this.watchers) watcher.close()
    this.watchers = []
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    if (this.activeTimer) {
      clearInterval(this.activeTimer)
      this.activeTimer = null
    }
    for (const timer of this.pending.values()) clearTimeout(timer)
    this.pending.clear()
    this.threadCache = null
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
      void this.saveCache()
    }
    try {
      await this.archive?.stop()
    } finally {
      for (const provider of this.providers) provider.close?.()
    }
  }

  /* ------------------------------------------------------------ internals */

  private ensurePolling(): void {
    if (this.pollTimer) return
    this.pollTimer = setInterval(() => {
      void this.scan({ emitChanges: true })
    }, POLL_FALLBACK_MS)
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

  private noticed(path: string): void {
    const provider = this.ownerOf(path)
    if (!provider) return
    const mapped = provider.watchTarget?.(path)
    if (mapped === null) return
    const target = mapped ?? path
    if (provider.rescanRoot || this.threadCache?.path === target) {
      this.threadCache = null
    }
    // Shared-database stores have no per-session file to stat: any write
    // under the root re-runs that provider's discovery, debounced under
    // one key so a burst costs one rescan. Sidecar writes debounce under
    // the native file so summary.json and updates.jsonl cannot race.
    const key = provider.rescanRoot
      ? `rescan:${provider.harness}:${provider.roots()[0]}`
      : target
    clearTimeout(this.pending.get(key))
    const sidecar = target !== path
    this.pending.set(
      key,
      setTimeout(() => {
        this.pending.delete(key)
        if (provider.rescanRoot) void this.rescanProvider(provider)
        else void this.refresh(provider, target, sidecar)
      }, provider.rescanDebounceMs ?? WATCH_DEBOUNCE_MS)
    )
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
        } while (state.requested)
      } finally {
        if (this.rescans.get(key) === state) this.rescans.delete(key)
      }
    })()
    this.rescans.set(key, state)
    return state.promise
  }

  /** Re-discover one provider's synthetic files; diff against the cache. */
  private async rescanProviderOnce(provider: SessionProvider): Promise<void> {
    const files = await provider.discover().catch((): NativeFile[] => [])
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
        if (ref) this.emit({ type: cached?.ref ? "updated" : "added", ref })
        else if (cached?.ref) this.emit({ type: "removed", path: file.path })
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
        } while (state.requested)
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
    const info = await stat(path).catch(() => null)
    if (!info || !info.isFile()) {
      if (this.forget(path)) {
        this.scheduleSave()
        this.emit({ type: "removed", path })
      }
      return
    }
    const file: NativeFile = { path, bytes: info.size, mtimeMs: info.mtimeMs }
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
    if (ref) this.emit({ type: cached?.ref ? "updated" : "added", ref })
    else if (cached?.ref) this.emit({ type: "removed", path })

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
    if (!ref.archived && !ref.locked)
      this.archive?.note(ref, () => this.open(ref.path, false))
  }

  private forget(path: string): boolean {
    this.orderedRefs = null
    return this.byPath.delete(path)
  }

  private emit(event: CatalogEvent): void {
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
    if (!this.cachePath || this.saveTimer) return
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
