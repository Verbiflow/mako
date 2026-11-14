import type { WorkspaceTracking } from "../contracts/workspace-snapshots.js"
import type { CataloguedSession } from "./writer-paths.js"
export { harnessStores, harnessScratch, sessionFolders, sessionIds, outsideFolders, rootId, type CataloguedSession } from "./writer-paths.js"
import { locate, type Git } from "@mako/git"
import type { ContentRef, ExactBounds, MakoWrite, MakoWriting, PathMap, ThreadFileHistory } from "@mako/protocol"
import type { ChildSource } from "@mako/sessions"
import type { ToolEffects } from "@mako/sessions/tool-effects"
import { randomUUID } from "node:crypto"
import { realpathSync } from "node:fs"
import { homedir, hostname, tmpdir } from "node:os"
import { join, sep } from "node:path"
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
import { JournalReader } from "./journal-reader.js"
import { AttributionWriter } from "./writer-client.js"
import { WriterPathsSchema, WriterCollectionSchema } from "./writer-protocol.js"
import { JournalStore, type MoveRecord } from "./journal-store.js"
import { PlacedSessionSchema, SharedJournal, sharedJournalFolder, type SharingStatus } from "./shared-journal.js"
import type { ChosenFile, FileReferenceSource, FileResolution, FileSpelling, FileSpellings, MovedPaths } from "../contracts/file-references.js"
import { spellingPath } from "../files/index.js"
import { MAX_SPELLINGS, ThreadFiles, type ReferenceSource } from "./thread-files.js"
import { threadHistory, type CarryResult } from "./thread-history.js"
import { projectRepositories } from "../git/index.js"
import type { BackfillResult } from "./backfill.js"
import { LiveActivity, reportedEffect } from "./live-activity.js"
import { within } from "./paths.js"
import type { SystemHistory, TreeWatcher } from "./ports.js"
import { changes, countTurnInSlices, hunks, partition, restorable, shares, storedView, type CheckoutHunk, type CheckoutShares, type JournalView, type Partition, type PartitionOptions, type Restorable, type ThreadChanges } from "./queries.js"
import { threadTrees, type ThreadTree } from "./thread-tree.js"
import { runningIn, turnOnlyPair, turnWriters, undoPlan, type ShownPair, type UndoPlan } from "./turn-lines.js"
import type { TurnUndoScope, WriterRun } from "../contracts/turn-review.js"
import type { RescanFootprint } from "../contracts/mako-footprint.js"
import { SETTLE_MS } from "./tracker.js"
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
  // These reads come from opening the window's changes/usage view, not background journal polling.
  const forWindowView = () => {
    const journal = attribution()
    journal?.retryFromPerson()
    return journal
  }
  methods.handle("mako:thread-changes", (thread: string): ThreadChangeSummary | null => forWindowView()?.threadChanges(thread) ?? null)
  methods.handle("mako:change-usage", (): ChangeUsage | null => forWindowView()?.changeUsage() ?? null)
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
  /** How late the tree watch delivers now (`TrackerOptions.deliveryLagMs`). */
  deliveryLagMs?(): number
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
  /** A person opened a view of the journal; bounded independently of background reads and writes. */
  retryFromPerson(): void
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
  /**
   * `partition` without `options`, read on a worker from what the journal committed, never on the host's thread: what
   * work that runs on its own (a Thread's checkpoint as it writes) asks. Rejects if the worker can't answer.
   */
  partitionOffLoop(checkout: string, thread: string): Promise<Partition>
  /** How the checkout's changes divide by whose they are, for one Thread. */
  shares(checkout: string, thread: string): CheckoutShares
  /** Every change heard so far journaled. */
  settled(): Promise<void>
  /** Every change heard so far journaled, without waiting on rescans for lost events: what a turn's count waits for. */
  heard(): Promise<void>
  /**
   * Track each repository of `checkout` if nothing has yet, so a move can
   * divide it; what it holds uncommitted then is journaled as before tracking.
   */
  track(checkout: string): Promise<void>
  /** Prepare tracking in the background when a checkout is seen, never as a send prerequisite. */
  prepareTurn(checkout: string): Promise<WorkspaceTracking>
  /** The last tracking result; a failed writer overrides a previously ready checkout. */
  tracking(checkout: string): WorkspaceTracking
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
   * (`countingTurn`, a slice at a time); `settling` while its entries may
   * still be given another author. Undefined while the journal isn't open.
   */
  countTurn(thread: string, turn: string, state: TurnChanges["state"]): Promise<TurnChanges | undefined>
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
  failure(): string | undefined
  status(): AttributionStatus & { sharing: SharingStatus }
  /** The rescans for lost events this host's tracker made lately; null where another host owns the journal. */
  rescans(): RescanFootprint | null
  close(): Promise<void>
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

/** `folders` less any inside another of them. */
function outermost(folders: readonly string[]): string[] {
  const unique = [...new Set(folders)]
  return unique.filter((folder) => !unique.some((other) => other !== folder && within(other, folder)))
}

/** A turn re-asks the owner to track its checkout at most this often: the owner may have let it go as idle. */
const RETRACK_MS = 10 * 60_000

/** The shared journal once it's open; what it calls while it opens reads it through this. */
interface Sharing {
  journal?: SharedJournal
}

export async function openAttribution(deps: AttributionDeps): Promise<Attribution> {
  const home = homedir()
  const temporary = temporaryFolders()
  /** Mako's own folders: never a Thread's footprint, and its busiest writers, so history reads leave them to fseventsd. */
  const own = outermost([deps.dataRoot, deps.userRoot, join(home, ".mako"), join(temporary[0]!, HISTORY_SCRATCH)])
  const folder = sharedJournalFolder(deps.userRoot)
  const journalFile = join(folder, "journal.sqlite")
  const sharing: Sharing = {}
  let activeFile = journalFile
  const writer = new AttributionWriter(deps, {
    dataRoot: deps.dataRoot, userRoot: deps.userRoot, defaultDataRoot: deps.defaultDataRoot, label: deps.label, hostPid: process.pid,
    home, temporary, own, history: Boolean(deps.history), children: Boolean(deps.children), catalogued: Boolean(deps.catalogued), running: Boolean(deps.running),
  }, { applied: () => sharing.journal?.applied() ?? Promise.resolve() })
  /** The journal another host owns, read from the file, and its view as of the last commit read. */
  let reader: { store: JournalStore; version: number; view?: JournalView } | undefined

  // This device's sessions as the journal reads them: the catalog, with the Threads followers run their sessions in.
  const catalogued = (): readonly CataloguedSession[] => {
    const own = deps.catalogued?.() ?? []
    const placed = new Map((writer.snapshot()?.followers ?? []).flatMap((follower) => [...follower.placed]))
    if (!placed.size) return own
    return own.map((session) => {
      const thread = session.threadId ? undefined : placed.get(session.path)
      return thread ? { ...session, threadId: thread.thread, sessionId: thread.session } : session
    })
  }
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
  /** The worker `partitionOffLoop` reads on, for the journal file it was made for. */
  let offLoop: { path: string; reader: JournalReader } | undefined

  const view = (): JournalView => {
    if (!reader) throw new Error("Mako's record of changes isn't open yet. Try again in a moment.")
    const version = reader.store.dataVersion()
    if (!reader.view || version !== reader.version) {
      reader.view = storedView(reader.store)
      reader.version = version
    }
    return reader.view
  }

  try {
    sharing.journal = await SharedJournal.open({
    folder,
    host: { pid: process.pid, dataRoot: deps.dataRoot, label: deps.label },
    startOwner: async (privateReason) => {
      const state = await writer.ensure(privateReason)
      activeFile = state.path
      return state.address
    },
    own: async () => { throw new Error("A host never opens the attribution writing owner on its own thread.") },
    follow: () => {
      reader?.store.close()
      reader = { store: JournalStore.open(activeFile, { device: hostname(), readOnly: true }), version: -1 }
    },
    alone: async () => { throw new Error("A private attribution writer runs off-thread too.") },
    log: (message, facts) => hostLog("attribution", message, facts),
    })
  } catch (error) {
    const [cleanup] = await Promise.allSettled([writer.close()])
    if (cleanup.status === "rejected") throw new AggregateError([error, cleanup.reason], "Attribution could not open or close its writer", { cause: error })
    throw error
  }
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
  const preparing = new Map<string, Promise<WorkspaceTracking>>()
  const tracking = new Map<string, WorkspaceTracking>()
  /** When each repository was last asked to be tracked. */
  const asked = new Map<string, number>()
  const prepareWorkspace = (checkout: string): Promise<WorkspaceTracking> => {
    const waiting = preparing.get(checkout)
    if (waiting) return waiting
    const failure = journal.status().failure
    if (failure) {
      const unavailable: WorkspaceTracking = { kind: "unavailable", reason: failure }
      tracking.set(checkout, unavailable)
      return Promise.resolve(unavailable)
    }
    tracking.set(checkout, { kind: "pending", reason: "The checkout's tracking has not finished" })
    const prepared = (async (): Promise<WorkspaceTracking> => {
      try {
        const found = await locate(deps.git, checkout)
        const project = found ? { roots: [found.root] } : await projectRepositories(deps.git, checkout)
        if ("refusal" in project) return project.reason === "outside" ? { kind: "outside" } : { kind: "incomplete", reason: project.refusal }
        for (const root of project.roots) {
          await journal.writes.track(root)
          asked.set(root, Date.now())
        }
        checkouts.set(checkout, found ? found.root : project.roots.length ? checkout : null)
        repositories.set(checkout, project.roots)
        return project.roots.length ? { kind: "tracked" } : { kind: "outside" }
      } catch (error) {
        return { kind: "unavailable", reason: error instanceof Error ? error.message : String(error) }
      }
    })().then(result => { tracking.set(checkout, result); return result }).finally(() => preparing.delete(checkout))
    preparing.set(checkout, prepared)
    return prepared
  }
  const fresh = (cwd: string) => repositories.get(cwd)?.every(root => Date.now() - (asked.get(root) ?? 0) < RETRACK_MS)
  const working = (cwd: string) => {
    if (cwd === home || cwd === sep) return
    if (tracking.get(cwd)?.kind === "tracked" && fresh(cwd)) return
    void prepareWorkspace(cwd)
  }
  journal.onRole(role => {
    if (role.kind === "follower" || role.kind === "owner" || role.kind === "private")
      for (const cwd of tracking.keys()) void prepareWorkspace(cwd)
  })
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
    await writer.command({ kind: "read-back" })
  }, { firstAfterMs: 60_000 })
  deps.jobs.every("tell the owner this Mako's sessions", 10 * 60_000, tellSessions, { firstAfterMs: 10 * 60_000 })
  // On a worker with a connection of its own: on the host's thread it held the loop 2.4 to 3.9 s an hour.
  deps.jobs.every("collect attribution content", 60 * 60_000, async () => {
    const collected = WriterCollectionSchema.parse(await writer.command({ kind: "collect" }).catch((error: Error) => {
      hostWarn("attribution", "kept content could not be collected; trying again next hour", { error: error.message })
      return undefined
    }))
    if (collected?.dropped) hostLog("attribution", "content collected", { ...collected })
  })
  /**
   * Wake the roots of `checkout` that sleep (`LaptopTracker.sleepIdle`), as a turn there would: its status, a move's
   * division or a tree read of it asks, so what changed there while it slept is read before the next answer. The
   * answer under way reads what the journal holds now.
   */
  const wakeFor = (checkout: string): Promise<void>[] => [writer.command({ kind: "wake", checkout }).then(() => undefined).catch((error: Error) => {
    hostWarn("attribution", "a checkout could not be woken", { checkout, error: error.message })
  })]
  // Roots nobody changed or worked around for hours let go of their stat caches; a turn there wakes them.
  deps.jobs.every("let quiet attribution roots sleep", 60 * 60_000, async () => {
    for (const root of WriterPathsSchema.parse(await writer.command({ kind: "sleep" }) ?? [])) asked.delete(root)
  }, { firstAfterMs: 15 * 60_000 })
  deps.jobs.every("let go of idle attribution roots", 6 * 60 * 60_000, async () => {
    // A repository let go is tracked again on the next turn there.
    for (const root of WriterPathsSchema.parse(await writer.command({ kind: "let-go" }) ?? [])) asked.delete(root)
  }, { firstAfterMs: 10 * 60_000 })
  deps.jobs.every("remove journals nothing writes", 24 * 60 * 60_000, async () => {
    const removed = WriterPathsSchema.parse(await writer.command({ kind: "sweep" }) ?? [])
    if (removed?.length) hostLog("attribution", "removed journals nothing wrote for two weeks", { removed: removed.join(", ") })
  }, { firstAfterMs: 30 * 60_000 })
  return {
    live: (batch) => {
      const cwd = batch.session?.cwd ?? batch.sessionChanges?.cwd
      if (cwd && !tracking.has(cwd)) void prepareWorkspace(cwd)
      activity.observe(batch)
    },
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
    hunks: (checkout) => {
      wakeFor(checkout)
      return hunks(view(), checkout)
    },
    changes: (thread) => changes(view(), thread),
    partition: (checkout, thread, options) => {
      wakeFor(checkout)
      return partition(view(), checkout, thread, options)
    },
    partitionOffLoop: (checkout, thread) => {
      wakeFor(checkout)
      const path = activeFile
      if (offLoop?.path !== path) {
        offLoop?.reader.close()
        offLoop = { path, reader: new JournalReader(path) }
      }
      return offLoop.reader.partition(checkout, thread)
    },
    shares: (checkout, thread) => {
      wakeFor(checkout)
      return shares(view(), checkout, thread)
    },
    settled: () => journal.writes.settled(),
    heard: () => journal.writes.settled({ rescans: false }),
    async track(checkout) {
      const found = await locate(deps.git, checkout).catch(() => null)
      const roots = found ? [found.root] : await projectRepositories(deps.git, checkout).then((result) => ("roots" in result ? result.roots : []), () => [])
      for (const root of roots) {
        await journal.writes.track(root)
        asked.set(root, Date.now())
      }
    },
    prepareTurn: prepareWorkspace,
    tracking: (checkout) => {
      const failure = journal.status().failure
      if (failure) return { kind: "unavailable", reason: failure }
      const state = tracking.get(checkout)
      if (state?.kind === "tracked" && !fresh(checkout)) return { kind: "pending", reason: "The checkout's tracking needs to be refreshed" }
      return state ?? { kind: "pending", reason: "The checkout has not been tracked yet" }
    },
    readBack: (checkout, budgetMs) => journal.writes.readBack(checkout, budgetMs),
    head: (repository) => [...view().roots()].find((state) => state.root.path === repository)?.root.head,
    blob: (ref) => view().store.blob(ref),
    threadTrees: async (checkout, thread) => {
      await Promise.all(wakeFor(checkout))
      await journal.writes.settled()
      return threadTrees(deps.git, view(), partition(view(), checkout, thread))
    },
    restorable: (target) => restorable(view(), target),
    threadChanges: (thread) => {
      const current = view()
      return threadTotals(current.store.turnChangesOf(thread), changes(current, thread))
    },
    countTurn: async (thread, turn, state) => {
      if (!reader) return undefined
      return countTurnInSlices(view(), thread, turn, state)
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
    retryFromPerson: () => journal.retryFromPerson(),
    failure: () => journal.status().failure ?? [...tracking.values()].find(state => state.kind === "unavailable")?.reason,
    status: () => ({
      ...attributionStatus(view(), { recent: writer.snapshot()?.recent, live: writer.snapshot()?.role.kind === "owner" || writer.snapshot()?.role.kind === "private" }),
      sharing: { ...(journal.role().kind === "failed" ? journal.status() : writer.snapshot()?.sharing ?? journal.status()), unsent: journal.status().unsent },
    }),
    rescans: () => { void writer.command({ kind: "snapshot" }).catch(() => {}); return writer.snapshot()?.rescans ?? null },
    async close() {
      unwatch()
      offLoop?.reader.close()
      offLoop = undefined
      const acknowledged = await Promise.allSettled([journal.applied()])
      const closed = await Promise.allSettled([journal.close()])
      const stopped = await Promise.allSettled([writer.close()])
      reader?.store.close()
      reader = undefined
      const failed = [...acknowledged, ...closed, ...stopped].flatMap(result => result.status === "rejected" ? [result.reason] : [])
      if (failed.length) throw new AggregateError(failed, "Attribution did not close cleanly", { cause: failed[0] })
    },
  }
}

/** The device's shared journal under a user root (`HostEnvironment.userRoot`), for the debugging script. */
export function journalPath(userRoot: string): string {
  return join(sharedJournalFolder(userRoot), "journal.sqlite")
}

export { within }
export { SHARED_FORMAT, SharedJournal, sharedJournalFolder, type JournalRole, type SharingStatus } from "./shared-journal.js"
