/**
 * The machine's sessions, whoever wrote them.
 *
 * This is the host's face of `@mako/sessions`: one catalog over every
 * provider's native store, scanned once, watched continuously, and pushed to
 * the renderer whenever anything anywhere writes a session. Open a conversation
 * in another provider's terminal and it appears in the rail mid-turn; that is
 * not an import feature, it is a file watcher.
 *
 * Continuation renders a provider-neutral transcript into a fresh session in
 * the same working directory. No provider can inherit another's private state;
 * it can inherit the conversation, and that is what this hands over.
 */
import { makoRuntimeReadings } from "@mako/sessions/record-observed"
import { contextFreeTitle, makoViews, threadIdentity, VIEWER_PAGE, type KeptRestore } from "@mako/sessions"
import { makoRecords } from "@mako/sessions/record-streams"
import { recordWritersAt } from "@mako/sessions/record-store"
import type { InstalledReading, SessionWriters } from "@mako/sessions/record-writers"
import type { ReceivedRecords, ReceivingSession, RecordsLink, SentRecords, StagedRecords } from "@mako/sessions/record-sync"
import type { CopyScope } from "@mako/sessions/reading-copies"
import { isReplyEntry } from "@mako/sessions/entries"
import { nativeSessionPath, type NativeSourceIdentity } from "./native-source.js"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import { MessageChannel, Worker } from "node:worker_threads"
import { connectOnDemandCatalog } from "./catalog-connection.js"
import {
  connectDaemon,
  connectDaemonPort,
  daemonMemoryUnsafe,
  ChildSidecars,
  defaultCatalog,
  buildTranscript,
  toolIdsOf,
  transcriptNote,
  writeTranscript,
  type BundledChildren,
  type ChildSource,
  type DaemonClient,
  type DaemonEvent,
  type DaemonStats,
  type ChildTranscripts,
  type EntryOriginal,
  type Entry,
  type SessionCatalog,
  type Thread,
  type ThreadPage,
  type ThreadPageOptions,
  type ThreadRef,
} from "@mako/sessions"
import type {
  CatalogWorkerData,
  CatalogWorkerMessage,
} from "./catalog-worker.js"
import { daemonIsForeign } from "./daemon-vintage.js"
import { headlessNodeExecutable } from "../base/headless-node.js"
import { hostLog, hostWarn } from "../base/host-log.js"
import type { HostJobs } from "../base/host-jobs.js"
import { threadFileWorkspace } from "../contracts/thread-file-workspace.js"
import type { WorktreeOrigins } from "./worktree-origins.js"
import type { Lineage } from "./lineage.js"
import { sessionMemoryPath, type SessionMemory } from "./session-memory.js"
import type { ThreadStore } from "./store.js"
import type { Actor, ThreadId } from "../contracts/thread-identity.js"
import {
  resolveAnchor,
  type MessageAnchor,
} from "../contracts/message-anchor.js"
import { tmpdir } from "node:os"
import { ProviderActivityEngine } from "./activity-engine.js"
import type { ProviderActivitySession, ThreadHarnesses } from "./harnesses.js"
import {
  type ActivityIndex,
  WRITE_ACTIVE_MS,
  deriveActivity,
  indexActivityRefs,
  sameActivity,
} from "./activity.js"
import {
  daemonLoginEnabled,
  daemonLoginOwner,
  daemonLoginProcess,
  daemonScript,
  refreshDaemonLoginJob,
  type DaemonApp,
  setDaemonLogin,
} from "./daemon-login.js"
import type { ExternalThreadActivity, HostEvent } from "../contracts/host-events-boot.js"
import type { FileContents } from "../contracts/git-workspace-search.js"
import type { ThreadFileContext } from "../contracts/conversation-session.js"
import { THREAD_LIST_CAP, threadList, unlistedThreadSessions } from "../contracts/thread-list.js"

const TEMPORARY_ROOTS = [
  tmpdir(),
  "/tmp",
  "/private/tmp",
  "/var/folders",
  "/private/var/folders",
]
const WORKSPACE_PRESENCE_TTL_MS = 60_000
const CATALOG_ACTOR: Actor = { kind: "service", name: "catalog" }

/** Refs other host callers look through; the rail's own list is `threadList`. */
const LIST_CAP = THREAD_LIST_CAP

/** Stop settles waiting reads even if a native scan has not returned yet. */
function catalogTask(
  signal: AbortSignal,
  work: () => Promise<void>
): Promise<void> {
  let abort = () => {}
  const stopped = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
  })
  const task = Promise.race([
    Promise.resolve().then(() => {
      signal.throwIfAborted()
      return work()
    }),
    stopped,
  ]).finally(() => signal.removeEventListener("abort", abort))
  // Startup is also observed by readers, but may fail before any reader exists.
  void task.catch(() => {})
  return task
}

/**
 * A worker that ran this long is replaced again when it dies. The in-process
 * catalog parses every session write on the host's own thread, which stalls
 * each RPC behind it, so it is only for a worker that keeps dying young.
 */
const CATALOG_WORKER_STEADY_MS = 10 * 60_000

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export type TranscriptArtifact = ThreadFileContext
const MAX_TRANSCRIPT_ARTIFACTS = 32

/** Content a page of a whole read carries, so the sync daemon, in its 128 MB heap, holds one page of a session at a time and never the session. */
const WHOLE_READ_PAGE = { maxChars: 4 * 1024 * 1024 } as const satisfies ThreadPageOptions
/** A session read a page at a time that moves this often while it's read is opened whole instead. */
const WHOLE_READ_ATTEMPTS = 3

/** What a page was read from: two pages with the same stamp are of one decode. */
function pageStamp(page: ThreadPage): string {
  return JSON.stringify([page.total, page.ref.bytes, page.ref.updatedAt, page.ref.revision, page.checkpoint, page.translator])
}

/**
 * The whole session from a reader in another process, a page at a time,
 * newest first. Every page must be of the decode the newest was; a session
 * that moves while it's read is read again.
 */
export async function pagedThread(reader: Pick<DaemonClient, "page" | "open">, path: string): Promise<Thread | null> {
  for (let attempt = 0; attempt < WHOLE_READ_ATTEMPTS; attempt++) {
    const newest = await reader.page(path, undefined, Number.MAX_SAFE_INTEGER, WHOLE_READ_PAGE)
    if (!newest) return null
    const stamp = pageStamp(newest)
    const pages = [newest.entries]
    let start = newest.start
    while (start > 0) {
      const page = await reader.page(path, start, Number.MAX_SAFE_INTEGER, WHOLE_READ_PAGE)
      if (!page || page.start >= start || pageStamp(page) !== stamp) break
      pages.push(page.entries)
      start = page.start
    }
    if (start > 0) continue
    const thread: Thread = { ref: newest.ref, entries: pages.reverse().flat() }
    if (newest.checkpoint !== undefined) thread.checkpoint = newest.checkpoint
    if (newest.unread) thread.unread = newest.unread
    return thread
  }
  return reader.open(path)
}

/** Where transcripts are written, each in a folder named for its digest. */
function transcriptsRoot(): string {
  return join(homedir(), ".mako", "transcripts")
}
/** Beside the transcripts; one links a child as `../children/…`. */
const CHILDREN_FOLDER = "children"

/** Where each Thread's environment keeps the files its conversations link to; Workspaces has them. */
export interface ThreadFileHomes {
  fileDataDir(owner: { cwd?: string; thread?: ThreadId }): Promise<string | undefined>
}

export interface ThreadCatalogDeps {
  /** Where this host keeps its catalog cache. */
  dataRoot: string
  /**
   * Where every profile's data root sits (`appData`) and what the app's
   * are named: the worker's backfill reads every reader's stores before it
   * sweeps Mako's attachment files (`attachmentReaders`).
   */
  profiles?: { appData: string; app: string }
  /** The app whose sync daemon serves the catalog, which only an installed one registers at login. */
  app: DaemonApp
  /** The per-user ledger every served ref is read through. */
  sessionMemory: SessionMemory | null
  /** The per-user Thread store every served ref is placed through. */
  threadStore: ThreadStore | null
  /** Where each worktree came from, so a ref names the worktrees it ran in. */
  worktreeOrigins: Pick<WorktreeOrigins, "of">
  /** Where continuations Mako wrote came from, loaded before the first catalog. */
  lineage: Pick<Lineage, "load" | "annotate">
  harnesses: ThreadHarnesses
  /** A file in a workspace, as the conversation that linked it sees it; Workspaces reads it. */
  readFile(cwd: string, path: string, dataDir?: () => Promise<string | undefined>): Promise<FileContents>
  /** Which catalog readers this host can share: the reader code it loaded as it opened, and the archive they write. */
  catalogIdentity(): Promise<string>
  jobs: HostJobs
  /** A fixture desk's catalog writes neither the archive nor any harness's store. */
  readOnly: boolean
  /** How this build stamps a store format it sets (`storeWriter`), handed to the catalog's worker or reader. */
  writer?: string
  emit(event: HostEvent): void
}

/** The catalog's service: built at composition, reading from `start` until `stop`. */
export interface ThreadCatalog {
  /**
   * Prefer the daemon; run locally only when it cannot exist.
   *
   * The daemon owns the watchers and the always-warm cache, so the app's
   * "scan" becomes one socket round-trip — and sync keeps happening while no
   * window is open, which is the entire point of having one. On macOS the
   * LaunchAgent owns startup; other platforms use one detached fallback.
   */
  start(): void
  stop(): void
  /** Whether the serving reader has a complete initial catalog for the rail. */
  ready(): boolean
  /** Sessions another app is running now, by path. */
  activity(): Record<string, ExternalThreadActivity>
  /** For the settings surface: is the daemon doing the work, and since when. */
  daemonStatus(): Promise<DaemonStats | null>
  list(filter?: { cwd?: string; harness?: string }): ThreadRef[]
  /**
   * The window's rail list, by the same rule the window applies to every push.
   * The cap is cut before rows are placed, so the rows past it that share a
   * Thread with a listed row are found here: placements are cached, and only
   * the rows found are annotated.
   */
  rail(filter?: { cwd?: string; harness?: string }): ThreadRef[]
  /** A catalogued row by path, past the list's cap. */
  ref(path: string): ThreadRef | undefined
  /** The session's ref as reading it now gives it, without moving its entries here. */
  readRef(path: string): Promise<ThreadRef | null>
  /** Recovery must not depend on the sidebar's ordering or visible result cap. */
  nativePath(identity: NativeSourceIdentity): string | undefined
  /**
   * Read a file for a catalogued thread's viewer. Relative paths resolve
   * against the thread's workspace; absolute ones open as they are, so a file
   * the agent wrote outside the project and linked from its answer opens too.
   */
  readFile(threadPath: string, filePath: string, homes?: ThreadFileHomes): Promise<FileContents>
  page(path: string, before?: number, limit?: number, options?: ThreadPageOptions): Promise<ThreadPage | null>
  /**
   * Takes the session at `path` into the record store now. True once the
   * store holds its records, so its history can be read back from them
   * whatever its harness does with its own.
   */
  hold(path: string): Promise<boolean>
  /**
   * Puts a session its harness deleted back into the harness's own store
   * from Mako's records (`SessionCatalog.restoreKept`), so the harness can
   * resume it as the same session, unless the harness `installed` here is
   * older than the newest version that wrote them (`restoreGate`).
   */
  restoreKept(path: string, installed?: InstalledReading | null): Promise<KeptRestore>
  /**
   * On a cloud machine: the record store kept in step with its Thread's records at the gateway, each capture pushed
   * as it lands (`SessionCatalog.syncRecords`); null stops. Kept across a restart of the catalog's reader.
   */
  syncRecords(link: RecordsLink | null): Promise<void>
  /**
   * On a device: its reading copies of the Sessions its account lists, kept in step in its records in the account
   * (`SessionCatalog.syncCopies`, `scopeCopies`), the most wanted first. Kept across a restart of the catalog's reader.
   */
  syncCopies(link: RecordsLink | null): Promise<void>
  scopeCopies(scope: CopyScope): Promise<void>
  /** Sends the sessions at `paths` to a remote store now and through to their newest, as a move hands them on (`SessionCatalog.sendRecords`). */
  sendRecords(link: RecordsLink, paths: string[]): Promise<SentRecords[]>
  /** Takes sessions from a remote store into their harnesses' own stores here, as a move's destination does (`SessionCatalog.receiveRecords`). */
  receiveRecords(link: RecordsLink, sessions: ReceivingSession[], installed: Record<string, InstalledReading | null>): Promise<ReceivedRecords[]>
  /** Pulls sessions' records into the record store ahead of a move, writing nothing into the harnesses' stores (`SessionCatalog.stageRecords`). */
  stageRecords(link: RecordsLink, sessions: ReceivingSession[]): Promise<StagedRecords[]>
  /** Every harness version that wrote the session at `path`, as the record store keeps them, read without writing; null when it holds none. */
  recordWriters(path: string): SessionWriters | null
  /** A page for the viewer; a tool row fetches its whole output (`block`) when it opens. */
  viewPage(path: string, before?: number, limit?: number): Promise<ThreadPage | null>
  /**
   * The newest exchanges of a large record read from its tail, shaped like a
   * viewer page; the full page replaces it. Null when there is nothing to gain
   * over the full page.
   */
  viewPreview(path: string): Promise<ThreadPage | null>
  /** One entry of the session, whole, by its id: what a page left out of it. */
  entry(path: string, id: string): Promise<Entry | null>
  /** The bytes one entry of the session was read from, by its id: the harness's record, or the record store's copy. */
  original(path: string, id: string): Promise<EntryOriginal | null>
  /**
   * The child agents a session started, each with its link to the call that
   * started it, where its transcript is and how much of it is on this Mac.
   * No child's transcript is read: one opens through `viewPage` by its path.
   */
  children(path: string): Promise<ChildTranscripts | null>
  /**
   * Sessions' children and their transcripts for a bundle to carry: listed as
   * `children` lists them, opened without taking the viewer's follow.
   */
  childSource: ChildSource
  /**
   * Live entries for one child agent's transcript, beside the viewer's own
   * follow: they go out as `thread-entries` under the child's path. One at a
   * time; another call replaces it.
   */
  followChild(path: string, fromByte: number): void
  unfollowChild(): void
  open(path: string): Promise<Thread | null>
  /**
   * Live entries for the thread open in the viewer.
   *
   * One follow at a time: the viewer shows one conversation, and a second
   * follow request supersedes the first. Entries appended to the native file —
   * by whatever app is writing it — stream to the renderer as they land.
   */
  follow(path: string, fromByte: number): void
  unfollow(): void
  /**
   * A thread, or the part of it up to one answer, written down as a
   * transcript (`buildTranscript`) under `~/.mako/transcripts/<digest>/`,
   * with the note that hands it over. `upto` names the answer by the
   * provider's own message identity (`MessageAnchor`), so a store that moved
   * since the transcript was read still forks at that answer rather than at
   * whatever now sits at its old index; an anchor carrying only an index is
   * that position, accepted while an answer still sits there.
   */
  transcriptArtifact(path: string, upto?: MessageAnchor): Promise<TranscriptArtifact | null>
  /** Every harness whose store we can write, behind one door. */
  /**
   * The access mode the next session of a catalogued thread should start in.
   * A choice made while viewing a thread that is not live belongs to the
   * thread, not only to the provider, and to every host that serves it; the
   * refreshed ref is announced so the composer reads it back at once.
   */
  rememberMode(path: string, modeId: string): ThreadRef | null
  /** Every event the catalog sends, for a service that follows it. */
  subscribe(subscriber: (event: HostEvent) => void): () => void
}

export function threadCatalog(deps: ThreadCatalogDeps): ThreadCatalog {
  const { app, sessionMemory, threadStore, worktreeOrigins, lineage, harnesses, catalogIdentity, jobs, readOnly: catalogReadOnly } = deps
  const workspacePresence = new Map<string, { at: number; missing: boolean }>()

  /**
   * A session that ran in a temporary directory which is gone (a test fixture,
   * a scratch run) is marked so the desk can keep it out of Recent. Only
   * temporary paths are stat-ed, and each answer is held for a minute.
   */
  function withWorkspacePresence(ref: ThreadRef): ThreadRef {
    const cwd = ref.cwd
    if (!cwd || !TEMPORARY_ROOTS.some((root) => cwd.startsWith(`${root}/`))) return ref
    const now = Date.now()
    let held = workspacePresence.get(cwd)
    if (!held || now - held.at > WORKSPACE_PRESENCE_TTL_MS) {
      held = { at: now, missing: !existsSync(cwd) }
      workspacePresence.set(cwd, held)
    }
    return held.missing ? { ...ref, workspaceMissing: true } : ref
  }

  function withWorktrees(ref: ThreadRef): ThreadRef {
    const folders = new Set([ref.cwd, ref.workspace, ref.currentCwd].filter((folder): folder is string => Boolean(folder)))
    if (!folders.size) return ref
    const found = new Map<string, { path: string; repoRoot: string }>()
    for (const folder of folders) {
      const linked = worktreeOrigins.of(folder)
      if (linked) found.set(linked.path, linked)
    }
    return found.size ? { ...ref, worktrees: [...found.values()] } : ref
  }
  let placementFailed = false

  /** Places refs in one pass: cached rows cost a map lookup, and misses share one transaction. */
  function withThreadPlacements(refs: readonly ThreadRef[]): ThreadRef[] {
    if (!threadStore || !refs.length) return [...refs]
    try {
      const placed = threadStore.placeMany(refs, CATALOG_ACTOR)
      return refs.map((ref) => {
        const found = placed.get(ref.path)
        return found ? { ...ref, threadId: found.thread, sessionId: found.session } : ref
      })
    } catch (error) {
      if (!placementFailed)
        hostWarn("threads", "Thread store placement failed; refs are served without Thread IDs", {
          error: error instanceof Error ? error.message : String(error),
        })
      placementFailed = true
      return [...refs]
    }
  }

  /**
   * Every catalogued native session gets its Session and Thread when the first
   * full catalog is in, not only the rows the rail shows.
   */
  function placeCatalog(refs: readonly ThreadRef[]): void {
    if (!threadStore) return
    const started = performance.now()
    try {
      threadStore.placeMany(refs, CATALOG_ACTOR)
      hostLog("threads", "catalog placed in Threads", { rows: refs.length, ms: Math.round(performance.now() - started) })
    } catch (error) {
      hostWarn("threads", "catalog placement failed", { error: error instanceof Error ? error.message : String(error) })
    }
  }

  function annotated(ref: ThreadRef): ThreadRef {
    const known = sessionMemory ? sessionMemory.annotate(ref) : ref
    // A title a harness took from the first prompt carries Mako's context
    // markers; every surface reads the person's words instead.
    const title = contextFreeTitle(known.title)
    const titled = title === known.title ? known : withTitle(known, title)
    return withWorktrees(withWorkspacePresence(lineage.annotate(titled)))
  }

  function annotate(ref: ThreadRef): ThreadRef {
    return withThreadPlacements([annotated(ref)])[0] ?? ref
  }

  function annotateAll(refs: readonly ThreadRef[]): ThreadRef[] {
    return withThreadPlacements(refs.map(annotated))
  }

  function rememberThreadMode(path: string, modeId: string): ThreadRef | null {
    const ref = daemon
      ? mirror.get(path)
      : catalog?.list().find((candidate) => candidate.path === path)
    if (!ref) return null
    sessionMemory?.remember(ref.harness, ref.nativeId, { modeId })
    const refreshed = annotate(ref)
    emit({ type: "thread-ref", ref: refreshed })
    return refreshed
  }

  let catalog: SessionCatalog | null = null
  let daemon: DaemonClient | null = null
  /** The serving reader whose initial discovery has also completed. */
  let discoveredSource: SessionCatalog | DaemonClient | null = null
  /** Who serves `daemon`: the user's detached daemon or this host's own worker thread. */
  let daemonKind: "process" | "shared" | "worker" | null = null
  let catalogWorker: Worker | null = null
  let stopMonitoring: (() => void) | null = null
  let activityEngine: ProviderActivityEngine | null = null
  const providerActivity = new Map<string, ProviderActivitySession[]>()
  let emittedActivity = new Map<string, ExternalThreadActivity>()
  /** Daemon mode's synchronous view: filled once, patched by events. */
  const mirror = new Map<string, ThreadRef>()
  let activityIndex: ActivityIndex | null = null

  function invalidateActivityRef(ref: ThreadRef): void {
    const old = activityIndex?.byPath.get(ref.path)
    if (!old || threadIdentity(old) !== threadIdentity(ref)) activityIndex = null
  }
  const threadEventSubscribers = new Set<(event: HostEvent) => void>()
  let recoveringDaemon: Promise<void> | null = null
  let catalogStartup: Promise<void> | null = null
  let catalogLifetime: AbortController | null = null
  /** Where records are kept in step, given again to whichever reader serves next. */
  let recordsLink: RecordsLink | null = null
  let copiesLink: RecordsLink | null = null
  let copyScope: CopyScope | null = null

  async function awaitCatalogReady(): Promise<{
    source: Pick<SessionCatalog, "page" | "open" | "entry" | "original" | "children" | "hold" | "restoreKept" | "syncRecords" | "syncCopies" | "scopeCopies" | "sendRecords" | "receiveRecords" | "stageRecords">
    signal: AbortSignal
  }> {
    const signal = catalogLifetime?.signal
    if (!signal) throw new Error("The session history reader has not started")
    signal.throwIfAborted()
    while (!daemon && !catalog) {
      const pending = recoveringDaemon ?? catalogStartup
      if (!pending) throw new Error("The session history reader is unavailable")
      await pending
      signal.throwIfAborted()
      if (
        !daemon &&
        !catalog &&
        pending === (recoveringDaemon ?? catalogStartup)
      ) {
        throw new Error("The session history reader is unavailable")
      }
    }
    const source = daemon ?? catalog
    if (!source) throw new Error("The session history reader is unavailable")
    return { source, signal }
  }

  function emit(event: HostEvent): void {
    if (event.type === "thread-ref") invalidateActivityRef(event.ref)
    if (event.type === "threads" || event.type === "thread-removed") activityIndex = null
    deps.emit(event)
    for (const subscriber of threadEventSubscribers) subscriber(event)
  }

  function subscribeThreadEvents(
    subscriber: (event: HostEvent) => void
  ): () => void {
    threadEventSubscribers.add(subscriber)
    return () => threadEventSubscribers.delete(subscriber)
  }
  let stopping = false

  function stopDaemonMonitor(): void {
    stopMonitoring?.()
    stopMonitoring = null
  }

  /** When each catalogued store last visibly moved (bytes or activity time). */
  const storeWrites = new Map<string, number>()
  let writeSettleTimer: ReturnType<typeof setTimeout> | null = null

  /** Each store's last seen size and activity time, so a title refinement is not a write. */
  const storeMarks = new Map<string, string>()

  function noteStoreWrite(ref: ThreadRef, previous: ThreadRef | undefined): void {
    const mark = `${ref.bytes ?? ""}:${ref.updatedAt ?? ""}`
    const before = previous ? `${previous.bytes ?? ""}:${previous.updatedAt ?? ""}` : storeMarks.get(ref.path)
    storeMarks.set(ref.path, mark)
    if (before === undefined) {
      // First sight (a host that just started, a store just discovered): the
      // provider's own activity stamp says whether it was written moments ago,
      // so a turn already streaming is not "open" until its next write.
      const stamped = ref.updatedAt ? Date.parse(ref.updatedAt) : Number.NaN
      if (Number.isFinite(stamped) && Date.now() - stamped < WRITE_ACTIVE_MS) storeWrites.set(ref.path, stamped)
      return
    }
    if (before !== mark) storeWrites.set(ref.path, Date.now())
  }

  function forgetStore(path: string): void {
    storeMarks.delete(path)
    storeWrites.delete(path)
  }

  /** Re-reconcile once the earliest write-derived activity can have settled. */
  function scheduleWriteSettle(earliestWriteAt: number): void {
    if (writeSettleTimer) return
    const delay = Math.max(50, earliestWriteAt + WRITE_ACTIVE_MS - Date.now() + 50)
    writeSettleTimer = setTimeout(() => {
      writeSettleTimer = null
      reconcileProviderActivity()
    }, delay)
  }

  /** Drops writes too old to matter and says when the earliest live one was. */
  function pruneWrites(now: number): number | null {
    let earliest: number | null = null
    for (const [path, at] of storeWrites) {
      if (now - at >= WRITE_ACTIVE_MS) storeWrites.delete(path)
      else if (earliest === null || at < earliest) earliest = at
    }
    return earliest
  }

  function reconcileProviderActivity(): void {
    if (!activityIndex)
      activityIndex = indexActivityRefs(daemon ? mirror.values() : (catalog?.list() ?? []))
    const now = Date.now()
    const earliestWrite = pruneWrites(now)
    const next = deriveActivity({
      index: activityIndex,
      probes: providerActivity,
      writes: storeWrites,
      heldElsewhere: (ref) => Boolean(sessionMemory?.heldBy(ref.harness, ref.nativeId)),
      previous: emittedActivity,
      now,
    })
    if (earliestWrite !== null) scheduleWriteSettle(earliestWrite)
    for (const path of new Set([...emittedActivity.keys(), ...next.keys()])) {
      const previous = emittedActivity.get(path)
      const activity = next.get(path)
      if (!sameActivity(previous, activity))
        emit({ type: "thread-activity", path, activity: activity ?? null })
    }
    emittedActivity = next
  }

  function monitorProviderProcesses(): void {
    if (activityEngine) return
    activityEngine = new ProviderActivityEngine(harnesses.processProbes())
    activityEngine.onChange((snapshot) => {
      providerActivity.set(snapshot.provider, snapshot.sessions)
      reconcileProviderActivity()
    })
    activityEngine.start()
  }

  function stopProcessMonitor(): void {
    activityEngine?.stop()
    activityEngine = null
    providerActivity.clear()
    emittedActivity = new Map()
    storeWrites.clear()
    storeMarks.clear()
    if (writeSettleTimer) clearTimeout(writeSettleTimer)
    writeSettleTimer = null
  }

  function start(): void {
    if (catalogLifetime) stop()
    catalogLifetime = new AbortController()
    const signal = catalogLifetime.signal
    stopping = false
    monitorProviderProcesses()
    catalogStartup = catalogTask(signal, async () => {
      await lineage.load()
      signal.throwIfAborted()
      // The installed app enables login capture by default; explicit opt-outs use only an on-demand reader.
      await refreshDaemonLoginJob(app)
      signal.throwIfAborted()
      if (!(await daemonLoginEnabled())) {
        await runLocalCatalog(signal)
        return
      }
      if (await connectViaDaemon(signal)) return
      if (!(await startDaemon(signal))) {
        await runLocalCatalog(signal)
        return
      }
      for (let attempt = 0; attempt < 100; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        if (await connectViaDaemon(signal)) return
      }
      await runLocalCatalog(signal)
    })
    void catalogStartup.catch((error) => {
      if (signal.aborted) return
      // A catalog that failed to build must say so — an empty rail with no
      // explanation reads as "the feature is broken", which it would be.
      emit({
        type: "notice",
        level: "error",
        message: `The thread catalog failed to start: ${error instanceof Error ? error.message : String(error)}`,
      })
    })
  }

  function applyDaemonEvent(event: DaemonEvent, announce: boolean): void {
    if (event.event === "added" || event.event === "updated") {
      invalidateActivityRef(event.ref)
      noteStoreWrite(event.ref, mirror.get(event.ref.path))
      mirror.set(event.ref.path, event.ref)
      if (announce) emit({ type: "thread-ref", ref: annotate(event.ref) })
      reconcileProviderActivity()
    } else if (event.event === "removed") {
      activityIndex = null
      mirror.delete(event.path)
      forgetStore(event.path)
      if (announce) emit({ type: "thread-removed", path: event.path })
      reconcileProviderActivity()
    } else if (event.event === "entries" && announce) {
      emit({
        type: "thread-entries",
        path: event.path,
        entries: event.entries,
        replace: event.replace,
        replaceFrom: event.replaceFrom,
      })
    } else if (event.event === "reload" && announce) {
      emit({ type: "thread-reader-reset", path: event.path })
    }
  }

  function monitorDaemon(client: DaemonClient): void {
    stopDaemonMonitor()
    let highMemorySamples = 0
    stopMonitoring = jobs.every("watch the sync daemon's memory", 5_000, async () => {
      if (daemon !== client || stopping) return
      const stats = await client.refresh().catch(() => undefined)
      if (!stats || daemon !== client) return
      highMemorySamples = daemonMemoryUnsafe(stats.rss ?? 0) ? highMemorySamples + 1 : 0
      if (highMemorySamples < 3) return
      emit({
        type: "notice",
        level: "error",
        message: "Session sync exceeded 512 MB and was restarted safely.",
      })
      stopDaemonMonitor()
      void client.retire().catch(() => {})
      client.close()
    })
  }

  async function connectViaDaemon(signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted()
    let client: DaemonClient | null = null
    try {
      client = await connectDaemon()
      signal.throwIfAborted()
      const identity = await catalogIdentity()
      signal.throwIfAborted()
      if (daemonIsForeign(client.stats, daemonScript(app), identity)) {
        // A checkout never evicts the daemon the user relies on; it watches
        // locally instead. The installed app replaces any vintage but its own.
        if (!daemonLoginOwner(app)) {
          client.close()
          return false
        }
        signal.throwIfAborted()
        const pid = client.stats.pid
        await Promise.race([
          client.retire().catch(() => {}),
          new Promise((resolve) => setTimeout(resolve, 150)),
        ])
        client.close()
        await new Promise((resolve) => setTimeout(resolve, 50))
        signal.throwIfAborted()
        if (pid !== process.pid && processIsAlive(pid)) {
          try {
            process.kill(pid, "SIGTERM")
          } catch {
            // It exited between the liveness check and the signal.
          }
        }
        for (
          let attempt = 0;
          attempt < 100 && processIsAlive(pid);
          attempt += 1
        ) {
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
        return false
      }
      const loginPid = await daemonLoginProcess()
      if (loginPid && loginPid !== client.stats.pid) {
        client.close()
        return false
      }
      const adopted = await adoptClient(client, "process", signal)
      if (!adopted) return false
      monitorDaemon(client)
      client.onClose(() => {
        // The daemon died underneath us; restart it before falling back locally.
        if (daemon !== client) return
        stopDaemonMonitor()
        daemon = null
        daemonKind = null
        if (!stopping) void recoverDaemon(signal)
      })
      return true
    } catch {
      client?.close()
      if (daemon === client) {
        daemon = null
        daemonKind = null
      }
      return false
    }
  }

  /**
   * Take a connected catalog server as the source of truth: mirror its list,
   * then patch the mirror from later events. The client publishes that snapshot
   * in wire order: earlier events are already included, later ones must win.
   */
  async function adoptClient(
    client: DaemonClient,
    kind: "process" | "shared" | "worker",
    signal: AbortSignal
  ): Promise<boolean> {
    if (signal.aborted || stopping) {
      client.close()
      return false
    }
    daemon = client
    daemonKind = kind
    refreshFollowForReader(client)
    if (copyScope) void client.scopeCopies(copyScope).catch((error: Error) => hostWarn("threads", "copies' scope not given to the catalog", { error: error.message }))
    if (copiesLink) void client.syncCopies(copiesLink).catch((error: Error) => hostWarn("threads", "copies' link not given to the catalog", { error: error.message }))
    if (recordsLink) void client.syncRecords(recordsLink).catch((error: Error) => hostWarn("threads", "records link not given to the catalog", { error: error.message }))
    const started = performance.now()
    let hydrated = false
    const stopEvents = client.onEvent((event) => {
      if (signal.aborted || daemon !== client) return
      // A known-path follow may already be live while the catalog list loads.
      if (event.event === "entries" || event.event === "reload") {
        applyDaemonEvent(event, true)
        return
      }
      if (!hydrated) return
      applyDaemonEvent(event, true)
    })
    client.onClose(stopEvents)
    void catalogTask(signal, async () => {
      await client.list({}, (refs) => {
        signal.throwIfAborted()
        if (daemon !== client) return
        mirror.clear()
        activityIndex = null
        for (const ref of refs) {
          noteStoreWrite(ref, undefined)
          mirror.set(ref.path, ref)
        }
        hydrated = true
        discoveredSource = client
        placeCatalog(refs)
        push()
        reconcileProviderActivity()
      })
      if (signal.aborted || daemon !== client) return
      hostLog("threads", "catalog discovery adopted", {
        sessions: mirror.size,
        discoveryMs: Math.round(performance.now() - started),
        kind,
      })
    }).catch((error) => {
      stopEvents()
      if (!signal.aborted && daemon === client)
        hostWarn("threads", "catalog discovery failed", {
          error: error instanceof Error ? error.message : String(error),
        })
      client.close()
    })
    return true
  }

  /**
   * Run the catalog on a worker thread of this host and adopt it like a
   * daemon. The renderer's RPCs keep answering while a store is being read;
   * the worker's heap is bounded on its own, and if it dies the catalog is
   * started once more before this host falls back to reading in-process.
   * The two threads speak over a `MessageChannel`, whose port delivers each
   * frame whole; a Unix socket handed the host a 7 MB thread as some nine
   * hundred 8 KiB reads, and each read woke the Chromium-integrated loop.
   */
  async function runCatalogWorker(signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted()
    if (catalog || daemon) return true
    const channel = new MessageChannel()
    const data: CatalogWorkerData = {
      port: channel.port2,
      cachePath: join(deps.dataRoot, "threads-catalog.json"),
      // Same archive the daemon reads: Mako's copies of sessions nothing else
      // holds, which this worker's backfill migrates onto the record store.
      archivePath: join(homedir(), ".mako", "archive"),
      recordsPath: makoRecords(),
      viewsPath: makoViews(),
      runtimeReadings: makoRuntimeReadings(),
      readOnly: catalogReadOnly,
      decodeExecutable: headlessNodeExecutable(),
      ...deps.writer && { writer: deps.writer },
      ...deps.profiles && { profiles: { ...deps.profiles, dataRoot: deps.dataRoot, sessionMemory: sessionMemoryPath(), home: homedir() } },
    }
    const compiled = new URL("./catalog-worker.js", import.meta.url)
    const worker = new Worker(compiled, {
      workerData: data,
      transferList: [channel.port2],
      resourceLimits: { maxOldGenerationSizeMb: 768 },
    })
    catalogWorker = worker
    // The worker's own log lines (the record store's backfill), kept with the host's.
    worker.on("message", (message: CatalogWorkerMessage) => {
      if (message.type === "log") hostLog("records", message.message, message.fields)
    })
    const listening = await new Promise<Exclude<CatalogWorkerMessage, { type: "log" }>>((resolve) => {
      const settle = (message: CatalogWorkerMessage) => {
        if (message.type === "log") return
        worker.off("message", settle)
        worker.off("error", failed)
        worker.off("exit", exited)
        resolve(message)
      }
      const failed = (error: Error) => settle({ type: "failed", message: error.message })
      const exited = (code: number) =>
        settle({
          type: "failed",
          message: `The catalog worker exited with code ${code}`,
        })
      worker.on("message", settle)
      worker.once("error", failed)
      worker.once("exit", exited)
    })
    if (signal.aborted) {
      await stopCatalogWorker(worker)
      channel.port1.close()
      signal.throwIfAborted()
    }
    if (listening.type === "failed") {
      hostWarn("threads", "catalog worker failed to start", {
        error: listening.message,
      })
      await stopCatalogWorker(worker)
      return false
    }
    hostLog("threads", "catalog worker listening", {
      sessions: listening.sessions,
      prepareMs: listening.prepareMs,
    })
    let client: DaemonClient
    try {
      client = await connectDaemonPort(channel.port1, 10_000)
    } catch (error) {
      hostWarn("threads", "catalog worker did not answer", {
        error: error instanceof Error ? error.message : String(error),
      })
      await stopCatalogWorker(worker)
      return false
    }
    if (!(await adoptClient(client, "worker", signal))) {
      await stopCatalogWorker(worker)
      return false
    }
    const startedAt = performance.now()
    const lost = (reason: string) => {
      if (daemon !== client && catalogWorker !== worker) return
      if (daemon === client) {
        daemon = null
        daemonKind = null
      }
      client.close()
      void stopCatalogWorker(worker)
      if (stopping) return
      const livedMs = Math.round(performance.now() - startedAt)
      hostWarn("threads", "catalog worker lost", { reason, livedMs })
      void recoverCatalogWorker(signal, livedMs)
    }
    // The port usually closes first, so these are the only record of why it died.
    worker.once("error", (error) => {
      if (!stopping) hostWarn("threads", "catalog worker error", { error: error.message })
      lost(error.message)
    })
    worker.once("exit", (code) => {
      if (!stopping) hostLog("threads", "catalog worker exited", { code })
      lost(`exit ${code}`)
    })
    client.onClose(() => lost("port closed"))
    return true
  }
  let catalogWorkerRestarts = 0

  function recoverCatalogWorker(signal: AbortSignal, livedMs: number): Promise<void> {
    if (livedMs >= CATALOG_WORKER_STEADY_MS) catalogWorkerRestarts = 0
    return recoverCatalog(signal, async () => {
      if (catalogWorkerRestarts < 1) {
        catalogWorkerRestarts += 1
        if (await runCatalogWorker(signal)) return
      }
      await runInProcessCatalog(signal)
    })
  }

  function recoverCatalog(
    signal: AbortSignal,
    work: () => Promise<void>
  ): Promise<void> {
    if (recoveringDaemon) return recoveringDaemon
    const task = catalogTask(signal, work).finally(() => {
      if (recoveringDaemon === task) recoveringDaemon = null
    })
    recoveringDaemon = task
    void task.catch((error) => {
      if (signal.aborted) return
      hostWarn("threads", "catalog recovery failed", {
        error: error instanceof Error ? error.message : String(error),
      })
    })
    return task
  }

  async function stopCatalogWorker(
    worker: Worker | null = catalogWorker
  ): Promise<void> {
    if (!worker) return
    if (catalogWorker === worker) catalogWorker = null
    await worker.terminate().catch(() => {})
  }

  function recoverDaemon(signal: AbortSignal): Promise<void> {
    return recoverCatalog(signal, async () => {
      if (!(await daemonLoginEnabled()) || !(await startDaemon(signal))) {
        await runLocalCatalog(signal)
        return
      }
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)))
        if (stopping) return
        if (await connectViaDaemon(signal)) {
          emit({
            type: "notice",
            level: "success",
            message: "Session sync recovered without interrupting your work.",
          })
          return
        }
      }
      await runLocalCatalog(signal)
      emit({
        type: "notice",
        level: "error",
        message:
          "Session sync could not restart. Mako is watching locally until the next launch.",
      })
    })
  }

  /** Installs the login job and returns whether this build is allowed to. */
  async function startDaemon(signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted()
    if (!daemonLoginOwner(app)) return false
    await setDaemonLogin(app, true)
    return true
  }

  /**
   * Watch from this host: on a worker thread, or in-process when the worker
   * cannot start. Either way the renderer sees one catalog.
   */
  async function runLocalCatalog(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (catalog || daemon) return
    try {
      // A reader this host started would capture into the archive on its behalf.
      const identity = await catalogIdentity()
      signal.throwIfAborted()
      const client = await connectOnDemandCatalog(signal, { script: daemonScript(app), identity, start: !catalogReadOnly, writer: deps.writer })
      if (client && await adoptClient(client, "shared", signal)) {
        hostLog("threads", "shared catalog connected", { pid: client.stats.pid })
        client.onClose(() => {
          if (daemon !== client) return
          daemon = null
          daemonKind = null
          if (!stopping) void recoverCatalog(signal, () => runLocalCatalog(signal))
        })
        return
      }
    } catch (error) {
      signal.throwIfAborted()
      hostWarn("threads", "shared catalog unavailable", {
        error: error instanceof Error ? error.message : String(error),
      })
    }
    if (await runCatalogWorker(signal)) return
    await runInProcessCatalog(signal)
  }

  async function runInProcessCatalog(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (catalog || daemon) return
    hostWarn("threads", "catalog running on the host thread")
    const source = defaultCatalog({
      cachePath: join(deps.dataRoot, "threads-catalog.json"),
      archivePath: join(homedir(), ".mako", "archive"),
      recordsPath: makoRecords(),
      viewsPath: makoViews(),
      runtimeReadings: makoRuntimeReadings(),
      readOnly: catalogReadOnly,
      decodeExecutable: headlessNodeExecutable(),
      ...deps.writer && { writer: deps.writer },
    })
    const stop = () => void source.stop()
    signal.addEventListener("abort", stop, { once: true })
    try {
      await source.prepare()
      signal.throwIfAborted()
      catalog = source
      refreshFollowForReader(source)
      if (recordsLink) source.syncRecords(recordsLink)
      if (copyScope) source.scopeCopies(copyScope)
      if (copiesLink) source.syncCopies(copiesLink)
      source.onEvent((event) => {
        if (signal.aborted || catalog !== source) return
        if (event.type === "removed") {
          forgetStore(event.path)
          emit({ type: "thread-removed", path: event.path })
        } else {
          noteStoreWrite(event.ref, undefined)
          emit({ type: "thread-ref", ref: annotate(event.ref) })
        }
        reconcileProviderActivity()
      })
      void catalogTask(signal, async () => {
        await source.scan()
        signal.throwIfAborted()
        if (catalog !== source) return
        discoveredSource = source
        for (const ref of source.list()) noteStoreWrite(ref, undefined)
        placeCatalog(source.list())
        push()
        reconcileProviderActivity()
        source.startWatching()
      }).catch((error) => {
        if (signal.aborted || catalog !== source) return
        emit({
          type: "notice",
          level: "error",
          message: `Session discovery failed: ${error instanceof Error ? error.message : String(error)}`,
        })
      })
    } catch (error) {
      if (catalog === source) catalog = null
      await source.stop()
      throw error
    } finally {
      signal.removeEventListener("abort", stop)
    }
  }

  function threadsReady(): boolean {
    return discoveredSource !== null && discoveredSource === (daemon ?? catalog)
  }

  function threadActivitySnapshot(): Record<
    string,
    ExternalThreadActivity
  > {
    return Object.fromEntries(emittedActivity)
  }

  async function daemonStatus(): Promise<DaemonStats | null> {
    // The worker is this host watching for itself, not the daemon that keeps
    // syncing while Mako is closed; Settings reports only the latter.
    const current = daemonKind === "process" ? daemon : null
    return current ? current.refresh().catch(() => current.stats) : null
  }

  function stop(): void {
    stopping = true
    catalogLifetime?.abort(new Error("The session history reader stopped"))
    catalogStartup = null
    recoveringDaemon = null
    discoveredSource = null
    catalogWorkerRestarts = 0
    unfollowThread()
    stopDaemonMonitor()
    stopProcessMonitor()
    catalog?.stop()
    catalog = null
    daemon?.close()
    daemon = null
    daemonKind = null
    void stopCatalogWorker()
    mirror.clear()
    activityIndex = null
    transcriptArtifacts.clear()
  }

  function catalogRefs(filter: { cwd?: string; harness?: string }): ThreadRef[] {
    return daemon
      ? [...mirror.values()]
          .filter(
            (ref) =>
              (!filter.cwd || ref.cwd === filter.cwd) &&
              (!filter.harness || ref.harness === filter.harness)
          )
          .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
      : (catalog?.list(filter) ?? [])
  }

  function listThreads(
    filter: { cwd?: string; harness?: string } = {}
  ): ThreadRef[] {
    return annotateAll(catalogRefs(filter).slice(0, LIST_CAP))
  }

  function railThreads(
    filter: { cwd?: string; harness?: string } = {}
  ): ThreadRef[] {
    const refs = catalogRefs(filter)
    const listed = annotateAll(threadList(refs))
    if (!threadStore || refs.length <= listed.length) return listed
    const missing = unlistedThreadSessions(listed, threadStore.groups())
    if (!missing.size) return listed
    const paths = new Set(listed.map((ref) => ref.path))
    const companions = withThreadPlacements(refs.filter((ref) => !paths.has(ref.path)))
      .filter((ref) => ref.sessionId !== undefined && missing.has(ref.sessionId))
    return [...listed, ...annotateAll(companions)]
  }

  function catalogRef(path: string): ThreadRef | undefined {
    return daemon
      ? mirror.get(path)
      : catalog?.list().find((ref) => ref.path === path)
  }

  function nativePathForSession(
    identity: NativeSourceIdentity
  ): string | undefined {
    return nativeSessionPath(
      identity,
      daemon ? [...mirror.values()] : (catalog?.list() ?? [])
    )
  }

  async function readThreadFile(
    threadPath: string,
    filePath: string,
    homes?: ThreadFileHomes
  ): Promise<FileContents> {
    const ref = daemon
      ? mirror.get(threadPath)
      : catalog?.list().find((candidate) => candidate.path === threadPath)
    const cwd = ref ? threadFileWorkspace(ref) : undefined
    if (!cwd && !isAbsolute(filePath) && !filePath.startsWith("~/"))
      throw new Error("This conversation has no recorded working folder. Open the file by its full path.")
    const dataDir = ref && homes ? () => homes.fileDataDir({
      cwd: ref.cwd ?? ref.workspace ?? cwd,
      thread: threadStore?.place(ref, CATALOG_ACTOR).thread,
    }) : undefined
    return deps.readFile(cwd ?? "/", filePath, dataDir)
  }

  async function pageThread(
    path: string,
    before?: number,
    limit?: number,
    options?: ThreadPageOptions
  ): Promise<ThreadPage | null> {
    const { source, signal } = await awaitCatalogReady()
    signal.throwIfAborted()
    const page = await source.page(path, before, limit, options)
    if (!page) return null
    // Unread records are counted where views are written (`@mako/sessions/unread-index`), not as a page is shown.
    const shown = { ...page, ref: annotate(page.ref) }
    delete shown.unread
    return shown
  }

  async function readThreadRef(path: string): Promise<ThreadRef | null> {
    return (await pageThread(path, undefined, 1))?.ref ?? null
  }

  function viewThreadPage(
    path: string,
    before?: number,
    limit?: number
  ): Promise<ThreadPage | null> {
    return pageThread(path, before, limit, VIEWER_PAGE)
  }

  function viewThreadPreview(path: string): Promise<ThreadPage | null> {
    return pageThread(path, undefined, undefined, { ...VIEWER_PAGE, preview: true })
  }

  async function threadEntry(path: string, id: string): Promise<Entry | null> {
    const { source, signal } = await awaitCatalogReady()
    signal.throwIfAborted()
    return source.entry(path, id)
  }

  async function threadOriginal(path: string, id: string): Promise<EntryOriginal | null> {
    const { source, signal } = await awaitCatalogReady()
    signal.throwIfAborted()
    return source.original(path, id)
  }

  async function syncRecords(link: RecordsLink | null): Promise<void> {
    recordsLink = link
    const { source, signal } = await awaitCatalogReady()
    signal.throwIfAborted()
    await source.syncRecords(link)
  }

  async function syncCopies(link: RecordsLink | null): Promise<void> {
    copiesLink = link
    const { source, signal } = await awaitCatalogReady()
    signal.throwIfAborted()
    await source.syncCopies(link)
  }

  async function scopeCopies(scope: CopyScope): Promise<void> {
    copyScope = scope
    const { source, signal } = await awaitCatalogReady()
    signal.throwIfAborted()
    await source.scopeCopies(scope)
  }

  async function sendRecords(link: RecordsLink, paths: string[]): Promise<SentRecords[]> {
    const { source, signal } = await awaitCatalogReady()
    signal.throwIfAborted()
    return source.sendRecords(link, paths)
  }

  async function receiveRecords(link: RecordsLink, sessions: ReceivingSession[], installed: Record<string, InstalledReading | null>): Promise<ReceivedRecords[]> {
    const { source, signal } = await awaitCatalogReady()
    signal.throwIfAborted()
    return source.receiveRecords(link, sessions, installed)
  }

  async function stageRecords(link: RecordsLink, sessions: ReceivingSession[]): Promise<StagedRecords[]> {
    const { source, signal } = await awaitCatalogReady()
    signal.throwIfAborted()
    return source.stageRecords(link, sessions)
  }

  async function restoreKept(path: string, installed?: InstalledReading | null): Promise<KeptRestore> {
    const { source, signal } = await awaitCatalogReady()
    signal.throwIfAborted()
    return source.restoreKept(path, installed)
  }

  function recordWriters(path: string): SessionWriters | null {
    try {
      return recordWritersAt(makoRecords(), path)?.writers ?? null
    } catch (error) {
      // A store being made or replaced, or a newer Mako's: nothing is known of its writers.
      hostWarn("records", "a session's writers could not be read", { path, error: error instanceof Error ? error.message : String(error) })
      return null
    }
  }

  async function holdThread(path: string): Promise<boolean> {
    const { source, signal } = await awaitCatalogReady()
    signal.throwIfAborted()
    return source.hold(path)
  }

  async function threadChildren(path: string): Promise<ChildTranscripts | null> {
    const { source, signal } = await awaitCatalogReady()
    signal.throwIfAborted()
    return source.children(path)
  }

  /** A child's transcript for a bundle: the viewer's follow stays on what it opened. */
  async function openChild(path: string): Promise<Thread | null> {
    const { source, signal } = await awaitCatalogReady()
    signal.throwIfAborted()
    return source === daemon ? pagedThread(source, path) : source.open(path, false)
  }

  const childSource: ChildSource = { children: threadChildren, open: openChild }
  const sidecars = new ChildSidecars(join(transcriptsRoot(), CHILDREN_FOLDER), (harness) => harnesses.label(harness))

  /**
   * The child agents `thread` carries, each rendered beside the bundles.
   * `whole` when `thread` is the session from its start to its end; a thread
   * cut at an answer carries only the children its calls started.
   */
  function bundledChildren(path: string, thread: Thread, whole: boolean, listed?: ChildTranscripts | null): Promise<BundledChildren> {
    const source = listed === undefined ? childSource : { ...childSource, children: (at: string) => (at === path ? Promise.resolve(listed) : threadChildren(at)) }
    return sidecars.bundle(source, [{ path, toolIds: toolIdsOf(thread.entries), whole }])
  }

  async function openThread(path: string): Promise<Thread | null> {
    const { source, signal } = await awaitCatalogReady()
    signal.throwIfAborted()
    const thread =
      source === daemon
        ? await openThreadViaDaemon(path)
        : await source.open(path)
    if (!thread) return null
    const shown = { ...thread, ref: annotate(thread.ref) }
    delete shown.unread
    return shown
  }

  async function openThreadViaDaemon(path: string): Promise<Thread | null> {
    const client = daemon
    if (!client) return openThreadDirect(path)
    // The worker is this host's own reader: racing it with a read on the host
    // thread would put the slow store back on the thread the worker exists
    // to protect.
    if (daemonKind === "worker") return pagedThread(client, path)
    let timer: ReturnType<typeof setTimeout> | undefined
    // A daemon that still answers is decoding a large session in its child:
    // reading it here too would decode it twice. One that doesn't is stuck.
    const fallback = new Promise<Thread | null>((resolve) => {
      timer = setTimeout(() => {
        const answered = client.refresh().then(() => true, () => false)
        const silent = new Promise<false>((settle) => {
          timer = setTimeout(() => settle(false), 500)
        })
        void Promise.race([answered, silent]).then((alive) => {
          if (!alive) void openThreadDirect(path).then(resolve, () => resolve(null))
        })
      }, 500)
    })
    try {
      return await Promise.race([
        pagedThread(client, path).catch(() => openThreadDirect(path)),
        fallback,
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async function openThreadDirect(path: string): Promise<Thread | null> {
    const direct = defaultCatalog({
      archivePath: join(homedir(), ".mako", "archive"),
      viewsPath: makoViews(),
      readOnly: catalogReadOnly,
      decodeExecutable: headlessNodeExecutable(),
    })
    try {
      return await direct.open(path, false)
    } finally {
      direct.stop()
    }
  }

  let unfollow: (() => void) | null = null
  /** The child transcript the Agents panel follows, on whichever reader serves it. */
  let childFollow: { path: string; reader: SessionCatalog | DaemonClient; stop: () => void } | null = null
  let followedReader: SessionCatalog | DaemonClient | null = null
  let followedPath: string | null = null

  function refreshFollowForReader(source: SessionCatalog | DaemonClient): void {
    if (childFollow && childFollow.reader !== source) {
      emit({ type: "thread-reader-reset", path: childFollow.path })
      childFollow = null
    }
    if (followedPath && followedReader && followedReader !== source)
      emit({ type: "thread-reader-reset", path: followedPath })
  }

  function followThread(path: string, fromByte: number): void {
    unfollow?.()
    followedPath = path
    followedReader = daemon ?? catalog
    if (!daemon && !catalog) {
      let cancelled = false
      unfollow = () => {
        cancelled = true
      }
      void awaitCatalogReady()
        .then(({ signal }) => {
          if (!cancelled && !signal.aborted) followThread(path, fromByte)
        })
        .catch((error) => {
          if (!cancelled)
            hostWarn("threads", "history follow unavailable", {
              error: error instanceof Error ? error.message : String(error),
            })
        })
      return
    }
    if (daemon) {
      const client = daemon
      void client.follow(path, fromByte).catch(() => {})
      unfollow = () => void client.unfollow(path).catch(() => {})
      return
    }
    unfollow =
      catalog?.follow(
        path,
        fromByte,
        (entries: Entry[], replaced: boolean, replaceFrom?: number) => {
          emit({
            type: "thread-entries",
            path,
            entries,
            replace: replaced,
            replaceFrom,
          })
        },
        () => emit({ type: "thread-reader-reset", path })
      ) ?? null
  }

  function followChild(path: string, fromByte: number): void {
    unfollowChild()
    const client = daemon
    if (client) {
      void client.follow(path, fromByte).catch(() => {})
      childFollow = { path, reader: client, stop: () => void client.unfollow(path).catch(() => {}) }
      return
    }
    if (!catalog) throw new Error("The session history reader has not started")
    const stop = catalog.follow(
      path,
      fromByte,
      (entries: Entry[], replace: boolean, replaceFrom?: number) => emit({ type: "thread-entries", path, entries, replace, replaceFrom }),
      () => emit({ type: "thread-reader-reset", path })
    )
    childFollow = { path, reader: catalog, stop }
  }

  function unfollowChild(): void {
    childFollow?.stop()
    childFollow = null
  }

  function unfollowThread(): void {
    unfollow?.()
    unfollow = null
    followedPath = null
    followedReader = null
  }

  const transcriptArtifacts = new Map<
    string,
    { version: string; artifact: TranscriptArtifact }
  >()

  function rememberTranscriptArtifact(
    key: string,
    value: { version: string; artifact: TranscriptArtifact }
  ) {
    transcriptArtifacts.delete(key)
    transcriptArtifacts.set(key, value)
    while (transcriptArtifacts.size > MAX_TRANSCRIPT_ARTIFACTS) {
      const oldest = transcriptArtifacts.keys().next().value
      if (!oldest) break
      transcriptArtifacts.delete(oldest)
    }
  }

  async function transcriptArtifactFor(
    path: string,
    upto?: MessageAnchor
  ): Promise<TranscriptArtifact | null> {
    const known = listThreads().find((ref) => ref.path === path)
    const point =
      upto === undefined ? "all" : (upto.id ?? upto.at ?? String(upto.index))
    const cacheKey = `${path}:${point}`
    // A child agent can go on writing after its session last did, so its stamp is part of the transcript's.
    const listed = await threadChildren(path).catch(() => null)
    const children = listed?.children.map((child) => `${child.nativeId}:${child.state.kind}:${child.updatedAt ?? ""}`).join("|") ?? ""
    const version = `${known?.bytes ?? "?"}:${known?.updatedAt ?? "?"}:${children}`
    // A path the list doesn't name (a child agent's transcript) has no stamp to tell a stale copy by.
    const cached = known ? transcriptArtifacts.get(cacheKey) : undefined
    if (cached?.version === version && existsSync(cached.artifact.file))
      return cached.artifact

    const opened = await openThread(path)
    if (!opened) return null
    let index: number | undefined
    if (upto) {
      index = resolveAnchor(opened.entries, 0, upto, isReplyEntry)
      if (index === undefined)
        throw new Error("The chosen answer is no longer in this conversation's history. Reload the thread and choose again.")
    }
    const thread =
      index !== undefined && index < opened.entries.length
        ? { ref: opened.ref, entries: opened.entries.slice(0, index + 1) }
        : opened
    const carried = await bundledChildren(path, thread, thread === opened, listed)
    const harness = harnesses.label(thread.ref.harness)
    const built = await buildTranscript({
      entries: thread.entries,
      harness,
      label: (id) => harnesses.label(id),
      ...thread.ref.title !== undefined && { title: thread.ref.title },
      ...thread.ref.cwd !== undefined && { cwd: thread.ref.cwd },
      children: carried.children,
    })
    const file = await writeTranscript(transcriptsRoot(), built)
    const artifact: TranscriptArtifact = {
      kind: "file",
      file,
      note: transcriptNote(file, built, harness),
      harness: thread.ref.harness,
      turns: built.turns,
      digest: built.digest,
      losses: built.losses,
      ...thread.ref.title !== undefined && { title: thread.ref.title },
    }
    rememberTranscriptArtifact(cacheKey, { version, artifact })
    return artifact
  }

  function push(): void {
    emit({ type: "threads", threads: railThreads() })
  }

  return {
    start,
    stop,
    ready: threadsReady,
    activity: threadActivitySnapshot,
    daemonStatus,
    list: listThreads,
    rail: railThreads,
    ref: catalogRef,
    readRef: readThreadRef,
    nativePath: nativePathForSession,
    readFile: readThreadFile,
    page: pageThread,
    hold: holdThread,
    restoreKept,
    syncRecords,
    syncCopies,
    scopeCopies,
    sendRecords,
    receiveRecords,
    stageRecords,
    recordWriters,
    viewPage: viewThreadPage,
    viewPreview: viewThreadPreview,
    entry: threadEntry,
    original: threadOriginal,
    children: threadChildren,
    childSource,
    followChild,
    unfollowChild,
    open: openThread,
    follow: followThread,
    unfollow: unfollowThread,
    transcriptArtifact: transcriptArtifactFor,
    rememberMode: rememberThreadMode,
    subscribe: subscribeThreadEvents,
  }
}

function withTitle(ref: ThreadRef, title: string | undefined): ThreadRef {
  const next = { ...ref }
  if (title === undefined) delete next.title
  else next.title = title
  return next
}
