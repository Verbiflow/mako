import { locate, type Git } from "@mako/git"
import type { ContentRef, MakoWrite, MakoWriting } from "@mako/protocol"
import type { ToolEffects } from "@mako/sessions/tool-effects"
import { createHash } from "node:crypto"
import { statSync } from "node:fs"
import { homedir, hostname } from "node:os"
import { join, sep } from "node:path"
import type { HostJobs } from "../base/host-jobs.js"
import type { MethodTable } from "../base/methods.js"
import { hostLog, hostWarn } from "../base/host-log.js"
import { workspaceWrites, type WorkspaceWrite } from "../base/workspace-writes.js"
import type { LiveBatch } from "../contracts/live-conversations.js"
import type { LostVersion, ThreadChangeSummary } from "../contracts/thread-changes.js"
import { projectRepositories } from "../git/index.js"
import { LiveActivity, reportedEffect } from "./live-activity.js"
import { within } from "./paths.js"
import { gitRepository, nodeFileSystem, watcherEvents, type SystemHistory, type TreeWatcher } from "./ports.js"
import { changes, hunks, partition, restorable, shares, storedView, type CheckoutHunk, type CheckoutShares, type JournalView, type Partition, type PartitionOptions, type Restorable, type ThreadChanges } from "./queries.js"
import { lostVersions, restoreVersion } from "./recovery.js"
import { threadTrees, type ThreadTree } from "./thread-tree.js"
import { LaptopTracker } from "./tracker.js"

export { JournalStore } from "./journal-store.js"
export { LaptopTracker, type TrackerOptions, type TrackerRepository } from "./tracker.js"
export { changes, classOf, hunks, partition, restorable, shares, side, storedView, unattributed, writerOf, type ChangeClass, type CheckoutHunk, type CheckoutShares, type FileVersion, type JournalView, type Partition, type PartitionFile, type PartitionOptions, type Restorable, type Share, type ThreadChanges, type UncertainChange, type WholeHunk } from "./queries.js"
export { threadTrees, type ThreadTree } from "./thread-tree.js"
export { LOST_LISTED, lostVersions, restoreVersion } from "./recovery.js"
export { contentRef } from "./content.js"
export { LiveActivity, reportedEffect } from "./live-activity.js"
export { gitRepository, nodeFileSystem, watcherEvents, type SystemHistory, type TreeWatcher } from "./ports.js"
export { attributionStatus, type AttributionStatus } from "./status.js"
import { attributionStatus, type AttributionStatus } from "./status.js"

/** A day of retention, the unit Settings will offer. */
const DAY_MS = 86_400_000
/** `changes` as counts, for "changes made" beside spend; the weak footprint is a count, never a list. */
export function changeSummary(found: ThreadChanges): ThreadChangeSummary {
  return {
    files: { created: found.files.created.length, changed: found.files.modified.length, deleted: found.files.deleted.length, renamed: found.files.renamed.length },
    lines: found.lines,
    commands: found.commands.length,
    outside: { named: new Set(found.outside.filter((entry) => entry.evidence === "strong").map((entry) => entry.path)).size, maybe: new Set(found.outside.filter((entry) => entry.evidence === "weak").map((entry) => entry.path)).size },
    maybe: found.maybe,
  }
}

/** What windows ask the journal: a Thread's changes made, versions lost from disk, and putting one back. */
export function declareAttributionMethods(methods: MethodTable, attribution: () => Attribution | undefined): void {
  methods.handle("mako:thread-changes", (thread: string): ThreadChangeSummary | null => attribution()?.threadChanges(thread) ?? null)
  methods.handle("mako:lost-versions", async (target: { thread: string } | { path: string }): Promise<LostVersion[]> => (await attribution()?.lost(target)) ?? [])
  methods.handle("mako:restore-version", (root: string, entry: number): Promise<{ path: string }> => {
    const journal = attribution()
    if (!journal) throw new Error("Mako's record of changes isn't open yet. Try again in a moment.")
    return journal.restore(root, entry)
  })
}

export interface AttributionDeps {
  dataRoot: string
  git: Git
  /** The host's tree watch, on its one watcher child. */
  watch: TreeWatcher
  /** The system's history, where it keeps one (FSEvents). */
  history?: SystemHistory
  /** HEAD moving in a Git folder outside the checkout (a linked worktree's). */
  watchGitDir?(folder: string, moved: () => void): { close(): void }
  jobs: HostJobs
  /** Folders whose churn is never a Thread's work: the harnesses' stores. Asked again as sessions appear. */
  stores(): readonly string[]
  /** The Thread a live conversation belongs to. */
  placement(conversationId: string): { thread: string; session: string } | undefined
  /** What the live conversations know of one: its folder, harness and the harness's own record. */
  session(conversationId: string): { cwd?: string; harness?: string; record?: string } | undefined
  /**
   * The folders of every other session on this Mac, of any harness, whose
   * record moved since `since` (epoch ms), with whose they are; never one of
   * `thread`'s own. A turn's footprint leaves their churn out.
   */
  others?(thread: string, since: number): readonly { folder: string; why: string }[]
  /** Native ids of every other session on this Mac, lowercase, with whose they are; never `thread`'s own. */
  sessions?(thread: string): ReadonlyMap<string, string>
}

/** Who changed what in every checkout Threads work in: the journal, what feeds it, and what it answers. */
export interface Attribution {
  tracker: LaptopTracker
  /** A batch the live conversations sent: turns, tool calls and background work starting and ending. */
  live(batch: LiveBatch): void
  /** A finished call's reported effects, from the live engine. */
  effects(conversation: string, call: ToolEffects): void
  mako(write: MakoWrite): MakoWriting
  hunks(checkout: string): CheckoutHunk[]
  changes(thread: string): ThreadChanges
  partition(checkout: string, thread: string, options?: PartitionOptions): Partition
  /** How the checkout's changes divide by whose they are, for one Thread. */
  shares(checkout: string, thread: string): CheckoutShares
  /** Every change heard so far journaled. */
  settled(): Promise<void>
  /**
   * Track each repository of `checkout` if nothing has yet, so a move can
   * divide it; what it holds uncommitted then is journaled as before tracking.
   */
  track(checkout: string): Promise<void>
  /** The commit the journal measures a repository from; undefined when it isn't tracked. */
  head(repository: string): string | null | undefined
  /** A version the journal keeps. */
  blob(ref: ContentRef): Uint8Array | undefined
  /** The Thread's side of each repository of `checkout` as a Git tree, without touching the checkout. */
  threadTrees(checkout: string, thread: string): Promise<ThreadTree[]>
  restorable(target: { root: string; path: string } | { thread: string }): Restorable[]
  /** "Changes made" by a Thread, in counts. */
  threadChanges(thread: string): ThreadChangeSummary
  /** Versions the journal keeps that the disk no longer has: the last of each file a Thread wrote, or one file's. */
  lost(target: { thread: string } | { path: string }): Promise<LostVersion[]>
  /** Write a kept version back, keeping what the file holds now as a version too. The person asked, so it's theirs. */
  restore(root: string, entry: number): Promise<{ path: string }>
  status(): AttributionStatus
  close(): Promise<void>
}

/**
 * The folders the harnesses keep their sessions in, from where their
 * sessions are: the folder under the home folder each store file sits in
 * (`~/.<harness>`), so a new harness's store is known without a list.
 */
export function harnessStores(sessionFiles: readonly string[], home = homedir()): string[] {
  const folders = new Set<string>()
  for (const path of sessionFiles) {
    if (!within(home, path)) continue
    const [first, second, third] = path.slice(home.length + 1).split("/")
    if (!first || !second) continue
    // Under Library, the application's own folder (`Library/Application Support/<app>`).
    if (first === "Library" && second && third) folders.add(join(home, first, second, third))
    else if (first.startsWith(".")) folders.add(join(home, first))
  }
  return [...folders].sort()
}

/**
 * What harnesses keep outside the stores `harnessStores` finds from session
 * paths: Claude Code's settings beside `~/.claude`, and its temporary folder
 * for this user, where every session's command output goes.
 */
export function harnessScratch(home: string): string[] {
  const uid = process.getuid?.()
  return [join(home, ".claude.json"), ...(uid === undefined ? [] : [`/private/tmp/claude-${uid}`])]
}

/** What `sessionFolders` reads of a catalogued session. */
export interface CataloguedSession {
  harness: string
  nativeId: string
  path: string
  cwd?: string
  currentCwd?: string
  worktrees?: readonly { path: string }[]
  updatedAt?: string
  threadId?: string
}

/** A session that stopped moving this long before a turn began may still be running a long command. */
const OTHERS_SLACK_MS = 5 * 60_000

/**
 * The folders of every session on this Mac that moved since `since`, or
 * that another app reports running now, except `thread`'s own: where their
 * churn during a turn comes from. Read from the catalog, which already
 * lists every harness's sessions.
 */
export function sessionFolders(sessions: readonly CataloguedSession[], running: Readonly<Record<string, { status: string }>>, thread: string, since: number): { folder: string; why: string }[] {
  const out = new Map<string, string>()
  for (const session of sessions) {
    if (thread && session.threadId === thread) continue
    const moved = session.updatedAt ? Date.parse(session.updatedAt) : Number.NaN
    const active = running[session.path]?.status === "active"
    if (!active && !(moved >= since - OTHERS_SLACK_MS)) continue
    const why = `${session.harness} session ${session.nativeId.slice(0, 8)}${active ? ", running" : ""}`
    for (const folder of [session.cwd, session.currentCwd, ...(session.worktrees ?? []).map((worktree) => worktree.path)])
      if (folder && !out.has(folder)) out.set(folder, why)
  }
  return [...out].map(([folder, why]) => ({ folder, why }))
}

/**
 * Every catalogued session's native id but `thread`'s own, lowercase, with
 * whose it is: tools that keep something per session (a memory index, a
 * sync's anchors) file it under the session's id.
 */
export function sessionIds(sessions: readonly CataloguedSession[], thread: string): Map<string, string> {
  const ids = new Map<string, string>()
  for (const session of sessions) if (!(thread && session.threadId === thread)) ids.set(session.nativeId.toLowerCase(), `${session.harness} session ${session.nativeId.slice(0, 8)}`)
  return ids
}

/** A root's id: stable for its path, so a restarted host resumes the same root. */
export function rootId(path: string): string {
  return `r-${createHash("sha256").update(path).digest("hex").slice(0, 16)}`
}

export async function openAttribution(deps: AttributionDeps): Promise<Attribution> {
  const home = homedir()
  const tracker = await LaptopTracker.open(
    {
      fs: nodeFileSystem(),
      events: watcherEvents(deps.watch, deps.history),
      clock: { now: () => Date.now() },
      storage: join(deps.dataRoot, "attribution"),
      device: hostname(),
    },
    {
      repository: async (root) => ((await locate(deps.git, root).catch(() => null))?.root === root ? gitRepository(deps.git, root, deps.watchGitDir) : null),
      retentionMs: 14 * DAY_MS,
      budgetBytes: 2 * 1024 ** 3,
      footprint: { home, roots: [home, "/private/tmp"], stores: () => [...deps.stores(), ...harnessScratch(home), deps.dataRoot, join(home, ".mako")], others: deps.others, sessions: deps.sessions },
      log: (message, facts) => hostLog("attribution", message, facts),
    },
  )
  /** Each folder a turn ran in, and the checkout it's in once known. */
  const checkouts = new Map<string, string | null>()
  const resolving = new Map<string, Promise<void>>()
  const track = (cwd: string) => {
    if (checkouts.has(cwd) || resolving.has(cwd)) return
    if (cwd === home || cwd === sep) {
      checkouts.set(cwd, null)
      return
    }
    const done = (async () => {
      const found = await locate(deps.git, cwd).catch(() => null)
      const roots = found ? [found.root] : await projectRepositories(deps.git, cwd).then((result) => ("roots" in result ? result.roots : []), () => [])
      checkouts.set(cwd, found ? found.root : roots.length ? cwd : null)
      for (const root of roots) await tracker.track({ id: rootId(root), path: root, kind: "workspace" })
    })().catch((error: Error) => {
      hostWarn("attribution", "a checkout could not be tracked", { cwd, error: error.message })
    }).finally(() => resolving.delete(cwd))
    resolving.set(cwd, done)
  }
  const activity = new LiveActivity({
    tracker,
    placement: deps.placement,
    session: deps.session,
    checkout: (cwd) => checkouts.get(cwd) ?? undefined,
    working: track,
    now: () => Date.now(),
  })
  // Mako's own writes: Git commands it ran, files the person saved through it.
  const unwatch = workspaceWrites.subscribe((write: WorkspaceWrite) => {
    if (!write.paths.length) return
    tracker.makoWrote({ kind: write.kind, operation: write.operation.slice(0, 200), paths: write.paths.slice(0, 4096) }, write.startedAt, write.endedAt)
  })
  const view = (): JournalView => ({ store: tracker.store, roots: () => tracker.rootStates().values(), author: (seq) => tracker.authorOf(seq) })
  deps.jobs.every("collect attribution content", 60 * 60_000, () => {
    const dropped = tracker.collect()
    if (dropped.dropped) hostLog("attribution", "content collected", dropped)
  })
  return {
    tracker,
    live: (batch) => activity.observe(batch),
    effects(conversation, call) {
      const placed = deps.placement(conversation)
      if (!placed || !call.effects.length) return
      tracker.reported({
        thread: placed.thread,
        session: placed.session,
        call: call.callId,
        startedAt: call.startedAt,
        endedAt: call.endedAt,
        status: call.status,
        effects: call.effects.map(reportedEffect),
      })
    },
    mako: (write) => tracker.mako(write),
    hunks: (checkout) => hunks(view(), checkout),
    changes: (thread) => changes(view(), thread),
    partition: (checkout, thread, options) => partition(view(), checkout, thread, options),
    shares: (checkout, thread) => shares(view(), checkout, thread),
    settled: () => tracker.settled(),
    async track(checkout) {
      const found = await locate(deps.git, checkout).catch(() => null)
      const roots = found ? [found.root] : await projectRepositories(deps.git, checkout).then((result) => ("roots" in result ? result.roots : []), () => [])
      for (const root of roots) await tracker.track({ id: rootId(root), path: root, kind: "workspace" })
    },
    head: (repository) => [...tracker.rootStates().values()].find((state) => state.root.path === repository)?.root.head,
    blob: (ref) => tracker.store.blob(ref),
    threadTrees: async (checkout, thread) => {
      await tracker.settled()
      return threadTrees(deps.git, view(), partition(view(), checkout, thread))
    },
    restorable: (target) => restorable(view(), target),
    threadChanges: (thread) => changeSummary(changes(view(), thread)),
    lost: (target) => lostVersions(tracker, view(), target),
    async restore(rootId, seq) {
      const restored = await restoreVersion(tracker, rootId, seq)
      hostLog("attribution", "restored a version", { path: restored.path, entry: seq })
      return restored
    },
    status: () => attributionStatus(storedView(tracker.store), { recent: tracker.recent(), live: true }),
    async close() {
      unwatch()
      await tracker.close()
    },
  }
}

/** The journal's file under a host's data folder, for the debugging script. */
export function journalPath(dataRoot: string): string {
  return join(dataRoot, "attribution", "journal.sqlite")
}

/** Whether a journal exists under a host's data folder. */
export function hasJournal(dataRoot: string): boolean {
  try {
    return statSync(journalPath(dataRoot)).isFile()
  } catch {
    return false
  }
}

export { within }
