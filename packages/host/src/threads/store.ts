import { ReportActionSchema, ReportActionTargetSchema, ReportDispositionSchema, pendingReportAction, type ReportAction, type ReportActionTarget, type ReportActionsPage, type ReportDisposition } from "../contracts/report-actions.js"
import { createHash, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, realpathSync, renameSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { DatabaseSync, type SQLOutputValue, type StatementSync } from "node:sqlite"
import { z } from "zod"
import type { ThreadRef } from "@mako/sessions"
import { ReadOnlyConnection, ReadOnlyStoreError } from "@mako/sessions/read-only-sqlite"
import {
  declareStoreFormat,
  guardRefused,
  NewerStoreError,
  NewerStoreReadOnlyError,
  readStoreFormat,
  storeAccess,
  writeStoreFormat,
  type StoreFormat,
  type StoreStanding,
} from "@mako/sessions/store-format"
import {
  ActorSchema,
  PrincipalIdSchema,
  SessionIdSchema,
  ThreadIdSchema,
  type Actor,
  type PrincipalId,
  type SessionId,
  type ThreadId,
  type ThreadPlacement,
} from "../contracts/thread-identity.js"
import {
  ClaimReceiptSchema,
  DeviceIdSchema,
  ExecutionOwnerSchema,
  HandoffSchema,
  MoveIdSchema,
  RefusalSchema,
  SessionOriginSchema,
  executionRefusal,
  sameOwner,
  type ClaimReceipt,
  type ExecutionOwner,
  type Handoff,
  type MoveId,
  type Refusal,
  type SessionExecution,
} from "../contracts/thread-execution.js"
import { ThreadGroupSchema, type ThreadGroup } from "../contracts/thread-groups.js"
import type { ThreadWorktree } from "../contracts/thread-worktrees.js"
import type { ThreadPurpose, ThreadPurposeKind } from "../contracts/thread-purposes.js"
import type { ThreadTitleEntry } from "../contracts/thread-titles.js"
import { AppKeySchema, type AppKey, type ThreadEnvironmentValues } from "../contracts/thread-environments.js"
import { FinTurnSchema, LimitNoticeSchema, ReportSchema, ThreadParentSchema, internalDiscoveredRun, type FinRerouted, type FinTurn, type FollowedRun, type LimitNotice, type Placed, type Report, type ThreadParent } from "../contracts/agents.js"
import { hostLog, hostWarn } from "../base/host-log.js"
import { enableSharedWal } from "../base/sqlite-wal.js"
import { keepPreSplitCopy, SPLIT_TABLES, splitThreads } from "./thread-split.js"

/**
 * The per-user Thread store: which Session every journal and native session
 * belongs to, and which Thread every Session belongs to. One file for every
 * Mako host on this Mac, beside `session-memory.sqlite`, so the installed app
 * and a development host name a conversation with the same IDs.
 *
 * Nothing here is derived from a directory, title or native ID. A native
 * session is found by its provider's catalog identity (`identity ?? nativeId`)
 * and a journal by the exact paths and native IDs its bindings recorded; the
 * Session and Thread they resolve to are random IDs minted when first needed.
 * The mapping rules and why each exists are in
 * `docs/audits/2026-09-26/track-a1-threads-store/README.md`.
 *
 * Every write runs under `BEGIN IMMEDIATE`, so two hosts resolving the same
 * row serialize and the second reads the first one's answer.
 *
 * Format 2: migration 6 moved background agents into `thread_parents` and
 * dropped their table, which a format-1 build would make again and write to,
 * so such a build reads the store and changes nothing in it.
 */
export const THREAD_STORE_SCHEMA = 2
/**
 * The oldest format whose builds can still read a store this build writes
 * (`reads` in `store_meta`, `@mako/sessions/store-format`). It rises only
 * for a change an older build would misread, never with `THREAD_STORE_SCHEMA`
 * alone.
 */
export const THREAD_STORE_READS = 1
/**
 * Additive changes on top of `THREAD_STORE_SCHEMA`, which older builds can
 * ignore. The schema number rises only for a change an older writer would
 * break; an older host then reads the store and changes nothing in it, and
 * only one older than `THREAD_STORE_READS` leaves it.
 *
 * Migration 7 adds `thread_places` and `thread_splits` (`thread-split.ts`), which older builds ignore.
 */
export const THREAD_STORE_MIGRATION = 7

/**
 * The store is synchronous on the host's main thread. Opening waits as long
 * as another host's migration could take; after that no host holds the write
 * lock for more than one batch of `PLACE_BATCH` rows (about 25 ms), so a
 * longer wait means a host is stuck, and freezing this one helps nobody.
 */
const OPEN_WAIT_MS = 5000
const WRITE_WAIT_MS = 1000
const PLACE_BATCH = 500

/** What an operation acts on; its digest tells a replay from a conflict. */
interface OperationContent {
  thread?: ThreadId
  sessions?: SessionId[]
  undoing?: string
  title?: string
  move?: MoveId
  target?: ExecutionOwner
  /** A conversation adopted where its Thread runs elsewhere (`adoptElsewhere`), and its Session or the one it forks. */
  conversation?: string
  session?: SessionId
  forkOf?: string
}

/** A store whose `reads` is newer than this build: it's left as it is, and the error names the Mako that reads it. */
export class ThreadStoreVersionError extends NewerStoreError {
  constructor(format: StoreFormat, build = THREAD_STORE_SCHEMA) {
    super("the Thread store", format, build)
    this.name = "ThreadStoreVersionError"
  }
}

/** What a host that only reads a newer Mako's store says when asked to change it. */
function declinedThreads(format: StoreFormat): NewerStoreReadOnlyError {
  return new NewerStoreReadOnlyError("your Threads", format, "can show them but not change them. Update Mako to edit")
}

export class ThreadOperationConflictError extends Error {
  constructor(id: string) {
    super(`Operation ${id} was already recorded with different content`)
    this.name = "ThreadOperationConflictError"
  }
}

export class ThreadMoveConflictError extends Error {
  readonly move: MoveId
  constructor(move: MoveId) {
    super(`This Thread is already moving (move ${move})`)
    this.name = "ThreadMoveConflictError"
    this.move = move
  }
}

/**
 * The store in a user root (`HostEnvironment.userRoot`): the one every
 * profile shares, unless the host is isolated, whose data root keeps its
 * own copy so a test never adds Sessions to the user's store.
 */
export function threadStorePath(userRoot: string): string {
  return join(userRoot, "threads.sqlite")
}

/** SQLite's codes for a file that is damaged or isn't a database at all. */
const DAMAGED_CODES = new Set([11, 26])
const SqliteErrorSchema = z.object({ errcode: z.number() })

/** The store, or why Threads are off; a store started over after damage has both. */
export interface OpenedThreadStore {
  store: ThreadStore | null
  problem?: string
}

/**
 * Open the store, or say why Threads are off. A damaged file is kept beside
 * the store under a dated name and a new store starts: Sessions come back
 * from their journals and the catalog, and only the groupings made before
 * are lost, still readable in the kept file.
 */
export function openThreadStore(path: string, options: ThreadStoreOptions = {}): OpenedThreadStore {
  try {
    return { store: new ThreadStore(path, options) }
  } catch (error) {
    const sqlite = SqliteErrorSchema.safeParse(error)
    if (options.readOnly || error instanceof ThreadStoreVersionError || !sqlite.success || !DAMAGED_CODES.has(sqlite.data.errcode))
      return { store: null, problem: `Threads are off: ${error instanceof Error ? error.message : String(error)}` }
    const kept = `${path}.damaged-${new Date(options.now?.() ?? Date.now()).toISOString().replaceAll(":", "-")}`
    for (const suffix of ["", "-wal", "-shm"])
      if (existsSync(path + suffix)) renameSync(path + suffix, kept + suffix)
    hostWarn("threads", "the Thread store was damaged; a new one was started", { kept })
    try {
      return { store: new ThreadStore(path, options), problem: `Mako's Thread store was damaged, so it started a new one. Sessions keep their history, but Threads grouped before are separate again. The old store is kept at ${kept}.` }
    } catch (retry) {
      return { store: null, problem: `Threads are off: ${retry instanceof Error ? retry.message : String(retry)}` }
    }
  }
}

export type SessionOrigin = "imported" | "started" | "captured" | "fork" | "new"

/** What a journal's metadata says about where it came from. */
export interface JournalFacts {
  conversationId: string
  createdAt: number
  harness: string
  threadPath?: string
  bindings: ReadonlyArray<{ provider: string; nativeId?: string; path?: string }>
  /** The conversation this one forked from. `parent-thread` puts its new Session in the parent's Thread; without it the fork has its own Thread. */
  ancestry?: { parentId: string; placement?: "parent-thread"; session?: SessionId }
  /** A journal started inside a Session that already exists (a `+` tab). */
  session?: SessionId
}

export type SourceRef = Pick<ThreadRef, "harness" | "nativeId" | "path" | "identity" | "parentNativeId">

export interface ThreadRecord {
  id: ThreadId
  owner: PrincipalId
  title?: string
  titleSource?: "user" | "frozen" | "auto"
  revision: number
  sessions: SessionId[]
}

/**
 * The parent edges a store knows (`ThreadStore.edges`): every child Thread's, a parent's children, the edge a spawn's
 * operation made, and the one whose followed run is a harness Session.
 */
export interface ThreadEdges {
  all: readonly ThreadParent[]
  /** Historical discoveries reclassified as internal native reviews; only reconciliation reads these. */
  internalRuns: readonly ThreadParent[]
  of(child: string): ThreadParent | undefined
  children(parent: string): readonly ThreadParent[]
  byOp(op: string): ThreadParent | undefined
  byRun(harness: string, nativeId: string): ThreadParent | undefined
  /** The child Threads' harness Sessions, so a catalog row is known for a child's before it's placed. */
  childNative(harness: string, nativeId: string): boolean
}

function runKey(harness: string, nativeId: string): string {
  return `${harness}\n${nativeId}`
}

/** A spawn the tree's running budget holds until a running child ends (`ThreadStore.queuedSpawns`). */
export interface QueuedSpawn {
  op: string
  /** The root of the tree whose budget it waits on. */
  tree: string
  record: string
  at: number
  /**
   * It starts on another device (`agent_placings`): kept apart from the spawns that start here, in a table a build
   * from before placement never reads, so such a build sharing this store neither starts it here nor drops it.
   */
  away?: true
}

/** A Thread's name and where it came from, as a list of many Threads reads it (`titlesOf`). */
export type ThreadTitle = Pick<ThreadRecord, "title" | "titleSource">

export interface StoreConflict {
  sessions: [SessionId, SessionId]
  reason: string
}

export interface ThreadStoreOptions {
  now?: () => number
  /** How a native path is compared; defaults to `realNativePath`. */
  realPath?: (path: string) => string
  /**
   * The environment this store executes for. A Mac's store is its own
   * device; a cloud runtime passes its runtime ID. Fixed when the store is
   * created.
   */
  self?: ExecutionOwner
  /**
   * Only read the store another host keeps: nothing is created or migrated,
   * every write throws `ReadOnlyStoreError`, and a row no writing host has
   * placed is served without a Thread. A fixture desk opens the user's store
   * this way.
   */
  readOnly?: boolean
  /** How this build stamps a format it raises (`storeWriter`), so an older build can name it. */
  writer?: string
  /** The format this build writes; the constants unless a test plays a newer build. */
  format?: { writableBy: number; readableBy: number }
  /**
   * A Thread is one conversation (`docs/one-conversation.md`): each open splits every Thread holding several Sessions
   * (`splitThreads`), having kept a copy of the store first, and a fork or a `+` makes a Thread of its own in its
   * source's place. Off until the windows draw one conversation per Thread.
   */
  oneConversation?: boolean
  /** A test's hook after each Thread the split finishes, inside its transaction. */
  afterSplitThread?: (done: number) => void
}

export interface MoveStatus {
  phase: MovePhase
  thread: ThreadId
  target: ExecutionOwner
}

export interface MovingSession {
  session: SessionId
  journals: string[]
  natives: { harness: string; nativeId: string }[]
}

export interface MoveBegan {
  move: MoveId
  thread: ThreadId
  sessions: SessionId[]
}

/**
 * The file a native path names. A provider root can be reached through a
 * symlink (a Claude account home whose `projects` links to
 * `~/.claude/projects`): the catalog lists the resolved path while a journal
 * kept the one its session was opened by. A `#` suffix (one session inside a
 * Devin or OpenCode database) is kept as it is. A deleted file resolves
 * through its directory, or stays as given.
 */
export function realNativePath(path: string): string {
  const at = path.indexOf("#")
  const file = at < 0 ? path : path.slice(0, at)
  const suffix = at < 0 ? "" : path.slice(at)
  for (const candidate of [() => realpathSync.native(file), () => join(realpathSync.native(dirname(file)), basename(file))]) {
    try {
      return candidate() + suffix
    } catch {
      continue
    }
  }
  return path
}

const MetaRowSchema = z.object({ value: z.string() })
const SessionRowSchema = z.object({ session_id: z.string() })
const LocatorRowSchema = z.object({ session_id: z.string(), harness: z.string(), native_id: z.string().nullable() })
const LocatorPathRowSchema = z.object({ path: z.string(), harness: z.string() })
const SessionDetailSchema = z.object({
  id: z.string(),
  origin: z.string(),
  parent_session: z.string().nullable(),
  created_at: z.number(),
  merged_into: z.string().nullable(),
})
const MembershipRowSchema = z.object({ thread_id: z.string() })
const ThreadRowSchema = z.object({
  id: z.string(),
  owner_id: z.string(),
  title: z.string().nullable(),
  title_source: z.enum(["user", "frozen", "auto"]).nullable(),
  revision: z.number(),
  merged_into: z.string().nullable(),
})
const OperationRowSchema = z.object({ kind: z.string(), digest: z.string(), result: z.string() })
const PlacementSchema = z.object({ thread: ThreadIdSchema, session: SessionIdSchema })
const CountSchema = z.object({ count: z.number() })
const FirstJournalSchema = z.object({ count: z.number(), first: z.number().nullable() })
const VersionSchema = z.object({ data_version: z.number() })
const TotalChangesSchema = z.object({ count: z.number() })
const PlacementChangeRowSchema = z.object({ seq: z.number(), session_id: z.string() })
const ExecutionRowSchema = z.object({
  owner_kind: z.enum(["device", "cloud"]).nullable(),
  owner_id: z.string().nullable(),
  generation: z.number().int().positive(),
  move_id: z.string().nullable(),
})
type ExecutionRow = z.infer<typeof ExecutionRowSchema>
/** A Session's row beside its execution's, when it has one (`held`): what `executionsOf` reads of many at once. */
const SessionExecutionRowSchema = ExecutionRowSchema.extend({
  id: z.string(),
  merged_into: z.string().nullable(),
  held: z.string().nullable(),
  generation: z.number().int().positive().nullable(),
})
const ForkRowSchema = z.object({ id: z.string(), parent_session: z.string() })
/**
 * Where a reader of reports, answers, title changes and journals read them to, by the store's order of taking them
 * (`rowid`, a title change's `seq`).
 */
export interface KeptMark {
  reports: number
  answers: number
  titles: number
  journals: number
}
/** What was kept after a mark, oldest first, and the mark it leaves off at (`keptSince`). */
export interface KeptSince {
  reports: Report[]
  answers: KeptAnswer[]
  /** Threads whose title changed or whose Sessions gained a journal. */
  threads: string[]
  /** The title changes since the mark were pruned before they were read: anything may have changed. */
  lost: boolean
  mark: KeptMark
}
const SeqRowSchema = z.object({ seq: z.number() })
const JournalThreadRowSchema = z.object({ seq: z.number(), thread_id: z.string() })
const SeqRecordRowSchema = z.object({ seq: z.number(), record: z.string() })
const ThreadConversationRowSchema = z.object({ thread: z.string(), session: z.string(), merged: z.string().nullable(), conversation: z.string().nullable() })
const ThreadTitleRowSchema = z.object({ id: z.string(), title: z.string().nullable(), title_source: z.enum(["user", "frozen", "auto"]).nullable(), merged_into: z.string().nullable() })
const GroupMemberRowSchema = z.object({ thread_id: z.string(), merged_into: z.string().nullable(), session_id: z.string(), added_at: z.number(), origin: z.string(), parent_session: z.string().nullable(), started: z.number() })
/** One Session of a Thread's group as a window draws it: a fork says the Session it was forked from. */
function groupMember(id: string, origin: string, started: boolean, parent: string | null) {
  return { id, origin, started, ...(origin === "fork" && parent && { forkOf: parent }) }
}
const MovePhaseSchema = z.enum(["leaving", "cancelled", "released", "arrived", "refused", "reclaimed"])
const MoveRowSchema = z.object({
  id: MoveIdSchema,
  thread_id: z.string(),
  source_kind: z.enum(["device", "cloud"]),
  source_id: z.string(),
  target_kind: z.enum(["device", "cloud"]),
  target_id: z.string(),
  phase: MovePhaseSchema,
  handoff: z.string().nullable(),
  outcome: z.string().nullable(),
})
type MoveRow = z.infer<typeof MoveRowSchema>
export type MovePhase = z.infer<typeof MovePhaseSchema>
interface ReleasedMove { move: MoveRow; handoff: Handoff }
const MoveBeganSchema = z.object({ move: MoveIdSchema, thread: ThreadIdSchema, sessions: z.array(SessionIdSchema) })
const MovedSchema = z.object({ move: MoveIdSchema })
const JournalRowSchema = z.object({ conversation_id: z.string() })
const NativeRowSchema = z.object({ harness: z.string(), native_id: z.string() })
const ChildNativeRowSchema = NativeRowSchema.extend({ thread_id: z.string() })

/**
 * Migration 2 (track A2): who may execute each Session, and every move of a
 * Thread between environments. Rows describe this store's view; a Session
 * minted by an older build has no row until the next open writes one.
 */
const EXECUTION_TABLES = `
CREATE TABLE IF NOT EXISTS moves (
  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('device', 'cloud')), source_id TEXT NOT NULL,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('device', 'cloud')), target_id TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('leaving', 'cancelled', 'released', 'arrived', 'refused', 'reclaimed')),
  handoff TEXT, outcome TEXT, created_at INTEGER NOT NULL, created_by TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS moves_thread ON moves(thread_id, phase);
CREATE TABLE IF NOT EXISTS executions (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id),
  owner_kind TEXT CHECK (owner_kind IN ('device', 'cloud')), owner_id TEXT,
  generation INTEGER NOT NULL CHECK (generation > 0),
  move_id TEXT REFERENCES moves(id), updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL,
  CHECK ((owner_kind IS NULL) = (owner_id IS NULL)));
CREATE INDEX IF NOT EXISTS executions_move ON executions(move_id);
CREATE TABLE IF NOT EXISTS store_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
`

/**
 * Every Session whose Thread changed, in commit order. Hosts share one store,
 * and a host that sees another's commit forgets only these Sessions'
 * placements instead of re-placing its whole catalog. Triggers write the log,
 * so a build that predates it logs its merges too once any newer build has
 * opened the store. A new Session's first membership isn't logged: nothing
 * can have cached it.
 */
const PLACEMENT_LOG = `
CREATE TABLE IF NOT EXISTS placement_changes (seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS placement_member_moved AFTER UPDATE OF thread_id ON memberships
  WHEN OLD.thread_id IS NOT NEW.thread_id
  BEGIN INSERT INTO placement_changes (session_id) VALUES (NEW.session_id); END;
CREATE TRIGGER IF NOT EXISTS placement_member_left AFTER DELETE ON memberships
  BEGIN INSERT INTO placement_changes (session_id) VALUES (OLD.session_id); END;
CREATE TRIGGER IF NOT EXISTS placement_session_merged AFTER UPDATE OF merged_into ON sessions
  WHEN NEW.merged_into IS NOT NULL
  BEGIN INSERT INTO placement_changes (session_id) VALUES (NEW.id); END;
CREATE TRIGGER IF NOT EXISTS placement_thread_merged AFTER UPDATE OF merged_into ON threads
  WHEN NEW.merged_into IS NOT NULL
  BEGIN INSERT INTO placement_changes (session_id) SELECT session_id FROM memberships WHERE thread_id = NEW.id; END;
`
/** Log rows kept past a store open; a host further behind than this forgets everything once. */
const PLACEMENT_LOG_KEEP = 10_000

/**
 * Worktrees Mako made for a Thread on a device. A Thread has at most one per
 * device; its Sessions run in `path` or a folder under it, and `project` is
 * the folder in the main checkout that the Thread was started from.
 */
const WORKTREE_TABLE = `
CREATE TABLE IF NOT EXISTS thread_worktrees (
  path TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id), device_id TEXT NOT NULL,
  repo_root TEXT NOT NULL, project TEXT NOT NULL, branch TEXT NOT NULL, base TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS thread_worktrees_thread ON thread_worktrees(thread_id, device_id);
`
/**
 * For a Thread's checkout of a project folder holding several repositories,
 * whose `thread_worktrees` row is the folder mirroring the project: each
 * repository's worktree inside it. A table of its own, so the Thread keeps
 * one row there that older builds read as they always have.
 */
const WORKTREE_REPOSITORY_TABLE = `
CREATE TABLE IF NOT EXISTS thread_worktree_repositories (
  path TEXT PRIMARY KEY, checkout TEXT NOT NULL, repo_root TEXT NOT NULL, base TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS thread_worktree_repositories_checkout ON thread_worktree_repositories(checkout);
`
const WorktreeRowSchema = z.object({
  path: z.string(), thread_id: z.string(), repo_root: z.string(), project: z.string(),
  branch: z.string(), base: z.string(), created_at: z.number(),
})
const WorktreeRepositoryRowSchema = z.object({ path: z.string(), checkout: z.string(), repo_root: z.string(), base: z.string() })
/** One repository's worktree in a Thread's checkout of several. */
export interface WorktreeRepository {
  path: string
  repoRoot: string
  base: string
}
/**
 * Threads Mako started for a job of its own, such as setting up a project's
 * app. `purpose` is unchecked so a later build can add one; a build that
 * doesn't know a purpose leaves its Thread unmarked.
 */
const PURPOSE_TABLE = `
CREATE TABLE IF NOT EXISTS thread_purposes (
  thread_id TEXT PRIMARY KEY REFERENCES threads(id), purpose TEXT NOT NULL, project TEXT NOT NULL, created_at INTEGER NOT NULL);
`
const PurposeRowSchema = z.object({ thread_id: z.string(), purpose: z.string(), project: z.string(), created_at: z.number() })
/**
 * Migration 3, from builds that named Threads automatically. `title` with
 * `title_source` is the Thread's own name (a person's, or one Mako chose
 * and `frozen`); a title with no source came from a build that didn't say,
 * and counts as the user's. `original_title` is the name the Thread showed
 * before it was first renamed, and `title_revision` rises on every change.
 * The `auto_*` and `title_pending*` columns and `title_exchanges` held
 * those builds' automatic titles; this build neither shows nor writes
 * them, and keeps them for builds that share the store.
 */
const TITLE_COLUMNS = [
  "original_title TEXT",
  "auto_title TEXT",
  "auto_context TEXT",
  "auto_at INTEGER",
  "title_revision INTEGER NOT NULL DEFAULT 0",
  "title_pending TEXT",
  "title_pending_at INTEGER",
  "title_pending_by TEXT",
]
/** `title_exchanges` as migration 3 made it, and every change of a Thread's name in commit order, for other hosts' windows. */
const TITLE_TABLES = `
CREATE TABLE IF NOT EXISTS title_exchanges (
  session_id TEXT NOT NULL REFERENCES sessions(id), exchange TEXT NOT NULL, completed_at INTEGER NOT NULL,
  prompt TEXT NOT NULL, answer TEXT NOT NULL, PRIMARY KEY (session_id, exchange));
CREATE INDEX IF NOT EXISTS title_exchanges_recent ON title_exchanges(session_id, completed_at);
CREATE TABLE IF NOT EXISTS title_changes (seq INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS thread_title_changed AFTER UPDATE OF title, title_source, auto_title ON threads
  WHEN OLD.title IS NOT NEW.title OR OLD.title_source IS NOT NEW.title_source OR OLD.auto_title IS NOT NEW.auto_title
  BEGIN INSERT INTO title_changes (thread_id) VALUES (NEW.id); END;
`
const TitleRowSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  title_source: z.enum(["user", "frozen", "auto"]).nullable(),
})
type TitleRow = z.infer<typeof TitleRowSchema>
const TITLE_ROW = "SELECT id, title, title_source FROM threads"
/** A Thread without a name of its own; a title an older build wrote automatically isn't one. */
const UNNAMED = "(title IS NULL OR title_source IS 'auto')"
const TitleChangeRowSchema = z.object({ seq: z.number(), thread_id: z.string() })
const ColumnRowSchema = z.object({ name: z.string() })
const PurposeKindSchema = z.enum(["setup"])
/**
 * The values that keep one folder's running app from colliding with
 * another's on a device: its hostname and the first of its block of ports.
 * Each is held by one app per device, and an app keeps its values for its
 * folder's whole life unless the device runs out and it has gone unused
 * longest. `thread_environments`, keyed by Thread before apps were one per
 * folder, stays for hosts that still write it; its rows move here on open.
 */
const ENVIRONMENT_TABLE = `
CREATE TABLE IF NOT EXISTS thread_environments (
  thread_id TEXT NOT NULL REFERENCES threads(id), device_id TEXT NOT NULL, host TEXT NOT NULL, port INTEGER NOT NULL,
  created_at INTEGER NOT NULL, used_at INTEGER NOT NULL, PRIMARY KEY (thread_id, device_id));
CREATE UNIQUE INDEX IF NOT EXISTS thread_environments_host ON thread_environments(device_id, host);
CREATE UNIQUE INDEX IF NOT EXISTS thread_environments_port ON thread_environments(device_id, port);
CREATE TABLE IF NOT EXISTS app_environments (
  app TEXT NOT NULL, device_id TEXT NOT NULL, host TEXT NOT NULL, port INTEGER NOT NULL,
  created_at INTEGER NOT NULL, used_at INTEGER NOT NULL, PRIMARY KEY (app, device_id));
CREATE UNIQUE INDEX IF NOT EXISTS app_environments_host ON app_environments(device_id, host);
CREATE UNIQUE INDEX IF NOT EXISTS app_environments_port ON app_environments(device_id, port);
INSERT OR IGNORE INTO app_environments (app, device_id, host, port, created_at, used_at) SELECT thread_id, device_id, host, port, created_at, used_at FROM thread_environments;
DELETE FROM thread_environments;
`
/**
 * Migration 5's table, from builds that kept a conversation's background agents beside its Session; migration 6
 * moves its rows into `thread_parents` and drops it (`migrateBackgroundAgents`). Read only there.
 */
const LegacyBackgroundAgentSchema = z.object({
  id: z.string(),
  parent: z.string(),
  harness: z.string(),
  nativeId: z.string().optional(),
  title: z.string(),
  detail: z.string().optional(),
  model: z.string().optional(),
  origin: z.enum(["started", "discovered", "linked"]),
  device: z.string().uuid(),
  process: z.object({ pid: z.number().int().positive(), startedAt: z.number().optional() }).optional(),
  runDir: z.string().optional(),
  startedAt: z.number(),
  ended: z.object({ at: z.number(), kind: z.enum(["done", "failed", "stopped", "unknown"]), detail: z.string().max(2000).optional(), toolUses: z.number().int().nonnegative().optional() }).optional(),
})
/**
 * Migration 6: who leads whom (`contracts/agents.ts`). One edge per child Thread, kept whole as JSON a newer build may
 * add to, with the columns it's found by; a child's reports, each written once by its id, with the request that
 * carries it to its parent named before that request is sent and marked once it was, so a host that stopped between
 * the two sends that same request again; and spawns the tree's running budget holds.
 */
const EDGE_TABLES = `
CREATE TABLE IF NOT EXISTS thread_parents (
  child_thread TEXT PRIMARY KEY REFERENCES threads(id), parent_thread TEXT NOT NULL REFERENCES threads(id),
  name TEXT NOT NULL, op TEXT NOT NULL, run_harness TEXT, run_native_id TEXT,
  record TEXT NOT NULL, created_at INTEGER NOT NULL, closed_at INTEGER);
CREATE UNIQUE INDEX IF NOT EXISTS thread_parents_name ON thread_parents(parent_thread, name);
CREATE UNIQUE INDEX IF NOT EXISTS thread_parents_op ON thread_parents(op);
CREATE UNIQUE INDEX IF NOT EXISTS thread_parents_run ON thread_parents(run_harness, run_native_id) WHERE run_native_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS thread_reports (
  id TEXT PRIMARY KEY, child_thread TEXT NOT NULL REFERENCES threads(id), record TEXT NOT NULL, at INTEGER NOT NULL,
  wake_request TEXT, delivered_at INTEGER);
CREATE INDEX IF NOT EXISTS thread_reports_child ON thread_reports(child_thread, at);
CREATE INDEX IF NOT EXISTS thread_reports_waiting ON thread_reports(at) WHERE delivered_at IS NULL;
CREATE TABLE IF NOT EXISTS agent_report_actions (
  report TEXT PRIMARY KEY REFERENCES thread_reports(id), parent_thread TEXT NOT NULL REFERENCES threads(id),
  child_thread TEXT NOT NULL REFERENCES threads(id), pending INTEGER NOT NULL, record TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS agent_report_actions_pending ON agent_report_actions(parent_thread, pending, child_thread);
CREATE INDEX IF NOT EXISTS agent_report_actions_owner ON agent_report_actions(json_extract(record, '$.owner'), pending);
CREATE TABLE IF NOT EXISTS agent_report_action_ops (
  op TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, record TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS agent_spawns (op TEXT PRIMARY KEY, tree TEXT NOT NULL, record TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS agent_placings (op TEXT PRIMARY KEY, tree TEXT NOT NULL, record TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS agent_cancels (op TEXT PRIMARY KEY, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS fin_moves (child_thread TEXT PRIMARY KEY, record TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS limit_notices (root_thread TEXT NOT NULL, id TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY (root_thread, id));
CREATE TABLE IF NOT EXISTS agent_answers (
  ask TEXT PRIMARY KEY, child_thread TEXT NOT NULL, op TEXT NOT NULL, record TEXT NOT NULL, at INTEGER NOT NULL, delivered_at INTEGER);
CREATE INDEX IF NOT EXISTS agent_answers_child ON agent_answers(child_thread, at);
CREATE INDEX IF NOT EXISTS agent_answers_op ON agent_answers(op);
CREATE TABLE IF NOT EXISTS agent_pull_wakes (
  wait TEXT PRIMARY KEY, child_thread TEXT NOT NULL, record TEXT NOT NULL, at INTEGER NOT NULL, delivered_at INTEGER);
CREATE INDEX IF NOT EXISTS agent_pull_wakes_waiting ON agent_pull_wakes(at) WHERE delivered_at IS NULL;
`
const RecordRowSchema = z.object({ record: z.string() })
const LimitNoticeRowSchema = z.object({ root_thread: z.string(), record: z.string() })
const ReportRowSchema = z.object({ record: z.string(), wake_request: z.string().nullable() })

/**
 * The answer that took a question in a Fin's report, kept as it's claimed and before it's delivered: the ask it
 * answers, the operation whose repeat it is, who gave it and its words, and the message that carries it to the Fin
 * under the request it's sent as, so a host that stopped before it was delivered sends that same request once.
 */
export const KeptAnswerSchema = z.object({
  ask: z.string().min(1).max(600),
  child: ThreadIdSchema,
  op: z.string().min(1).max(600),
  by: z.enum(["lead", "person"]),
  answer: z.string().max(400),
  request: z.string().min(1).max(200),
  text: z.string().max(20_000),
  actor: z.object({ kind: z.literal("agent"), session: SessionIdSchema }).optional(),
  at: z.number(),
  /** When it reached the Fin's conversation, and how. */
  delivered: z.object({ at: z.number(), delivery: z.enum(["turn", "steer", "queued", "interrupt"]) }).optional(),
})
export type KeptAnswer = z.infer<typeof KeptAnswerSchema>
const AnswerRowSchema = z.object({ record: z.string(), delivered_at: z.number().nullable() })
function keptAnswer(row: Record<string, SQLOutputValue>): KeptAnswer {
  return KeptAnswerSchema.parse(JSON.parse(AnswerRowSchema.parse(row).record))
}

/**
 * The outcome of a pull request that woke a Fin waiting on it, claimed before it's delivered: the wait (its Fin, the
 * dependency's first report, pull request and observation cursor), the outcome, and the note that carries it under the
 * request it's sent as, so a host that stopped before it was delivered sends that same request once, and none sends
 * a wait's outcome twice.
 */
export const KeptPullWakeSchema = z.object({
  wait: z.string().min(1).max(1200),
  child: ThreadIdSchema,
  /** A report in the retained dependency registration, and its pull request by `pullKey`: what must still stand for it to go. */
  report: z.string().min(1).max(600),
  pull: z.string().min(1).max(300),
  outcome: z.enum(["settled", "failed", "review", "merged", "closed"]),
  request: z.string().min(1).max(200),
  text: z.string().max(2_000),
  at: z.number(),
  delivered: z.object({ at: z.number(), delivery: z.enum(["turn", "steer", "queued", "interrupt"]) }).optional(),
  /** When its wait stopped holding before its note was sent (withdrawal, changed condition, stop): retired, never sent. */
  obsolete: z.number().optional(),
})
export type KeptPullWake = z.infer<typeof KeptPullWakeSchema>
function keptPullWake(row: Record<string, SQLOutputValue>): KeptPullWake {
  return KeptPullWakeSchema.parse(JSON.parse(RecordRowSchema.parse(row).record))
}

/** A report its parent hasn't heard yet, and the request already named to carry it, if one was. */
export interface WaitingReport {
  report: Report
  wake?: string
}
const QueuedSpawnRowSchema = z.object({ op: z.string(), tree: z.string(), record: z.string(), at: z.number(), away: z.number() })
const EnvironmentRowSchema = z.object({ app: z.string(), host: z.string(), port: z.number(), used_at: z.number() })
class EnvironmentTaken extends Error {}
function environmentValues(row: z.infer<typeof EnvironmentRowSchema>): ThreadEnvironmentValues {
  return { app: AppKeySchema.parse(row.app), host: row.host, port: row.port, usedAt: row.used_at }
}

const SCHEMA = `
CREATE TABLE principals (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('person')), label TEXT, created_at INTEGER NOT NULL);
CREATE TABLE threads (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES principals(id),
  title TEXT, title_source TEXT CHECK (title_source IN ('user', 'frozen', 'auto')),
  created_at INTEGER NOT NULL, created_by TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
  merged_into TEXT REFERENCES threads(id));
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  origin TEXT NOT NULL CHECK (origin IN ('imported', 'started', 'captured', 'fork', 'new')),
  parent_session TEXT REFERENCES sessions(id), created_at INTEGER NOT NULL, created_by TEXT NOT NULL,
  merged_into TEXT REFERENCES sessions(id));
CREATE TABLE memberships (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id), thread_id TEXT NOT NULL REFERENCES threads(id),
  position INTEGER NOT NULL, added_at INTEGER NOT NULL, added_by TEXT NOT NULL);
CREATE INDEX memberships_thread ON memberships(thread_id, position);
CREATE TABLE journals (
  conversation_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
  created_at INTEGER NOT NULL, registered_at INTEGER NOT NULL);
CREATE INDEX journals_session ON journals(session_id);
CREATE TABLE sources (
  device_id TEXT NOT NULL, harness TEXT NOT NULL, key TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id), first_seen_at INTEGER NOT NULL,
  PRIMARY KEY (device_id, harness, key));
CREATE INDEX sources_session ON sources(session_id);
CREATE TABLE locators (
  device_id TEXT NOT NULL, path TEXT NOT NULL, harness TEXT NOT NULL, native_id TEXT,
  session_id TEXT NOT NULL REFERENCES sessions(id), origin TEXT NOT NULL CHECK (origin IN ('journal', 'catalog')),
  PRIMARY KEY (device_id, path));
CREATE INDEX locators_session ON locators(session_id);
CREATE TABLE native_claims (
  device_id TEXT NOT NULL, harness TEXT NOT NULL, native_id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id), PRIMARY KEY (device_id, harness, native_id));
CREATE INDEX native_claims_session ON native_claims(session_id);
CREATE TABLE operations (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, digest TEXT NOT NULL, actor TEXT NOT NULL,
  result TEXT NOT NULL, at INTEGER NOT NULL);
`

export class ThreadStore {
  readonly path: string
  readonly deviceId: string
  readonly localPrincipal: PrincipalId
  /** The environment whose ownership this store's host enforces. */
  readonly self: ExecutionOwner
  private db: DatabaseSync
  private reader: ReadOnlyConnection | undefined
  /** How many times `reader` opened on a newer file. */
  private reopened = 0
  /**
   * The store's own numbers. In a newer Mako's format this build reads
   * Threads and Sessions and changes nothing (`write` declines), whether the
   * store was newer when it opened or another host raised it since.
   */
  private format: StoreFormat | undefined
  /** The format this build writes (`THREAD_STORE_SCHEMA`, `THREAD_STORE_READS`). */
  private readonly build: { writableBy: number; readableBy: number }
  private readonly now: () => number
  private readonly realPath: (path: string) => string
  private depth = 0
  private readonly placements = new Map<string, ThreadPlacement>()
  /** Moves whenever a placement this store holds is new, changed or forgotten (`placementVersion`). */
  private placementEpoch = 0
  /** The cache keys holding each Session, so a logged change forgets only those. */
  private readonly keysBySession = new Map<string, Set<string>>()
  private readonly executions = new Map<string, SessionExecution>()
  private dataVersion = -1
  /**
   * Counts the commits this store has seen, this host's and every other's. What's read of many Sessions or Threads at
   * once (`executionsOf`, `titlesOf`, `groups`) is answered from memory until it moves; never inside a write.
   */
  private revision = 0
  private readonly executionsSeen = new Map<string, SessionExecution | null>()
  private readonly titlesSeen = new Map<string, ThreadTitle | null>()
  /** Each Thread's conversations by Session (`threadConversations`), until any commit. */
  private readonly conversationsSeen = new Map<string, string[][]>()
  /** Read again only once the store moves, as a roster reads each Fin's on every look: */
  private readonly threadsSeen = new Map<string, ThreadRecord | null>()
  private readonly reportAsksSeen = new Map<string, readonly Report[]>()
  private readonly answersSeen = new Map<string, KeptAnswer | null>()
  private readonly forksSeen = new Map<string, SessionId | null>()
  private groupsSeen: { revision: number; groups: ThreadGroup[] } | undefined
  private edgesSeen: { revision: number; edges: ThreadEdges } | undefined
  /** The rows the last edges were read from, kept through commits: a read that finds the same keeps the same object. */
  private edgesKept: { records: string[]; native: Set<string>; edges: ThreadEdges } | undefined
  private worktreesSeen: { revision: number; worktrees: ThreadWorktree[] } | undefined
  /** Who hears this device's worktrees change here (`onWorktrees`). */
  private readonly worktreeListeners = new Set<() => void>()
  private changeSeq = 0
  private titleSeq = 0
  /** Threads whose name another host changed since `takeExternalTitles` last ran. */
  private readonly externalTitles = new Set<string>()
  /** Sessions whose Thread another host changed since `takeExternalChanges` last ran. */
  private readonly external = new Set<string>()
  private externalAll = false
  private readonly reported = new Set<string>()
  private readonly statements = new Map<string, StatementSync>()
  readonly conflicts: StoreConflict[] = []
  /** Whether a Thread is one conversation here (`ThreadStoreOptions.oneConversation`). */
  readonly oneConversation: boolean
  private readonly afterSplitThread: ((done: number) => void) | undefined

  constructor(path: string, options: ThreadStoreOptions = {}) {
    this.path = path
    this.now = options.now ?? Date.now
    this.realPath = options.realPath ?? realNativePath
    this.oneConversation = options.oneConversation === true
    this.afterSplitThread = options.afterSplitThread
    this.build = options.format ?? { writableBy: THREAD_STORE_SCHEMA, readableBy: THREAD_STORE_READS }
    if (options.readOnly) {
      this.reader = new ReadOnlyConnection(path, { timeout: WRITE_WAIT_MS })
      this.db = this.reader.database
    } else {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      this.db = new DatabaseSync(path)
    }
    try {
      if (this.reader) this.checkReadable()
      else if (!this.create(options.self, options.writer)) {
        // A newer Mako's format this build may read: it reads as a fixture desk does, through a connection that can't write.
        this.db.close()
        this.reader = new ReadOnlyConnection(path, { timeout: WRITE_WAIT_MS })
        this.db = this.reader.database
        this.checkReadable()
      }
      this.deviceId = z.string().uuid().parse(this.meta("device"))
      this.changeSeq = CountSchema.parse(this.db.prepare("SELECT coalesce(max(seq), 0) AS count FROM placement_changes").get()).count
      this.titleSeq = CountSchema.parse(this.db.prepare("SELECT coalesce(max(seq), 0) AS count FROM title_changes").get()).count
      this.localPrincipal = PrincipalIdSchema.parse(this.meta("principal"))
      this.self = ExecutionOwnerSchema.parse(JSON.parse(z.string().parse(this.meta("self"))))
      if (!this.reader) {
        this.db.exec(`PRAGMA busy_timeout=${WRITE_WAIT_MS}`)
        this.write(() => this.migrateBackgroundAgents())
      }
    } catch (error) {
      this.close()
      throw error
    }
  }

  /** Create or migrate the store; false, with nothing written, for one in a newer Mako's format this build may read. */
  private create(self: ExecutionOwner | undefined, writer: string | undefined): boolean {
    declareStoreFormat(this.db, this.build.writableBy)
    this.db.exec(`PRAGMA busy_timeout=${OPEN_WAIT_MS}`)
    enableSharedWal(this.db, OPEN_WAIT_MS)
    this.db.exec(`PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`)
    if (this.oneConversation && storeAccess(readStoreFormat(this.db, "store_meta"), this.build.writableBy) === "write") {
      const kept = keepPreSplitCopy(this.db, this.path)
      if (kept) hostLog("threads", "kept a copy of the Thread store before splitting its Threads", { kept })
    }
    // Lock before reading the version so two hosts creating the store at
    // once cannot both mint a device and a principal.
    this.db.exec("BEGIN IMMEDIATE")
    try {
      const found = readStoreFormat(this.db, "store_meta")
      const access = storeAccess(found, this.build.writableBy)
      if (found && access === "refused") throw new ThreadStoreVersionError(found, this.build.writableBy)
      if (access === "read") {
        this.db.exec("ROLLBACK")
        return false
      }
      if (found === undefined) {
        this.db.exec(SCHEMA)
        const principal = randomUUID()
        this.db.prepare("INSERT INTO principals (id, kind, label, created_at) VALUES (?, 'person', NULL, ?)").run(principal, this.now())
        const insert = this.db.prepare("INSERT INTO store_meta (key, value) VALUES (?, ?)")
        insert.run("device", randomUUID())
        insert.run("principal", principal)
      }
      writeStoreFormat(this.db, "store_meta", this.build, writer)
      this.format = readStoreFormat(this.db, "store_meta")
      this.migrate(self)
      this.db.exec("COMMIT")
      return true
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
  }

  /** A reader cannot create or migrate, so it needs a store a host of this schema, or a newer one, has migrated. */
  private checkReadable(): void {
    const found = readStoreFormat(this.db, "store_meta")
    if (found === undefined) throw new Error("No Mako host has created the Thread store yet")
    if (storeAccess(found, this.build.writableBy) === "refused") throw new ThreadStoreVersionError(found, this.build.writableBy)
    this.format = found
    if (!this.db.prepare("SELECT 1 AS found FROM store_migrations WHERE version = ?").get(THREAD_STORE_MIGRATION))
      throw new Error("The Thread store predates this build; it is read once a current host has opened it")
  }

  close(): void {
    if (this.reader) this.reader.close()
    else this.db.close()
  }

  /** Whether this host may change the store: not a fixture desk's reader, and not a newer Mako's format. */
  get writable(): boolean {
    return !this.reader && !this.newer
  }

  /** The store's format for this build, as Settings › Diagnostics shows it. */
  standing(): StoreStanding {
    const standing: StoreStanding = { access: storeAccess(this.format, this.build.writableBy), build: this.build.writableBy }
    if (this.format) standing.format = this.format
    return standing
  }

  /** The format of a newer Mako, when this build only reads the store because of it. */
  private get newer(): StoreFormat | undefined {
    return this.format && storeAccess(this.format, this.build.writableBy) !== "write" ? this.format : undefined
  }

  /** The actor for anything the person at this Mac does. */
  person(): Actor {
    return { kind: "person", principal: this.localPrincipal }
  }

  /**
   * Register journals in creation order, in one transaction. A fork is
   * created after its parent, so the parent's Session exists when the fork
   * links to it. Registering a known journal again only adds what its
   * bindings learned since.
   */
  registerJournals(journals: readonly JournalFacts[], actor: Actor): Map<string, ThreadPlacement> {
    const ordered = [...journals].sort((left, right) =>
      left.createdAt - right.createdAt || left.conversationId.localeCompare(right.conversationId))
    return this.write(() => {
      const placed = new Map<string, ThreadPlacement>()
      for (const facts of ordered) placed.set(facts.conversationId, this.placeSession(this.registerOne(facts, actor)))
      return placed
    })
  }

  registerJournal(facts: JournalFacts, actor: Actor): ThreadPlacement {
    return this.write(() => this.placeSession(this.registerOne(facts, actor)))
  }

  /** Where a journal's Session is, answered from memory until any commit moves a Session. */
  journalPlacement(conversationId: string): ThreadPlacement | undefined {
    this.syncVersion()
    const key = journalPlacementKey(conversationId)
    const cached = this.placements.get(key)
    if (cached) return cached
    const row = this.sql("SELECT session_id FROM journals WHERE conversation_id = ?").get(conversationId)
    if (!row) return undefined
    const placed = this.placeSession(SessionRowSchema.parse(row).session_id)
    this.remember(key, placed)
    return placed
  }

  /**
   * Every Thread with more than one Session, each with its Sessions in tab order: read in one query, then answered from
   * memory until any commit (`revision`). A Thread merged into another reads as that one, as `group` says it.
   */
  groups(): ThreadGroup[] {
    this.syncVersion()
    const held = this.groupsSeen
    if (held && held.revision === this.revision && this.depth === 0) return held.groups
    // Grouped by the index alone; the order (each Thread's first Session added, then its ID) is worked out here, which
    // spares reading every membership's row.
    const rows = this.sql(`WITH grouped AS (SELECT thread_id FROM memberships GROUP BY thread_id HAVING count(*) > 1)
      SELECT g.thread_id, t.merged_into, m.session_id, m.added_at, s.origin, s.parent_session,
        EXISTS (SELECT 1 FROM journals WHERE session_id = m.session_id) OR EXISTS (SELECT 1 FROM sources WHERE session_id = m.session_id) AS started
      FROM grouped g JOIN threads t ON t.id = g.thread_id JOIN memberships m ON m.thread_id = g.thread_id JOIN sessions s ON s.id = m.session_id
      ORDER BY g.thread_id, m.position, m.session_id`).all().map((row) => GroupMemberRowSchema.parse(row))
    const found: { first: number; id: string; group: ThreadGroup }[] = []
    for (let start = 0; start < rows.length;) {
      const head = rows[start]!
      let end = start
      while (end < rows.length && rows[end]!.thread_id === head.thread_id) end += 1
      const members = rows.slice(start, end)
      start = end
      const group = head.merged_into
        ? this.group(ThreadIdSchema.parse(head.thread_id))
        : ThreadGroupSchema.parse({ id: head.thread_id, sessions: members.map((member) => groupMember(member.session_id, member.origin, member.started !== 0, member.parent_session)) })
      if (group) found.push({ first: Math.min(...members.map((member) => member.added_at)), id: head.thread_id, group })
    }
    const groups = found.sort((left, right) => left.first - right.first || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)).map(({ group }) => group)
    if (this.depth === 0) this.groupsSeen = { revision: this.revision, groups }
    return groups
  }

  /**
   * Every parent edge this store knows (`contracts/agents.ts`): read in one query, then answered from memory until any
   * commit (`revision`), so the catalog asks it of every row it serves. A commit that changed no edge (a title, a
   * report, another Mako's write to any table) answers the same object it did, read again but not parsed again, so
   * what's built on it (`Agents.sync`) is kept: rebuilt on every commit, every Fin's roster entry was, all day.
   */
  edges(): ThreadEdges {
    this.syncVersion()
    const held = this.edgesSeen
    if (held && held.revision === this.revision && this.depth === 0) return held.edges
    const records = this.sql("SELECT record FROM thread_parents ORDER BY created_at, child_thread").all().map((row) => RecordRowSchema.parse(row).record)
    const nativeRows = records.length ? this.sql(`SELECT c.harness, c.native_id FROM native_claims c JOIN memberships m ON m.session_id = c.session_id
        WHERE c.device_id = ? AND m.thread_id IN (SELECT child_thread FROM thread_parents)
        UNION SELECT s.harness, s.key AS native_id FROM sources s JOIN memberships m ON m.session_id = s.session_id
        WHERE s.device_id = ? AND m.thread_id IN (SELECT child_thread FROM thread_parents)`).all(this.deviceId, this.deviceId).map((row) => NativeRowSchema.parse(row)) : []
    const native = new Set(nativeRows.map((found) => runKey(found.harness, found.native_id)))
    const same = this.edgesKept && this.edgesKept.records.length === records.length && this.edgesKept.records.every((record, index) => record === records[index]) &&
      this.edgesKept.native.size === native.size && [...native].every((key) => this.edgesKept!.native.has(key))
    if (same) {
      if (this.depth === 0) this.edgesSeen = { revision: this.revision, edges: this.edgesKept!.edges }
      return this.edgesKept!.edges
    }
    const all: ThreadParent[] = []
    const internalRuns: ThreadParent[] = []
    const byChild = new Map<string, ThreadParent>()
    const byParent = new Map<string, ThreadParent[]>()
    const byOp = new Map<string, ThreadParent>()
    const byRun = new Map<string, ThreadParent>()
    for (const record of records) {
      const parsed = ThreadParentSchema.safeParse(JSON.parse(record))
      if (!parsed.success) continue
      const edge = parsed.data
      // Keep the original edge and reports as history. A confirmed internal native reviewer was never delegated work.
      if (internalDiscoveredRun(edge)) { internalRuns.push(edge); continue }
      all.push(edge)
      byChild.set(edge.child, edge)
      byOp.set(edge.op, edge)
      const siblings = byParent.get(edge.parent)
      if (siblings) siblings.push(edge)
      else byParent.set(edge.parent, [edge])
      if (edge.run?.nativeId) byRun.set(runKey(edge.run.harness, edge.run.nativeId), edge)
    }
    const edges: ThreadEdges = {
      all,
      internalRuns,
      of: (child) => byChild.get(child),
      children: (parent) => byParent.get(parent) ?? [],
      byOp: (op) => byOp.get(op),
      byRun: (harness, nativeId) => byRun.get(runKey(harness, nativeId)),
      childNative: (harness, nativeId) => native.has(runKey(harness, nativeId)) || byRun.has(runKey(harness, nativeId)),
    }
    if (this.depth === 0) {
      this.edgesSeen = { revision: this.revision, edges }
      this.edgesKept = { records, native, edges }
    }
    return edges
  }

  /**
   * Keeps a child's edge, or what may change of one already kept: its followed run (its Session once known, its
   * process, its end) and when the delegation closed. A child has one parent: an edge for a Thread that already has
   * one keeps the first, and a spawn's operation names one edge. An end, and a close, are said once.
   */
  keepEdge(input: ThreadParent): ThreadParent {
    const edge = ThreadParentSchema.parse(input)
    return this.write(() => {
      const byOp = this.sql("SELECT record FROM thread_parents WHERE op = ?").get(edge.op)
      const kept = this.sql("SELECT record FROM thread_parents WHERE child_thread = ?").get(edge.child)
      const previous = kept ? ThreadParentSchema.parse(JSON.parse(RecordRowSchema.parse(kept).record)) : undefined
      if (byOp && !previous) return ThreadParentSchema.parse(JSON.parse(RecordRowSchema.parse(byOp).record))
      if (previous && (previous.parent !== edge.parent || previous.op !== edge.op)) return previous
      // Reclassified discoveries are immutable history. Stale catalog/adoption or run callbacks cannot make them workers again.
      if (previous && internalDiscoveredRun(previous)) return previous
      // The end of an edge that lives on another device has a row here only so the edge and its reports can name it:
      // a Thread with no Session, which nothing lists.
      if (edge.remote) this.keepAwayThread(edge.parent, edge.startedBy)
      if (edge.placed) this.keepAwayThread(edge.child, edge.startedBy)
      if (!this.sql("SELECT id FROM threads WHERE id = ?").get(edge.parent) || !this.sql("SELECT id FROM threads WHERE id = ?").get(edge.child))
        throw new Error("A parent edge names a Thread that isn't in the Thread store")
      const run: FollowedRun | undefined = edge.run && previous?.run?.ended ? { ...edge.run, ended: previous.run.ended } : edge.run
      const closedAt = previous?.closedAt ?? edge.closedAt
      const closedReason = previous?.closedAt !== undefined ? previous.closedReason : edge.closedReason
      const next: ThreadParent = previous
        ? { ...previous, ...(run && { run }), ...(closedAt !== undefined && { closedAt, ...(closedReason && { closedReason }) }) }
        : { ...edge, ...(run && { run }) }
      this.sql(`INSERT INTO thread_parents (child_thread, parent_thread, name, op, run_harness, run_native_id, record, created_at, closed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (child_thread) DO UPDATE SET run_harness = excluded.run_harness, run_native_id = excluded.run_native_id,
          record = excluded.record, closed_at = excluded.closed_at`)
        .run(next.child, next.parent, next.name, next.op, next.run?.harness ?? null, next.run?.nativeId ?? null, JSON.stringify(next), next.createdAt, next.closedAt ?? null)
      return next
    })
  }

  /** Replace a followed run only while its persisted generation and delegation still match the caller's snapshot. */
  keepRun(expected: ThreadParent, run: FollowedRun): ThreadParent | undefined {
    return this.write(() => {
      const kept = this.sql("SELECT record FROM thread_parents WHERE child_thread = ?").get(expected.child)
      const current = kept ? ThreadParentSchema.parse(JSON.parse(RecordRowSchema.parse(kept).record)) : undefined
      if (!current?.run || internalDiscoveredRun(current) || current.op !== expected.op || current.parent !== expected.parent || current.parentSession !== expected.parentSession || current.closedAt !== expected.closedAt || JSON.stringify(current.run) !== JSON.stringify(expected.run)) return undefined
      return this.keepEdge({ ...current, run })
    })
  }

  /** A row for a Thread another device owns (an edge's other end), made once; one this device has is left as it is. */
  private keepAwayThread(thread: string, actor: Actor): void {
    this.sql("INSERT OR IGNORE INTO threads (id, owner_id, created_at, created_by) VALUES (?, ?, ?, ?)").run(thread, this.localPrincipal, this.now(), JSON.stringify(actor))
  }

  /** A Fin's logical turn as its fallback left it (`FinTurn`); undefined between turns, or for one this build can't read. */
  finTurn(child: string): FinTurn | undefined {
    const kept = this.sql("SELECT record FROM fin_moves WHERE child_thread = ?").get(child)
    if (!kept) return undefined
    const parsed = FinTurnSchema.safeParse(JSON.parse(RecordRowSchema.parse(kept).record))
    return parsed.success ? parsed.data : undefined
  }

  /** The notice of a limit a tree waits on the person's seeing: the newest not seen. */
  limitNotice(root: string): LimitNotice | undefined {
    const rows = this.sql("SELECT record FROM limit_notices WHERE root_thread = ?").all(root).flatMap((row) => {
      const parsed = LimitNoticeSchema.safeParse(JSON.parse(RecordRowSchema.parse(row).record))
      return parsed.success ? [parsed.data] : []
    })
    return rows.filter((notice) => !notice.seen && !notice.gathering).sort((a, b) => b.at - a.at)[0]
  }

  /** Every tree's notices, said or gathering: what a host picks up from the last. */
  limitNotices(): { root: string; notice: LimitNotice }[] {
    return this.sql("SELECT root_thread, record FROM limit_notices").all().flatMap((row) => {
      const { root_thread: root, record } = LimitNoticeRowSchema.parse(row)
      const parsed = LimitNoticeSchema.safeParse(JSON.parse(record))
      return parsed.success ? [{ root, notice: parsed.data }] : []
    })
  }

  private keptLimitNotice(root: string, id: string): LimitNotice | undefined {
    const kept = this.sql("SELECT record FROM limit_notices WHERE root_thread = ? AND id = ?").get(root, id)
    return kept ? LimitNoticeSchema.parse(JSON.parse(RecordRowSchema.parse(kept).record)) : undefined
  }

  /**
   * A limit touched a Fin of tree `root`, gone on to `to` or nowhere, or with `apex` the Apex itself, which stays where
   * it is without one: kept now, gathering what else it touches until `sayLimitNotice`. False when this episode was said
   * already, seen or not.
   */
  gatherLimitNotice(root: string, first: LimitNotice & { gathering: NonNullable<LimitNotice["gathering"]> }, to?: string, apex = false): boolean {
    return this.write(() => {
      const kept = this.keptLimitNotice(root, first.id)
      if (kept && !kept.gathering) return false
      const notice = kept ?? first
      const { moved, stopped, ...rest } = notice.gathering!
      const gathering = apex ? { ...rest, moved, stopped, ...(to && { apex: to }) } : to ? { ...rest, moved: [...moved, to], stopped } : { ...rest, moved, stopped: stopped + 1 }
      this.sql("INSERT INTO limit_notices (root_thread, id, record) VALUES (?, ?, ?) ON CONFLICT (root_thread, id) DO UPDATE SET record = excluded.record").run(root, first.id, JSON.stringify({ ...notice, gathering }))
      return true
    })
  }

  /** A gathered notice is said, once: false when it was already. */
  sayLimitNotice(root: string, id: string, line: string): boolean {
    return this.write(() => {
      const kept = this.keptLimitNotice(root, id)
      if (!kept?.gathering) return false
      this.sql("UPDATE limit_notices SET record = ? WHERE root_thread = ? AND id = ?").run(JSON.stringify({ ...kept, gathering: undefined, line }), root, id)
      return true
    })
  }

  /** The person has seen it, wherever they were: it stays said. False when it's not theirs to see. */
  seeLimitNotice(root: string, id: string): boolean {
    return this.write(() => {
      const notice = this.keptLimitNotice(root, id)
      if (!notice) return false
      this.sql("UPDATE limit_notices SET record = ? WHERE root_thread = ? AND id = ?").run(JSON.stringify({ ...notice, seen: true }), root, id)
      return true
    })
  }

  /**
   * Claims the move for `wait` for host generation `owner`: refused (undefined) when the turn moved for it already or
   * a newer host holds a move; an older host's claim, left by an exit, gives way. The turn as claimed.
   */
  claimFinMove(child: string, wait: string, owner: number, at: number): FinTurn | undefined {
    return this.write(() => {
      const turn = this.finTurn(child) ?? { visited: [], handled: [] }
      if (turn.handled.includes(wait) || (turn.moving && turn.moving.owner > owner)) return undefined
      const next: FinTurn = { ...turn, moving: { owner, wait, at } }
      this.sql("INSERT INTO fin_moves (child_thread, record) VALUES (?, ?) ON CONFLICT (child_thread) DO UPDATE SET record = excluded.record").run(child, JSON.stringify(next))
      return next
    })
  }

  /**
   * Ends `owner`'s move for its wait: with `visited` added and the wait handled when it moved; `retired`, the wait
   * handled with nothing visited, when what the move was decided on stopped holding, so no move is made for it again;
   * released when it found nothing to do. False when another host's claim took it meanwhile, which then has the move.
   */
  finishFinMove(child: string, owner: number, moved?: { visited: readonly string[] } | "retired"): boolean {
    return this.write(() => {
      const turn = this.finTurn(child)
      if (!turn?.moving || turn.moving.owner !== owner) return false
      const { moving, ...rest } = turn
      const next: FinTurn = moved === "retired"
        ? { ...rest, handled: [...rest.handled, moving.wait].slice(-64) }
        : moved
          ? { visited: [...new Set([...rest.visited, ...moved.visited])].slice(-64), handled: [...rest.handled, moving.wait].slice(-64) }
          : rest
      this.sql("UPDATE fin_moves SET record = ? WHERE child_thread = ?").run(JSON.stringify(next), child)
      return true
    })
  }

  /** The Fin's turn ended without a limit: its next one goes from the person's first choice again. */
  clearFinTurn(child: string): void {
    this.write(() => this.sql("DELETE FROM fin_moves WHERE child_thread = ?").run(child))
  }

  /**
   * Where a child went on when its harness's account ran out (`FinRerouted`): the move replaces the last one, its
   * model's source kept. The edge as it stands after, undefined when there's none.
   */
  rerouteEdge(child: string, rerouted: FinRerouted | undefined): ThreadParent | undefined {
    return this.write(() => {
      const kept = this.sql("SELECT record FROM thread_parents WHERE child_thread = ?").get(child)
      if (!kept) return undefined
      const previous = ThreadParentSchema.parse(JSON.parse(RecordRowSchema.parse(kept).record))
      const tuned: NonNullable<ThreadParent["tuned"]> = { ...(previous.tuned ?? { source: "harness" }) }
      delete tuned.rerouted
      const next: ThreadParent = { ...previous, tuned: { ...tuned, ...(rerouted && { rerouted }) } }
      this.sql("UPDATE thread_parents SET record = ? WHERE child_thread = ?").run(JSON.stringify(next), child)
      return next
    })
  }

  /**
   * Opens a stopped child's delegation again, as a message to it does: the
   * close and its reason go into `resumed`, and a later stop closes it anew.
   * The edge unchanged when it isn't closed, undefined when there's none.
   */
  reopenEdge(child: string, at: number): ThreadParent | undefined {
    return this.write(() => {
      const kept = this.sql("SELECT record FROM thread_parents WHERE child_thread = ?").get(child)
      if (!kept) return undefined
      const previous = ThreadParentSchema.parse(JSON.parse(RecordRowSchema.parse(kept).record))
      if (previous.closedAt === undefined) return previous
      const { closedAt, closedReason, ...open } = previous
      const next: ThreadParent = { ...open, resumed: { at, closedAt, ...(closedReason && { reason: closedReason }) } }
      this.sql("UPDATE thread_parents SET record = ?, closed_at = NULL WHERE child_thread = ?").run(JSON.stringify(next), child)
      return next
    })
  }

  /**
   * A Fin placed elsewhere, as its Apex's device keeps how it stands: whether it's at work, how many times this
   * device set it to work, and a stop its device hasn't confirmed (`Placed`); a member given as undefined is dropped.
   * The edge as it stands after; undefined when there's none, or it isn't placed.
   */
  keepPlaced(child: string, standing: Partial<Pick<Placed, "working" | "epoch" | "stop" | "said">>): ThreadParent | undefined {
    return this.write(() => {
      const kept = this.sql("SELECT record FROM thread_parents WHERE child_thread = ?").get(child)
      if (!kept) return undefined
      const previous = ThreadParentSchema.parse(JSON.parse(RecordRowSchema.parse(kept).record))
      if (!previous.placed) return undefined
      const next: ThreadParent = { ...previous, placed: { ...previous.placed, ...standing } }
      this.sql("UPDATE thread_parents SET record = ? WHERE child_thread = ?").run(JSON.stringify(next), child)
      return next
    })
  }

  /** The newest of its Apex's messages a Fin here heard, its Apex on another device (`RemoteParent.heard`): it only rises. */
  keepHeard(child: string, heard: number): ThreadParent | undefined {
    return this.write(() => {
      const kept = this.sql("SELECT record FROM thread_parents WHERE child_thread = ?").get(child)
      if (!kept) return undefined
      const previous = ThreadParentSchema.parse(JSON.parse(RecordRowSchema.parse(kept).record))
      if (!previous.remote || (previous.remote.heard ?? 1) >= heard) return previous
      const next: ThreadParent = { ...previous, remote: { ...previous.remote, heard } }
      this.sql("UPDATE thread_parents SET record = ? WHERE child_thread = ?").run(JSON.stringify(next), child)
      return next
    })
  }

  /**
   * A start for an Apex on another device that its Apex stopped (`mako:agents-cancel`), kept by its op in a table of
   * its own: the start is refused here whenever it arrives, after a restart too.
   */
  cancelStart(op: string, at: number): void {
    this.write(() => this.sql("INSERT OR IGNORE INTO agent_cancels (op, at) VALUES (?, ?)").run(op, at))
  }

  startCancelled(op: string): boolean {
    this.syncVersion()
    return this.sql("SELECT op FROM agent_cancels WHERE op = ?").get(op) !== undefined
  }

  /** A Fin moved to another harness: its edge says what it runs on now (`Agents.move`), nothing else of it changes. */
  moveEdge(child: string, asked: Pick<ThreadParent["asked"], "harness" | "model" | "reasoning" | "fast" | "access">, tuned: Omit<NonNullable<ThreadParent["tuned"]>, "rule" | "rerouted"> | undefined): ThreadParent | undefined {
    return this.write(() => {
      const kept = this.sql("SELECT record FROM thread_parents WHERE child_thread = ?").get(child)
      if (!kept) return undefined
      const previous = ThreadParentSchema.parse(JSON.parse(RecordRowSchema.parse(kept).record))
      const { asked: was, ...edge } = previous
      const held = { ...was }
      delete held.harness
      delete held.model
      delete held.reasoning
      delete held.fast
      delete held.access
      delete edge.tuned
      const next: ThreadParent = { ...edge, asked: { ...held, ...asked }, ...(tuned && { tuned }) }
      this.sql("UPDATE thread_parents SET record = ? WHERE child_thread = ?").run(JSON.stringify(next), child)
      return next
    })
  }

  /** The Threads `thread` descends from, its parent first: one chain, since each Thread has one parent. */
  ancestors(thread: string): string[] {
    const edges = this.edges()
    const chain: string[] = []
    for (let edge = edges.of(thread); edge && chain.length < 10_000 && !chain.includes(edge.parent); edge = edges.of(edge.parent)) chain.push(edge.parent)
    return chain
  }

  /**
   * Keeps a child's report, once by its id: a repeat answers the first (`deduped`), and the same id with other words
   * is a conflict. A report from an owner older than one already heard from is refused (`stale`).
   */
  keepReport(input: Report): { report: Report; deduped: boolean } | { stale: true } {
    const report = ReportSchema.parse(input)
    return this.write(() => {
      const kept = this.sql("SELECT record FROM thread_reports WHERE id = ?").get(report.id)
      if (kept) {
        const first = ReportSchema.parse(JSON.parse(RecordRowSchema.parse(kept).record))
        if (first.status !== report.status || first.summary !== report.summary || first.child !== report.child) throw new ThreadOperationConflictError(report.id)
        return { report: first, deduped: true }
      }
      const newest = this.sql("SELECT record FROM thread_reports WHERE child_thread = ? ORDER BY rowid DESC LIMIT 1").get(report.child)
      if (newest && ReportSchema.parse(JSON.parse(RecordRowSchema.parse(newest).record)).ownerGeneration > report.ownerGeneration) return { stale: true }
      this.sql("INSERT INTO thread_reports (id, child_thread, record, at, delivered_at) VALUES (?, ?, ?, ?, ?)")
        .run(report.id, report.child, JSON.stringify(report), report.at, null)
      if (report.followUp) {
        const edge = this.edges().of(report.child)
        if (!edge || edge.closedAt !== undefined || edge.placed || edge.remote || !report.action?.trim() || report.question?.trim() || (report.status !== "done" && report.status !== "failed") || report.implicit)
          throw new ThreadOperationConflictError(report.id)
        const action: ReportAction = ReportActionSchema.parse({ report: report.id, child: report.child, parent: edge.parent,
          owner: edge.parent, target: report.followUp, action: report.action, version: 1, at: report.at, updatedAt: report.at, disposition: { kind: "pending" } })
        this.sql("INSERT INTO agent_report_actions (report, parent_thread, child_thread, pending, record) VALUES (?, ?, ?, 1, ?)")
          .run(report.id, edge.parent, edge.child, JSON.stringify(action))
      }
      return { report, deduped: false }
    })
  }

  /**
   * A child's reports in the order the store took them, oldest first; `after` leaves out those at or before it. A
   * report's `rowid` is that order: `at` can tie or run backward with the clock, and an id is its client's to choose.
   */
  reportsOf(child: string, after = 0): Report[] {
    this.syncVersion()
    return this.sql("SELECT record FROM thread_reports WHERE child_thread = ? AND at > ? ORDER BY rowid").all(child, after)
      .flatMap((row) => {
        const parsed = ReportSchema.safeParse(JSON.parse(RecordRowSchema.parse(row).record))
        return parsed.success ? [parsed.data] : []
      })
  }

  /** Report questions still owned by someone: notice delivery and later narration do not answer them. */
  openReportAsks(child: string): readonly Report[] {
    this.syncVersion()
    const known = this.depth === 0 ? this.reportAsksSeen.get(child) : undefined
    if (known) return known
    const reports = this.reportsOf(child)
    const answered = new Set(this.sql("SELECT ask FROM agent_answers WHERE child_thread = ?").all(child).map((row) => z.object({ ask: z.string() }).parse(row).ask))
    const superseded = new Set(reports.flatMap((report) => report.supersedes ?? []))
    const latest = reports.at(-1)
    const open = reports.filter((report) => (report.retainsQuestion || report === latest) && !report.implicit &&
      (report.status === "done" || report.status === "blocked" || report.status === "needs-input") && report.question?.trim() &&
      !answered.has(report.id) && !superseded.has(report.id))
    if (this.depth === 0) this.reportAsksSeen.set(child, open)
    return open
  }

  /** A follow-up's immutable report/target plus its current exact disposition. Never a delivery receipt. */
  reportAction(report: string): ReportAction | undefined {
    this.syncVersion()
    if (!this.sql("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_report_actions'").get()) return undefined
    const row = this.sql("SELECT record FROM agent_report_actions WHERE report = ?").get(report)
    return row ? ReportActionSchema.parse(JSON.parse(RecordRowSchema.parse(row).record)) : undefined
  }

  /** Bounded indexed projection. Resolved cursor rows remain addressable; clocks never determine page order. */
  reportActions(parent: string, children: readonly string[], after?: string): ReportActionsPage {
    this.syncVersion()
    if (!children.length || !this.sql("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_report_actions'").get()) return { items: [], total: 0 }
    return this.reportActionPage(`parent_thread = ? AND child_thread IN (${children.map(() => "?").join(",")})`, [parent, ...children], after)
  }

  /** Source Apex retains custody decisions even when source/receiver native work stops or is archived. */
  reportActionInbox(thread: string): ReportActionsPage {
    return this.reportActionPage("parent_thread = ? OR json_extract(record, '$.owner') = ?", [thread, thread])
  }

  /** A custodian can inspect only the explicit work assigned to itself, not sibling conversations. */
  reportCustody(owner: string, after?: string): ReportActionsPage {
    return this.reportActionPage("json_extract(record, '$.owner') = ? AND parent_thread <> ?", [owner, owner], after)
  }

  private reportActionPage(scope: string, args: string[], after?: string): ReportActionsPage {
    this.syncVersion()
    if (!this.sql("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_report_actions'").get()) return { items: [], total: 0 }
    const count = z.object({ count: z.number() })
    const total = count.parse(this.sql(`SELECT count(*) AS count FROM agent_report_actions WHERE (${scope}) AND pending = 1`).get(...args)).count
    const cursor = after === undefined ? undefined : this.sql(`SELECT rowid AS position FROM agent_report_actions WHERE report = ? AND (${scope})`).get(after, ...args)
    const position = cursor ? z.object({ position: z.number() }).parse(cursor).position : undefined
    if (after !== undefined && position === undefined) throw new ThreadOperationConflictError(after)
    const rows = this.sql(`SELECT record FROM agent_report_actions WHERE (${scope}) AND pending = 1 AND rowid > ? ORDER BY rowid LIMIT 9`).all(...args, position ?? 0)
    const items = rows.slice(0, 8).map(row => ReportActionSchema.parse(JSON.parse(RecordRowSchema.parse(row).record)))
    return { items, total, ...(rows.length > 8 && { next: items.at(-1)!.report }) }
  }

  hasReportActionOperation(op: string): boolean {
    this.syncVersion()
    return this.sql("SELECT 1 FROM agent_report_action_ops WHERE op = ?").get(op) !== undefined
  }

  /** One transaction owns the expected version and durable receipt; retries cannot settle siblings or successors. */
  resolveReportAction(input: { parent: string; child: string; report: string; version: number; target: ReportActionTarget;
    disposition: ReportDisposition; op: string; at: number }): { action: ReportAction; deduped?: true } {
    const target = ReportActionTargetSchema.parse(input.target)
    const disposition = ReportDispositionSchema.parse(input.disposition)
    const fingerprint = JSON.stringify({ parent: input.parent, child: input.child, report: input.report, version: input.version, target, disposition })
    return this.write(() => {
      const prior = this.sql("SELECT fingerprint, record FROM agent_report_action_ops WHERE op = ?").get(input.op)
      if (prior) {
        const kept = z.object({ fingerprint: z.string(), record: z.string() }).parse(prior)
        if (kept.fingerprint !== fingerprint) throw new ThreadOperationConflictError(input.op)
        return { action: ReportActionSchema.parse(JSON.parse(kept.record)), deduped: true as const }
      }
      const current = this.reportAction(input.report)
      const edge = this.edges().of(input.child)
      if (!current || current.parent !== input.parent || current.child !== input.child || edge?.parent !== input.parent ||
          current.version !== input.version || !pendingReportAction(current) || current.target.ref !== target.ref || current.target.version !== target.version)
        throw new ThreadOperationConflictError(input.op)
      if (disposition.kind === "supersede") {
        const next = this.reportAction(disposition.report)
        const position = this.sql("SELECT 1 AS newer FROM agent_report_actions a, agent_report_actions b WHERE a.report = ? AND b.report = ? AND b.rowid > a.rowid").get(input.report, disposition.report)
        if (!next || next.parent !== current.parent || next.child !== current.child || !pendingReportAction(next) || !position)
          throw new ThreadOperationConflictError(input.op)
      }
      const action = ReportActionSchema.parse({ ...current, version: current.version + 1, updatedAt: input.at, disposition,
        ...((disposition.kind === "dispatch" || disposition.kind === "handoff") && { owner: disposition.to, custody: disposition }),
        ...(disposition.kind === "reclaim" && { owner: current.parent, custody: undefined }) })
      const record = JSON.stringify(action)
      this.sql("UPDATE agent_report_actions SET pending = ?, record = ? WHERE report = ?").run(pendingReportAction(action) ? 1 : 0, record, input.report)
      this.sql("INSERT INTO agent_report_action_ops (op, fingerprint, record) VALUES (?, ?, ?)").run(input.op, fingerprint, record)
      return { action }
    })
  }

  /** Moves with every write to this store, this host's or another's, without reading a table. */
  /**
   * Where the store's placements stand: moves when a row's Thread or Session is new, changes or is forgotten here, or
   * another host commits, never on this host's other writes (`version` moves on every one). For a reader that holds
   * rows placed by it, such as attribution's catalog, which `version` threw away at every Thread's write.
   */
  placementVersion(): string {
    this.syncVersion()
    return `${this.reopened}:${this.dataVersion}:${this.placementEpoch}`
  }

  version(): string {
    this.syncVersion()
    // Connection's own counters: a snapshot reopened on a newer file starts them again, so the reopening has to count.
    return `${this.reopened}:${this.dataVersion}:${TotalChangesSchema.parse(this.sql("SELECT total_changes() AS count").get()).count}`
  }

  /**
   * The harness Sessions of every Thread's children, by the parent's Thread, oldest child first: one read, for whatever
   * walks many Sessions. One Apex's 54 children read once per child and per Session of its Thread held the host 175 ms.
   */
  childSessions(): ReadonlyMap<string, { harness: string; nativeId: string }[]> {
    const native = new Map<string, { harness: string; nativeId: string }[]>()
    const rows = this.sql(`SELECT m.thread_id, c.harness, c.native_id FROM native_claims c JOIN memberships m ON m.session_id = c.session_id
      WHERE c.device_id = ? AND m.thread_id IN (SELECT child_thread FROM thread_parents)
      UNION SELECT m.thread_id, s.harness, s.key AS native_id FROM sources s JOIN memberships m ON m.session_id = s.session_id
      WHERE s.device_id = ? AND m.thread_id IN (SELECT child_thread FROM thread_parents)`).all(this.deviceId, this.deviceId)
    for (const row of rows) {
      const { thread_id: thread, harness, native_id: nativeId } = ChildNativeRowSchema.parse(row)
      const held = native.get(thread)
      if (held) held.push({ harness, nativeId })
      else native.set(thread, [{ harness, nativeId }])
    }
    const children = new Map<string, { harness: string; nativeId: string }[]>()
    for (const edge of this.edges().all) {
      const claimed = native.get(edge.child) ?? (edge.run?.nativeId ? [{ harness: edge.run.harness, nativeId: edge.run.nativeId }] : [])
      if (!claimed.length) continue
      const held = children.get(edge.parent)
      if (held) held.push(...claimed)
      else children.set(edge.parent, [...claimed])
    }
    return children
  }

  /** Each child's newest report, by its Thread. */
  latestReports(): Map<string, Report> {
    this.syncVersion()
    const latest = new Map<string, Report>()
    for (const row of this.sql(`SELECT record FROM thread_reports r WHERE rowid = (SELECT max(rowid) FROM thread_reports WHERE child_thread = r.child_thread)`).all()) {
      const parsed = ReportSchema.safeParse(JSON.parse(RecordRowSchema.parse(row).record))
      if (parsed.success) latest.set(parsed.data.child, parsed.data)
    }
    return latest
  }

  /**
   * Reports and answers kept after `after` (the store's order of taking them, `rowid`), oldest first, with where they
   * leave off: what `latestReports` and `latestAnswers` would say differently since, read without reading them all.
   */
  keptSince(after: KeptMark): KeptSince {
    this.syncVersion()
    const mark = { ...after }
    const reports = this.sql("SELECT rowid AS seq, record FROM thread_reports WHERE rowid > ? ORDER BY rowid").all(after.reports).flatMap((row) => {
      const found = SeqRecordRowSchema.parse(row)
      mark.reports = Math.max(mark.reports, found.seq)
      const parsed = ReportSchema.safeParse(JSON.parse(found.record))
      return parsed.success ? [parsed.data] : []
    })
    const answers = this.sql("SELECT rowid AS seq, record, delivered_at FROM agent_answers WHERE rowid > ? ORDER BY rowid").all(after.answers).map((row) => {
      mark.answers = Math.max(mark.answers, SeqRecordRowSchema.parse(row).seq)
      return keptAnswer(row)
    })
    const titles = this.sql("SELECT seq, thread_id FROM title_changes WHERE seq > ? ORDER BY seq").all(after.titles).map((row) => TitleChangeRowSchema.parse(row))
    const lost = titles.length > 0 && titles[0]!.seq !== after.titles + 1 && after.titles > 0
    mark.titles = titles.at(-1)?.seq ?? mark.titles
    const journals = this.sql("SELECT j.rowid AS seq, m.thread_id FROM journals j JOIN memberships m ON m.session_id = j.session_id WHERE j.rowid > ? ORDER BY j.rowid").all(after.journals)
      .map((row) => JournalThreadRowSchema.parse(row))
    mark.journals = Math.max(mark.journals, ...journals.map((row) => row.seq))
    const threads = [...new Set([...titles.map((row) => row.thread_id), ...journals.map((row) => row.thread_id)])]
    return { reports, answers, threads, lost, mark }
  }

  /** A number that moves with every commit to the store, this host's or another's: what a reader's cache is good for. */
  moved(): number {
    this.syncVersion()
    return this.revision
  }

  /** Where `keptSince` begins for a reader that read every latest report and answer now. */
  keptMark(): KeptMark {
    this.syncVersion()
    const reports = SeqRowSchema.parse(this.sql("SELECT coalesce(max(rowid), 0) AS seq FROM thread_reports").get()).seq
    const answers = SeqRowSchema.parse(this.sql("SELECT coalesce(max(rowid), 0) AS seq FROM agent_answers").get()).seq
    const titles = SeqRowSchema.parse(this.sql("SELECT coalesce(max(seq), 0) AS seq FROM title_changes").get()).seq
    const journals = SeqRowSchema.parse(this.sql("SELECT coalesce(max(rowid), 0) AS seq FROM journals").get()).seq
    return { reports, answers, titles, journals }
  }

  /** Reports no parent has heard yet, oldest first: the outbox a starting host sends again under their ids. */
  undeliveredReports(): WaitingReport[] {
    this.syncVersion()
    return this.sql("SELECT record, wake_request FROM thread_reports WHERE delivered_at IS NULL ORDER BY rowid").all().flatMap((row) => {
      const found = ReportRowSchema.parse(row)
      const parsed = ReportSchema.safeParse(JSON.parse(found.record))
      return parsed.success ? [{ report: parsed.data, ...(found.wake_request && { wake: found.wake_request }) }] : []
    })
  }

  /** Names the request that will carry these reports, before it's sent; one already named keeps its own. */
  assignWake(ids: readonly string[], request: string): void {
    if (!ids.length) return
    this.write(() => {
      const assign = this.sql("UPDATE thread_reports SET wake_request = ? WHERE id = ? AND wake_request IS NULL AND delivered_at IS NULL")
      for (const id of ids) assign.run(request, id)
    })
  }

  /** The parent heard these reports, in the turn or step that carried them. */
  markReportsDelivered(ids: readonly string[], at: number): void {
    if (!ids.length) return
    this.write(() => {
      const mark = this.sql("UPDATE thread_reports SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL")
      for (const id of ids) mark.run(at, id)
    })
  }

  /**
   * Claims a question in a Fin's report for one answer, in one write: the answer kept, or the one that claimed it
   * first (`claimed: false`), whoever's it was. A repeat of the same operation is that first answer.
   */
  claimAnswer(input: KeptAnswer): { answer: KeptAnswer; claimed: boolean } {
    const answer = KeptAnswerSchema.parse(input)
    return this.write(() => {
      const held = this.sql("SELECT record, delivered_at FROM agent_answers WHERE ask = ?").get(answer.ask)
      if (held) return { answer: keptAnswer(held), claimed: false }
      this.sql("INSERT INTO agent_answers (ask, child_thread, op, record, at, delivered_at) VALUES (?, ?, ?, ?, ?, NULL)")
        .run(answer.ask, answer.child, answer.op, JSON.stringify(answer), answer.at)
      return { answer, claimed: true }
    })
  }

  /** The answer an operation claimed with, delivered or not. */
  answerByOp(op: string): KeptAnswer | undefined {
    this.syncVersion()
    const row = this.sql("SELECT record, delivered_at FROM agent_answers WHERE op = ?").get(op)
    return row ? keptAnswer(row) : undefined
  }

  /** The answer that took an ask, if one did. */
  answerOf(ask: string): KeptAnswer | undefined {
    this.syncVersion()
    const known = this.depth === 0 ? this.answersSeen.get(ask) : undefined
    if (known !== undefined) return known ?? undefined
    const row = this.sql("SELECT record, delivered_at FROM agent_answers WHERE ask = ?").get(ask)
    const answer = row ? keptAnswer(row) : undefined
    if (this.depth === 0) this.answersSeen.set(ask, answer ?? null)
    return answer
  }

  /** Each Fin's newest answer, by its Thread: the last one kept, whatever the clocks said. */
  latestAnswers(): Map<string, KeptAnswer> {
    this.syncVersion()
    const latest = new Map<string, KeptAnswer>()
    for (const row of this.sql("SELECT record, delivered_at FROM agent_answers a WHERE rowid = (SELECT max(rowid) FROM agent_answers WHERE child_thread = a.child_thread) ORDER BY at, ask").all()) {
      const answer = keptAnswer(row)
      latest.set(answer.child, answer)
    }
    return latest
  }

  /** Answers claimed and not yet delivered to their Fin, oldest first: what a starting host sends once. */
  undeliveredAnswers(): KeptAnswer[] {
    this.syncVersion()
    return this.sql("SELECT record, delivered_at FROM agent_answers WHERE delivered_at IS NULL ORDER BY at, ask").all().map(keptAnswer)
  }

  /** The answer reached its Fin's conversation. */
  markAnswerDelivered(ask: string, delivered: NonNullable<KeptAnswer["delivered"]>): void {
    this.write(() => {
      const held = this.sql("SELECT record, delivered_at FROM agent_answers WHERE ask = ? AND delivered_at IS NULL").get(ask)
      if (!held) return
      const answer = { ...keptAnswer(held), delivered }
      this.sql("UPDATE agent_answers SET record = ?, delivered_at = ? WHERE ask = ?").run(JSON.stringify(answer), delivered.at, ask)
    })
  }

  /** Lets go of a claim whose delivery failed, so another answer can take the ask; one delivered stays. */
  releaseAnswer(ask: string, op: string): void {
    this.write(() => this.sql("DELETE FROM agent_answers WHERE ask = ? AND op = ? AND delivered_at IS NULL").run(ask, op))
  }

  /** Claims a wait's one wake, in one write: the wake kept, or the one that claimed it first (`claimed: false`). */
  claimPullWake(input: KeptPullWake): { wake: KeptPullWake; claimed: boolean } {
    const wake = KeptPullWakeSchema.parse(input)
    return this.write(() => {
      const held = this.sql("SELECT record FROM agent_pull_wakes WHERE wait = ?").get(wake.wait)
      if (held) return { wake: keptPullWake(held), claimed: false }
      this.sql("INSERT INTO agent_pull_wakes (wait, child_thread, record, at, delivered_at) VALUES (?, ?, ?, ?, NULL)")
        .run(wake.wait, wake.child, JSON.stringify(wake), wake.at)
      return { wake, claimed: true }
    })
  }

  /** The waits of these Fins that woke them already. */
  pullWakesOf(children: readonly string[]): Set<string> {
    this.syncVersion()
    if (!children.length) return new Set()
    const rows = this.sql(`SELECT wait FROM agent_pull_wakes WHERE child_thread IN (${children.map(() => "?").join(", ")})`).all(...children)
    return new Set(rows.map((row) => z.object({ wait: z.string() }).parse(row).wait))
  }

  /** A Fin's durable outcome claims, including retired ones, for legacy-wait reconciliation. */
  pullWakesFor(child: string): KeptPullWake[] {
    this.syncVersion()
    return this.sql("SELECT record FROM agent_pull_wakes WHERE child_thread = ? ORDER BY at, wait").all(child).map(keptPullWake)
  }

  /** Wakes claimed and not yet delivered to their Fin, oldest first: what a starting host sends once. */
  undeliveredPullWakes(): KeptPullWake[] {
    this.syncVersion()
    return this.sql("SELECT record FROM agent_pull_wakes WHERE delivered_at IS NULL ORDER BY at, wait").all().map(keptPullWake)
  }

  /** The wake reached its Fin's conversation. */
  markPullWakeDelivered(wait: string, delivered: NonNullable<KeptPullWake["delivered"]>): void {
    this.write(() => {
      const held = this.sql("SELECT record FROM agent_pull_wakes WHERE wait = ? AND delivered_at IS NULL").get(wait)
      if (!held || keptPullWake(held).obsolete !== undefined) return
      this.sql("UPDATE agent_pull_wakes SET record = ?, delivered_at = ? WHERE wait = ?").run(JSON.stringify({ ...keptPullWake(held), delivered }), delivered.at, wait)
    })
  }

  /** A Fin's wake that its note goes as `request`. */
  pullWakeOfRequest(child: string, request: string): KeptPullWake | undefined {
    this.syncVersion()
    return this.sql("SELECT record FROM agent_pull_wakes WHERE child_thread = ?").all(child).map(keptPullWake).find((wake) => wake.request === request)
  }

  /** Retires a wake whose wait no longer holds: marked obsolete and as settled, so no start sends it again. */
  retirePullWake(wait: string, at: number): void {
    this.write(() => {
      const held = this.sql("SELECT record FROM agent_pull_wakes WHERE wait = ?").get(wait)
      if (!held) return
      const wake = keptPullWake(held)
      if (wake.obsolete !== undefined) return
      this.sql("UPDATE agent_pull_wakes SET record = ?, delivered_at = coalesce(delivered_at, ?) WHERE wait = ?").run(JSON.stringify({ ...wake, obsolete: at }), at, wait)
    })
  }

  /** Spawns waiting on a tree's running budget, oldest first. */
  queuedSpawns(): QueuedSpawn[] {
    this.syncVersion()
    // In the order they came: two spawns of one millisecond keep it.
    return this.sql(`SELECT op, tree, record, at, 0 AS away, rowid AS place FROM agent_spawns
      UNION ALL SELECT op, tree, record, at, 1 AS away, rowid AS place FROM agent_placings ORDER BY at, away, place`).all().map((row) => {
      const { op, tree, record, at, away } = QueuedSpawnRowSchema.parse(row)
      return { op, tree, record, at, ...(away === 1 && { away: true as const }) }
    })
  }

  /** Holds a spawn for its tree's budget; a repeat of one held keeps its place. */
  queueSpawn(spawn: QueuedSpawn): void {
    this.write(() => this.sql(`INSERT OR IGNORE INTO ${spawn.away ? "agent_placings" : "agent_spawns"} (op, tree, record, at) VALUES (?, ?, ?, ?)`).run(spawn.op, spawn.tree, spawn.record, spawn.at))
  }

  /** Rewrites a held spawn's record in its place in line: one that couldn't start, kept until its Apex has heard why. */
  keepQueuedSpawn(op: string, record: string): void {
    this.write(() => {
      this.sql("UPDATE agent_spawns SET record = ? WHERE op = ?").run(record, op)
      this.sql("UPDATE agent_placings SET record = ? WHERE op = ?").run(record, op)
    })
  }

  unqueueSpawn(op: string): void {
    this.write(() => {
      this.sql("DELETE FROM agent_spawns WHERE op = ?").run(op)
      this.sql("DELETE FROM agent_placings WHERE op = ?").run(op)
    })
  }

  /**
   * Migration 6 from migration 5: each background agent becomes its Session's Thread's edge under the Thread of the
   * Session it worked for. Its Session is the one the catalog placed for its harness Session, placed here if it never
   * was. An ended one's end becomes its last report, already heard, so no parent wakes for history; a stopped one
   * closes its edge; one still running keeps being followed, by its pid and the exit file its run folder holds. One
   * #286 never matched to a Session can't be shown as a Thread and goes. Then the table goes. Once the store knows its
   * device, in one transaction keyed by each row's ID, so a second open finds nothing to move.
   */
  private migrateBackgroundAgents(): void {
    if (!this.sql("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'background_agents'").get()) return
    const counts = { edges: 0, ended: 0, running: 0, dropped: 0 }
    const actor: Actor = { kind: "service", name: "migration" }
    const now = this.now()
    const taken = new Map<string, Set<string>>()
    for (const row of this.sql("SELECT record FROM background_agents ORDER BY started_at, id").all()) {
      const parsed = LegacyBackgroundAgentSchema.safeParse(JSON.parse(RecordRowSchema.parse(row).record))
      const agent = parsed.success ? parsed.data : undefined
      const parentSession = agent && this.canonical(agent.parent)
      if (!agent?.nativeId || !parentSession) {
        counts.dropped += 1
        continue
      }
      let session = this.nativeSession(agent.harness, agent.nativeId)
      if (!session) {
        session = this.mintSingleton("imported", null, actor)
        this.sql("INSERT OR IGNORE INTO sources (device_id, harness, key, session_id, first_seen_at) VALUES (?, ?, ?, ?, ?)").run(agent.device, agent.harness, agent.nativeId, session, now)
      }
      const child = this.placeSession(session).thread
      const parent = this.placeSession(parentSession).thread
      if (child === parent) {
        counts.dropped += 1
        continue
      }
      const names = taken.get(parent) ?? new Set(this.sql("SELECT name FROM thread_parents WHERE parent_thread = ?").all(parent).map((found) => z.object({ name: z.string() }).parse(found).name))
      taken.set(parent, names)
      const name = uniqueName(agent.title, names)
      names.add(name)
      const ended = agent.ended
      const edge: ThreadParent = {
        child,
        parent,
        parentSession: SessionIdSchema.parse(parentSession),
        name,
        role: "worker",
        origin: agent.origin,
        asked: { brief: { objective: agent.detail || agent.title || agent.harness }, harness: agent.harness, ...(agent.model && { model: agent.model }) },
        op: `migrated:${agent.id}`,
        startedBy: { kind: "agent", session: SessionIdSchema.parse(parentSession) },
        createdAt: agent.startedAt,
        ...(ended?.kind === "stopped" && { closedAt: ended.at }),
        run: {
          harness: agent.harness,
          nativeId: agent.nativeId,
          device: agent.device,
          ...(agent.process && { process: agent.process }),
          ...(agent.runDir && { runDir: agent.runDir }),
          startedAt: agent.startedAt,
          ...(ended && { ended }),
        },
      }
      const inserted = this.sql(`INSERT OR IGNORE INTO thread_parents (child_thread, parent_thread, name, op, run_harness, run_native_id, record, created_at, closed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(child, parent, name, edge.op, agent.harness, agent.nativeId, JSON.stringify(ThreadParentSchema.parse(edge)), edge.createdAt, edge.closedAt ?? null)
      if (!inserted.changes) {
        counts.dropped += 1
        continue
      }
      counts.edges += 1
      if (!ended) {
        counts.running += 1
        continue
      }
      counts.ended += 1
      if (ended.kind === "stopped") continue
      const report: Report = {
        id: `report:${child}:migrated`,
        child,
        status: ended.kind === "done" ? "done" : "failed",
        summary: ended.detail ?? (ended.kind === "unknown" ? "It ended without saying how it went (unknown)." : ended.kind === "done" ? "It finished." : "It failed."),
        implicit: true,
        ownerGeneration: 1,
        at: ended.at,
      }
      this.sql("INSERT OR IGNORE INTO thread_reports (id, child_thread, record, at, delivered_at) VALUES (?, ?, ?, ?, ?)").run(report.id, child, JSON.stringify(ReportSchema.parse(report)), report.at, now)
    }
    this.db.exec("DROP TABLE background_agents")
    hostLog("agents", "migrated background agents", counts)
  }

  /** The conversations that are `session`, following merges. */
  conversationsOf(session: string): string[] {
    this.syncVersion()
    return this.journalsOf(this.canonical(session) ?? session)
  }

  /** One Thread's group, following merges; undefined while it has one Session. */
  group(id: ThreadId): ThreadGroup | undefined {
    const thread = this.thread(id)
    if (!thread || thread.sessions.length < 2) return undefined
    return ThreadGroupSchema.parse({
      id: thread.id,
      sessions: thread.sessions.map((session) => {
        const row = this.sessionRow(session)
        const started = Boolean(this.sql("SELECT 1 AS found FROM journals WHERE session_id = ? UNION ALL SELECT 1 FROM sources WHERE session_id = ? LIMIT 1").get(session, session))
        return groupMember(session, row.origin, started, row.parent_session)
      }),
    })
  }

  /**
   * Record the checkout a Thread was started in; the first one recorded for
   * the Thread on this device stays. A checkout of a project folder holding
   * several repositories names each one's worktree in `repositories`.
   */
  attachWorktree(input: Omit<ThreadWorktree, "createdAt">, repositories: readonly WorktreeRepository[] = []): void {
    const thread = this.thread(input.thread)
    if (!thread) throw new Error("This Thread no longer exists")
    let added = false
    this.write(() => {
      added = this.sql("INSERT OR IGNORE INTO thread_worktrees (path, thread_id, device_id, repo_root, project, branch, base, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(input.path, thread.id, this.deviceId, input.repoRoot, input.project, input.branch, input.base, this.now()).changes > 0
      if (!added) return
      for (const repository of repositories)
        this.sql("INSERT OR IGNORE INTO thread_worktree_repositories (path, checkout, repo_root, base) VALUES (?, ?, ?, ?)").run(repository.path, input.path, repository.repoRoot, repository.base)
    })
    if (added) this.worktreesMoved()
  }

  /** Hears this device's worktrees change here (one added, moved home, forgotten); returns how to stop hearing. */
  onWorktrees(listener: () => void): () => void {
    this.worktreeListeners.add(listener)
    return () => this.worktreeListeners.delete(listener)
  }

  private worktreesMoved(): void {
    for (const listener of this.worktreeListeners) listener()
  }

  /**
   * This device's worktrees, each with the Thread it belongs to now. A
   * checkout of several repositories lists each one's worktree, with the
   * project folder as `project`.
   */
  worktrees(): ThreadWorktree[] {
    // Every summary, status and read of a worktree asks: read once per commit, as `groups` is.
    this.syncVersion()
    const held = this.worktreesSeen
    if (held && held.revision === this.revision && this.depth === 0) return [...held.worktrees]
    const worktrees = this.readWorktrees()
    if (this.depth === 0) this.worktreesSeen = { revision: this.revision, worktrees }
    return [...worktrees]
  }

  private readWorktrees(): ThreadWorktree[] {
    const repositories = new Map<string, WorktreeRepository[]>()
    for (const found of this.sql("SELECT path, checkout, repo_root, base FROM thread_worktree_repositories ORDER BY path").all()) {
      const row = WorktreeRepositoryRowSchema.parse(found)
      repositories.set(row.checkout, [...repositories.get(row.checkout) ?? [], { path: row.path, repoRoot: row.repo_root, base: row.base }])
    }
    return this.sql("SELECT path, thread_id, repo_root, project, branch, base, created_at FROM thread_worktrees WHERE device_id = ? ORDER BY created_at")
      .all(this.deviceId)
      .flatMap((found) => {
        const row = WorktreeRowSchema.parse(found)
        const worktree: ThreadWorktree = {
          path: row.path,
          thread: this.thread(ThreadIdSchema.parse(row.thread_id))?.id ?? ThreadIdSchema.parse(row.thread_id),
          repoRoot: row.repo_root,
          project: row.project,
          branch: row.branch,
          base: row.base,
          createdAt: row.created_at,
        }
        const inside = repositories.get(row.path)
        return inside ? inside.map((repository) => ({ ...worktree, ...repository })) : [worktree]
      })
  }

  /**
   * The Thread whose place `thread` works in: the owner of the worktree it shares (`thread_places`), following
   * merges, or itself. A worktree's row stays with its owner; every Thread in the place finds it here.
   */
  placeOf(thread: ThreadId): ThreadId {
    let current = this.thread(thread)?.id ?? thread
    for (let hops = 0; hops < 16; hops += 1) {
      const found = this.sql("SELECT place_thread FROM thread_places WHERE thread_id = ?").get(current)
      if (!found) return current
      const next = this.thread(ThreadIdSchema.parse(z.object({ place_thread: z.string() }).parse(found).place_thread))?.id
      if (!next || next === current) return current
      current = next
    }
    return current
  }

  /** The Threads a split made, each with the Thread and Session it came from, for a window carrying what it kept by Thread. */
  threadSplits(): { thread: ThreadId; from: ThreadId; session: SessionId; fromTitle?: string }[] {
    return this.sql("SELECT thread_id, from_thread, session_id, from_title FROM thread_splits ORDER BY from_thread, position").all().map((row) => {
      const found = z.object({ thread_id: z.string(), from_thread: z.string(), session_id: z.string(), from_title: z.string().nullable() }).parse(row)
      return { thread: ThreadIdSchema.parse(found.thread_id), from: ThreadIdSchema.parse(found.from_thread), session: SessionIdSchema.parse(found.session_id), ...(found.from_title !== null && { fromTitle: found.from_title }) }
    })
  }

  /** A Thread of its own for a fork or a second conversation, in `source`'s place. */
  private mintBeside(source: string, why: "fork" | "new", origin: SessionOrigin, parent: string | null, actor: Actor, owner: ExecutionOwner = this.self, id?: SessionId): string {
    const session = this.mintSession(origin, parent, actor, owner, id)
    const thread = randomUUID()
    this.sql("INSERT INTO threads (id, owner_id, created_at, created_by) VALUES (?, ?, ?, ?)").run(thread, this.localPrincipal, this.now(), JSON.stringify(actor))
    this.addMember(ThreadIdSchema.parse(thread), session, actor)
    this.sql("INSERT OR REPLACE INTO thread_places (thread_id, place_thread, why, created_at) VALUES (?, ?, ?, ?)")
      .run(thread, this.placeOf(ThreadIdSchema.parse(source)), why, this.now())
    return session
  }

  /** Record what Mako started a Thread for; the first purpose recorded for it stays. */
  markPurpose(thread: ThreadId, kind: ThreadPurposeKind, project: string): void {
    const current = this.thread(thread)
    if (!current) throw new Error("This Thread no longer exists")
    this.write(() => {
      this.sql("INSERT OR IGNORE INTO thread_purposes (thread_id, purpose, project, created_at) VALUES (?, ?, ?, ?)").run(current.id, kind, project, this.now())
    })
  }

  /**
   * Every Thread Mako started for a purpose this build knows, under the
   * Thread it belongs to now. Two that were merged keep the earlier purpose.
   */
  purposes(): ThreadPurpose[] {
    const found = new Map<string, ThreadPurpose>()
    for (const row of this.sql("SELECT thread_id, purpose, project, created_at FROM thread_purposes ORDER BY created_at").all()) {
      const parsed = PurposeRowSchema.parse(row)
      const kind = PurposeKindSchema.safeParse(parsed.purpose)
      const thread = this.thread(ThreadIdSchema.parse(parsed.thread_id))
      if (!kind.success || !thread || found.has(thread.id)) continue
      found.set(thread.id, { thread: thread.id, kind: kind.data, project: parsed.project, createdAt: parsed.created_at })
    }
    return [...found.values()]
  }

  /** An app's values on this device, marked as used now. */
  useEnvironment(app: AppKey): ThreadEnvironmentValues | undefined {
    return this.write(() => {
      this.sql("UPDATE app_environments SET used_at = ? WHERE app = ? AND device_id = ?").run(this.now(), app, this.deviceId)
      return this.environmentRow(app)
    })
  }

  /** An app's values on this device, without marking them used, for a view. */
  environment(app: AppKey): ThreadEnvironmentValues | undefined {
    return this.environmentRow(app)
  }

  /** Every value held on this device, least recently used first. */
  heldEnvironments(): ThreadEnvironmentValues[] {
    return this.sql("SELECT app, host, port, used_at FROM app_environments WHERE device_id = ? ORDER BY used_at, app")
      .all(this.deviceId)
      .map((found) => environmentValues(EnvironmentRowSchema.parse(found)))
  }

  /**
   * Hold `host` and `port` for an app, first giving up `reclaim`'s values if
   * named. An app that already has values keeps them. Undefined when another
   * host took the name or the port first; choose again.
   */
  claimEnvironment(input: { app: AppKey; host: string; port: number; reclaim?: AppKey }): ThreadEnvironmentValues | undefined {
    try {
      return this.write(() => {
        const held = this.environmentRow(input.app)
        if (held) return held
        if (input.reclaim) this.sql("DELETE FROM app_environments WHERE app = ? AND device_id = ?").run(input.reclaim, this.deviceId)
        const inserted = this.sql("INSERT OR IGNORE INTO app_environments (app, device_id, host, port, created_at, used_at) VALUES (?, ?, ?, ?, ?, ?)")
          .run(input.app, this.deviceId, input.host, input.port, this.now(), this.now())
        // Rolls back the reclaim too: its app keeps its values when this claim fails.
        if (!inserted.changes) throw new EnvironmentTaken()
        return this.environmentRow(input.app)
      })
    } catch (error) {
      if (error instanceof EnvironmentTaken) return undefined
      throw error
    }
  }

  private environmentRow(app: AppKey): ThreadEnvironmentValues | undefined {
    const found = this.sql("SELECT app, host, port, used_at FROM app_environments WHERE app = ? AND device_id = ?").get(app, this.deviceId)
    return found ? environmentValues(EnvironmentRowSchema.parse(found)) : undefined
  }

  /**
   * A worktree whose main checkout moved: the repository it belongs to now, and the folder its Thread was started
   * from, at the same place inside it.
   */
  rehomeWorktree(path: string, repoRoot: string, project: string): void {
    this.write(() => {
      this.sql("UPDATE thread_worktrees SET repo_root = ?, project = ? WHERE path = ? AND device_id = ?").run(repoRoot, project, path, this.deviceId)
    })
    this.worktreesMoved()
  }

  /** Forget a worktree; a checkout of several repositories goes with the last of its worktrees, or at once by its own folder. */
  detachWorktree(path: string): void {
    this.write(() => {
      const found = this.sql("SELECT checkout FROM thread_worktree_repositories WHERE path = ?").get(path)
      const checkout = found ? z.object({ checkout: z.string() }).parse(found).checkout : path
      this.sql("DELETE FROM thread_worktree_repositories WHERE path = ?").run(path)
      if (checkout !== path && this.sql("SELECT 1 AS found FROM thread_worktree_repositories WHERE checkout = ? LIMIT 1").get(checkout)) return
      this.sql("DELETE FROM thread_worktree_repositories WHERE checkout = ?").run(checkout)
      const owner = this.sql("SELECT thread_id FROM thread_worktrees WHERE path = ? AND device_id = ?").get(checkout, this.deviceId)
      this.sql("DELETE FROM thread_worktrees WHERE path = ? AND device_id = ?").run(checkout, this.deviceId)
      // The place is gone: a Thread that shared it doesn't inherit the owner's next worktree.
      if (owner && !this.sql("SELECT 1 AS found FROM thread_worktrees WHERE thread_id = ?").get(MembershipRowSchema.parse(owner).thread_id))
        this.sql("DELETE FROM thread_places WHERE place_thread = ?").run(MembershipRowSchema.parse(owner).thread_id)
    })
    this.worktreesMoved()
  }

  /**
   * Resolve catalog rows, minting a Session and a singleton Thread for any
   * native session seen for the first time. Rows whose path a journal or
   * earlier row recorded go first, so an alias in the same batch finds the
   * identity its sibling registered.
   */
  resolveRefs(refs: readonly SourceRef[], actor: Actor): Map<string, ThreadPlacement> {
    this.syncVersion()
    const located = refs.map((ref) => ({ ref, path: this.realPath(ref.path) }))
    const placed = !this.writable ? this.recordedPlacements(located) : this.write(() => {
      const known = located.filter((entry) => this.locator(entry.path))
      const unknown = parentsFirst(located.filter((entry) => !this.locator(entry.path)))
      const result = new Map<string, ThreadPlacement>()
      for (const entry of [...known, ...unknown])
        result.set(entry.ref.path, this.placeSession(this.resolveOne({ ...entry.ref, path: entry.path }, actor)))
      return result
    })
    // A later row in the batch can merge an earlier row's Session, so every
    // row is read back after the last write.
    for (const ref of refs) {
      const session = placed.get(ref.path)?.session
      const current = session && this.sessionPlacement(session)
      if (!current) continue
      placed.set(ref.path, current)
      this.remember(placementKey(ref), current)
    }
    return placed
  }

  /** Rows another host placed, without placing the rest. */
  private recordedPlacements(located: readonly { ref: SourceRef; path: string }[]): Map<string, ThreadPlacement> {
    const placed = new Map<string, ThreadPlacement>()
    for (const entry of located) {
      const { bySource, byPath, claimed } = this.recorded({ ...entry.ref, path: entry.path })
      const session = bySource ?? byPath ?? claimed
      if (session) placed.set(entry.ref.path, this.placeSession(session))
    }
    return placed
  }

  /**
   * A served row's placement, answered from memory after the first time.
   * A commit that changes a Session's Thread, from any host, forgets that
   * Session's rows only.
   */
  place(ref: SourceRef, actor: Actor): ThreadPlacement {
    const placed = this.placeMany([ref], actor).get(ref.path)
    if (!placed) throw new Error("The Thread store did not place a catalog row")
    return placed
  }

  /**
   * Rows served together, checked against other hosts' commits once. Only
   * rows never placed, or whose Session changed Thread, touch the database,
   * in transactions of `PLACE_BATCH` rows, parents before their forks. When
   * a batch fails, the rows placed so far are still returned; the rest are
   * placed the next time they're served.
   */
  placeMany(refs: readonly SourceRef[], actor: Actor): Map<string, ThreadPlacement> {
    this.syncVersion()
    const placed = new Map<string, ThreadPlacement>()
    const missing: SourceRef[] = []
    for (const ref of refs) {
      const cached = this.placements.get(placementKey(ref))
      if (cached) placed.set(ref.path, cached)
      else missing.push(ref)
    }
    const ordered = parentsFirst(missing.map((ref) => ({ ref }))).map(({ ref }) => ref)
    for (let start = 0; start < ordered.length; start += PLACE_BATCH) {
      try {
        for (const [path, found] of this.resolveRefs(ordered.slice(start, start + PLACE_BATCH), actor)) placed.set(path, found)
      } catch (error) {
        if (!placed.size) throw error
        hostWarn("threads", "some rows were served without their Thread", { unplaced: ordered.length - start, error: error instanceof Error ? error.message : String(error) })
        break
      }
    }
    return placed
  }

  /**
   * Sessions whose Thread another host changed since the last call, or
   * `"all"` when this host fell further behind than the change log keeps.
   * Reads `PRAGMA data_version`, which costs a look at shared memory.
   */
  takeExternalChanges(): SessionId[] | "all" | undefined {
    this.syncVersion()
    if (this.externalAll) {
      this.externalAll = false
      this.external.clear()
      return "all"
    }
    if (!this.external.size) return undefined
    const sessions = [...this.external].map((session) => SessionIdSchema.parse(session))
    this.external.clear()
    return sessions
  }

  /** Where a Session belongs now, following merges. */
  sessionPlacement(session: SessionId): ThreadPlacement | undefined {
    const current = this.canonical(session)
    return current ? this.placeSession(current) : undefined
  }

  thread(id: ThreadId): ThreadRecord | undefined {
    if (this.depth > 0) return this.readThread(id)
    this.syncVersion()
    const known = this.threadsSeen.get(id)
    if (known !== undefined) return known ?? undefined
    const read = this.readThread(id)
    this.threadsSeen.set(id, read ?? null)
    return read
  }

  private readThread(id: ThreadId): ThreadRecord | undefined {
    let current: string | null = id
    for (let hops = 0; current && hops < 64; hops += 1) {
      const found = this.sql("SELECT id, owner_id, title, title_source, revision, merged_into FROM threads WHERE id = ?").get(current)
      if (!found) return undefined
      const row = ThreadRowSchema.parse(found)
      if (row.merged_into) { current = row.merged_into; continue }
      const sessions = this.sql("SELECT session_id FROM memberships WHERE thread_id = ? ORDER BY position, session_id").all(row.id)
        .map((member) => SessionIdSchema.parse(SessionRowSchema.parse(member).session_id))
      return {
        id: ThreadIdSchema.parse(row.id),
        owner: PrincipalIdSchema.parse(row.owner_id),
        title: row.title ?? undefined,
        titleSource: row.title_source ?? undefined,
        revision: row.revision,
        sessions,
      }
    }
    return undefined
  }

  /**
   * What a Session holds: its journals, oldest first, and the native
   * sessions this device's catalog placed in it, by path. A Session with a
   * journal is that conversation; one without is a native session alone.
   */
  sessionContents(session: SessionId) {
    const natives = this.sql("SELECT path, harness FROM locators WHERE device_id = ? AND session_id = ? AND origin = 'catalog' ORDER BY path")
      .all(this.deviceId, session)
      .map((row) => LocatorPathRowSchema.parse(row))
    return { conversations: this.journalsOf(session), natives }
  }

  /**
   * A new, empty Session in an existing Thread: the `+` tab. It exists before
   * anything is sent so its draft and chips have an identity; its first
   * journal registers into it by ID.
   */
  createSession(input: { operationId: string; thread: ThreadId; actor: Actor; session?: SessionId }): ThreadPlacement {
    const content: OperationContent = input.session ? { thread: input.thread, session: input.session } : { thread: input.thread }
    return this.write(() => this.receipt(input.operationId, "create-session", content, input.actor, () => {
      const thread = this.thread(input.thread)
      if (!thread) throw new Error("That Thread no longer exists")
      // A Thread that runs elsewhere (moved to the cloud) gains its new Session there, under the same owner; one that is
      // moving gains none until the move ends.
      const away = this.awayOwner(thread.sessions)
      if (this.oneConversation) {
        // A second conversation is a Thread of its own, beside this one.
        const session = this.mintBeside(thread.id, "new", "new", null, input.actor, away, input.session)
        return this.placeSession(session)
      }
      const session = this.mintSession("new", null, input.actor, away, input.session)
      this.addMember(thread.id, session, input.actor)
      this.sql("UPDATE threads SET revision = revision + 1 WHERE id = ?").run(thread.id)
      return { thread: thread.id, session: SessionIdSchema.parse(session) }
    }, PlacementSchema))
  }

  private bumpRevisions(threads: readonly ThreadId[]): void {
    this.sql(`UPDATE threads SET revision = revision + 1 WHERE id IN (${threads.map(() => "?").join(", ")})`).run(...threads)
  }

  /**
   * The person's name for the Thread as a whole: the rail shows it, and
   * each Session keeps its own title on its tab. `original` is the name the
   * row showed, kept if the Thread had none recorded.
   */
  renameThread(input: { operationId: string; thread: ThreadId; title: string; actor: Actor; original?: string }): ThreadRecord {
    const title = input.title.trim()
    if (!title) throw new Error("A Thread title cannot be empty")
    return this.write(() => {
      this.receipt(input.operationId, "rename-thread", { thread: input.thread, title }, input.actor, () => {
        const thread = this.thread(input.thread)
        if (!thread) throw new Error("That Thread no longer exists")
        this.sql(`UPDATE threads SET title = ?, title_source = 'user', original_title = coalesce(original_title, ?),
          title_revision = title_revision + 1, revision = revision + 1 WHERE id = ?`)
          .run(title, input.original?.trim() || null, thread.id)
        return { thread: thread.id }
      }, z.object({ thread: ThreadIdSchema }))
      const renamed = this.thread(input.thread)
      if (!renamed) throw new Error("That Thread no longer exists")
      return renamed
    })
  }

  /** Drop the Thread's own name; its row shows its first Session's title again. */
  clearThreadTitle(input: { operationId: string; thread: ThreadId; actor: Actor }): ThreadTitleEntry {
    return this.write(() => {
      const cleared = this.receipt(input.operationId, "clear-thread-title", { thread: input.thread }, input.actor, () => {
        const thread = this.thread(input.thread)
        if (!thread) throw new Error("That Thread no longer exists")
        this.sql(`UPDATE threads SET title = NULL, title_source = NULL, title_revision = title_revision + 1,
          revision = revision + 1 WHERE id = ?`).run(thread.id)
        return { thread: thread.id }
      }, z.object({ thread: ThreadIdSchema }))
      return this.titleEntry(cleared.thread) ?? { thread: cleared.thread, title: null }
    })
  }

  /**
   * A name Mako chose for a Thread it started (a setup Thread's), which its
   * agent's titles don't replace. A Thread that already has a name of its
   * own keeps it.
   */
  keepThreadTitle(thread: ThreadId, title: string): ThreadTitleEntry | undefined {
    const name = title.trim()
    if (!name) return undefined
    return this.write(() => {
      const current = this.thread(thread)
      if (!current) return undefined
      this.sql(`UPDATE threads SET title = ?, title_source = 'frozen', title_revision = title_revision + 1
        WHERE id = ? AND ${UNNAMED}`).run(name, current.id)
      return this.titleEntry(current.id)
    })
  }

  /**
   * Names people gave Threads before the store kept them (a window's own
   * renames). Each is the person's, and only a Thread with no name of its
   * own takes one, so importing twice, or after a rename, changes nothing.
   */
  importThreadTitles(entries: ReadonlyArray<{ thread: ThreadId; title: string }>): ThreadTitleEntry[] {
    if (!entries.length) return []
    return this.write(() => {
      const changed: ThreadTitleEntry[] = []
      for (const entry of entries) {
        const current = this.thread(entry.thread)
        const title = entry.title.trim()
        if (!current || !title) continue
        const updated = this.sql(`UPDATE threads SET title = ?, title_source = 'user', title_revision = title_revision + 1
          WHERE id = ? AND ${UNNAMED}`).run(title, current.id)
        const found = updated.changes ? this.titleEntry(current.id) : undefined
        if (found) changed.push(found)
      }
      return changed
    })
  }

  /** Every Thread with a name of its own. */
  titles(): ThreadTitleEntry[] {
    return this.sql(`${TITLE_ROW} WHERE merged_into IS NULL AND NOT ${UNNAMED}`).all()
      .map((row) => titleEntry(TitleRowSchema.parse(row)))
  }

  /** One Thread's name, following merges; `title: null` when it has none. */
  titleEntry(id: ThreadId): ThreadTitleEntry | undefined {
    const thread = this.thread(id)
    const row = thread && this.titleRow(thread.id)
    return row ? titleEntry(row) : undefined
  }

  /**
   * Threads whose name another host changed since the last call, as they
   * read now. Costs a look at shared memory when nothing changed.
   */
  takeExternalTitles(): ThreadTitleEntry[] {
    this.syncVersion()
    if (!this.externalTitles.size) return []
    const threads = [...this.externalTitles]
    this.externalTitles.clear()
    return threads.flatMap((id) => {
      const row = this.titleRow(id)
      return row ? [titleEntry(row)] : []
    })
  }

  /** The name a Thread showed before Mako or a person first named it, when one was recorded. */
  originalTitle(id: ThreadId): string | undefined {
    const thread = this.thread(id)
    const found = thread && this.sql("SELECT original_title FROM threads WHERE id = ?").get(thread.id)
    return found ? z.object({ original_title: z.string().nullable() }).parse(found).original_title ?? undefined : undefined
  }

  private titleRow(id: string): TitleRow | undefined {
    const found = this.sql(`${TITLE_ROW} WHERE id = ?`).get(id)
    return found ? TitleRowSchema.parse(found) : undefined
  }

  /** Who may execute a Session now, following merges; undefined for a Session this store never saw. */
  execution(session: SessionId): SessionExecution | undefined {
    return this.executionsOf([session]).get(session)
  }

  /**
   * Who may execute each of `sessions` now, as `execution` says it, the ones this store never saw left out: read in one
   * query, then answered from memory until any commit, this host's or another's (`revision`). A report of every Session
   * in the sync window asks this once, not once a row.
   */
  executionsOf(sessions: Iterable<SessionId>): Map<SessionId, SessionExecution> {
    this.syncVersion()
    const remember = this.depth === 0
    const found = new Map<SessionId, SessionExecution>()
    const unread = new Set<SessionId>()
    for (const session of sessions) {
      if (!remember || !this.executionsSeen.has(session)) unread.add(session)
      else {
        const known = this.executionsSeen.get(session)
        if (known) found.set(session, known)
      }
    }
    if (!unread.size) return found
    const read = new Map<string, SessionExecution>()
    const rows = this.sql(`SELECT s.id, s.merged_into, e.session_id AS held, e.owner_kind, e.owner_id, e.generation, e.move_id
      FROM sessions s LEFT JOIN executions e ON e.session_id = s.id WHERE s.id IN (SELECT value FROM json_each(?))`).all(JSON.stringify([...unread]))
    for (const row of rows) {
      const parsed = SessionExecutionRowSchema.parse(row)
      if (parsed.merged_into) {
        const current = this.canonical(parsed.id)
        if (current) read.set(parsed.id, this.executionState(current))
      } else read.set(parsed.id, this.executionFrom(parsed.held === null || parsed.generation === null ? undefined : { ...parsed, generation: parsed.generation }))
    }
    for (const session of unread) {
      const execution = read.get(session)
      if (remember) this.executionsSeen.set(session, execution ?? null)
      if (execution) found.set(session, execution)
    }
    return found
  }

  /**
   * The Session each of `sessions` that is a fork was forked from, the rest left out: read in one query, then answered
   * from memory until any commit (`revision`), as `executionsOf` is.
   */
  forksOf(sessions: Iterable<SessionId>): Map<SessionId, SessionId> {
    this.syncVersion()
    const remember = this.depth === 0
    const found = new Map<SessionId, SessionId>()
    const unread = new Set<SessionId>()
    for (const session of sessions) {
      if (!remember || !this.forksSeen.has(session)) unread.add(session)
      else {
        const known = this.forksSeen.get(session)
        if (known) found.set(session, known)
      }
    }
    if (!unread.size) return found
    const read = new Map<string, SessionId>()
    const rows = this.sql("SELECT id, parent_session FROM sessions WHERE origin = 'fork' AND parent_session IS NOT NULL AND id IN (SELECT value FROM json_each(?))").all(JSON.stringify([...unread]))
    for (const row of rows) {
      const parsed = ForkRowSchema.parse(row)
      read.set(parsed.id, SessionIdSchema.parse(parsed.parent_session))
    }
    for (const session of unread) {
      const parent = read.get(session)
      if (remember) this.forksSeen.set(session, parent ?? null)
      if (parent) found.set(session, parent)
    }
    return found
  }

  /**
   * Each of `threads`' name and where it came from, following merges, the ones this store never saw left out: read in
   * one query, then answered from memory until any commit (`revision`), as `executionsOf` is.
   */
  titlesOf(threads: Iterable<ThreadId>): Map<ThreadId, ThreadTitle> {
    this.syncVersion()
    const remember = this.depth === 0
    const found = new Map<ThreadId, ThreadTitle>()
    const unread = new Set<ThreadId>()
    for (const thread of threads) {
      if (!remember || !this.titlesSeen.has(thread)) unread.add(thread)
      else {
        const known = this.titlesSeen.get(thread)
        if (known) found.set(thread, known)
      }
    }
    if (!unread.size) return found
    const read = new Map<string, ThreadTitle>()
    const rows = this.sql("SELECT id, title, title_source, merged_into FROM threads WHERE id IN (SELECT value FROM json_each(?))").all(JSON.stringify([...unread]))
    for (const row of rows) {
      const parsed = ThreadTitleRowSchema.parse(row)
      const record = parsed.merged_into ? this.thread(ThreadIdSchema.parse(parsed.id)) : undefined
      if (parsed.merged_into && !record) continue
      const title = record ? record.title : (parsed.title ?? undefined)
      const titleSource = record ? record.titleSource : (parsed.title_source ?? undefined)
      read.set(parsed.id, { ...title !== undefined && { title }, ...titleSource !== undefined && { titleSource } })
    }
    for (const thread of unread) {
      const title = read.get(thread)
      if (remember) this.titlesSeen.set(thread, title ?? null)
      if (title) found.set(thread, title)
    }
    return found
  }

  /**
   * Each Thread's conversations, Session by Session in the Thread's order, each Session's journals oldest first: what
   * `thread(id).sessions` and `conversationsOf` say, read for all of `threads` in two queries and answered from memory
   * until any commit. A roster reads every Fin's this way on each look, and read one Fin at a time it was four queries a
   * Fin a look: on a day of 226 Fins and a store other Makos commit to all day, seconds of the host's loop. A Thread
   * merged into another, or holding a merged Session, is read as `thread` and `conversationsOf` read it. `alongside`:
   * Threads read with them when any must be read, so the next look at one of those reads nothing.
   */
  threadConversations(threads: Iterable<string>, alongside?: () => Iterable<string>): Map<string, string[][]> {
    this.syncVersion()
    const remember = this.depth === 0
    const found = new Map<string, string[][]>()
    const unread = new Set<string>()
    for (const thread of threads) {
      const known = remember ? this.conversationsSeen.get(thread) : undefined
      if (known) found.set(thread, known)
      else unread.add(thread)
    }
    if (!unread.size) return found
    const asked = new Set(unread)
    if (remember && alongside) for (const thread of alongside()) if (!this.conversationsSeen.has(thread)) unread.add(thread)
    const ids = JSON.stringify([...unread])
    const merged = new Set<string>()
    const rows = new Map<string, z.infer<typeof ThreadRowSchema>>()
    for (const row of this.sql("SELECT id, owner_id, title, title_source, revision, merged_into FROM threads WHERE id IN (SELECT value FROM json_each(?))").all(ids)) {
      const parsed = ThreadRowSchema.parse(row)
      rows.set(parsed.id, parsed)
      if (parsed.merged_into) merged.add(parsed.id)
    }
    const read = new Map<string, { session: string; conversations: string[] }[]>()
    for (const row of this.sql(`SELECT m.thread_id AS thread, m.session_id AS session, s.merged_into AS merged, j.conversation_id AS conversation
      FROM memberships m LEFT JOIN sessions s ON s.id = m.session_id LEFT JOIN journals j ON j.session_id = m.session_id
      WHERE m.thread_id IN (SELECT value FROM json_each(?))
      ORDER BY m.thread_id, m.position, m.session_id, j.created_at, j.conversation_id`).all(ids)) {
      const parsed = ThreadConversationRowSchema.parse(row)
      if (parsed.merged) merged.add(parsed.thread)
      const sessions = read.get(parsed.thread) ?? []
      read.set(parsed.thread, sessions)
      const last = sessions.at(-1)
      const session = last?.session === parsed.session ? last : { session: parsed.session, conversations: [] }
      if (session !== last) sessions.push(session)
      if (parsed.conversation) session.conversations.push(parsed.conversation)
    }
    for (const thread of unread) {
      const row = rows.get(thread)
      if (!row) continue
      // The same read is the Thread's record, as `thread` reads it, so a roster's next look at it reads nothing.
      if (remember && !merged.has(thread) && !this.threadsSeen.has(thread))
        this.threadsSeen.set(thread, {
          id: ThreadIdSchema.parse(row.id), owner: PrincipalIdSchema.parse(row.owner_id),
          title: row.title ?? undefined, titleSource: row.title_source ?? undefined,
          revision: row.revision, sessions: (read.get(thread) ?? []).map((session) => SessionIdSchema.parse(session.session)),
        })
      const conversations = merged.has(thread)
        ? (this.thread(ThreadIdSchema.parse(thread))?.sessions ?? []).map((session) => this.conversationsOf(session))
        : (read.get(thread) ?? []).map((session) => session.conversations)
      if (remember) this.conversationsSeen.set(thread, conversations)
      if (asked.has(thread)) found.set(thread, conversations)
    }
    return found
  }

  /**
   * Who may execute a journal's Session, answered from memory until any
   * commit. A journal the store has not registered yet is new work here,
   * unless its bindings name a Session this store knows.
   */
  journalExecution(facts: JournalFacts): SessionExecution {
    this.syncVersion()
    const cached = this.executions.get(facts.conversationId)
    if (cached) return cached
    const known = this.sql("SELECT session_id FROM journals WHERE conversation_id = ?").get(facts.conversationId)
    if (known) {
      const session = SessionRowSchema.parse(known).session_id
      const found = this.executionState(this.canonical(session) ?? session)
      this.executions.set(facts.conversationId, found)
      return found
    }
    // A new journal that names a native session this device recorded, by
    // path or by ID alone, answers to that Session's owner.
    const candidates = facts.session
      ? [facts.session]
      : facts.ancestry
        ? []
        : [this.findJournalSession(facts), ...facts.bindings.flatMap((binding) =>
          binding.nativeId ? this.nativeSessions(binding.provider, binding.nativeId) : [])]
    const executions = [...new Set(candidates.flatMap((session) => {
      const current = session && this.canonical(session)
      return current ? [current] : []
    }))].map((session) => this.executionState(session))
    return executions.find((execution) => execution.state !== "here")
      ?? executions[0]
      ?? { state: "here", owner: this.self, generation: 1 }
  }

  /**
   * Start moving a Thread to another environment. Every Session in it must
   * run here with no move open. Nothing changes owner yet: running turns
   * finish and new work waits until the move is released or cancelled.
   */
  beginMove(input: { move: MoveId; thread: ThreadId; target: ExecutionOwner; actor: Actor }): MoveBegan {
    const target = ExecutionOwnerSchema.parse(input.target)
    if (sameOwner(target, this.self)) throw new Error("This Thread already runs here")
    return this.write(() => this.receipt(input.move, "begin-move", { thread: input.thread, move: input.move, target }, input.actor, () => {
      const thread = this.thread(input.thread)
      if (!thread) throw new Error("That Thread no longer exists")
      const open = this.sql("SELECT id FROM moves WHERE thread_id = ? AND phase IN ('leaving', 'released')").get(thread.id)
      if (open) throw new ThreadMoveConflictError(MoveIdSchema.parse(z.object({ id: z.string() }).parse(open).id))
      for (const session of thread.sessions) {
        const execution = this.executionState(session)
        if (execution.state !== "here")
          throw new Error(executionRefusal(execution) ?? "A Session in this Thread is already moving")
      }
      this.insertMove({ move: input.move, thread: thread.id, source: this.self, target, phase: "leaving", handoff: null, outcome: null, actor: input.actor })
      for (const session of thread.sessions) {
        const execution = this.executionState(session)
        this.setExecution(session, this.self, execution.generation, input.move, input.actor)
      }
      return { move: input.move, thread: thread.id, sessions: thread.sessions }
    }, MoveBeganSchema))
  }

  moveStatus(move: MoveId): MoveStatus | undefined {
    const row = this.moveRow(MoveIdSchema.parse(move))
    return row && { phase: row.phase, thread: ThreadIdSchema.parse(row.thread_id), target: ownerFrom(row.target_kind, row.target_id) }
  }

  /**
   * The move's Sessions with their journals and the native sessions this
   * device recorded for them, for the host to prove quiet before release.
   */
  moveJournals(move: MoveId): MovingSession[] {
    return this.sql("SELECT session_id FROM executions WHERE move_id = ? ORDER BY session_id").all(move)
      .map((row) => this.movingSession(SessionRowSchema.parse(row).session_id))
  }

  /** A Thread's Sessions as a move would carry them, in tab order, before any move begins. */
  threadSessions(thread: ThreadId): MovingSession[] {
    return (this.thread(thread)?.sessions ?? []).map((session) => this.movingSession(session))
  }

  private movingSession(session: string): MovingSession {
    const natives = this.sql(`SELECT harness, native_id FROM locators WHERE device_id = ? AND session_id = ? AND native_id IS NOT NULL
      UNION SELECT harness, native_id FROM native_claims WHERE device_id = ? AND session_id = ?`).all(this.deviceId, session, this.deviceId, session)
      .map((native) => NativeRowSchema.parse(native))
      .map((native) => ({ harness: native.harness, nativeId: native.native_id }))
    return { session: SessionIdSchema.parse(session), journals: this.journalsOf(session), natives }
  }

  /**
   * A Thread and its Sessions as a handoff names them, each at the generation it has here: what a Thread coming back
   * from elsewhere is claimed as, with every Session it has now, those it gained there included.
   */
  threadHandoff(id: ThreadId): Pick<Handoff, "thread" | "sessions"> {
    const thread = this.thread(id)
    if (!thread) throw new Error("That Thread no longer exists")
    return {
      thread: this.handoffThread(thread),
      sessions: thread.sessions.map((session) => this.handoffSession(session, this.executionState(session).generation)),
    }
  }

  private handoffThread(thread: ThreadRecord): Handoff["thread"] {
    const original = this.originalTitle(thread.id)
    const named: Handoff["thread"] = { id: thread.id, owner: thread.owner, title: thread.title, titleSource: thread.titleSource }
    if (original) named.originalTitle = original
    return named
  }

  private handoffSession(session: string, generation: number): Handoff["sessions"][number] {
    const row = this.sessionRow(session)
    const position = z.object({ position: z.number() })
      .parse(this.sql("SELECT position FROM memberships WHERE session_id = ?").get(session)).position
    const entry: Handoff["sessions"][number] = {
      id: SessionIdSchema.parse(session),
      origin: SessionOriginSchema.parse(row.origin),
      position,
      generation,
      journals: this.journalsOf(session),
    }
    if (row.parent_session) entry.parent = SessionIdSchema.parse(row.parent_session)
    return entry
  }

  /** Keep the Thread here: a move that was never released changes nothing. */
  cancelMove(input: { operationId: string; move: MoveId; actor: Actor }): void {
    this.write(() => this.receipt(input.operationId, "cancel-move", { move: input.move }, input.actor, () => {
      const move = this.leavingMove(input.move)
      for (const { session } of this.moveJournals(move.id)) {
        const execution = this.executionState(session)
        this.setExecution(session, this.self, execution.generation, null, input.actor)
      }
      this.setMovePhase(move.id, "cancelled", {})
      return { move: move.id }
    }, MovedSchema))
  }

  /**
   * Give up the Thread: from this commit nothing here may run its Sessions,
   * whatever happens to the handoff. The host calls this only once every
   * journal is quiet and its provider is closed. Replaying the operation
   * returns the same handoff.
   */
  release(input: { operationId: string; move: MoveId; actor: Actor }): Handoff {
    return this.write(() => this.receipt(input.operationId, "release-move", { move: input.move }, input.actor, () => {
      const move = this.leavingMove(input.move)
      const thread = this.thread(ThreadIdSchema.parse(move.thread_id))
      if (!thread) throw new Error("That Thread no longer exists")
      const moving = new Set(this.moveJournals(move.id).map((entry) => entry.session))
      if (thread.sessions.length !== moving.size || thread.sessions.some((session) => !moving.has(session)))
        throw new Error("This Thread's Sessions changed while it was moving; cancel the move and start again")
      const sessions = thread.sessions.map((session) => {
        const generation = this.executionState(session).generation + 1
        this.setExecution(session, null, generation, move.id, input.actor)
        return this.handoffSession(session, generation)
      })
      const moved = this.handoffThread(thread)
      const handoff = HandoffSchema.parse({
        move: move.id,
        source: this.self,
        target: ownerFrom(move.target_kind, move.target_id),
        releasedAt: this.now(),
        thread: moved,
        sessions,
      })
      this.setMovePhase(move.id, "released", { handoff: JSON.stringify(handoff) })
      return handoff
    }, HandoffSchema))
  }

  /**
   * Take ownership of a released Thread under the same identities. A move is
   * claimed at most once: claiming it again returns the first receipt, and a
   * move this store refused is never claimed.
   */
  claim(input: { operationId: string; handoff: Handoff; actor: Actor }): ClaimReceipt {
    const handoff = HandoffSchema.parse(input.handoff)
    if (!sameOwner(handoff.target, this.self)) throw new Error("This handoff is addressed to another environment")
    return this.takeHandoff(input.operationId, handoff, input.actor)
  }

  /**
   * A cloud machine's store taking the Thread that moved to it, under the handoff's identities: the Thread, its
   * Sessions in their places and their journals, each Session run here one generation on, so a conversation opened
   * as the move arrives is filed in its own Session, and a tab or fork begun here later sits beside it in the same
   * Thread, under the same IDs the device's store has. The handoff names the cloud runtime the gateway made this
   * machine for (only the Thread's device reaches the machine, through the gateway); the store, made before the
   * machine knew its Thread, runs as itself. Taken once per move: asked again, the first answer.
   */
  takeArrival(input: { operationId: string; handoff: Handoff; actor: Actor }): ClaimReceipt {
    const handoff = HandoffSchema.parse(input.handoff)
    if (handoff.target.kind !== "cloud") throw new Error("This handoff is addressed to a device, not a cloud machine")
    return this.takeHandoff(input.operationId, handoff, input.actor)
  }

  private takeHandoff(operationId: string, handoff: Handoff, actor: Actor): ClaimReceipt {
    return this.write(() => {
      const known = this.moveRow(handoff.move)
      if (known?.phase === "arrived" && known.outcome) return ClaimReceiptSchema.parse(JSON.parse(known.outcome))
      if (known) throw new Error(`This move was already ${known.phase} here`)
      return this.receipt(operationId, "claim-move", { move: handoff.move, thread: handoff.thread.id }, actor, () => {
        for (const session of handoff.sessions) {
          const found = this.sql("SELECT id, origin, parent_session, created_at, merged_into FROM sessions WHERE id = ?").get(session.id)
          if (!found) continue
          if (SessionDetailSchema.parse(found).merged_into) throw new Error("A Session in this handoff was merged here")
          const execution = this.executionState(session.id)
          if (execution.state === "here" || execution.state === "leaving")
            throw new Error("A Session in this handoff already runs here")
          if (execution.generation >= session.generation)
            throw new Error("This handoff is older than what this store knows about its Sessions")
        }
        this.acceptThread(handoff, actor)
        const receipt = ClaimReceiptSchema.parse({
          move: handoff.move,
          owner: this.self,
          sessions: handoff.sessions.map((session) => ({ id: session.id, generation: session.generation + 1 })),
        })
        for (const session of receipt.sessions) this.setExecution(session.id, this.self, session.generation, null, actor)
        this.recordArrival(handoff, "arrived", JSON.stringify(receipt), actor)
        return receipt
      }, ClaimReceiptSchema)
    })
  }

  /**
   * Decline a released Thread for good, so its source may take it back. A
   * move already claimed here cannot be refused.
   */
  refuse(input: { operationId: string; handoff: Handoff; reason: string; actor: Actor }): Refusal {
    const handoff = HandoffSchema.parse(input.handoff)
    if (!sameOwner(handoff.target, this.self)) throw new Error("This handoff is addressed to another environment")
    return this.write(() => {
      const known = this.moveRow(handoff.move)
      if (known?.phase === "refused" && known.outcome) return RefusalSchema.parse(JSON.parse(known.outcome))
      if (known) throw new Error(`This move was already ${known.phase} here`)
      return this.receipt(input.operationId, "refuse-move", { move: handoff.move }, input.actor, () => {
        const refusal = RefusalSchema.parse({ move: handoff.move, by: this.self, reason: input.reason })
        this.recordArrival(handoff, "refused", JSON.stringify(refusal), input.actor)
        return refusal
      }, RefusalSchema)
    })
  }

  /** The source learns the destination claimed the Thread; its Sessions run there now. */
  confirm(input: { operationId: string; receipt: ClaimReceipt; actor: Actor }): void {
    const receipt = ClaimReceiptSchema.parse(input.receipt)
    this.write(() => this.receipt(input.operationId, "confirm-move", { move: receipt.move }, input.actor, () => {
      const { move, handoff } = this.releasedMove(receipt.move)
      // Already arrived when the Thread came back before this receipt did.
      if (move.phase === "arrived") return { move: move.id }
      if (move.phase === "reclaimed") throw new Error("This Thread was taken back after its destination refused it")
      if (!sameOwner(receipt.owner, handoff.target)) throw new Error("This receipt is from an environment the Thread was not sent to")
      for (const session of handoff.sessions) {
        const claimed = receipt.sessions.find((entry) => entry.id === session.id)
        if (claimed?.generation !== session.generation + 1) throw new Error("This receipt does not match the handoff")
        this.setExecution(session.id, receipt.owner, claimed.generation, null, input.actor)
      }
      this.setMovePhase(move.id, "arrived", { outcome: JSON.stringify(receipt) })
      return { move: move.id }
    }, MovedSchema))
  }

  /** The destination refused the Thread for good; it runs here again. */
  reclaim(input: { operationId: string; refusal: Refusal; actor: Actor }): void {
    const refusal = RefusalSchema.parse(input.refusal)
    this.write(() => this.receipt(input.operationId, "reclaim-move", { move: refusal.move }, input.actor, () => {
      const { move, handoff } = this.releasedMove(refusal.move)
      if (move.phase === "reclaimed") return { move: move.id }
      if (move.phase === "arrived") throw new Error("This Thread's destination already claimed it")
      if (!sameOwner(refusal.by, handoff.target)) throw new Error("This refusal is from an environment the Thread was not sent to")
      for (const session of handoff.sessions) this.setExecution(session.id, this.self, session.generation + 1, null, input.actor)
      this.setMovePhase(move.id, "reclaimed", { outcome: JSON.stringify(refusal) })
      return { move: move.id }
    }, MovedSchema))
  }

  private registerOne(facts: JournalFacts, actor: Actor): string {
    const known = this.sql("SELECT session_id FROM journals WHERE conversation_id = ?").get(facts.conversationId)
    if (known) {
      const session = SessionRowSchema.parse(known).session_id
      return this.attach(facts, session, actor)
    }
    const session = this.startedIn(facts) ?? (facts.ancestry
      ? this.mintDescendant(facts.ancestry, actor)
      : this.findJournalSession(facts) ?? this.mintSingleton(facts.threadPath ? "captured" : "started", null, actor))
    this.sql("INSERT INTO journals (conversation_id, session_id, created_at, registered_at) VALUES (?, ?, ?, ?)").run(facts.conversationId, session, facts.createdAt, this.now())
    return this.attach(facts, session, actor)
  }

  /**
   * A path identifies one native session wherever it was recorded. A bare
   * native ID is trusted only against another binding that had no path: two
   * stores can share an ID (a Cursor agent and its `chats/` copy) and differ
   * in path and catalog identity.
   */
  private findJournalSession(facts: JournalFacts): string | undefined {
    for (const path of this.journalPaths(facts)) {
      const found = this.locator(path.path)
      if (found && compatible(found, path)) return found.session_id
    }
    for (const binding of facts.bindings) {
      if (binding.path || !binding.nativeId) continue
      const found = this.nativeClaim(binding.provider, binding.nativeId) ?? this.source(binding.provider, binding.nativeId)
      if (found) return found
    }
    return undefined
  }

  /** Record what the journal's bindings name; a different owner is reconciled. */
  private attach(facts: JournalFacts, session: string, actor: Actor): string {
    let current = session
    for (const path of this.journalPaths(facts)) {
      const found = this.locator(path.path)
      if (!found) {
        this.sql("INSERT INTO locators (device_id, path, harness, native_id, session_id, origin) VALUES (?, ?, ?, ?, ?, 'journal')")
          .run(this.deviceId, path.path, path.harness, path.nativeId ?? null, current)
        continue
      }
      if (found.session_id === current || !compatible(found, path)) continue
      current = this.reconcile(current, found.session_id, `journal ${facts.conversationId} and another record share ${path.harness} path`, actor)
    }
    for (const binding of facts.bindings) {
      if (binding.path || !binding.nativeId) continue
      const found = this.nativeClaim(binding.provider, binding.nativeId)
      if (!found) {
        this.sql("INSERT INTO native_claims (device_id, harness, native_id, session_id) VALUES (?, ?, ?, ?)").run(this.deviceId, binding.provider, binding.nativeId, current)
        continue
      }
      if (found !== current)
        current = this.reconcile(current, found, `journal ${facts.conversationId} and another record share a ${binding.provider} native session`, actor)
    }
    return current
  }

  private journalPaths(facts: JournalFacts): JournalPath[] {
    const paths: JournalPath[] = facts.bindings.flatMap((binding) =>
      binding.path ? [{ path: this.realPath(binding.path), harness: binding.provider, nativeId: binding.nativeId }] : [])
    // A fork's thread path is its parent's; it identifies nothing of its own.
    const threadPath = facts.threadPath && !facts.ancestry ? this.realPath(facts.threadPath) : undefined
    if (threadPath && !paths.some((entry) => entry.path === threadPath))
      paths.push({ path: threadPath, harness: facts.harness })
    return paths
  }

  /** What this device recorded for a catalog row, by its identity, its path and its native claim. */
  private recorded(ref: SourceRef) {
    const key = ref.identity ?? ref.nativeId
    const located = this.locator(ref.path)
    const byPath = located && compatible(located, ref) ? located.session_id : undefined
    const bySource = this.source(ref.harness, key)
    // A pathless binding's claim speaks only for rows without a distinct
    // identity; a Cursor `chats/` copy never answers to its agent's claim.
    const claimed = key === ref.nativeId ? this.nativeClaim(ref.harness, ref.nativeId) : undefined
    return { key, located, byPath, bySource, claimed }
  }

  private resolveOne(ref: SourceRef, actor: Actor): string {
    const { key, located, byPath, bySource, claimed } = this.recorded(ref)
    let session = bySource ?? byPath ?? claimed
    for (const other of [byPath, claimed])
      if (session && other && other !== session)
        session = this.reconcile(session, other, `${ref.harness} catalog row's path, identity and native claims name different Sessions`, actor)
    if (session) this.adoptFork(session, ref, actor)
    session ??= this.mintImported(ref, actor)
    if (!bySource)
      this.sql("INSERT INTO sources (device_id, harness, key, session_id, first_seen_at) VALUES (?, ?, ?, ?, ?)").run(this.deviceId, ref.harness, key, session, this.now())
    if (!located)
      this.sql("INSERT INTO locators (device_id, path, harness, native_id, session_id, origin) VALUES (?, ?, ?, ?, ?, 'catalog')")
        .run(this.deviceId, ref.path, ref.harness, ref.nativeId, session)
    return session
  }

  /**
   * A native session seen for the first time. A fork its harness made joins
   * its parent's Thread as the last tab, the way a fork made in Mako does,
   * unless that Thread is moving or runs elsewhere.
   */
  private mintImported(ref: SourceRef, actor: Actor): string {
    const parent = ref.parentNativeId ? this.nativeSession(ref.harness, ref.parentNativeId) : undefined
    if (!parent) return this.mintSingleton("imported", null, actor)
    const home = this.placeSession(parent).thread
    if (this.oneConversation) return this.mintBeside(home, "fork", "imported", parent, actor)
    const here = this.thread(home)?.sessions.every((member) => this.executionState(member).state === "here")
    if (!here) return this.mintSingleton("imported", parent, actor)
    const session = this.mintSession("imported", parent, actor)
    this.addMember(home, session, actor)
    this.bumpRevisions([home])
    return session
  }

  /**
   * A harness fork imported before its row named a parent stands alone.
   * It joins its parent's Thread once, if nothing depends on it standing
   * alone: never adopted or split before (no parent recorded), alone in an
   * untitled Thread, and no Mako conversation of its own.
   */
  private adoptFork(session: string, ref: SourceRef, actor: Actor): void {
    if (!ref.parentNativeId || this.oneConversation) return
    const current = this.canonical(session)
    if (!current) return
    const row = this.sessionRow(current)
    if (row.origin !== "imported" || row.parent_session || !this.mergeable(current) || this.hasJournals(current)) return
    const parent = this.nativeSession(ref.harness, ref.parentNativeId)
    if (!parent || parent === current || this.descends(parent, current)) return
    const own = this.placeSession(current).thread
    const home = this.placeSession(parent).thread
    if (home === own || !this.thread(home)?.sessions.every((member) => this.executionState(member).state === "here")) return
    this.sql("UPDATE sessions SET parent_session = ? WHERE id = ?").run(parent, current)
    const next = CountSchema.parse(this.sql("SELECT coalesce(max(position) + 1, 0) AS count FROM memberships WHERE thread_id = ?").get(home)).count
    this.sql("UPDATE memberships SET thread_id = ?, position = ?, added_at = ?, added_by = ? WHERE session_id = ?").run(home, next, this.now(), JSON.stringify(actor), current)
    this.sql("UPDATE threads SET merged_into = ? WHERE id = ?").run(home, own)
    this.keepOneWorktreePerThread()
    this.bumpRevisions([home])
  }

  /** The Session behind a native id of this device, however it was first recorded. */
  private nativeSession(harness: string, nativeId: string): string | undefined {
    const found = this.source(harness, nativeId) ?? this.nativeClaim(harness, nativeId) ?? this.locatedNative(harness, nativeId)
    return found ? this.canonical(found) : undefined
  }

  private hasJournals(session: string): boolean {
    return CountSchema.parse(this.sql("SELECT count(*) AS count FROM journals WHERE session_id = ?").get(session)).count > 0
  }

  private locatedNative(harness: string, nativeId: string): string | undefined {
    const found = this.sql("SELECT session_id FROM locators WHERE device_id = ? AND harness = ? AND native_id = ? LIMIT 1").get(this.deviceId, harness, nativeId)
    return found ? SessionRowSchema.parse(found).session_id : undefined
  }

  /**
   * Two Sessions claim one native session. The one that nothing structural
   * depends on joins the other: a Session alone in an untitled Thread, not a
   * fork, child or `+` Session, and not an ancestor of the other. Anything
   * else stays as it is and is reported, never merged by guesswork.
   */
  private reconcile(first: string, second: string, reason: string, actor: Actor): string {
    const a = this.canonical(first)
    const b = this.canonical(second)
    if (!a || !b) throw new Error("A Session in the Thread store has no record")
    if (a === b) return a
    const loser = this.mergeLoser(a, b)
    if (!loser) {
      this.conflict(a, b, reason)
      return a
    }
    const winner = loser === a ? b : a
    this.merge(loser, winner, reason, actor)
    return winner
  }

  private mergeLoser(a: string, b: string): string | undefined {
    if (this.descends(a, b) || this.descends(b, a)) return undefined
    const candidates = [a, b].filter((session) => this.mergeable(session))
    if (candidates.length < 2) return candidates[0]
    // Keep the Session with journals, then the one whose record is oldest:
    // Sessions minted in one migration share a creation time, their journals
    // do not.
    const [left, right] = candidates.map((session) => {
      const journals = FirstJournalSchema.parse(this.sql("SELECT count(*) AS count, min(created_at) AS first FROM journals WHERE session_id = ?").get(session))
      return { session, journals: journals.count, first: journals.first ?? this.sessionRow(session).created_at }
    })
    if (!left || !right) return undefined
    if ((left.journals > 0) !== (right.journals > 0)) return left.journals > 0 ? right.session : left.session
    if (left.first !== right.first) return left.first > right.first ? left.session : right.session
    return left.session > right.session ? left.session : right.session
  }

  private mergeable(session: string): boolean {
    const row = this.sessionRow(session)
    if (row.merged_into || row.origin === "fork" || row.origin === "new") return false
    // A Session that ever moved, or is moving, keeps its identity: another
    // environment may hold records of it.
    const execution = this.executionState(session)
    if (execution.state !== "here" || execution.generation !== 1) return false
    // A harness-made fork the catalog found before Mako's own record of it:
    // only its tab depends on it.
    if (row.origin === "imported" && row.parent_session && !this.hasJournals(session)) return true
    const membership = this.sql("SELECT thread_id FROM memberships WHERE session_id = ?").get(session)
    if (!membership) return false
    const threadId = MembershipRowSchema.parse(membership).thread_id
    const thread = ThreadRowSchema.parse(this.sql("SELECT id, owner_id, title, title_source, revision, merged_into FROM threads WHERE id = ?").get(threadId))
    if (thread.title !== null || thread.merged_into) return false
    return CountSchema.parse(this.sql("SELECT count(*) AS count FROM memberships WHERE thread_id = ?").get(threadId)).count === 1
  }

  private descends(session: string, ancestor: string): boolean {
    let current = this.sessionRow(session).parent_session
    for (let hops = 0; current && hops < 64; hops += 1) {
      if (current === ancestor) return true
      current = this.sessionRow(current).parent_session
    }
    return false
  }

  private merge(loser: string, winner: string, reason: string, actor: Actor): void {
    const membership = MembershipRowSchema.parse(this.sql("SELECT thread_id FROM memberships WHERE session_id = ?").get(loser))
    const winnerThread = this.placeSession(winner).thread
    for (const table of ["journals", "sources", "locators", "native_claims"])
      this.sql(`UPDATE ${table} SET session_id = ? WHERE session_id = ?`).run(winner, loser)
    this.sql("UPDATE sessions SET parent_session = ? WHERE parent_session = ?").run(winner, loser)
    this.sql("DELETE FROM memberships WHERE session_id = ?").run(loser)
    this.sql("UPDATE sessions SET merged_into = ? WHERE id = ?").run(winner, loser)
    // A loser that shared its Thread leaves only its tab; the Thread stays.
    const left = CountSchema.parse(this.sql("SELECT count(*) AS count FROM memberships WHERE thread_id = ?").get(membership.thread_id)).count
    if (!left && membership.thread_id !== winnerThread) {
      this.sql("UPDATE threads SET merged_into = ? WHERE id = ?").run(winnerThread, membership.thread_id)
      this.keepOneWorktreePerThread()
    }
    this.sql("INSERT INTO operations (id, kind, digest, actor, result, at) VALUES (?, 'merge', ?, ?, ?, ?)")
      .run(randomUUID(), JSON.stringify({ loser, winner, reason }), JSON.stringify(actor), JSON.stringify({ session: winner }), this.now())
    this.forgetPlacements()
    this.executions.clear()
  }

  private conflict(a: string, b: string, reason: string): void {
    const pair = [a, b].sort().join("\n")
    if (this.reported.has(pair)) return
    this.reported.add(pair)
    this.conflicts.push({ sessions: [SessionIdSchema.parse(a), SessionIdSchema.parse(b)], reason })
    hostWarn("threads", "two Sessions claim one native session; neither was merged", { sessions: `${a} ${b}`, reason })
  }

  /**
   * The Session a `+` tab's first send started in. A journal naming a Session
   * this store never held (the store was recreated) is placed as if it named
   * none: throwing would fail every journal registered in the same batch.
   */
  private startedIn(facts: JournalFacts): string | undefined {
    if (!facts.session) return undefined
    const session = this.canonical(facts.session)
    if (!session)
      hostWarn("threads", "a journal names a Session this store doesn't have; placing it by its records", { conversation: facts.conversationId })
    return session
  }

  /**
   * A fork. Its inherited history names its parent's native session, so only
   * the link to the parent counts, never a match through it. A fork made to
   * join its parent's Thread does so when it can.
   */
  private mintDescendant(ancestry: NonNullable<JournalFacts["ancestry"]>, actor: Actor): string {
    const found = this.sql("SELECT session_id FROM journals WHERE conversation_id = ?").get(ancestry.parentId)
    const parent = found ? this.canonical(SessionRowSchema.parse(found).session_id) ?? null : null
    if (this.oneConversation && parent) return this.mintBeside(this.placeSession(parent).thread, "fork", "fork", parent, actor, this.self, ancestry.session)
    const home = parent && ancestry.placement === "parent-thread" ? this.forkHome(parent) : undefined
    if (!home) return this.mintSingleton("fork", parent, actor, ancestry.session)
    const session = this.mintSession("fork", parent, actor, this.self, ancestry.session)
    this.addMember(home, session, actor)
    this.sql("UPDATE threads SET revision = revision + 1 WHERE id = ?").run(home)
    return session
  }

  /**
   * The Thread a new fork of `parent` joins: the parent's, unless any Session
   * there runs elsewhere or is moving. A release checks that the moving set
   * is unchanged, so a Thread in transit takes no new member.
   */
  private forkHome(parent: string): ThreadId | undefined {
    const thread = this.thread(this.placeSession(parent).thread)
    if (!thread) return undefined
    return thread.sessions.every((member) => this.executionState(member).state === "here") ? thread.id : undefined
  }

  private mintSingleton(origin: SessionOrigin, parent: string | null, actor: Actor, id?: SessionId): string {
    const session = this.mintSession(origin, parent, actor, this.self, id)
    const thread = randomUUID()
    this.sql("INSERT INTO threads (id, owner_id, created_at, created_by) VALUES (?, ?, ?, ?)")
      .run(thread, this.localPrincipal, this.now(), JSON.stringify(actor))
    this.addMember(ThreadIdSchema.parse(thread), session, actor)
    return session
  }

  /** `owner`: where it runs when that isn't here (a Session its Thread gains in the cloud). */
  /** `id`: the one the Thread's other place gave it, so the two stores name it alike; else a new one. */
  private mintSession(origin: SessionOrigin, parent: string | null, actor: Actor, owner: ExecutionOwner = this.self, id?: SessionId): string {
    const session = id ?? randomUUID()
    if (id && this.sql("SELECT id FROM sessions WHERE id = ?").get(id)) {
      // Said with where it is, so a collision between two stores' IDs names both ends.
      const row = z.object({ origin: z.string(), parent_session: z.string().nullable(), merged_into: z.string().nullable() }).partial().safeParse(this.sql("SELECT origin, parent_session, merged_into FROM sessions WHERE id = ?").get(id)).data
      const member = this.sql("SELECT thread_id FROM memberships WHERE session_id = ?").get(id)
      throw new Error(`A Session with that ID exists here already: ${id} (${row?.origin ?? "?"}${row?.parent_session ? `, a fork of ${row.parent_session}` : ""}${row?.merged_into ? `, merged into ${row.merged_into}` : ""}, ${member ? `in Thread ${MembershipRowSchema.parse(member).thread_id}` : "in no Thread"})`)
    }
    this.sql("INSERT INTO sessions (id, origin, parent_session, created_at, created_by) VALUES (?, ?, ?, ?, ?)")
      .run(session, origin, parent, this.now(), JSON.stringify(actor))
    this.setExecution(session, owner, 1, null, actor)
    return session
  }

  /**
   * Where a Thread's Sessions run, for a Session it gains: here, or the one owner they all have elsewhere. Refuses a
   * Thread that's moving, or split between owners, naming why.
   */
  private awayOwner(sessions: readonly string[]): ExecutionOwner {
    const executions = sessions.map((member) => this.executionState(member))
    const moving = executions.find((execution) => execution.state !== "here" && execution.state !== "elsewhere")
    if (moving) throw new Error(executionRefusal(moving) ?? "This Thread is moving; open a new tab once the move ends")
    const away = executions.filter((execution) => execution.state === "elsewhere")
    if (!away.length) return this.self
    const [first] = away
    if (!first || first.state !== "elsewhere" || away.length !== executions.length || away.some((execution) => execution.state !== "elsewhere" || !sameOwner(execution.owner, first.owner)))
      throw new Error("This Thread's Sessions run in more than one place; open a new tab once they're together again")
    return first.owner
  }

  /**
   * A conversation that runs where its Thread does, elsewhere (on its cloud machine), recorded here: a `+` tab's into
   * the Session the tab made, or a fork of one of the Thread's conversations into a new Session beside its parent's,
   * under the ID the machine gave it (`forkSession`), so both stores name it alike. Its journal lives there until the
   * Thread comes back; this store knows its Session, so the way back carries it.
   */
  adoptElsewhere(input: { operationId: string; conversationId: string; actor: Actor } & ({ session: SessionId } | { forkOf: string; forkSession: SessionId })): ThreadPlacement {
    const content: OperationContent = "session" in input ? { conversation: input.conversationId, session: input.session } : { conversation: input.conversationId, forkOf: input.forkOf, session: input.forkSession }
    return this.write(() => this.receipt(input.operationId, "adopt-elsewhere", content, input.actor, () => {
      let placement: ThreadPlacement
      if ("session" in input) {
        const membership = this.sql("SELECT thread_id FROM memberships WHERE session_id = ?").get(input.session)
        if (!membership) throw new Error("That Session isn't in a Thread")
        placement = { thread: ThreadIdSchema.parse(MembershipRowSchema.parse(membership).thread_id), session: input.session }
      } else {
        const parent = this.journalPlacement(input.forkOf)
        if (!parent) throw new Error("The conversation it forks isn't in a Thread")
        const members = this.thread(parent.thread)?.sessions ?? []
        const session = this.mintSession("fork", parent.session, input.actor, this.awayOwner(members), input.forkSession)
        this.addMember(parent.thread, session, input.actor)
        placement = { thread: parent.thread, session: SessionIdSchema.parse(session) }
      }
      const now = this.now()
      this.sql("INSERT OR IGNORE INTO journals (conversation_id, session_id, created_at, registered_at) VALUES (?, ?, ?, ?)").run(input.conversationId, placement.session, now, now)
      this.sql("UPDATE threads SET revision = revision + 1 WHERE id = ?").run(placement.thread)
      this.forgetPlacements()
      return placement
    }, PlacementSchema))
  }

  private addMember(thread: ThreadId, session: string, actor: Actor): void {
    const next = CountSchema.parse(this.sql("SELECT coalesce(max(position) + 1, 0) AS count FROM memberships WHERE thread_id = ?").get(thread)).count
    this.sql("INSERT INTO memberships (session_id, thread_id, position, added_at, added_by) VALUES (?, ?, ?, ?, ?)").run(session, thread, next, this.now(), JSON.stringify(actor))
  }

  /**
   * A caller-minted operation ID is accepted once. Repeating it returns the
   * first result; reusing it for different content is refused.
   */
  private receipt<T>(id: string, kind: string, content: OperationContent, actor: Actor, work: () => T, schema: z.ZodType<T>): T {
    z.string().uuid().parse(id)
    ActorSchema.parse(actor)
    const digest = createHash("sha256").update(JSON.stringify({ kind, content, actor })).digest("hex")
    const found = this.sql("SELECT kind, digest, result FROM operations WHERE id = ?").get(id)
    if (found) {
      const row = OperationRowSchema.parse(found)
      if (row.kind !== kind || row.digest !== digest) throw new ThreadOperationConflictError(id)
      return schema.parse(JSON.parse(row.result))
    }
    const result = work()
    this.sql("INSERT INTO operations (id, kind, digest, actor, result, at) VALUES (?, ?, ?, ?, ?, ?)").run(id, kind, digest, JSON.stringify(actor), JSON.stringify(result), this.now())
    return result
  }

  /**
   * A Thread has one worktree per device. Where a merge leaves one with two,
   * the first stays its own; the later one's folder and branch stay on disk
   * as a worktree Mako didn't make.
   */
  private keepOneWorktreePerThread(): void {
    const seen = new Set<string>()
    for (const found of this.db.prepare("SELECT path, thread_id, device_id FROM thread_worktrees ORDER BY created_at").all()) {
      const row = z.object({ path: z.string(), thread_id: z.string(), device_id: z.string() }).parse(found)
      const key = `${this.thread(ThreadIdSchema.parse(row.thread_id))?.id ?? row.thread_id}\0${row.device_id}`
      if (seen.has(key)) {
        this.db.prepare("DELETE FROM thread_worktrees WHERE path = ?").run(row.path)
        this.db.prepare("DELETE FROM thread_worktree_repositories WHERE checkout = ?").run(row.path)
      } else seen.add(key)
    }
  }

  private migrate(self: ExecutionOwner | undefined): void {
    this.db.exec(EXECUTION_TABLES)
    this.db.exec(PLACEMENT_LOG)
    this.db.prepare("DELETE FROM placement_changes WHERE seq <= (SELECT max(seq) FROM placement_changes) - ?").run(PLACEMENT_LOG_KEEP)
    this.db.exec("DROP TABLE IF EXISTS regroups")
    this.db.exec(WORKTREE_TABLE)
    this.db.exec(WORKTREE_REPOSITORY_TABLE)
    this.keepOneWorktreePerThread()
    this.db.exec(ENVIRONMENT_TABLE)
    this.db.exec(PURPOSE_TABLE)
    this.db.exec(EDGE_TABLES)
    // Delegate, retired, made forks with a task; their Sessions are forks.
    this.db.exec("UPDATE sessions SET origin = 'fork' WHERE origin = 'delegation'")
    const columns = new Set(this.db.prepare("PRAGMA table_info(threads)").all().map((row) => ColumnRowSchema.parse(row).name))
    for (const column of TITLE_COLUMNS)
      if (!columns.has(column.slice(0, column.indexOf(" ")))) this.db.exec(`ALTER TABLE threads ADD COLUMN ${column}`)
    this.db.exec(TITLE_TABLES)
    this.db.prepare("DELETE FROM title_changes WHERE seq <= (SELECT max(seq) FROM title_changes) - ?").run(PLACEMENT_LOG_KEEP)
    const stored = this.meta("self")
    if (stored === undefined) {
      const owner = self ?? { kind: "device", device: DeviceIdSchema.parse(this.meta("device")) }
      this.db.prepare("INSERT INTO store_meta (key, value) VALUES ('self', ?)").run(JSON.stringify(ExecutionOwnerSchema.parse(owner)))
    } else if (self && !sameOwner(ExecutionOwnerSchema.parse(JSON.parse(stored)), self)) {
      throw new Error("This Thread store executes for another environment")
    }
    const [kind, id] = ownerColumns(ExecutionOwnerSchema.parse(JSON.parse(z.string().parse(this.meta("self")))))
    const actor: Actor = { kind: "service", name: "migration" }
    // Sessions from before migration 2, or minted since by an older build.
    this.db.prepare(`INSERT INTO executions (session_id, owner_kind, owner_id, generation, move_id, updated_at, updated_by)
      SELECT id, ?, ?, 1, NULL, ?, ? FROM sessions
      WHERE merged_into IS NULL AND NOT EXISTS (SELECT 1 FROM executions WHERE session_id = sessions.id)`)
      .run(kind, id, this.now(), JSON.stringify(actor))
    this.db.exec(SPLIT_TABLES)
    if (this.oneConversation) {
      const self = ExecutionOwnerSchema.parse(JSON.parse(z.string().parse(this.meta("self"))))
      const counts = splitThreads(this.db, { self, now: this.now(), actor, ...(this.afterSplitThread && { afterThread: this.afterSplitThread }) })
      if (counts.threads || counts.deferred) hostLog("threads", "split Threads into one conversation each", { ...counts })
    }
    this.db.prepare("INSERT OR IGNORE INTO store_migrations (version, applied_at) VALUES (?, ?)").run(THREAD_STORE_MIGRATION, this.now())
  }

  /** A Session without a row was minted here by a build that predates ownership. */
  private executionState(session: string): SessionExecution {
    const found = this.sql("SELECT owner_kind, owner_id, generation, move_id FROM executions WHERE session_id = ?").get(session)
    return this.executionFrom(found ? ExecutionRowSchema.parse(found) : undefined)
  }

  /** A Session's execution from its row; one with none runs here, as every Session did before executions were kept. */
  private executionFrom(row: ExecutionRow | undefined): SessionExecution {
    if (!row) return { state: "here", owner: this.self, generation: 1 }
    const move = row.move_id ? this.moveRow(MoveIdSchema.parse(row.move_id)) : undefined
    if (row.owner_kind === null || row.owner_id === null) {
      if (!move) throw new Error("A Session in transit has no move in the Thread store")
      return { state: "in-transit", generation: row.generation, move: move.id, target: ownerFrom(move.target_kind, move.target_id) }
    }
    const owner = ownerFrom(row.owner_kind, row.owner_id)
    if (!sameOwner(owner, this.self)) return { state: "elsewhere", owner, generation: row.generation }
    if (move?.phase === "leaving")
      return { state: "leaving", owner, generation: row.generation, move: move.id, target: ownerFrom(move.target_kind, move.target_id) }
    return { state: "here", owner, generation: row.generation }
  }

  private setExecution(session: string, owner: ExecutionOwner | null, generation: number, move: MoveId | null, actor: Actor): void {
    const [kind, id] = owner ? ownerColumns(owner) : [null, null]
    this.sql(`INSERT INTO executions (session_id, owner_kind, owner_id, generation, move_id, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (session_id) DO UPDATE SET
      owner_kind = excluded.owner_kind, owner_id = excluded.owner_id, generation = excluded.generation,
      move_id = excluded.move_id, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
      .run(session, kind, id, generation, move, this.now(), JSON.stringify(actor))
    this.executions.clear()
  }

  private insertMove(input: {
    move: MoveId
    thread: ThreadId
    source: ExecutionOwner
    target: ExecutionOwner
    phase: z.infer<typeof MovePhaseSchema>
    handoff: string | null
    outcome: string | null
    actor: Actor
  }): void {
    const [sourceKind, sourceId] = ownerColumns(input.source)
    const [targetKind, targetId] = ownerColumns(input.target)
    const now = this.now()
    this.sql(`INSERT INTO moves (id, thread_id, source_kind, source_id, target_kind, target_id, phase, handoff, outcome, created_at, created_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(input.move, input.thread, sourceKind, sourceId, targetKind, targetId, input.phase, input.handoff, input.outcome, now, JSON.stringify(input.actor), now)
  }

  private setMovePhase(move: MoveId, phase: z.infer<typeof MovePhaseSchema>, columns: { handoff?: string; outcome?: string }): void {
    this.sql("UPDATE moves SET phase = ?, handoff = coalesce(?, handoff), outcome = coalesce(?, outcome), updated_at = ? WHERE id = ?")
      .run(phase, columns.handoff ?? null, columns.outcome ?? null, this.now(), move)
    this.executions.clear()
  }

  private moveRow(move: MoveId): MoveRow | undefined {
    const found = this.sql(`SELECT id, thread_id, source_kind, source_id, target_kind, target_id, phase, handoff, outcome
      FROM moves WHERE id = ?`).get(move)
    return found ? MoveRowSchema.parse(found) : undefined
  }

  private leavingMove(id: MoveId): MoveRow {
    const move = this.moveRow(MoveIdSchema.parse(id))
    if (!move || !sameOwner(ownerFrom(move.source_kind, move.source_id), this.self)) throw new Error("This store never started that move")
    if (move.phase !== "leaving") throw new Error(`This move was already ${move.phase}`)
    return move
  }

  private releasedMove(id: MoveId): ReleasedMove {
    const move = this.moveRow(MoveIdSchema.parse(id))
    if (!move?.handoff || !sameOwner(ownerFrom(move.source_kind, move.source_id), this.self))
      throw new Error("This store never released that move")
    return { move, handoff: HandoffSchema.parse(JSON.parse(move.handoff)) }
  }

  /** The destination's record of a handoff it answered, so a repeat gets the same answer. */
  private recordArrival(handoff: Handoff, phase: "arrived" | "refused", outcome: string, actor: Actor): void {
    this.insertMove({
      move: handoff.move,
      thread: handoff.thread.id,
      source: handoff.source,
      target: handoff.target,
      phase,
      handoff: JSON.stringify(handoff),
      outcome,
      actor,
    })
  }

  /**
   * Write a handed-off Thread under its own identities. Its native sessions,
   * paths and claims are the source's and stay there; journals arrive by ID
   * and carry their bindings through the journal transfer.
   */
  private acceptThread(handoff: Handoff, actor: Actor): void {
    const { thread } = handoff
    const now = this.now()
    this.sql("INSERT OR IGNORE INTO principals (id, kind, label, created_at) VALUES (?, 'person', NULL, ?)").run(thread.owner, now)
    const existing = this.sql("SELECT id, owner_id, title, title_source, revision, merged_into FROM threads WHERE id = ?").get(thread.id)
    if (!existing) {
      this.sql("INSERT INTO threads (id, owner_id, title, title_source, original_title, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(thread.id, thread.owner, thread.title ?? null, thread.titleSource ?? null, thread.originalTitle ?? null, handoff.releasedAt, JSON.stringify(actor))
    } else {
      if (ThreadRowSchema.parse(existing).merged_into) throw new Error("The Thread in this handoff was merged here")
      this.sql(`UPDATE threads SET title = ?, title_source = ?, original_title = coalesce(original_title, ?),
        title_revision = title_revision + 1, revision = revision + 1 WHERE id = ?`)
        .run(thread.title ?? null, thread.titleSource ?? null, thread.originalTitle ?? null, thread.id)
    }
    for (const session of [...handoff.sessions].sort((left, right) => left.position - right.position)) {
      if (!this.sql("SELECT id FROM sessions WHERE id = ?").get(session.id)) {
        // A parent in a Thread that stayed behind is named in the handoff only.
        const parent = session.parent && this.sql("SELECT id FROM sessions WHERE id = ?").get(session.parent) ? session.parent : null
        this.sql("INSERT INTO sessions (id, origin, parent_session, created_at, created_by) VALUES (?, ?, ?, ?, ?)")
          .run(session.id, session.origin, parent, handoff.releasedAt, JSON.stringify(actor))
      }
      if (this.sql("SELECT thread_id FROM memberships WHERE session_id = ?").get(session.id))
        this.sql("UPDATE memberships SET thread_id = ?, position = ? WHERE session_id = ?").run(thread.id, session.position, session.id)
      else
        this.sql("INSERT INTO memberships (session_id, thread_id, position, added_at, added_by) VALUES (?, ?, ?, ?, ?)").run(session.id, thread.id, session.position, now, JSON.stringify(actor))
      for (const journal of session.journals)
        this.sql("INSERT OR IGNORE INTO journals (conversation_id, session_id, created_at, registered_at) VALUES (?, ?, ?, ?)").run(journal, session.id, handoff.releasedAt, now)
    }
    // The Thread coming back proves the destination claimed what this store
    // released, even if its receipt never arrived.
    this.sql("UPDATE moves SET phase = 'arrived', updated_at = ? WHERE thread_id = ? AND phase = 'released' AND source_kind = ? AND source_id = ?")
      .run(now, thread.id, ...ownerColumns(this.self))
    this.forgetPlacements()
  }

  private nativeSessions(harness: string, nativeId: string): string[] {
    return this.sql(`SELECT session_id FROM locators WHERE device_id = ? AND harness = ? AND native_id = ?
      UNION SELECT session_id FROM native_claims WHERE device_id = ? AND harness = ? AND native_id = ?
      UNION SELECT session_id FROM sources WHERE device_id = ? AND harness = ? AND key = ?`)
      .all(this.deviceId, harness, nativeId, this.deviceId, harness, nativeId, this.deviceId, harness, nativeId)
      .map((row) => SessionRowSchema.parse(row).session_id)
  }

  private journalsOf(session: string): string[] {
    return this.sql("SELECT conversation_id FROM journals WHERE session_id = ? ORDER BY created_at, conversation_id").all(session)
      .map((row) => JournalRowSchema.parse(row).conversation_id)
  }

  private placeSession(session: string): ThreadPlacement {
    const current = this.canonical(session)
    const membership = current && this.sql("SELECT thread_id FROM memberships WHERE session_id = ?").get(current)
    if (!current || !membership) throw new Error("A Session in the Thread store has no Thread")
    return { thread: ThreadIdSchema.parse(MembershipRowSchema.parse(membership).thread_id), session: SessionIdSchema.parse(current) }
  }

  private canonical(session: string): string | undefined {
    let current = session
    for (let hops = 0; hops < 64; hops += 1) {
      const found = this.sql("SELECT id, origin, parent_session, created_at, merged_into FROM sessions WHERE id = ?").get(current)
      if (!found) return undefined
      const row = SessionDetailSchema.parse(found)
      if (!row.merged_into) return row.id
      current = row.merged_into
    }
    throw new Error("A Session merge chain in the Thread store does not end")
  }

  private sessionRow(session: string): z.infer<typeof SessionDetailSchema> {
    const found = this.sql("SELECT id, origin, parent_session, created_at, merged_into FROM sessions WHERE id = ?").get(session)
    if (!found) throw new Error("A Session in the Thread store has no record")
    return SessionDetailSchema.parse(found)
  }

  private locator(path: string): z.infer<typeof LocatorRowSchema> | undefined {
    const found = this.sql("SELECT session_id, harness, native_id FROM locators WHERE device_id = ? AND path = ?").get(this.deviceId, path)
    return found ? LocatorRowSchema.parse(found) : undefined
  }

  private source(harness: string, key: string): string | undefined {
    const found = this.sql("SELECT session_id FROM sources WHERE device_id = ? AND harness = ? AND key = ?").get(this.deviceId, harness, key)
    return found ? SessionRowSchema.parse(found).session_id : undefined
  }

  private nativeClaim(harness: string, nativeId: string): string | undefined {
    const found = this.sql("SELECT session_id FROM native_claims WHERE device_id = ? AND harness = ? AND native_id = ?").get(this.deviceId, harness, nativeId)
    return found ? SessionRowSchema.parse(found).session_id : undefined
  }

  private sql(text: string): StatementSync {
    let statement = this.statements.get(text)
    if (!statement) {
      statement = this.db.prepare(text)
      this.statements.set(text, statement)
    }
    return statement
  }

  private meta(key: string): string | undefined {
    const found = this.db.prepare("SELECT value FROM store_meta WHERE key = ?").get(key)
    return found ? MetaRowSchema.parse(found).value : undefined
  }

  /** `data_version` moves only for other connections' commits; this host's own are consumed in `write`. */
  private syncVersion(): void {
    if (this.reader?.refresh()) {
      this.db = this.reader.database
      this.statements.clear()
      this.dataVersion = -1
      this.reopened += 1
    }
    const version = VersionSchema.parse(this.sql("PRAGMA data_version").get()).data_version
    if (version === this.dataVersion) return
    this.dataVersion = version
    // Another host committed: a newer Mako may have raised the format since this one opened.
    if (!this.reader) this.format = readStoreFormat(this.db, "store_meta") ?? this.format
    this.executions.clear()
    this.committed()
    this.consumeChanges(true)
  }

  private consumeChanges(external: boolean): void {
    const titles = this.sql("SELECT seq, thread_id FROM title_changes WHERE seq > ? ORDER BY seq").all(this.titleSeq)
      .map((row) => TitleChangeRowSchema.parse(row))
    for (const row of titles) if (external) this.externalTitles.add(row.thread_id)
    this.titleSeq = titles.at(-1)?.seq ?? this.titleSeq
    const rows = this.sql("SELECT seq, session_id FROM placement_changes WHERE seq > ? ORDER BY seq").all(this.changeSeq)
      .map((row) => PlacementChangeRowSchema.parse(row))
    const first = rows[0]
    if (!first) return
    // Rows are consecutive unless an open pruned past this host's position.
    if (first.seq !== this.changeSeq + 1) {
      this.forgetPlacements()
      if (external) this.externalAll = true
    } else {
      for (const row of rows) {
        this.forgetSession(row.session_id)
        if (external) this.external.add(row.session_id)
      }
    }
    this.changeSeq = rows.at(-1)?.seq ?? this.changeSeq
  }

  /** A commit landed, this host's or another's (or a write was rolled back): what was read of many at once is read again. */
  private committed(): void {
    this.revision += 1
    this.executionsSeen.clear()
    this.titlesSeen.clear()
    this.conversationsSeen.clear()
    this.threadsSeen.clear()
    this.reportAsksSeen.clear()
    this.answersSeen.clear()
    this.forksSeen.clear()
    this.groupsSeen = undefined
    this.edgesSeen = undefined
    this.worktreesSeen = undefined
  }

  private remember(key: string, placed: ThreadPlacement): void {
    const before = this.placements.get(key)
    if (before?.thread !== placed.thread || before.session !== placed.session) this.placementEpoch += 1
    this.placements.set(key, placed)
    const keys = this.keysBySession.get(placed.session)
    if (keys) keys.add(key)
    else this.keysBySession.set(placed.session, new Set([key]))
  }

  private forgetSession(session: string): void {
    this.placementEpoch += 1
    for (const key of this.keysBySession.get(session) ?? []) this.placements.delete(key)
    this.keysBySession.delete(session)
  }

  private forgetPlacements(): void {
    this.placementEpoch += 1
    this.placements.clear()
    this.keysBySession.clear()
  }

  private write<T>(work: () => T): T {
    const newer = this.newer
    if (newer) throw declinedThreads(newer)
    if (this.reader) throw new ReadOnlyStoreError("The Thread store")
    if (this.depth > 0) return work()
    this.db.exec("BEGIN IMMEDIATE")
    this.depth += 1
    try {
      // Other hosts' commits before this one are theirs; the rest are this write's.
      this.syncVersion()
      const raised = this.newer
      if (raised) throw declinedThreads(raised)
      const result = work()
      this.db.exec("COMMIT")
      this.committed()
      this.consumeChanges(false)
      return result
    } catch (error) {
      this.db.exec("ROLLBACK")
      this.forgetPlacements()
      this.executions.clear()
      this.committed()
      // A newer Mako's guard stopped the write inside SQLite: it raised the format after this check.
      if (error instanceof Error && guardRefused(error)) {
        this.format = readStoreFormat(this.db, "store_meta") ?? this.format
        const guarded = this.newer
        if (guarded) throw declinedThreads(guarded)
      }
      throw error
    } finally {
      this.depth -= 1
    }
  }
}

interface JournalPath { path: string; harness: string; nativeId?: string }

/** The Thread's own name, as `UNNAMED` reads it: an unsourced title is the user's, an automatic one isn't a name. */
function titleEntry(row: TitleRow): ThreadTitleEntry {
  const thread = ThreadIdSchema.parse(row.id)
  if (row.title === null || row.title_source === "auto") return { thread, title: null }
  return { thread, title: row.title, source: row.title_source === "frozen" ? "frozen" : "user" }
}

function ownerColumns(owner: ExecutionOwner): ["device" | "cloud", string] {
  return owner.kind === "device" ? ["device", owner.device] : ["cloud", owner.runtime]
}

function ownerFrom(kind: "device" | "cloud", id: string): ExecutionOwner {
  return ExecutionOwnerSchema.parse(kind === "device" ? { kind, device: id } : { kind, runtime: id })
}

/** A NUL can't start a harness name, so a journal's key never meets a catalog row's. */
function journalPlacementKey(conversationId: string): string {
  return `\0journal\n${conversationId}`
}

/** A batch's forks after the parents they name, so a fork finds its parent's Thread. */
function parentsFirst<T extends { ref: SourceRef }>(entries: readonly T[]): T[] {
  const byNative = new Map(entries.map((entry) => [`${entry.ref.harness}\n${entry.ref.nativeId}`, entry]))
  const depth = new Map<T, number>()
  const measure = (entry: T, seen: number): number => {
    const known = depth.get(entry)
    if (known !== undefined) return known
    const parent = entry.ref.parentNativeId ? byNative.get(`${entry.ref.harness}\n${entry.ref.parentNativeId}`) : undefined
    const found = parent && parent !== entry && seen < 64 ? measure(parent, seen + 1) + 1 : 0
    depth.set(entry, found)
    return found
  }
  return entries.map((entry, index) => ({ entry, index, depth: measure(entry, 0) }))
    .sort((left, right) => left.depth - right.depth || left.index - right.index)
    .map(({ entry }) => entry)
}

function placementKey(ref: SourceRef): string {
  return `${ref.harness}\n${ref.path}\n${ref.identity ?? ""}\n${ref.nativeId}`
}

/** A recorded path matches only the same harness and, when both name one, the same native session. */
function compatible(
  found: { harness: string; native_id: string | null },
  entry: { harness: string; nativeId?: string }
): boolean {
  return found.harness === entry.harness && (!found.native_id || !entry.nativeId || found.native_id === entry.nativeId)
}

/** A child's name among its parent's children: a few words of `title`, with a number when that's taken. */
export function uniqueName(title: string, taken: ReadonlySet<string>): string {
  const words = title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean).slice(0, 4).join("-") || "agent"
  const base = words.slice(0, 60)
  if (!taken.has(base)) return base
  for (let index = 2; ; index += 1) if (!taken.has(`${base}-${index}`)) return `${base}-${index}`
}
