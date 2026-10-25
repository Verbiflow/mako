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

import type { InstalledReading } from "./record-writers.js"
import { UNREAD_INDEX_FILE, UnreadIndex } from "./unread-index.js"
import { observedInstall } from "./record-observed.js"
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
import { SessionArchive } from "./archive.js"
import { ThreadRefSchema } from "./thread-schema.js"
import type { KeptRestore } from "./kept-restore.js"
import { ArchiveMigration, type ArchiveMigrationPassOptions, type ArchiveMigrationReport, type ArchiveMigrationSource } from "./archive-migration.js"
import { AttachmentSweep, type AttachmentReaders } from "./attachment-sweep.js"
import { takeLock } from "./record-locks.js"
import { boundedChildren, type ChildTranscript, type ChildTranscripts } from "./children.js"
import { NativeStores, ReadOnlyStoreError } from "./read-only-sqlite.js"
import { DECODE_ASIDE_BYTES, type AsideJob, type DecodeAside } from "./decode-aside.js"
import type { FollowStart } from "./jsonl.js"
import { RecordBackfill, type BackfillLog, type ChildLinkFill, type ViewRebuild, type WriterFill } from "./record-backfill.js"
import { WriterEvidenceReader } from "./record-evidence.js"
import { readReleaseTimelines } from "./record-releases.js"
import { EVIDENCE_RULES, type WriterEvidence } from "./record-writers.js"
import { RecordCapture } from "./record-capture.js"
import { RecordReads, RESTORED, type ReadBack } from "./record-reads.js"
import { RecordStore, type RestoreInput } from "./record-store.js"
import type { RecordRoot } from "./harness-records.js"
import { ReadingCopies, ReceivedCopies, type CopyPage, type CopyScope } from "./reading-copies.js"
import { RecordPushes, RecordSync, RecordsLinkRefusedError, type PushStatus, type ReceivedRecords, type ReceivingSession, type RecordsLink, type SentRecords, type StagedRecords, type SyncReport } from "./record-sync.js"
import { recordsOverHttp } from "@mako/protocol/records-http"
import { GatewayHttpError } from "@mako/protocol/gateway-http"
import type { RecordRemote } from "@mako/protocol/records"
import { readOriginal, type EntryOriginal } from "./record-original.js"
import { STREAMS_ROOT, streamOwner, streamsRoot } from "./record-streams.js"
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

/** Sessions whose last read a follow can take over from: the viewer's, and what was read beside it since. */
const OPENED_KEPT = 8
/**
 * What the views a catalog holds in memory weigh at most, compressed: the
 * sessions that decode too fast to be worth a file, and every session of a
 * catalog that writes nothing.
 */
const MEMORY_VIEW_BYTES = 192 * 1024 * 1024

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

/**
 * Where the harness here keeps each root a session was captured under, for a restore of it from another home: written
 * there, it's where the reader lists it, whatever the source's home or its roots' places in it were. A root the reader
 * keeps under another name of the same kind (another account's, `claude@…`) goes to its own (`claude`).
 */
function ownRoots(provider: SessionProvider, names: readonly string[], streams: string | null): Pick<RestoreInput, "roots"> {
  const own = provider.recordRoots?.()
  if (!own) return {}
  const roots = names.flatMap((name): RecordRoot[] => {
    // Mako's own streams of the session's launches go where this host keeps them.
    if (name === STREAMS_ROOT) return streams ? [{ name, path: streams }] : []
    const path = (own.find((root) => root.name === name) ?? own.find((root) => root.name === baseRoot(name)))?.path
    return path ? [{ name, path }] : []
  })
  return { roots }
}

/** A root's kind: an extra root's name (`claude@1a2b3c4d`) without its suffix. */
function baseRoot(name: string): string {
  return name.split("@")[0] ?? name
}

/** Whether a write at `path` re-runs this provider's discovery or refreshes the one file. */
export function rescansFor(provider: SessionProvider, path: string): boolean {
  return provider.rescanRoot?.(path) ?? false
}

/**
 * The session file a write at `path` under the provider's roots refreshes,
 * or null for a write the catalog ignores: SQLite's shared-memory file,
 * which changes when anyone reads, and whatever the provider maps away.
 */
export function writtenSession(provider: SessionProvider, path: string): string | null {
  if (path.endsWith("-shm")) return null
  const mapped = provider.watchTarget?.(path)
  return mapped === null ? null : mapped ?? path
}

/** The stat facts the catalog compares, from the provider when it knows better than `stat`. */
export async function nativeFileOf(
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

const RowPathSchema = ThreadRefSchema.pick({ path: true })

/** A session's row as the record store keeps it: what its harness says, without what Mako adds while serving it. */
function railRow(ref: ThreadRef): ThreadRef {
  const { active: _active, locked: _locked, archived: _archived, copyOnly: _copyOnly, ...row } = ref
  return row
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
  /** By provider, not harness: a harness can have several (Devin's CLI and its app), and each store is read on its own. */
  private rescans = new Map<SessionProvider, RefreshState>()
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
  /** Takes every session in the rail into the record store, for a catalog given `backfill`. */
  private backfill: RecordBackfill | null = null
  /** Where the backfill finds every reader of the archive's attachments, when it sweeps them. */
  private readonly attachments: { readers: () => Promise<AttachmentReaders>; views?: string; aside?: string } | null
  /** Sessions their harness deleted that the record store keeps the rail's row of (`RecordStore.listings`), read once until one is forgotten. */
  private recordRows: Map<string, ThreadRef> | null = null
  /** Harnesses whose discovery failed in the last scan: what the catalog lists of them is not all they have. */
  private undiscovered = new Set<string>()
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
  /** The unread records of every session this catalog decoded (`UnreadIndex`); in memory for a catalog that writes nothing. */
  readonly unread: UnreadIndex
  /** The record store capture writes, and sessions read back from it. */
  private recordStore: RecordStore | null = null
  /** The store captures write, for keeping a remote in step (`syncRecords`). */
  private recordWriter: RecordStore | null = null
  private recordPushes: RecordPushes | null = null
  /** The remote the pushes go to, read at each request: a renewed credential is taken without starting over. */
  private recordLink: { current: RecordsLink } | null = null
  /** This device's reading copies of the Sessions its account lists (`copies`), with a records store; null otherwise. */
  private readingCopies: ReadingCopies | null = null
  /** Copies other devices keep, read here (`copyPage`); made when first read. */
  private receivedCopies: ReceivedCopies | null = null
  /** Where the record store is kept, which the reading copies keep theirs beside; null for a catalog that writes nothing. */
  private readonly recordsFolder: string | null
  /** Where each session last read back from the record store was restored, which its entries' records name. */
  private readonly restoredFrom = new Map<string, string>()
  private recordReads: RecordReads | null = null
  /** The home record keys are relative to, where a session its harness deleted is restored (`restoreKept`). */
  private readonly recordsHome: string
  private readonly runtimeReadings: string | null
  /** How the harnesses' own stores are opened (`ReadBack.stores`): a restore for a harness to resume writes them; a strict host's refuse. */
  private readonly harnessStores: NativeStores | null
  /** Restores running, by path: a second ask shares the first. */
  private readonly restoring = new Map<string, Promise<KeptRestore>>()

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
      readOnly?: boolean
      /**
       * Take every session in the rail into the record store once watching
       * starts, newest first, then again every few minutes (`RecordBackfill`).
       * Only for a catalog off the host's main thread with the heap a first
       * capture of a large database needs (the catalog worker), that writes:
       * never with `readOnly`.
       */
      backfill?: boolean
      /** Where the backfill's progress lines go; the console by default. */
      log?: BackfillLog
      /**
       * The host's installed readings (`makoRuntimeReadings()`): a write
       * heard as it lands is stamped with the version installed then, where
       * its harness's records state none (`observedInstall`).
       */
      runtimeReadings?: string
      translator?: string
      /** How this build stamps a store format it sets (`storeWriter`): the record store's and the unread index's. */
      writer?: string
      /**
       * Large records decode in a child process (`DecodeAside`), for a
       * catalog with `viewsPath`. Each of `providers` must be the one
       * `SAVED_HISTORY_READERS` makes at its index, which the child makes
       * again.
       */
      decodeAside?: DecodeAside
      /**
       * Every profile's folders on this machine (`profileRoots` in the
       * host), whose stores the backfill reads before it sweeps the
       * attachment files Mako keeps (`AttachmentSweep`);
       * without it they aren't swept.
       */
      attachmentReaders?: () => Promise<AttachmentReaders>
    } = {}
  ) {
    this.providers = providers
    this.cachePath = options.cachePath
    this.readOnly = options.readOnly ?? false
    this.strictStores = options.readBack?.stores.strict ?? true
    this.translator = options.translator
    if (options.archivePath)
      this.archive = new SessionArchive(options.archivePath, { readOnly: this.readOnly })
    this.recordsHome = options.recordsHome ?? homedir()
    this.harnessStores = options.readBack?.stores ?? null
    this.runtimeReadings = options.runtimeReadings ?? null
    this.writer = options.writer
    this.attachments = options.attachmentReaders ? { readers: options.attachmentReaders, views: options.viewsPath, ...options.decodeAside && { aside: options.decodeAside.executable } } : null
    if (options.recordsPath && !this.readOnly) this.records = this.openRecords(options.recordsPath, options.recordsHome, options.readBack, options.backfill ? options.log ?? null : undefined)
    this.recordsFolder = options.recordsPath && !this.readOnly ? options.recordsPath : null
    const build = () => this.translator ??= translatorBuild()
    // Every view's unread records, the large ones on disk and the small ones held in memory alike (`unread-index.ts`).
    this.unread = openUnreadIndex(options.viewsPath && !this.readOnly ? join(options.viewsPath, UNREAD_INDEX_FILE) : null, options.writer)
    if (options.viewsPath) {
      this.views = new ViewCache(options.viewsPath, build, undefined, this.unread)
      this.viewsPath = options.viewsPath
      this.aside = options.decodeAside ?? null
    }
    this.memoryViews = new ViewCache(null, build, MEMORY_VIEW_BYTES, this.unread)
  }

  /**
   * Null, with a warning, when the store can't be opened or is in a newer
   * build's format: one this build may read (`RecordStore.access`) is still
   * read back from and restored from, with nothing captured into it; one it
   * can't read is left as it is, and the catalog serves without it.
   */
  private openRecords(folder: string, home: string | undefined, readBack: ReadBack | undefined, backfill: BackfillLog | null | undefined): RecordCapture | null {
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
      this.recordWriter = store
      const capture = new RecordCapture(store, async (ref) => (await this.ownerOf(ref.path)?.records(ref.path)) ?? null, {
        home,
        streams,
        carried: folder,
        stampOf: (ref) => this.stampOf(ref.path),
        listingOf: (ref) => {
          const listed = this.byPath.get(ref.path)?.ref
          return listed ? JSON.stringify(railRow(listed)) : null
        },
        rowBytesOf: async (ref) => (await this.ownerOf(ref.path)?.recordBytes?.(ref.path)) ?? null,
        observedInstall: (harness) => (this.runtimeReadings ? observedInstall(this.runtimeReadings, harness) : null),
        onError: (ref, message) => console.error("Session record capture failed", ref.path, message),
        onCaptured: (ref) => this.recordPushes?.captured(ref.harness, ref.nativeId),
      })
      this.streams = streams
      if (backfill !== undefined)
        this.backfill = new RecordBackfill(capture, store, {
          sessions: () => this.list(),
          listed: (ref) => Boolean(this.byPath.get(ref.path)?.ref),
          foreground: () => [...this.decoding.values()],
          streams,
          ...backfill && { log: backfill },
          // The archive's copies go once the store holds their sessions, which only a store this catalog reads back from can tell.
          ...this.archive && readBack && { archive: new ArchiveMigration(this.archive, this.migrationSource()) },
          // Swept where the migration runs, under the same lock, once it has dropped what it can.
          ...this.archive && this.attachments && { assets: new AttachmentSweep({ archive: this.archive.folder, ...this.attachments }) },
          views: { rebuild: (control) => this.rebuildStaleViews(control) },
          writers: { fill: (control) => this.fillWriters(store, folder, control) },
          ...readBack && { children: { link: (control) => this.linkChildren(control) } },
        })
      return capture
    } catch (error) {
      console.warn("Session records off:", error instanceof Error ? error.message : error)
      return null
    }
  }

  /**
   * The writers of sessions nothing named one for yet: what their own
   * records state, read from what the store holds of them (a session
   * captured before its harness's rule, or deleted by its harness since), and
   * else the evidence its harness leaves beside its store
   * (`WriterEvidenceReader`: logs, installs, a range). One reader per pass,
   * so each harness's logs and installs are read once; yields to the person
   * between sessions.
   */
  /**
   * The children's paths of sessions captured before captures named them
   * (`RecordStore.sessionsWithoutChildLinks`), kept once per session: from
   * its harness's reader while the harness has it, else from its records
   * read back (`keptChildren`), whose home goes again unless it was there
   * already. Then a link to such a child opens without its parent listed
   * first. Yields to the person between sessions.
   */
  async linkChildren(control: { stopped(): boolean; yieldToPerson(): Promise<void> } = { stopped: () => this.stopped, yieldToPerson: async () => undefined }): Promise<ChildLinkFill> {
    const started = Date.now()
    const report: ChildLinkFill = { looked: 0, parents: 0, children: 0, kept: 0, failed: 0, ms: 0 }
    const store = this.recordStore
    if (!store || this.readOnly || store.access !== "write") return report
    for (const session of store.sessionsWithoutChildLinks()) {
      if (control.stopped()) break
      await control.yieldToPerson()
      report.looked += 1
      try {
        let paths: string[] = []
        for (const path of session.paths) {
          const provider = this.ownerOf(path)
          if (!provider?.children) continue
          const live = Boolean(await nativeFileOf(provider, path))
          const read = !live && this.recordReads?.hasHome(session.harness, session.nativeId) === false
          const listed = live ? await provider.children(path) : await this.keptChildren(provider, path)
          if (read) await this.recordReads?.drop(session.harness, session.nativeId)
          if (!listed) continue
          if (!live) report.kept += 1
          paths = listed.flatMap((child) => (child.path && child.path !== path ? [child.path] : []))
          break
        }
        await store.keepChildPaths(session.harness, session.nativeId, paths, { linked: true })
        if (paths.length) report.parents += 1
        report.children += paths.length
      } catch {
        report.failed += 1
      }
    }
    report.ms = Date.now() - started
    return report
  }

  async fillWriters(store: RecordStore, folder: string, control: { stopped(): boolean; yieldToPerson(): Promise<void> }): Promise<WriterFill> {
    const started = Date.now()
    const report: WriterFill = { looked: 0, record: 0, log: 0, install: 0, range: 0, unknown: 0, failed: 0, ms: 0 }
    const evidence = join(folder, "evidence")
    const releases = readReleaseTimelines(evidence)
    const reader = new WriterEvidenceReader({ home: this.recordsHome, readings: this.runtimeReadings, cache: evidence, releases })
    // Release dates read since a session was found to have no evidence may bound it now.
    const unknownBefore = Math.max(0, ...Object.values(releases).map((timeline) => timeline.checkedAt))
    for (const session of store.sessionsWithoutWriters({ unknownBefore })) {
      if (control.stopped()) break
      await control.yieldToPerson()
      report.looked += 1
      try {
        const rule = this.providers.find((provider) => provider.harness === session.harness && provider.recordWriter)?.recordWriter
        if (rule && (await store.rescanWriters(session.harness, session.nativeId, rule)).length) {
          report.record += 1
          continue
        }
        let evidence: WriterEvidence | null = null
        for (const path of session.paths) {
          const provider = this.ownerOf(path) ?? this.providers.find((each) => each.harness === session.harness)
          evidence = provider ? await reader.evidence(provider, path) : null
          if (evidence) break
        }
        evidence ??= { source: "unknown", why: rule ? "its records state no version where its harness writes one" : "its records state none, Mako never ran it, and its harness leaves nothing that names one", at: Date.now(), rules: EVIDENCE_RULES }
        await store.noteEvidence(session.harness, session.nativeId, evidence)
        report[evidence.source] += 1
      } catch {
        report.failed += 1
      }
    }
    report.ms = Date.now() - started
    return report
  }

  /**
   * Every view an earlier decoder build made, and every session whose unread
   * records one noted, decoded again by this build, the most recently used
   * first, one at a time, yielding to the person between sessions. A view
   * stamped with another build is never served as current anyway (it's
   * decoded again when opened); this does it before anyone asks, so after an
   * update every past session reads as this build reads it, and the unread
   * counts in diagnostics drop as a decoder learns a kind.
   */
  private async rebuildStaleViews(control: { stopped(): boolean; yieldToPerson(): Promise<void> }): Promise<ViewRebuild> {
    const build = this.translator ??= translatorBuild()
    const started = Date.now()
    const paths = new Set<string>()
    for (const view of (await this.views?.list()) ?? []) if (view.translator !== build) paths.add(view.path)
    for (const path of this.unread.stalePaths(build)) paths.add(path)
    const listed = new Set(this.list().map((ref) => ref.path))
    const report: ViewRebuild = { stale: paths.size, rebuilt: 0, gone: 0, failed: 0, ms: 0 }
    for (const path of paths) {
      if (control.stopped()) break
      await control.yieldToPerson()
      if (control.stopped()) break
      if (!listed.has(path)) {
        await Promise.all([this.views?.remove(path), this.memoryViews.remove(path)])
        report.gone += 1
        continue
      }
      try {
        if (await this.open(path, false)) report.rebuilt += 1
        else report.failed += 1
      } catch {
        report.failed += 1
      }
    }
    report.ms = Date.now() - started
    return report
  }

  /**
   * The stamp the catalog keeps of the native records at `path` (their
   * bytes, mtime and the provider's revision, as discovery and watching
   * compare them), or null for a path it doesn't list. What the record
   * store keeps with each capture, so the backfill knows a session it holds
   * as it stands now without reading it.
   */
  stampOf(path: string): string | null {
    const entry = this.byPath.get(path)
    return entry?.ref ? `n:${entry.bytes}:${entry.mtimeMs}:${entry.revision ?? ""}` : null
  }

  /** Harnesses whose discovery failed in the last scan, so the rail lists only part of what they have. */
  get undiscoveredHarnesses(): ReadonlySet<string> {
    return this.undiscovered
  }

  /** The backfill's pass running, or the last one this catalog ran; null without a backfill. */
  get backfillProgress() {
    return this.backfill?.progress ?? null
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
          )
            return
          const ref = await peeked(provider, file, this.workspaces)
          if (ref === UNREADABLE || !this.commit(file, ref, cached)) return
          if (options.emitChanges) {
            if (ref) this.emit({ type: cached?.ref ? "updated" : "added", ref })
            else if (cached?.ref) this.emit({ type: "removed", path: file.path })
          }
        })
      })
    )
    this.undiscovered = new Set([...unavailable].map((provider) => provider.harness))
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
    // Sessions whose harness deleted them: what the record store keeps of
    // them, and what only the archive's copy keeps.
    for (const [path, ref] of this.keptRecordRows()) if (!this.byPath.has(path)) admit(ref)
    if (this.archive) {
      const live = new Set(this.byPath.keys())
      for (const ref of this.archive.orphans(live)) admit(ref)
    }
    // One session, one row — whatever the path. Symlinked roots and the
    // archive can each present the same conversation twice; identity is the
    // harness's own session id unless the provider says one id names two
    // stores. Live beats kept, the harness's records beat Mako's copy, the
    // harness's own record beats a client's copy, and newest beats older.
    const byIdentity = new Map<string, ThreadRef>()
    for (const ref of refs) {
      const key = threadIdentity(ref)
      const held = byIdentity.get(key)
      const rank = (candidate: ThreadRef) => [candidate.archived ? 0 : 1, candidate.copyOnly ? 0 : 1, candidate.clientCopy ? 0 : 1] as const
      const [heldLive, heldRecords, heldOwn] = held ? rank(held) : [0, 0, 0]
      const [live, records, own] = rank(ref)
      if (
        !held ||
        live > heldLive ||
        (live === heldLive && (records > heldRecords || (records === heldRecords && (own > heldOwn || (own === heldOwn && (ref.updatedAt ?? "") > (held.updatedAt ?? ""))))))
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
   * last was, or as Mako had captured it by `asOf`. A child agent's path is
   * read from its parent's records (`RecordStore.parentAt`), by the reader
   * that read it live, at the same path.
   */
  private async restored(path: string, asOf?: number): Promise<{ view: SessionView; ref: ThreadRef; decoded?: Thread } | null> {
    const reads = this.recordReads
    const session = reads && this.recordStore && (this.recordStore.sessionAt(path) ?? this.recordStore.parentAt(path))
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
    const read = found.view.ref
    const childOf = read.childOf?.path ? { childOf: { ...read.childOf, path: reads.original(read.childOf.path, restored.home) } } : {}
    const ref = this.workspaces.ref({ ...read, ...childOf, path, archived: true }) ?? read
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
   * Puts a session its harness deleted back into the harness's own store,
   * from Mako's records, so the harness resumes it as the same session.
   * Idempotent: a session the harness has is left as it is (`present`), and
   * a unit already there is skipped. A copy in the harness's store that went
   * on without Mako is never overwritten: Mako's version is written beside
   * it as the harness's own fork (`forked`). Whether something else holds
   * the session open is the caller's to have asked first. `installed` is the
   * version of the harness here: an older one than the newest that wrote the
   * records gets nothing written (`outdated`, `restoreGate`).
   */
  restoreKept(path: string, installed?: string | InstalledReading | null): Promise<KeptRestore> {
    const key = `${path}\0${JSON.stringify(installed ?? null)}`
    const running = this.restoring.get(key)
    if (running) return running
    const work = this.restoreKeptNow(path, installed).finally(() => this.restoring.delete(key))
    this.restoring.set(key, work)
    return work
  }

  private async restoreKeptNow(path: string, installed: string | InstalledReading | null | undefined): Promise<KeptRestore> {
    const refused = (reason: string): KeptRestore => ({ kind: "refused", reason })
    const store = this.recordStore
    const provider = this.ownerOf(path)
    if (this.readOnly || !store || !provider || !this.harnessStores) return refused("Mako keeps no records here it could restore this session from.")
    if (this.byPath.get(path)?.ref && (await nativeFileOf(provider, path))) return { kind: "present", path }
    const session = store.sessionAt(path)
    if (!session || !store.captured(session.harness, session.nativeId)) return refused("Mako holds no finished copy of this session's records.")
    const started = performance.now()
    const destination = await provider.records(path).catch(() => null)
    const report = await store.restore({
      harness: session.harness, nativeId: session.nativeId, home: this.recordsHome, stores: this.harnessStores,
      ...destination && { destination }, ...provider.fork && { fork: provider.fork },
      ...installed !== undefined && { installed },
    })
    // What its reader listed of the store before is stale: the session and its children are there the moment this returns.
    if (report.written || report.fork?.written) provider.storeWritten?.()
    if (report.outdated) return { kind: "outdated", ...report.outdated }
    if (report.fork) {
      if (rescansFor(provider, path)) await this.rescanProvider(provider)
      return report.fork.written || !report.fork.diverged.length
        ? { kind: "forked", nativeId: report.fork.nativeId }
        : refused(`${provider.displayName} holds a copy of this session that went on without Mako, and its fork couldn't be written.`)
    }
    if (report.diverged.length && !report.written) return refused(`${provider.displayName} holds part of this session that Mako never saw (${report.diverged[0]!.reason}), so nothing was restored.`)
    // The harness lists it again: the catalog reads it as it reads any session written.
    if (rescansFor(provider, path)) await this.rescanProvider(provider)
    else await this.refresh(provider, path)
    this.recordRows = null
    this.orderedRefs = null
    if (!this.byPath.get(path)?.ref) return refused(`Mako restored this session's records, but ${provider.displayName} doesn't list it at ${path}.`)
    return {
      kind: "restored", path,
      files: report.actions.filter((action) => action.action !== "skip").length,
      rows: report.rows.reduce((total, rows) => total + rows.insert + rows.replace + rows.delete, 0),
      ms: Math.round(performance.now() - started),
    }
  }

  /**
   * The rail's rows the record store keeps of sessions their harness
   * deleted (`RecordStore.listings`), by path: each read back from the
   * store when opened. Read once, and again after the catalog forgets a
   * path or the migration keeps a row; empty without a store to read
   * sessions back from.
   */
  private keptRecordRows(): ReadonlyMap<string, ThreadRef> {
    const store = this.recordStore
    if (!store || !this.recordReads) return new Map()
    if (this.recordRows) return this.recordRows
    const rows = new Map<string, ThreadRef>()
    try {
      for (const listing of store.listings()) {
        const value: unknown = JSON.parse(listing)
        // Only a session the harnesses no longer list is parsed whole: most rows are of live sessions.
        const listed = RowPathSchema.safeParse(value)
        if (!listed.success || this.byPath.has(listed.data.path)) continue
        const path = listed.data.path
        const ref = ThreadRefSchema.safeParse(value)
        if (ref.success) rows.set(path, { ...ref.data, locked: false, archived: true })
      }
    } catch (error) {
      console.warn("The record store's rows could not be read", error instanceof Error ? error.message : error)
    }
    this.recordRows = rows
    return rows
  }

  /**
   * One pass of the archive's migration now, as each backfill pass ends
   * with: for `records.ts` and benchmarks. It takes the backfill's lock, so
   * it never runs beside a pass; null without an archive, a store to read
   * sessions back from, or the lock.
   */
  async migrateArchive(options: Partial<ArchiveMigrationPassOptions> = {}): Promise<ArchiveMigrationReport | null> {
    const store = this.recordStore
    if (!this.archive || !store || this.readOnly) return null
    const lock = await takeLock(join(store.folder, "backfill.lock"))
    if (!lock) return null
    try {
      return await new ArchiveMigration(this.archive, this.migrationSource()).pass({
        stopped: () => this.stopped,
        yieldToPerson: async () => {
          await Promise.allSettled(this.decoding.values())
        },
        ...options,
      })
    } finally {
      await lock.release()
    }
  }

  /** What the archive's migration asks of this catalog (`archive-migration.ts`). */
  private migrationSource(): ArchiveMigrationSource {
    return {
      live: () => [...this.byPath.values()].flatMap((entry) => entry.ref ? [entry.ref] : []),
      discovered: (harness) => !this.undiscovered.has(harness),
      captured: (ref) => this.recordStore?.captured(ref.harness, ref.nativeId) ?? false,
      decodesNative: async (path) => {
        const provider = this.ownerOf(path)
        if (!provider) return null
        const stamp = await nativeFileOf(provider, path)
        const found = stamp ? await this.viewOf(provider, path, stamp) : await this.unstamped(provider, path)
        return found ? found.view.total : null
      },
      decodesRecords: async (ref) => {
        const store = this.recordStore
        if (!store) return null
        const here = store.sessionAt(ref.path)
        const own = here?.harness === ref.harness && here.nativeId === ref.nativeId ? [ref.path] : []
        for (const path of new Set([...own, ...store.pathsOf(ref.harness, ref.nativeId)])) {
          const restored = await this.restored(path)
          if (restored) return { path, entries: restored.view.total }
        }
        return null
      },
      keepListing: async (ref) => {
        const kept = (await this.recordStore?.keepListing(ref.harness, ref.nativeId, ref.path, JSON.stringify(railRow(ref)))) ?? false
        this.recordRows = null
        this.orderedRefs = null
        return kept
      },
    }
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
    // Discovery has listed every session: what was written before the catalog started is the backfill's.
    void this.backfill?.wake("start")
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
      if (this.watching) void this.backfill?.wake()
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
   * Delete a native session and the agents it started through its provider,
   * and drop it from the catalog. Refuses a path no provider owns or one it
   * cannot remove.
   */
  async remove(path: string): Promise<boolean> {
    if (this.readOnly) throw new ReadOnlyStoreError("The session catalog")
    const provider = this.ownerOf(path)
    if (!provider) return false
    const ref = this.byPath.get(path)?.ref
    const kept = ref ? undefined : this.keptRecordRows().get(path)
    if (kept) return this.removeKept(provider, kept)
    if (!provider.remove) return false
    // The agents it started go with it: a child is never a row of its own, so once its parent is gone nothing
    // lists it and nothing would ever remove it (Grok's and Codex's subagents keep sessions of their own beside
    // their parent's). The newest first, and before the parent: Codex refuses to remove a thread another continues.
    const children = ((await provider.children?.(path)) ?? []).flatMap((child) => (child.path && child.path !== path ? [child.path] : [])).reverse()
    for (const child of new Set(children)) {
      await provider.remove(child)
      await Promise.all([this.memoryViews.remove(child), this.views?.remove(child)])
    }
    if (!(await provider.remove(path))) return false
    // One session, one delete: a path folded onto the same session (a Cursor agent imported from a `cursor-agent` chat,
    // a Claude session seen through two account roots) goes too, or the rail would show the other half once this one is gone.
    for (const alias of ref ? this.foldedOnto(ref, path) : []) {
      if (!(await this.ownerOf(alias)?.remove?.(alias))) continue
      const aliasRef = this.byPath.get(alias)?.ref
      if (aliasRef) await this.forgetRecords(aliasRef)
      await Promise.all([this.memoryViews.remove(alias), this.views?.remove(alias)])
      if (this.forget(alias)) this.emit({ type: "removed", path: alias })
    }
    // The person deleted it: Mako's records of it go too, streams and its children's files included. A session its harness deletes keeps them.
    if (ref) await this.forgetRecords(ref)
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

  /** The other paths the catalog folds onto `ref`'s session: the same harness's session under one identity. */
  private foldedOnto(ref: ThreadRef, path: string): string[] {
    const identity = threadIdentity(ref)
    return [...this.byPath].flatMap(([other, entry]) => (other !== path && entry.ref && !entry.ref.copyOnly && threadIdentity(entry.ref) === identity ? [other] : []))
  }

  /**
   * The person's delete of a session its harness deleted, listed from Mako's
   * records: the records go, its children's with them (they're the
   * session's), and a child its harness still keeps goes from the harness,
   * as with any delete. Nothing lists the session or its children again.
   */
  private async removeKept(provider: SessionProvider, ref: ThreadRef): Promise<boolean> {
    const linked = (await provider.children?.(ref.path).catch(() => null)) ?? []
    const children = [...new Set(linked.flatMap((child) => (child.path && child.path !== ref.path ? [child.path] : [])))].reverse()
    for (const child of children) if (await nativeFileOf(provider, child)) await provider.remove?.(child)
    if (await nativeFileOf(provider, ref.path)) await provider.remove?.(ref.path)
    await this.forgetRecords(ref, children)
    this.follows.get(ref.path)?.unobserve?.()
    this.follows.get(ref.path)?.listeners.clear()
    this.follows.delete(ref.path)
    this.forget(ref.path)
    this.emit({ type: "removed", path: ref.path })
    return true
  }

  /**
   * Drops a session the person deleted from the record store, with its
   * children's paths, every home it was read back into and the views read
   * there; a failure is logged, and the deletion stands.
   */
  private async forgetRecords(ref: ThreadRef, children: readonly string[] = []): Promise<void> {
    const paths = new Set([ref.path, ...children, ...(this.recordStore?.childPaths(ref.harness, ref.nativeId) ?? [])])
    try {
      await this.records?.forget(ref)
      await this.recordReads?.drop(ref.harness, ref.nativeId)
    } catch (error) {
      console.error("Session records could not be forgotten", ref.path, error instanceof Error ? error.message : error)
    }
    for (const path of paths) {
      const read = [path, this.restoredFrom.get(path), this.recordReads?.restoredPath(ref.harness, ref.nativeId, path)]
      this.restoredFrom.delete(path)
      for (const at of new Set(read)) if (at) await Promise.all([this.memoryViews.remove(at), this.views?.remove(at)])
    }
    this.recordRows = null
    this.orderedRefs = null
  }

  /**
   * Keeps a remote store in step with this one, as a cloud machine keeps its Thread's records at the gateway: each
   * capture is pushed as it lands, and what was captured before is pushed now. Another link replaces it; null stops.
   */
  syncRecords(link: RecordsLink | null): void {
    const held = this.recordLink
    if (link && held && this.recordPushes && !this.stopped && held.current.id === link.id && held.current.base === link.base) {
      // The same remote with a renewed credential: the pushes go on, and their next request carries it.
      held.current = link
      return
    }
    this.recordPushes?.stop()
    this.recordPushes = null
    this.recordLink = null
    const store = this.recordWriter
    if (!link || !store || this.stopped) return
    const log = (level: "info" | "warn", message: string, fields: Record<string, string | number>) => (level === "warn" ? console.warn : console.info)(`Session records: ${message}`, JSON.stringify(fields))
    const remote = { current: link }
    const pushes = new RecordPushes(store, recordsOverHttp({ id: link.id, base: link.base, authorization: () => remote.current.authorization }), log)
    this.recordPushes = pushes
    this.recordLink = remote
    void pushes.catchUp(store.sessions()).catch((error: Error) => log("warn", "catching up stopped", { error: error.message }))
  }

  /**
   * Where this device's reading copies go (its records in the account), and which Sessions it keeps copies of, the
   * most wanted first (`ReadingCopies`): what another device reads while this one is off. Null stops them.
   */
  syncCopies(link: RecordsLink | null): void {
    this.copies()?.link(link)
  }

  scopeCopies(scope: CopyScope): void {
    this.copies()?.scope(scope)
  }

  /** How keeping the copies has gone; null when they aren't kept. */
  copiesStatus(): ReturnType<ReadingCopies["status"]> {
    return this.readingCopies?.status() ?? null
  }

  /**
   * A page of the copy another device keeps of one of its Sessions, at that device's records in the account (`link`),
   * as of now: what a window reads while that device is off. Null when it keeps none, or this catalog writes nothing.
   */
  async copyPage(link: RecordsLink, harness: string, nativeId: string, before?: number, limit = 100): Promise<CopyPage | null> {
    return (await this.received()?.page(link, harness, nativeId, before, limit)) ?? null
  }

  /** One entry of such a copy, by ID. */
  async copyEntry(link: RecordsLink, harness: string, nativeId: string, id: string): Promise<Entry | null> {
    return (await this.received()?.entry(link, harness, nativeId, id)) ?? null
  }

  private received(): ReceivedCopies | null {
    if (this.receivedCopies || !this.recordsFolder || this.readOnly || this.stopped) return this.receivedCopies
    this.receivedCopies = new ReceivedCopies(join(this.recordsFolder, "copies", "received"))
    return this.receivedCopies
  }

  private copies(): ReadingCopies | null {
    if (this.readingCopies || !this.recordsFolder || this.readOnly || this.stopped) return this.readingCopies
    const log = (level: "info" | "warn", message: string, fields: Record<string, string | number>) => (level === "warn" ? console.warn : console.info)(`Reading copies: ${message}`, JSON.stringify(fields))
    this.readingCopies = new ReadingCopies(join(this.recordsFolder, "copies"), {
      view: (path) => this.served(path),
      stamp: (path) => this.stampOf(path),
      translator: () => (this.translator ??= translatorBuild()),
    }, log)
    return this.readingCopies
  }

  /** How keeping the remote in step has gone; null without a link. */
  recordsStatus(): PushStatus | null {
    return this.recordPushes?.status() ?? null
  }

  /**
   * Sends the sessions at `paths` to a remote store now and through to their newest, as a move hands them on: each
   * taken whole first (`hold`), so what goes is what the harness has written. A session the store can't take is
   * refused by name, and nothing of the others is undone: a remote holding more than a move needs is harmless.
   */
  async sendRecords(link: RecordsLink, paths: readonly string[]): Promise<SentRecords[]> {
    const store = this.recordWriter
    if (!store || this.readOnly) throw new Error("Mako keeps no records here to send.")
    const sync = new RecordSync(store, refusingLink(recordsOverHttp({ id: link.id, base: link.base, authorization: () => link.authorization })), { describesStore: (harness, key) => this.describesStore(harness, key) })
    // Side by side: captures take the store's turn one at a time, and the pushes overlap on the network.
    return settledAll(paths.map(async (path): Promise<SentRecords> => {
      const ref = this.byPath.get(path)?.ref ?? (await this.open(path, false))?.ref
      if (!ref) throw new Error(`No session is listed at ${path}.`)
      if (!(await this.hold(path))) throw new Error(`Mako couldn't take ${ref.harness}'s session ${ref.nativeId} into its records whole, so it can't be sent.`)
      const report = await sync.push(ref.harness, ref.nativeId)
      return { harness: ref.harness, nativeId: ref.nativeId, ...report, holdings: store.holdings(ref.harness, ref.nativeId) }
    }))
  }

  /**
   * Pulls sessions' records from a remote store into this one, writing nothing into their harnesses' stores: what a
   * move's machine takes while the Thread still runs on its device, so the hand-over's `receiveRecords` pulls only the
   * last seconds. Nothing reads them from here until a receive writes them.
   */
  async stageRecords(link: RecordsLink, sessions: readonly ReceivingSession[]): Promise<StagedRecords[]> {
    const store = this.recordWriter
    if (!store || this.readOnly) throw new Error("Mako keeps no records here to stage into.")
    const sync = new RecordSync(store, refusingLink(recordsOverHttp({ id: link.id, base: link.base, authorization: () => link.authorization })), { describesStore: (harness, key) => this.describesStore(harness, key) })
    // Side by side: each reads its chunks before it takes the store's turn (`RecordSync.pull`).
    return settledAll(sessions.map(async ({ harness, nativeId }): Promise<StagedRecords> => ({ harness, nativeId, ...await sync.pull(harness, nativeId) })))
  }

  /**
   * Takes sessions from a remote store and writes each into its harness's own store here, as a move's destination
   * does before the harness resumes it: the same session, in this home, at the paths the harness keeps it. `installed`
   * is each harness's version here, gating a restore as `restoreKept` does. A session the harness here already has is
   * left as it is (`present`).
   *
   * `holdings` is what the sender pushed, each unit at its head (`SentRecords.holdings`): nothing is written into the
   * harness's store until this store holds at least that, so a session that went up only in part never resumes as if
   * it were whole. Without it, the session must at least be here. Imported records are never this store's own
   * captures, so being here, not `captured`, is the question.
   */
  async receiveRecords(link: RecordsLink, sessions: readonly ReceivingSession[], installed: Readonly<Record<string, InstalledReading | null>> = {}): Promise<ReceivedRecords[]> {
    const store = this.recordWriter
    if (!store || this.readOnly || !this.harnessStores) throw new Error("Mako keeps no records here to receive into.")
    const sync = new RecordSync(store, refusingLink(recordsOverHttp({ id: link.id, base: link.base, authorization: () => link.authorization })), { describesStore: (harness, key) => this.describesStore(harness, key) })
    const received: ReceivedRecords[] = []
    // Sessions this store held nothing of: what a receive that writes nothing pulled of them goes again, so no row of
    // a session that runs elsewhere stays listed here.
    const fresh = sessions.filter(({ harness, nativeId }) => !Object.keys(store.holdings(harness, nativeId)).length)
    const pulls: Array<{ provider: SessionProvider; harness: string; nativeId: string; pulled: SyncReport }> = []
    try {
      for (const { harness } of sessions) if (!this.providers.some((each) => each.harness === harness)) throw new Error(`No harness here reads ${harness}'s sessions.`)
      // Pulled side by side (each reads its chunks before it takes the store's turn), then checked in order.
      const pulledAll = await settledAll(sessions.map(({ harness, nativeId }) => sync.pull(harness, nativeId)))
      for (const [at, { harness, nativeId, holdings: sent }] of sessions.entries()) {
        const pulled = pulledAll[at]!
        const provider = this.readerOf(store, harness, nativeId)
        if (!provider) throw new Error(`No harness here reads ${harness}'s sessions.`)
        const held = store.holdings(harness, nativeId)
        if (!Object.keys(held).length) throw new Error(`The cloud holds none of ${harness}'s session ${nativeId}.`)
        // A unit that describes the store (a schema, a migration list) is this store's own where the sender's differed: numbered apart.
        const short = Object.entries(sent ?? {}).filter(([key, head]) => (held[key] ?? -1) < head && !this.describesStore(harness, key))
        if (short.length) {
          const [key, head] = short[0]!
          throw new Error(`The cloud holds ${harness}'s session ${nativeId} only in part: ${key} at version ${held[key] ?? "none"} of ${head}${short.length > 1 ? `, and ${short.length - 1} more` : ""}.`)
        }
        pulls.push({ provider, harness, nativeId, pulled })
      }
      // All or nothing: every restore is asked first, writing nothing, so a refusal never leaves another of these sessions
      // in its harness's store here, where it could run while its Thread runs elsewhere.
      for (const each of pulls) {
        const dry = await store.restore({ harness: each.harness, nativeId: each.nativeId, home: this.recordsHome, ...ownRoots(each.provider, store.rootNames(each.harness, each.nativeId), this.streams), stores: this.harnessStores, dryRun: true, ...each.provider.fork && { fork: each.provider.fork }, ...installed[each.harness] !== undefined && { installed: installed[each.harness] } })
        const refusal: KeptRestore | undefined = dry.outdated
          ? { kind: "outdated", ...dry.outdated }
          : dry.fork
            ? { kind: "forked", nativeId: dry.fork.nativeId }
            : dry.diverged.length
              ? { kind: "refused", reason: `${each.provider.displayName} holds part of this session that Mako never saw (${dry.diverged[0]!.reason}), so nothing was restored.` }
              : undefined
        if (!refusal) continue
        await this.forgetFresh(store, fresh)
        const others = pulls.filter((other) => other !== each).map((other): ReceivedRecords => ({
          harness: other.harness, nativeId: other.nativeId, pulled: other.pulled,
          restored: { kind: "refused", reason: `Nothing was written here, since ${each.provider.displayName}'s session ${each.nativeId} couldn't be.` },
        }))
        return [{ harness: each.harness, nativeId: each.nativeId, pulled: each.pulled, restored: refusal }, ...others]
      }
    } catch (error) {
      await this.forgetFresh(store, fresh)
      throw error
    }
    for (const { provider, harness, nativeId, pulled } of pulls) {
      const started = performance.now()
      const report = await store.restore({ harness, nativeId, home: this.recordsHome, ...ownRoots(provider, store.rootNames(harness, nativeId), this.streams), stores: this.harnessStores, ...provider.fork && { fork: provider.fork }, ...installed[harness] !== undefined && { installed: installed[harness] } })
      if (report.written || report.fork?.written) provider.storeWritten?.()
      const restored: KeptRestore = report.outdated
        ? { kind: "outdated", ...report.outdated }
        : report.fork
          ? report.fork.written || !report.fork.diverged.length ? { kind: "forked", nativeId: report.fork.nativeId } : { kind: "refused", reason: `${provider.displayName} holds a copy of this session that went on elsewhere, and its fork couldn't be written.` }
          : report.diverged.length && !report.written
            ? { kind: "refused", reason: `${provider.displayName} holds part of this session that Mako never saw (${report.diverged[0]!.reason}), so nothing was restored.` }
            : report.written
              ? { kind: "restored", path: "", files: report.actions.filter((action) => action.action !== "skip").length, rows: report.rows.reduce((total, rows) => total + rows.insert + rows.replace + rows.delete, 0), ms: Math.round(performance.now() - started) }
              : { kind: "present", path: "" }
      received.push({ harness, nativeId, pulled, restored })
    }
    // Each harness lists what was written, and each restored session is named by the path it's listed at. Only the
    // harnesses written are read again: a whole scan of a Mac's thousand sessions held every way back for it.
    await this.rescanHarnesses(received.map((each) => each.harness))
    this.recordRows = null
    this.orderedRefs = null
    for (const each of received) {
      if (each.restored.kind !== "restored" && each.restored.kind !== "present") continue
      const listed = [...this.byPath.values()].find((entry) => entry.ref?.harness === each.harness && entry.ref.nativeId === each.nativeId)?.ref
      each.restored = listed
        ? { ...each.restored, path: listed.path }
        : { kind: "refused", reason: `Mako restored ${each.harness}'s session ${each.nativeId}, but the harness doesn't list it.` }
    }
    return received
  }

  async stop(): Promise<void> {
    this.recordPushes?.stop()
    this.readingCopies?.stop()
    this.receivedCopies?.close()
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
      this.backfill?.stop(),
      this.preparation,
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
    this.unread.close()
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
   * taken with it when it is. A stream file removed is no write: the prune
   * removes one the store holds whole and restamps its session itself, and
   * a capture heard on Linux's prompt watch while it ran kept a stamp of
   * the files half pruned, so the next pass took the session again.
   */
  private streamed(path: string): void {
    const owner = this.streams && streamOwner(this.streams, path)
    if (!owner || this.stopped || !existsSync(path)) return
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
    const target = followedTarget ?? writtenSession(provider, path)
    if (target === null) return
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

  /**
   * Whether a unit of a harness's records describes its store rather than any session: a database's schema, or a row
   * of a table the harness keeps as its store's own (`RecordFork.storeTable`: a migration list, OpenCode's project).
   * Keys are `<database>\tschema` and `<database>\trow\t<table>\t<key>`.
   */
  private describesStore(harness: string, key: string): boolean {
    const [name = "", role, table = ""] = key.split("\t")
    if (role === "schema") return true
    return role === "row" && this.providers.some((provider) => provider.harness === harness && provider.fork?.storeTable?.(name, table) === true)
  }

  /**
   * The reader of `harness` whose store a received session's records are from, by the names of the roots they were
   * captured under: a harness can have several readers (Devin CLI's `devin-cli` and Devin.app's `devin-app`), and only
   * the right one's fork rule knows its store's own tables. The harness's first reader when none names them.
   */
  private readerOf(store: RecordStore, harness: string, nativeId: string): SessionProvider | undefined {
    const readers = this.providers.filter((each) => each.harness === harness)
    const names = new Set(store.rootNames(harness, nativeId).map(baseRoot))
    return readers.find((each) => each.recordRoots?.().some((root) => names.has(root.name))) ?? readers[0]
  }

  /** Forgets what a receive that wrote nothing pulled of sessions this store held nothing of before; the remote still has them. */
  private async forgetFresh(store: RecordStore, fresh: readonly ReceivingSession[]): Promise<void> {
    for (const { harness, nativeId } of fresh) await store.forget(harness, nativeId).catch(() => undefined)
    if (fresh.length) {
      this.recordRows = null
      this.orderedRefs = null
    }
  }

  /** Each of `harnesses` discovered again, as a write to its store would have it, and no other. */
  private async rescanHarnesses(harnesses: readonly string[]): Promise<void> {
    await this.prepare()
    await Promise.all([...new Set(harnesses)].flatMap((harness) => this.providers.filter((provider) => provider.harness === harness)).map((provider) => this.rescanProvider(provider)))
  }

  private rescanProvider(provider: SessionProvider): Promise<void> {
    const key = provider
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

  /**
   * The child agents a session started, as its harness's reader links them,
   * and those only Mako's archive still keeps. Lists links and stamps; a
   * child's transcript is read only when its `path` is opened, through
   * `open`, `page` and `follow` like any session's. Once its harness deletes
   * the session, the same reader links them in its records read back
   * (`keptChildren`), at the paths they had.
   */
  async children(path: string): Promise<ChildTranscripts | null> {
    const provider = this.ownerOf(path)
    const kept = this.archive?.childrenOf(path) ?? []
    let ref = this.byPath.get(path)?.ref ?? this.keptRecordRows().get(path) ?? this.archive?.kept(path)
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
    const listed = (provider?.children ? (await this.keptChildren(provider, path)) ?? (await provider.children(path)) : null) ?? []
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

  /**
   * The children of a session its harness deleted, linked by its reader in
   * the session's records read back, at the paths they had: each opens from
   * the same records (`restored`). Null for a session its harness has, or
   * one the store doesn't hold. Children a capture from before captures
   * named them are kept now, so a link to one resolves from then on.
   */
  private async keptChildren(provider: SessionProvider, path: string): Promise<ChildTranscript[] | null> {
    const reads = this.recordReads
    const store = this.recordStore
    const session = store?.sessionAt(path)
    if (!reads || !store || !session || (await nativeFileOf(provider, path))) return null
    const restored = await reads.read({ ...session, path }).catch((error) => {
      console.warn("A session's children could not be read back from its records", path, error instanceof Error ? error.message : error)
      return null
    })
    const children = restored?.provider.children ? await restored.provider.children(restored.path) : null
    if (!restored || !children) return null
    const listed = children.map((child) => (child.path ? { ...child, path: reads.original(child.path, restored.home) } : child))
    const unlinked = listed.flatMap((child) => (child.path && !store.parentAt(child.path) ? [child.path] : []))
    if (unlinked.length && store.access === "write" && !this.readOnly)
      await store.keepChildPaths(session.harness, session.nativeId, unlinked).catch((error) => {
        console.warn("A kept session's children could not be linked to it", path, error instanceof Error ? error.message : error)
      })
    return listed
  }

  private forget(path: string): boolean {
    this.orderedRefs = null
    // A session its harness deleted is listed from the record store's row of it now.
    this.recordRows = null
    return this.byPath.delete(path)
  }

  private emit(event: CatalogEvent): void {
    if (this.stopped) return
    // `list` goes on serving a session its harness deleted, from the record
    // store or the archive's copy, so the event says the same: announced as
    // removed, the row vanished and a reload brought it back.
    // A session its harness only moved (Codex archiving a rollout) is listed at its new path: the old one is simply removed.
    const kept = event.type === "removed" ? this.keptRecordRows().get(event.path) ?? this.archive?.kept(event.path) : undefined
    if (kept && !this.listsIdentity(threadIdentity(kept))) event = { type: "updated", ref: this.workspaces.ref(kept) ?? kept }
    if (event.type === "added" || event.type === "updated") this.records?.wrote(event.ref)
    for (const listener of this.listeners) listener(event)
  }

  /** Whether a harness lists a session of this identity now, at any path. */
  private listsIdentity(identity: string): boolean {
    for (const entry of this.byPath.values()) if (entry.ref && threadIdentity(entry.ref) === identity) return true
    return false
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

/** The index at `file`, or one in memory where it can't be opened: unread counts are diagnostics, never a reason a catalog doesn't start. */
function openUnreadIndex(file: string | null, writer: string | undefined): UnreadIndex {
  try {
    return new UnreadIndex(file, { writer })
  } catch (error) {
    console.warn("Unread records kept in memory:", error instanceof Error ? error.message : error)
    return new UnreadIndex(null)
  }
}

/** A remote whose refusals of the link's credential say so (`RecordsLinkRefusedError`), for the caller to send again. */
function refusingLink(remote: RecordRemote): RecordRemote {
  const said = <Value>(work: Promise<Value>): Promise<Value> => work.catch((error: Error) => {
    throw error instanceof GatewayHttpError && error.status === 401 ? new RecordsLinkRefusedError(error.message) : error
  })
  return {
    id: remote.id,
    missing: (hashes) => said(remote.missing(hashes)),
    putChunks: (pack) => said(remote.putChunks(pack)),
    readChunks: (hashes) => said(remote.readChunks(hashes)),
    push: (bundle) => said(remote.push(bundle)),
    pushWith: (bundle, chunks) => said(remote.pushWith(bundle, chunks)),
    holdings: (harness, nativeId, after) => said(remote.holdings(harness, nativeId, after)),
    pull: (harness, nativeId, after) => said(remote.pull(harness, nativeId, after)),
    sessions: () => said(remote.sessions()),
  }
}

/**
 * Every promise's value, in order, once all have settled: the first failure is thrown only then, so nothing that
 * cleans up after a failure runs while another of them still writes.
 */
async function settledAll<Value>(work: ReadonlyArray<Promise<Value>>): Promise<Value[]> {
  const values: Value[] = []
  for (const each of await Promise.allSettled(work)) {
    if (each.status === "rejected") throw each.reason
    values.push(each.value)
  }
  return values
}
