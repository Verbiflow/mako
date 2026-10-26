import { locate, type Git } from "@mako/git"
import type { ContentRef, ExactBounds, MakoWrite, MakoWriting, PathMap, ThreadFileHistory } from "@mako/protocol"
import type { ChildSource } from "@mako/sessions"
import type { ToolEffects } from "@mako/sessions/tool-effects"
import { createHash, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, statSync } from "node:fs"
import { homedir, hostname, tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { acquireHostLock } from "../base/host-lock.js"
import type { HostJobs } from "../base/host-jobs.js"
import { onMac } from "../base/platform.js"
import type { MethodTable } from "../base/methods.js"
import { hostLog, hostWarn } from "../base/host-log.js"
import { workspaceWrites, type WorkspaceWrite } from "../base/workspace-writes.js"
import type { LiveBatch } from "../contracts/live-conversations.js"
import type { FileWriters } from "../contracts/workspace-snapshots.js"
import { writersSince } from "./writers-since.js"
import { HISTORY_SCRATCH } from "../contracts/watcher-child.js"
import type { ChangeUsage, LostVersion, ThreadChangeSummary } from "../contracts/thread-changes.js"
import type { TurnChangedFile, TurnChanges } from "../contracts/turn-changes.js"
import { JournalStore, type MoveRecord } from "./journal-store.js"
import { PlacedSessionSchema, SharedJournal, sharedJournalFolder, type JournalWrites, type OwnedJournal, type SharingStatus } from "./shared-journal.js"
import type { ChosenFile, FileReferenceSource, FileResolution, FileSpelling, FileSpellings, MovedPaths } from "../contracts/file-references.js"
import { spellingPath } from "../files/index.js"
import { MAX_SPELLINGS, ThreadFiles, type ReferenceSource } from "./thread-files.js"
import { carryHistory, threadHistory, type CarryResult } from "./thread-history.js"
import { projectRepositories } from "../git/index.js"
import { Backfill, type BackfillResult } from "./backfill.js"
import { ChildCalls } from "./child-calls.js"
import { LiveActivity, reportedEffect } from "./live-activity.js"
import { within } from "./paths.js"
import { gitRepository, nodeFileSystem, watcherEvents, type SystemHistory, type TreeWatcher } from "./ports.js"
import { changes, hunks, partition, restorable, shares, storedView, turnChanges, type CheckoutHunk, type CheckoutShares, type JournalView, type Partition, type PartitionOptions, type Restorable, type ThreadChanges } from "./queries.js"
import { lostVersions, restoreVersion } from "./recovery.js"
import { threadTrees, type ThreadTree } from "./thread-tree.js"
import { runningIn, turnOnlyPair, turnWriters, undoPlan, type ShownPair, type UndoPlan } from "./turn-lines.js"
import type { TurnUndoScope, WriterRun } from "../contracts/turn-review.js"
import { LaptopTracker, SETTLE_MS } from "./tracker.js"
import { TRAIL_MS } from "./evidence.js"

export { JournalStore } from "./journal-store.js"
export { LaptopTracker, type TrackerOptions, type TrackerRepository } from "./tracker.js"
export { changes, classOf, hunks, partition, restorable, shares, side, storedView, turnChanges, unattributed, writerOf, type ChangeClass, type CheckoutHunk, type CheckoutShares, type FileVersion, type JournalView, type Partition, type PartitionFile, type PartitionOptions, type Restorable, type Share, type ThreadChanges, type UncertainChange, type WholeHunk } from "./queries.js"
export { threadTrees, type ThreadTree } from "./thread-tree.js"
export { runningIn, turnOnlyPair, turnWriters, undoPlan, type Hand, type ShownPair, type UndoPlan, type UndoWrite } from "./turn-lines.js"
export { LOST_LISTED, lostVersions, restoreVersion } from "./recovery.js"
export { contentRef, decodeText, isText, STORE_LIMIT } from "./content.js"
export { diffLines, splitLines } from "./line-diff.js"
export { LiveActivity, reportedEffect } from "./live-activity.js"
export { gitRepository, nodeFileSystem, watcherEvents, type SystemHistory, type TreeWatcher } from "./ports.js"
export { attributionStatus, type AttributionStatus } from "./status.js"
export { carryHistory, threadHistory, type CarryResult } from "./thread-history.js"
import { attributionStatus, type AttributionStatus } from "./status.js"

/** How long after a change the journal may still give it another author: a turn is counted for good once this has passed since it ended. */
export const ATTRIBUTION_SETTLE_MS = SETTLE_MS

/** A day of retention, the unit Settings will offer. */
const DAY_MS = 86_400_000
/** `changes` as counts, for the debugging script; the weak footprint is a count, never a list. */
export function changeSummary(found: ThreadChanges): ThreadChangeSummary {
  return {
    files: { created: found.files.created.length, changed: found.files.modified.length, deleted: found.files.deleted.length, renamed: found.files.renamed.length },
    lines: found.lines,
    commands: found.commands.length,
    outside: outsideCounts(found),
    maybe: found.maybe,
  }
}

const outsideCounts = (found: Pick<ThreadChanges, "outside">) => ({
  named: new Set(found.outside.filter((entry) => entry.evidence === "strong").map((entry) => entry.path)).size,
  maybe: new Set(found.outside.filter((entry) => entry.evidence === "weak").map((entry) => entry.path)).size,
})

/**
 * "Changes made" by a Thread: the sum of its turns' summaries, the same
 * records each turn's line under its answer draws. Its own lines only, each
 * file once at what its turns did to it in all; files that might be its
 * are counted apart. Commands and paths outside its checkouts come from
 * its calls, as before.
 */
export function threadTotals(turns: readonly TurnChanges[], found: Pick<ThreadChanges, "commands" | "outside">): ThreadChangeSummary {
  const files = new Map<string, { first: TurnChangedFile["kind"]; last: TurnChangedFile["kind"] }>()
  const maybe = new Set<string>()
  const lines = { added: 0, removed: 0 }
  let unlisted = 0
  for (const turn of turns) {
    lines.added += turn.own.added
    lines.removed += turn.own.removed
    unlisted += turn.more
    for (const file of turn.files) {
      if (file.own === undefined) {
        maybe.add(file.path)
        continue
      }
      const seen = files.get(file.from ?? file.path)
      if (seen && file.from) files.delete(file.from)
      files.set(file.path, { first: seen?.first ?? file.kind, last: file.kind })
    }
  }
  const kinds = { created: 0, changed: 0, deleted: 0, renamed: 0 }
  for (const { first, last } of files.values()) {
    if (first === "create" && last === "delete") continue
    if (first === "create") kinds.created++
    else if (last === "delete") kinds.deleted++
    else if (first === "rename" || last === "rename") kinds.renamed++
    else kinds.changed++
  }
  kinds.changed += unlisted
  for (const path of files.keys()) maybe.delete(path)
  return { files: kinds, lines, commands: found.commands.length, outside: outsideCounts(found), maybe: maybe.size }
}

/** The journal kept this long: its retention, and the window "changes made" covers. */
const RETENTION_DAYS = 14

/** Every Thread's changes made since `since`, by project, with how surely each was known and how moves went. */
export function changeUsage(store: JournalStore, since: number): ChangeUsage {
  const paths = new Map(store.roots().map((root) => [root.id, root.path]))
  const { roots, threads } = store.changesSince(since)
  const projects = roots
    .flatMap(({ root, ...totals }) => {
      const path = paths.get(root)
      return path ? [{ path, ...totals }] : []
    })
    .sort((a, b) => b.added + b.removed - (a.added + a.removed) || b.files - a.files)
  const sum = (key: "files" | "added" | "removed") => projects.reduce((total, project) => total + project[key], 0)
  const mix = store.certaintyMix(since)
  const moves = store.moveTotals(since)
  const move = moves.get("move")
  return {
    days: RETENTION_DAYS,
    total: { files: sum("files"), added: sum("added"), removed: sum("removed"), threads },
    projects,
    certainty: { exact: mix.get("exact") ?? 0, named: mix.get("named") ?? 0, window: mix.get("window") ?? 0, ambiguous: mix.get("ambiguous") ?? 0, person: mix.get("person") ?? 0, mako: mix.get("mako") ?? 0 },
    moves: {
      moves: move?.count ?? 0,
      came: move?.files ?? 0,
      guessed: move?.guessed ?? 0,
      putBack: moves.get("put-back")?.files ?? 0,
      offered: move?.offered ?? 0,
      brought: moves.get("bring")?.files ?? 0,
    },
  }
}

/** What windows ask the journal: a Thread's changes made, every Thread's, versions lost from disk, and putting one back. */
export function declareAttributionMethods(methods: MethodTable, attribution: () => Attribution | undefined): void {
  methods.handle("mako:thread-changes", (thread: string): ThreadChangeSummary | null => attribution()?.threadChanges(thread) ?? null)
  methods.handle("mako:change-usage", (): ChangeUsage | null => attribution()?.changeUsage() ?? null)
  // Null while the journal isn't open: the window links as it did before, unchecked.
  methods.handle("mako:resolve-file-references", async (source: FileReferenceSource, spellings: FileSpellings): Promise<FileResolution[] | null> =>
    (await attribution()?.resolveFiles(source, spellings)) ?? null)
  methods.handle("mako:choose-file-reference", (source: FileReferenceSource, spelling: FileSpelling, path: ChosenFile): void => attribution()?.chooseFile(source, spelling, path))
  methods.handle("mako:lost-versions", async (target: { thread: string } | { path: string }): Promise<LostVersion[]> => (await attribution()?.lost(target)) ?? [])
  methods.handle("mako:restore-version", (root: string, entry: number): Promise<{ path: string }> => {
    const journal = attribution()
    if (!journal) throw new Error("Mako's record of changes isn't open yet. Try again in a moment.")
    return journal.restore(root, entry)
  })
}

export interface AttributionDeps {
  dataRoot: string
  /** What every host of this user shares (`HostEnvironment.userRoot`): the device's one journal is kept there. */
  userRoot: string
  /** The installed app's data root, whose own journal from before sharing a first shared journal can start from. */
  defaultDataRoot?: string
  /** This host as the others on the device name it: the app and its profile. */
  label: string
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
  /** The harnesses' records of a session's child agents, and opening one. */
  children?: ChildSource
  /**
   * Every catalogued session on this device, with this host's Thread for it:
   * whose records backfill reads, whose churn a turn's footprint leaves out.
   */
  catalogued?(): readonly CataloguedSession[]
  /** Sessions another app is running now, by record path (the catalog's activity). */
  running?(): Readonly<Record<string, { status: string }>>
}

/** A call's exact bounds, as a hook its harness ran around the tool reported them (the harnesses' `liveCallBounds`). */
export interface ReportedBounds {
  /** The live conversation's id. */
  conversation: string
  /** The tool call's id, as the conversation's tool updates name it. */
  call: string
  status: "completed" | "failed"
  exact: ExactBounds
}

/** Who changed what in every checkout Threads work in: the journal, what feeds it, and what it answers. */
export interface Attribution {
  /** A batch the live conversations sent: turns, tool calls and background work starting and ending. */
  live(batch: LiveBatch): void
  /** A finished call's reported effects, from the live engine. */
  effects(conversation: string, call: ToolEffects): void
  /** A call's exact bounds, from a hook its harness ran around the tool (`liveCallBounds`). */
  bounds(bounds: ReportedBounds): void
  /** Who changed each of these files (absolute) since `since`, for a rewind's preview. */
  rewindWriters(paths: readonly string[], since: number): FileWriters
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
  /**
   * Read back from the records of sessions that worked in `checkout` which
   * of its unsure uncommitted lines they wrote, within `budgetMs`; a move
   * asks first, so it takes what's the Thread's without asking the person.
   */
  readBack(checkout: string, budgetMs?: number): Promise<BackfillResult | undefined>
  /** "Changes made" by a Thread, in counts: the sum of its turns' summaries. */
  threadChanges(thread: string): ThreadChangeSummary
  /**
   * Count what a Thread's turn changed, from the journal as it stands
   * (`turnChanges`); `settling` while its entries may still be given
   * another author. Undefined while the journal isn't open.
   */
  countTurn(thread: string, turn: string, state: TurnChanges["state"]): TurnChanges | undefined
  /** Whether every change by `at` has its author for good, so a turn that ended then can be counted once and for all. */
  settledThrough(at: number): boolean
  /** Keep a turn's summary beside the entries, for "changes made" to sum. */
  counted(summary: TurnChanges, session: string): void
  /** The Thread's turns with entries after `after`, each with its newest: a summary counted through less is behind. */
  turnsChangedAfter(thread: string, after: number): Map<string, number>
  /**
   * Who wrote each changed line of a turn's diff of one of its record's
   * files (`turn-lines.ts`), on the journal's sides or on `shown`'s; undefined
   * when a version isn't kept or the file isn't text.
   */
  turnWriters(thread: string, turn: string, file: TurnChangedFile, shown?: ShownPair): WriterRun[] | undefined
  /** The turn's diff of one file with only its own lines changed. */
  turnOnly(thread: string, turn: string, file: TurnChangedFile): { before: string | null; after: string | null } | undefined
  /** How to take a turn's or the Thread's own lines back out of the files in `checkout`, as they are now. */
  undoPlan(thread: string, scope: TurnUndoScope, checkout: string): UndoPlan
  /** A turn or background work running in `checkout` on any host of this journal; undefined when none is. */
  running(checkout: string): { thread: string; kind: "turn" | "background" } | undefined
  /** "Changes made" by every Thread on this device over the journal's window, for Settings › Usage. */
  changeUsage(): ChangeUsage
  /** Which file each spelling in a message means, from its Thread's touches, folders, places and renames. */
  resolveFiles(source: FileReferenceSource, spellings: readonly string[]): Promise<FileResolution[]>
  /** The person picked `path` for `spelling` in the source's Thread: its answers link there from now on, on every host of this journal. */
  chooseFile(source: FileReferenceSource, spelling: string, path: string): void
  /**
   * The Thread's file history as this journal knows it, its own part and the
   * parts carried here, for a move to carry to the machine the Thread lands
   * on: that machine then resolves its answers' file names the same.
   */
  threadHistory(thread: string): ThreadFileHistory
  /** Take a Thread's file history carried from another journal, through the journal's owner. `map`: where its paths are here, where they differ. */
  carryThreadHistory(history: ThreadFileHistory, map?: PathMap): Promise<CarryResult>
  /** What a Thread's agent should hear when its checkout moves from the folder `from` to `to`: files it used that were renamed since or stayed behind. */
  movedPaths(thread: string, from: string, to: string): Promise<MovedPaths | undefined>
  /** A move, a "Put back" or a "Bring these", counted for `changeUsage`. */
  moved(move: Omit<MoveRecord, "at">): void
  /** Versions the journal keeps that the disk no longer has: the last of each file a Thread wrote, or one file's. */
  lost(target: { thread: string } | { path: string }): Promise<LostVersion[]>
  /** Write a kept version back, keeping what the file holds now as a version too. The person asked, so it's theirs. */
  restore(root: string, entry: number): Promise<{ path: string }>
  status(): AttributionStatus & { sharing: SharingStatus }
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

/** What `sessionFolders` and backfill read of a catalogued session. */
export interface CataloguedSession {
  harness: string
  nativeId: string
  path: string
  cwd?: string
  currentCwd?: string
  worktrees?: readonly { path: string }[]
  updatedAt?: string
  threadId?: string
  sessionId?: string
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
 * The folders of sessions another app is working in now (another Mako on
 * this device, a harness in a terminal), with whose they are. The home
 * folder and the root hold everything, so they name nothing.
 */
export function outsideFolders(sessions: readonly CataloguedSession[], running: Readonly<Record<string, { status: string }>>, home = homedir()): { folder: string; why: string }[] {
  const active = new Set(Object.entries(running).flatMap(([path, activity]) => (activity.status === "active" ? [path] : [])))
  if (!active.size) return []
  const out = new Map<string, string>()
  for (const session of sessions) {
    if (!active.has(session.path)) continue
    for (const folder of [session.cwd, session.currentCwd, ...(session.worktrees ?? []).map((worktree) => worktree.path)])
      if (folder && folder !== home && folder !== sep && !out.has(folder)) out.set(folder, `${session.harness} session ${session.nativeId.slice(0, 8)}, outside this Mako`)
  }
  return [...out].map(([folder, why]) => ({ folder, why }))
}

/** How long the folders of agents outside this host are reused: a burst of changes asks once. */
const OUTSIDERS_FRESH_MS = 2_000

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

/** The machine's temporary folders, as the watcher reports their paths: the user's `$TMPDIR` and the shared one. */
function temporaryFolders(): string[] {
  const own = (() => {
    try {
      return realpathSync(tmpdir())
    } catch {
      return tmpdir()
    }
  })()
  return [...new Set([own, onMac() ? "/private/tmp" : "/tmp"])]
}

/** A turn re-asks the owner to track its checkout at most this often: the owner may have let it go as idle. */
const RETRACK_MS = 10 * 60_000

/** A journal's file and its write-ahead log, newest change first. */
function lastWritten(path: string): number {
  let newest = 0
  for (const file of [path, `${path}-wal`]) {
    try {
      newest = Math.max(newest, statSync(file).mtimeMs)
    } catch {
      // Not there.
    }
  }
  return newest
}

/**
 * Start the device's shared journal from the newest journal this device
 * already keeps: another format's shared one, or a host's own from before
 * sharing. Copied as one consistent snapshot, so a Mako still writing its
 * own goes on undisturbed; the tracker then catches up from the history.
 * The copy takes a new journal id: an older Mako may go on appending to the
 * original, and two histories under one id would mislead any peer that asks
 * by number. It's renamed into place whole, so a crash leaves no half copy.
 */
function adoptJournal(folder: string, candidates: readonly string[]): void {
  const target = join(folder, "journal.sqlite")
  if (existsSync(target)) return
  const newest = candidates.filter((path) => path !== target && existsSync(path)).sort((a, b) => lastWritten(b) - lastWritten(a))[0]
  if (!newest) return
  const began = Date.now()
  const copying = `${target}.copying`
  try {
    mkdirSync(folder, { recursive: true })
    rmSync(copying, { force: true })
    const source = new DatabaseSync(newest, { readOnly: true })
    try {
      source.exec(`VACUUM INTO '${copying.replaceAll("'", "''")}'`)
    } finally {
      source.close()
    }
    const copy = new DatabaseSync(copying)
    try {
      copy.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('journal', ?)").run(randomUUID())
    } finally {
      copy.close()
    }
    renameSync(copying, target)
    hostLog("attribution", "the device's record of changes started from an existing one", { from: newest, ms: Date.now() - began })
  } catch (error) {
    rmSync(copying, { force: true })
    hostWarn("attribution", "an existing record of changes couldn't be copied; starting a new one", { from: newest, error: error instanceof Error ? error.message : String(error) })
  }
}

/** Journals in other formats' folders, each with its folder. */
function otherFormats(userRoot: string, folder: string): { folder: string; journal: string }[] {
  const parent = join(userRoot, "attribution")
  try {
    return readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^[0-9a-f]{16}$/.test(entry.name) && join(parent, entry.name) !== folder)
      .map((entry) => ({ folder: join(parent, entry.name), journal: join(parent, entry.name, "journal.sqlite") }))
  } catch {
    return []
  }
}

/**
 * Remove journals nothing has written for longer than retention: other
 * formats' shared ones nobody owns, and this host's own from before sharing.
 * A Mako still using one writes it, so it's never this old.
 */
async function sweepOldJournals(userRoot: string, folder: string, dataRoot: string, before: number): Promise<string[]> {
  const removed: string[] = []
  for (const other of otherFormats(userRoot, folder)) {
    if (lastWritten(other.journal) > before) continue
    const lock = await acquireHostLock(other.folder, { purpose: "owner" }).catch(() => undefined)
    if (lock?.kind !== "held") continue
    try {
      rmSync(other.folder, { recursive: true, force: true })
      removed.push(other.folder)
    } finally {
      await lock.release()
    }
  }
  const own = join(dataRoot, "attribution", "journal.sqlite")
  if (own !== join(folder, "journal.sqlite") && existsSync(own) && lastWritten(own) <= before) {
    for (const file of [own, `${own}-wal`, `${own}-shm`]) rmSync(file, { force: true })
    removed.push(own)
  }
  return removed
}

/** The tracker this host runs when it owns the journal or keeps its own. */
interface Local {
  tracker: LaptopTracker
  readBack(folder?: string, budgetMs?: number): Promise<BackfillResult | undefined>
}

/** The shared journal once it's open; what it calls while it opens reads it through this. */
interface Sharing {
  journal?: SharedJournal
}

const liveView = (tracker: LaptopTracker): JournalView => ({ store: tracker.store, roots: () => tracker.rootStates().values(), author: (seq) => tracker.authorOf(seq) })

export async function openAttribution(deps: AttributionDeps): Promise<Attribution> {
  const home = homedir()
  const temporary = temporaryFolders()
  const folder = sharedJournalFolder(deps.userRoot)
  const journalFile = join(folder, "journal.sqlite")
  const sharing: Sharing = {}
  let local: Local | undefined
  /** The journal another host owns, read from the file, and its view as of the last commit read. */
  let reader: { store: JournalStore; version: number; view?: JournalView } | undefined

  // This device's sessions as the journal reads them: the catalog, with the Threads followers run their sessions in.
  const catalogued = (): readonly CataloguedSession[] => {
    const own = deps.catalogued?.() ?? []
    const placed = new Map((sharing.journal?.followers() ?? []).flatMap((follower) => [...follower.placed]))
    if (!placed.size) return own
    return own.map((session) => {
      const thread = session.threadId ? undefined : placed.get(session.path)
      return thread ? { ...session, threadId: thread.thread, sessionId: thread.session } : session
    })
  }
  const running = () => deps.running?.() ?? {}
  const files = new ThreadFiles({ git: deps.git, home })
  /** A message's Thread and folders: a live conversation's from the live engine, a record's from the catalog. */
  const referenceSource = (source: FileReferenceSource): ReferenceSource => {
    if (source.liveId) {
      const live = deps.session(source.liveId)
      return { thread: deps.placement(source.liveId)?.thread, cwd: live?.cwd, current: live?.cwd ? [live.cwd] : [], asOf: source.asOf }
    }
    const session = source.threadPath ? catalogued().find((one) => one.path === source.threadPath) : undefined
    const current = [session?.currentCwd ?? session?.cwd, ...(session?.worktrees ?? []).map((worktree) => worktree.path)].filter((folder) => folder !== undefined)
    return { thread: session?.threadId, cwd: session?.cwd, current, asOf: source.asOf }
  }
  let outsiders: { at: number; folders: readonly { folder: string; why: string }[] } | undefined
  /** An agent no host of this journal runs, working where `path` is: a follower's own are heard, so they're never outsiders. */
  const outsider = (path: string, root: string) => {
    const now = Date.now()
    if (!outsiders || now - outsiders.at > OUTSIDERS_FRESH_MS) {
      const followed = new Set((sharing.journal?.followers() ?? []).flatMap((follower) => [...follower.live.keys()]))
      outsiders = { at: now, folders: outsideFolders(catalogued().filter((session) => !followed.has(session.path)), running()) }
    }
    return outsiders.folders.find(({ folder: working }) => within(working, path) || within(root, working))?.why
  }

  const openLocal = async (storage: string): Promise<OwnedJournal> => {
    // Only calls into the tracker once a Session's turn marks it, after the tracker opens.
    const children = deps.children && new ChildCalls({
      records: deps.children,
      reported: (call) => tracker.reported(call),
      reconcile: (calls) => tracker.reconcile(calls),
      hold: () => tracker.hold(),
      unsure: () => tracker.unsure(),
      now: () => Date.now(),
      log: (message, facts) => hostWarn("attribution", message, facts),
    })
    const tracker = await LaptopTracker.open(
      {
        fs: nodeFileSystem(),
        events: watcherEvents(deps.watch, deps.history),
        clock: { now: () => Date.now() },
        storage,
        device: hostname(),
      },
      {
        repository: async (root) => ((await locate(deps.git, root).catch(() => null))?.root === root ? gitRepository(deps.git, root, deps.watchGitDir) : null),
        retentionMs: RETENTION_DAYS * DAY_MS,
        budgetBytes: 2 * 1024 ** 3,
        footprint: {
          home,
          roots: [home, ...temporary],
          live: temporary,
          stores: () => [...deps.stores(), ...harnessScratch(home), deps.dataRoot, deps.userRoot, join(home, ".mako"), join(temporary[0]!, HISTORY_SCRATCH), ...(sharing.journal?.followers() ?? []).map((follower) => follower.host.dataRoot)],
          others: (thread, since) => sessionFolders(catalogued(), running(), thread, since),
          sessions: (thread) => sessionIds(catalogued(), thread),
        },
        uncertain: (sessions) => children?.uncertain(sessions),
        outsider: deps.running && outsider,
        log: (message, facts) => hostLog("attribution", message, facts),
      },
    )
    const backfill = deps.children && deps.catalogued && new Backfill({
      sessions: catalogued,
      records: deps.children,
      unsure: () => tracker.unsureFiles(),
      reconcile: (calls) => tracker.reconcile(calls),
      now: () => Date.now(),
      log: (message, facts) => hostLog("attribution", message, facts),
    })
    const readBack = async (where?: string, budgetMs?: number) => backfill?.run(where, budgetMs).catch((error: Error) => {
      hostWarn("attribution", "records could not be read back", { error: error.message })
      return undefined
    })
    /** Track a root; one tracked anew holds what was there before, which the sessions that worked there may have written. */
    const trackRoot = async (root: string) => {
      const known = tracker.rootStates().size
      await tracker.track({ id: rootId(root), path: root, kind: "workspace" })
      if (tracker.rootStates().size > known) void readBack(root)
    }
    const writing = new Map<string, { end(at?: number): void }>()
    const writes: JournalWrites = {
      activity(mark) {
        tracker.activity(mark)
        children?.marked(mark)
      },
      reported: (call) => tracker.reported(call),
      makoStart: (id, write, at) => {
        writing.set(id, tracker.mako(write, at))
      },
      makoEnd: (id, at) => {
        writing.get(id)?.end(at)
        writing.delete(id)
      },
      makoWrote: (write, startedAt, endedAt) => tracker.makoWrote(write, startedAt, endedAt),
      moved: (move) => tracker.store.saveMove(move),
      chose: (choice) => tracker.store.saveChoice(choice),
      counted: (summary, session) => tracker.store.saveTurnChanges(summary, session),
      async carry(history, map) {
        const result = carryHistory(tracker.store, history, map, Date.now())
        hostLog("attribution", "carried a Thread's file history in", { thread: result.thread, taken: result.taken.length, left: result.left.length, choices: result.choices })
        return result
      },
      // This host's own sessions are in its catalog; a follower's come through `followers()`.
      sessions: () => undefined,
      track: trackRoot,
      settled: () => tracker.settled(),
      readBack: async (where, budgetMs) => {
        await tracker.settled()
        return readBack(where, budgetMs)
      },
      lost: (target) => lostVersions(tracker, liveView(tracker), target),
      async restore(root, entry) {
        const restored = await restoreVersion(tracker, root, entry)
        hostLog("attribution", "restored a version", { path: restored.path, entry })
        return restored
      },
    }
    local = { tracker, readBack }
    // The file stays readable until the tracker has it, so a view never goes missing while the owner changes.
    reader?.store.close()
    reader = undefined
    return {
      writes,
      async close() {
        children?.close()
        if (local?.tracker === tracker) local = undefined
        await tracker.close()
      },
    }
  }

  const view = (): JournalView => {
    if (local) return liveView(local.tracker)
    if (!reader) throw new Error("Mako's record of changes isn't open yet. Try again in a moment.")
    const version = reader.store.dataVersion()
    if (!reader.view || version !== reader.version) {
      reader.view = storedView(reader.store)
      reader.version = version
    }
    return reader.view
  }

  sharing.journal = await SharedJournal.open({
    folder,
    host: { pid: process.pid, dataRoot: deps.dataRoot, label: deps.label },
    own: async () => {
      adoptJournal(folder, [
        ...otherFormats(deps.userRoot, folder).map((other) => other.journal),
        join(deps.dataRoot, "attribution", "journal.sqlite"),
        // The installed app's own, only for a host of this user's: an isolated one (its user root is its data root) never reads the person's.
        ...(deps.defaultDataRoot && resolve(deps.userRoot) !== resolve(deps.dataRoot) ? [join(deps.defaultDataRoot, "attribution", "journal.sqlite")] : []),
      ])
      return openLocal(folder)
    },
    follow: () => {
      reader?.store.close()
      reader = { store: JournalStore.open(journalFile, { device: hostname(), readOnly: true }), version: -1 }
    },
    alone: () => openLocal(join(deps.dataRoot, "attribution", "private")),
    log: (message, facts) => hostLog("attribution", message, facts),
  })
  const journal = sharing.journal

  // A follower tells the owner which of the device's sessions are its Threads', so their work is read as theirs.
  let toldSessions = ""
  const tellSessions = () => {
    if (journal.role().kind !== "follower") return
    const since = Date.now() - RETENTION_DAYS * DAY_MS
    const sessions = (deps.catalogued?.() ?? []).flatMap((session) => {
      const placed = session.threadId && session.sessionId && (!session.updatedAt || Date.parse(session.updatedAt) >= since)
        ? PlacedSessionSchema.safeParse({ path: session.path, thread: session.threadId, session: session.sessionId })
        : undefined
      return placed?.success ? [placed.data] : []
    })
    const told = JSON.stringify(sessions)
    if (told === toldSessions) return
    toldSessions = told
    journal.writes.sessions(sessions)
  }
  journal.onRole((role) => {
    if (role.kind === "follower") {
      toldSessions = ""
      tellSessions()
    }
  })
  tellSessions()

  /** Each folder a turn ran in, the checkout it's in once known, and its repositories. */
  const checkouts = new Map<string, string | null>()
  const repositories = new Map<string, readonly string[]>()
  const resolving = new Map<string, Promise<void>>()
  /** When each repository was last asked to be tracked. */
  const asked = new Map<string, number>()
  const ensure = (root: string) => {
    const now = Date.now()
    if (now - (asked.get(root) ?? 0) < RETRACK_MS) return
    asked.set(root, now)
    journal.writes.track(root).catch((error: Error) => {
      asked.delete(root)
      hostWarn("attribution", "a checkout could not be tracked", { root, error: error.message })
    })
  }
  const working = (cwd: string) => {
    if (cwd === home || cwd === sep) return
    const known = repositories.get(cwd)
    if (known) return known.forEach(ensure)
    if (resolving.has(cwd)) return
    const done = (async () => {
      const found = await locate(deps.git, cwd).catch(() => null)
      const roots = found ? [found.root] : await projectRepositories(deps.git, cwd).then((result) => ("roots" in result ? result.roots : []), () => [])
      checkouts.set(cwd, found ? found.root : roots.length ? cwd : null)
      repositories.set(cwd, roots)
      roots.forEach(ensure)
    })().catch((error: Error) => {
      hostWarn("attribution", "a checkout could not be tracked", { cwd, error: error.message })
    }).finally(() => resolving.delete(cwd))
    resolving.set(cwd, done)
  }
  const activity = new LiveActivity({
    tracker: { activity: (mark) => journal.writes.activity(mark), reported: (call) => journal.writes.reported(call) },
    placement: deps.placement,
    session: deps.session,
    checkout: (cwd) => checkouts.get(cwd) ?? undefined,
    working,
    now: () => Date.now(),
  })
  // Mako's own writes: Git commands it ran, files the person saved through it.
  const unwatch = workspaceWrites.subscribe((write: WorkspaceWrite) => {
    if (!write.paths.length) return
    journal.writes.makoWrote({ kind: write.kind, operation: write.operation.slice(0, 200), paths: write.paths.slice(0, 4096) }, write.startedAt, write.endedAt)
  })
  // Sessions imported since, moved since, or lines that turned unsure: a pass opens only those.
  deps.jobs.every("read back unsure lines", 10 * 60_000, async () => {
    await local?.readBack()
  }, { firstAfterMs: 60_000 })
  deps.jobs.every("tell the owner this Mako's sessions", 10 * 60_000, tellSessions, { firstAfterMs: 10 * 60_000 })
  deps.jobs.every("collect attribution content", 60 * 60_000, () => {
    const dropped = local?.tracker.collect()
    if (dropped?.dropped) hostLog("attribution", "content collected", dropped)
  })
  deps.jobs.every("let go of idle attribution roots", 6 * 60 * 60_000, async () => {
    // A repository let go is tracked again on the next turn there.
    for (const root of (await local?.tracker.letGoIdle()) ?? []) asked.delete(root)
  }, { firstAfterMs: 10 * 60_000 })
  deps.jobs.every("remove journals nothing writes", 24 * 60 * 60_000, async () => {
    if (journal.role().kind !== "owner") return
    const removed = await sweepOldJournals(deps.userRoot, folder, deps.dataRoot, Date.now() - RETENTION_DAYS * DAY_MS)
    if (removed.length) hostLog("attribution", "removed journals nothing wrote for two weeks", { removed: removed.join(", ") })
  }, { firstAfterMs: 30 * 60_000 })
  return {
    live: (batch) => activity.observe(batch),
    effects(conversation, call) {
      const placed = deps.placement(conversation)
      if (!placed || !call.effects.length) return
      journal.writes.reported({
        thread: placed.thread,
        session: placed.session,
        call: call.callId,
        startedAt: call.startedAt,
        endedAt: call.endedAt,
        status: call.status,
        effects: call.effects.map(reportedEffect),
      })
    },
    bounds: ({ conversation, call, status, exact }) => activity.bounds(conversation, call, status, exact),
    mako(write) {
      const id = randomUUID()
      journal.writes.makoStart(id, write, Date.now())
      return { end: () => journal.writes.makoEnd(id, Date.now()) }
    },
    rewindWriters: (paths, since) => writersSince(view(), paths, since),
    hunks: (checkout) => hunks(view(), checkout),
    changes: (thread) => changes(view(), thread),
    partition: (checkout, thread, options) => partition(view(), checkout, thread, options),
    shares: (checkout, thread) => shares(view(), checkout, thread),
    settled: () => journal.writes.settled(),
    async track(checkout) {
      const found = await locate(deps.git, checkout).catch(() => null)
      const roots = found ? [found.root] : await projectRepositories(deps.git, checkout).then((result) => ("roots" in result ? result.roots : []), () => [])
      for (const root of roots) {
        await journal.writes.track(root)
        asked.set(root, Date.now())
      }
    },
    readBack: (checkout, budgetMs) => journal.writes.readBack(checkout, budgetMs),
    head: (repository) => [...view().roots()].find((state) => state.root.path === repository)?.root.head,
    blob: (ref) => view().store.blob(ref),
    threadTrees: async (checkout, thread) => {
      await journal.writes.settled()
      return threadTrees(deps.git, view(), partition(view(), checkout, thread))
    },
    restorable: (target) => restorable(view(), target),
    threadChanges: (thread) => {
      const current = view()
      return threadTotals(current.store.turnChangesOf(thread), changes(current, thread))
    },
    countTurn: (thread, turn, state) => {
      if (!local && !reader) return undefined
      return turnChanges(view(), thread, turn, state)
    },
    settledThrough: (at) => !view().store.unsettledThrough(at + TRAIL_MS),
    counted: (summary, session) => journal.writes.counted(summary, session),
    turnsChangedAfter: (thread, after) => view().store.turnsChangedAfter(thread, after),
    turnWriters: (thread, turn, file, shown) => turnWriters(view(), thread, turn, file, shown),
    turnOnly: (thread, turn, file) => turnOnlyPair(view(), thread, turn, file),
    undoPlan: (thread, scope, checkout) => undoPlan(view(), thread, scope, checkout),
    running: (checkout) => runningIn(view(), checkout),
    changeUsage: () => changeUsage(view().store, Date.now() - RETENTION_DAYS * DAY_MS),
    resolveFiles: (source, spellings) => files.resolve(view().store, referenceSource(source), spellings.slice(0, MAX_SPELLINGS)),
    chooseFile(source, spelling, path) {
      const thread = referenceSource(source).thread
      if (thread) journal.writes.chose({ thread, spelling: spellingPath(spelling), path, at: Date.now() })
    },
    threadHistory: (thread) => threadHistory(view().store, thread, Date.now()),
    carryThreadHistory: (history, map = []) => journal.writes.carry(history, map),
    movedPaths: (thread, from, to) => files.movedPaths(view().store, thread, from, to),
    moved: (move) => journal.writes.moved({ ...move, at: Date.now() }),
    lost: (target) => journal.writes.lost(target),
    restore: (root, entry) => journal.writes.restore(root, entry),
    status: () => ({
      ...attributionStatus(local ? storedView(local.tracker.store) : view(), { recent: local?.tracker.recent(), live: Boolean(local) }),
      sharing: journal.status(),
    }),
    async close() {
      unwatch()
      await journal.close()
      reader?.store.close()
      reader = undefined
    },
  }
}

/** The device's shared journal under a user root (`HostEnvironment.userRoot`), for the debugging script. */
export function journalPath(userRoot: string): string {
  return join(sharedJournalFolder(userRoot), "journal.sqlite")
}

export { within }
export { SHARED_FORMAT, SharedJournal, sharedJournalFolder, type JournalRole, type JournalWrites, type OwnedJournal, type SharingStatus } from "./shared-journal.js"
