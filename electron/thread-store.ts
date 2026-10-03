import { createHash, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, realpathSync, renameSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join, resolve, sep } from "node:path"
import { DatabaseSync, type StatementSync } from "node:sqlite"
import { z } from "zod"
import type { ThreadRef } from "@mako/sessions"
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
} from "./contracts/thread-identity.js"
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
} from "./contracts/thread-execution.js"
import { ThreadGroupSchema, type ThreadGroup } from "./contracts/thread-groups.js"
import type { ThreadWorktree } from "./contracts/thread-worktrees.js"
import type { ThreadPurpose, ThreadPurposeKind } from "./contracts/thread-purposes.js"
import type { ThreadTitleEntry } from "./contracts/thread-titles.js"
import { AppKeySchema, type AppKey, type ThreadEnvironmentValues } from "./contracts/thread-environments.js"
import { hostWarn } from "./host-log.js"
import { enableSharedWal } from "./sqlite-wal.js"

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
 */
export const THREAD_STORE_SCHEMA = 1
/**
 * Additive changes on top of `THREAD_STORE_SCHEMA`, which older builds can
 * ignore. The schema number rises only for a change an older reader would
 * misread; raising it refuses the whole store to every older host.
 */
export const THREAD_STORE_MIGRATION = 3

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
}

export class ThreadStoreVersionError extends Error {
  constructor(found: number) {
    super(`The Thread store was written by a newer Mako (schema ${found}); this build reads and writes nothing in it`)
    this.name = "ThreadStoreVersionError"
  }
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
 * The shared store, unless the host is a fixture: a data root outside the
 * application-data directory keeps its own copy, so a test never adds
 * Sessions to the user's store (the same rule as `utilityModelDirectory`).
 */
export function threadStorePath(input: { dataRoot: string; appData: string; home?: string }): string {
  const root = resolve(input.dataRoot)
  const appData = resolve(input.appData)
  const isProfile = root === appData || root.startsWith(appData + sep)
  if (!isProfile) return join(root, "threads.sqlite")
  return join(input.home ?? homedir(), ".mako", "threads.sqlite")
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
    if (error instanceof ThreadStoreVersionError || !sqlite.success || !DAMAGED_CODES.has(sqlite.data.errcode))
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

export type SessionOrigin = "imported" | "started" | "captured" | "fork" | "delegation" | "new"

/** What a journal's metadata says about where it came from. */
export interface JournalFacts {
  conversationId: string
  createdAt: number
  harness: string
  threadPath?: string
  bindings: ReadonlyArray<{ provider: string; nativeId?: string; path?: string }>
  /** `parent-thread` puts a fork's new Session in its parent's Thread; without it a fork has its own Thread. */
  ancestry?: { kind: "fork" | "delegation"; parentId: string; placement?: "parent-thread" }
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

/** One finished exchange of a Session, kept short enough to name a Thread from. */
export interface TitleExchange {
  session: SessionId
  /** The request that asked it; a second report of the same request is the same exchange. */
  exchange: string
  completedAt: number
  prompt: string
  answer: string
}

/** What naming a Thread would start from now. */
export interface TitleContext {
  thread: ThreadId
  /** A user or frozen title: nothing replaces it. */
  manual: boolean
  /** The title the row shows now, if the Thread has one of its own. */
  current?: string
  /** Which window the automatic title last answered. */
  answered?: string
  revision: number
  exchanges: TitleExchange[]
  /** Names the window's exchanges; the same window always has the same digest. */
  digest: string
}

export type AutoTitleOutcome = "applied" | "unchanged" | "manual" | "stale" | "gone"

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
 * symlink (a Claude router profile whose `projects` links to
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
const PlacementChangeRowSchema = z.object({ seq: z.number(), session_id: z.string() })
const ExecutionRowSchema = z.object({
  owner_kind: z.enum(["device", "cloud"]).nullable(),
  owner_id: z.string().nullable(),
  generation: z.number().int().positive(),
  move_id: z.string().nullable(),
})
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
const WorktreeRowSchema = z.object({
  path: z.string(), thread_id: z.string(), repo_root: z.string(), project: z.string(),
  branch: z.string(), base: z.string(), created_at: z.number(),
})
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
 * Migration 3: automatic titles. `title` with `title_source` stays the
 * Thread's own name (a person's, or one Mako chose and `frozen`); a title
 * with no source came from a build that didn't say, and counts as the
 * user's. The model's title is `auto_title`, beside it, so a build that
 * predates it reads every Thread as it did. `original_title` is the name
 * the Thread showed before Mako first named it. `title_revision` rises on
 * every change to any of them, so a result computed before one loses.
 * `title_pending` holds the window a host is asking a model about, for
 * `TITLE_LEASE_MS`, so two hosts don't ask about the same exchanges.
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
/**
 * The last `TITLE_WINDOW` finished exchanges of each Session, cut to
 * `TITLE_PROMPT_CHARS` and `TITLE_ANSWER_CHARS`, and every change of a
 * Thread's name in commit order, for other hosts' windows.
 */
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
export const TITLE_WINDOW = 2
export const TITLE_PROMPT_CHARS = 1_200
export const TITLE_ANSWER_CHARS = 1_600
export const TITLE_LEASE_MS = 90_000
const TitleRowSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  title_source: z.enum(["user", "frozen", "auto"]).nullable(),
  auto_title: z.string().nullable(),
  auto_context: z.string().nullable(),
  title_revision: z.number(),
  title_pending: z.string().nullable(),
  title_pending_at: z.number().nullable(),
  title_pending_by: z.string().nullable(),
})
type TitleRow = z.infer<typeof TitleRowSchema>
const TITLE_ROW = "SELECT id, title, title_source, auto_title, auto_context, title_revision, title_pending, title_pending_at, title_pending_by FROM threads"
const TitleExchangeRowSchema = z.object({ session_id: z.string(), exchange: z.string(), completed_at: z.number(), prompt: z.string(), answer: z.string() })
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
INSERT OR IGNORE INTO app_environments SELECT thread_id, device_id, host, port, created_at, used_at FROM thread_environments;
DELETE FROM thread_environments;
`
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
  origin TEXT NOT NULL CHECK (origin IN ('imported', 'started', 'captured', 'fork', 'delegation', 'new')),
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
  private readonly db: DatabaseSync
  private readonly now: () => number
  private readonly realPath: (path: string) => string
  private depth = 0
  private readonly placements = new Map<string, ThreadPlacement>()
  /** The cache keys holding each Session, so a logged change forgets only those. */
  private readonly keysBySession = new Map<string, Set<string>>()
  private readonly executions = new Map<string, SessionExecution>()
  private dataVersion = -1
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

  constructor(path: string, options: ThreadStoreOptions = {}) {
    this.path = path
    this.now = options.now ?? Date.now
    this.realPath = options.realPath ?? realNativePath
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    try {
      this.db.exec(`PRAGMA busy_timeout=${OPEN_WAIT_MS}`)
      enableSharedWal(this.db, OPEN_WAIT_MS)
      this.db.exec(`PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`)
      // Lock before reading the version so two hosts creating the store at
      // once cannot both mint a device and a principal.
      this.db.exec("BEGIN IMMEDIATE")
      try {
        const found = this.meta("schema")
        if (found === undefined) {
          this.db.exec(SCHEMA)
          const principal = randomUUID()
          this.db.prepare("INSERT INTO principals VALUES (?, 'person', NULL, ?)").run(principal, this.now())
          const insert = this.db.prepare("INSERT INTO store_meta VALUES (?, ?)")
          insert.run("device", randomUUID())
          insert.run("principal", principal)
          insert.run("schema", String(THREAD_STORE_SCHEMA))
        } else if (Number(found) > THREAD_STORE_SCHEMA) {
          throw new ThreadStoreVersionError(Number(found))
        }
        this.migrate(options.self)
        this.db.exec("COMMIT")
      } catch (error) {
        this.db.exec("ROLLBACK")
        throw error
      }
      this.deviceId = z.string().uuid().parse(this.meta("device"))
      this.changeSeq = CountSchema.parse(this.db.prepare("SELECT coalesce(max(seq), 0) AS count FROM placement_changes").get()).count
      this.titleSeq = CountSchema.parse(this.db.prepare("SELECT coalesce(max(seq), 0) AS count FROM title_changes").get()).count
      this.localPrincipal = PrincipalIdSchema.parse(this.meta("principal"))
      this.self = ExecutionOwnerSchema.parse(JSON.parse(z.string().parse(this.meta("self"))))
      this.db.exec(`PRAGMA busy_timeout=${WRITE_WAIT_MS}`)
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  close(): void {
    this.db.close()
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

  /** Every Thread with more than one Session, each with its Sessions in tab order. */
  groups(): ThreadGroup[] {
    return this.sql("SELECT thread_id FROM memberships GROUP BY thread_id HAVING count(*) > 1 ORDER BY min(added_at), thread_id").all()
      .flatMap((row) => {
        const group = this.group(ThreadIdSchema.parse(MembershipRowSchema.parse(row).thread_id))
        return group ? [group] : []
      })
  }

  /** One Thread's group, following merges; undefined while it has one Session. */
  group(id: ThreadId): ThreadGroup | undefined {
    const thread = this.thread(id)
    if (!thread || thread.sessions.length < 2) return undefined
    return ThreadGroupSchema.parse({
      id: thread.id,
      sessions: thread.sessions.map((session) => ({
        id: session,
        origin: this.sessionRow(session).origin,
        started: Boolean(this.sql("SELECT 1 AS found FROM journals WHERE session_id = ? UNION ALL SELECT 1 FROM sources WHERE session_id = ? LIMIT 1").get(session, session)),
      })),
    })
  }

  /** Record the worktree a Thread was started in; the first one recorded for the Thread on this device stays. */
  attachWorktree(input: Omit<ThreadWorktree, "createdAt">): ThreadWorktree | undefined {
    const thread = this.thread(input.thread)
    if (!thread) throw new Error("This Thread no longer exists")
    this.write(() => {
      this.sql("INSERT OR IGNORE INTO thread_worktrees VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(input.path, thread.id, this.deviceId, input.repoRoot, input.project, input.branch, input.base, this.now())
    })
    return this.worktrees().find((worktree) => worktree.path === input.path)
  }

  /** This device's worktrees, each with the Thread it belongs to now. */
  worktrees(): ThreadWorktree[] {
    return this.sql("SELECT path, thread_id, repo_root, project, branch, base, created_at FROM thread_worktrees WHERE device_id = ? ORDER BY created_at")
      .all(this.deviceId)
      .map((found) => {
        const row = WorktreeRowSchema.parse(found)
        return {
          path: row.path,
          thread: this.thread(ThreadIdSchema.parse(row.thread_id))?.id ?? ThreadIdSchema.parse(row.thread_id),
          repoRoot: row.repo_root,
          project: row.project,
          branch: row.branch,
          base: row.base,
          createdAt: row.created_at,
        }
      })
  }

  /** Record what Mako started a Thread for; the first purpose recorded for it stays. */
  markPurpose(thread: ThreadId, kind: ThreadPurposeKind, project: string): void {
    const current = this.thread(thread)
    if (!current) throw new Error("This Thread no longer exists")
    this.write(() => {
      this.sql("INSERT OR IGNORE INTO thread_purposes VALUES (?, ?, ?, ?)").run(current.id, kind, project, this.now())
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
        const inserted = this.sql("INSERT OR IGNORE INTO app_environments VALUES (?, ?, ?, ?, ?, ?)")
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

  detachWorktree(path: string): void {
    this.write(() => {
      this.sql("DELETE FROM thread_worktrees WHERE path = ? AND device_id = ?").run(path, this.deviceId)
    })
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
    const placed = this.write(() => {
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
   * A new, empty Session in an existing Thread: the `+` tab. It exists before
   * anything is sent so its draft and chips have an identity; its first
   * journal registers into it by ID.
   */
  createSession(input: { operationId: string; thread: ThreadId; actor: Actor }): ThreadPlacement {
    return this.write(() => this.receipt(input.operationId, "create-session", { thread: input.thread }, input.actor, () => {
      const thread = this.thread(input.thread)
      if (!thread) throw new Error("That Thread no longer exists")
      for (const member of thread.sessions) {
        const execution = this.executionState(member)
        if (execution.state !== "here")
          throw new Error(executionRefusal(execution) ?? "This Thread is moving; open a new tab once the move ends")
      }
      const session = this.mintSession("new", null, input.actor)
      this.addMember(thread.id, session, input.actor)
      this.sql("UPDATE threads SET revision = revision + 1 WHERE id = ?").run(thread.id)
      return { thread: thread.id, session: SessionIdSchema.parse(session) }
    }, PlacementSchema))
  }

  private bumpRevisions(threads: readonly ThreadId[]): void {
    this.sql(`UPDATE threads SET revision = revision + 1 WHERE id IN (${threads.map(() => "?").join(", ")})`).run(...threads)
  }

  /**
   * The person's name for a Thread. From this commit no automatic title
   * replaces it, including one a model is writing now. `original` is the
   * name the row showed, kept if the Thread had none recorded.
   */
  renameThread(input: { operationId: string; thread: ThreadId; title: string; actor: Actor; original?: string }): ThreadRecord {
    const title = input.title.trim()
    if (!title) throw new Error("A Thread title cannot be empty")
    return this.write(() => {
      this.receipt(input.operationId, "rename-thread", { thread: input.thread, title }, input.actor, () => {
        const thread = this.thread(input.thread)
        if (!thread) throw new Error("That Thread no longer exists")
        this.sql(`UPDATE threads SET title = ?, title_source = 'user', original_title = coalesce(original_title, ?),
          title_revision = title_revision + 1, title_pending = NULL, revision = revision + 1 WHERE id = ?`)
          .run(title, input.original?.trim() || null, thread.id)
        return { thread: thread.id }
      }, z.object({ thread: ThreadIdSchema }))
      const renamed = this.thread(input.thread)
      if (!renamed) throw new Error("That Thread no longer exists")
      return renamed
    })
  }

  /** Give a Thread's name back to automatic titles: its last automatic title, or its Session's own. */
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
   * A name Mako chose for a Thread it started (a setup Thread's), which
   * neither its agent nor a model replaces. A Thread that already has a name
   * of its own keeps it.
   */
  keepThreadTitle(thread: ThreadId, title: string): ThreadTitleEntry | undefined {
    const name = title.trim()
    if (!name) return undefined
    return this.write(() => {
      const current = this.thread(thread)
      if (!current) return undefined
      this.sql(`UPDATE threads SET title = ?, title_source = 'frozen', title_revision = title_revision + 1
        WHERE id = ? AND title IS NULL`).run(name, current.id)
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
          WHERE id = ? AND title IS NULL`).run(title, current.id)
        const found = updated.changes ? this.titleEntry(current.id) : undefined
        if (found) changed.push(found)
      }
      return changed
    })
  }

  /** Every Thread with a name of its own or an automatic one. */
  titles(): ThreadTitleEntry[] {
    return this.sql(`${TITLE_ROW} WHERE merged_into IS NULL AND (title IS NOT NULL OR auto_title IS NOT NULL)`).all()
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

  /**
   * Keep a Session's finished exchange for naming its Thread. False when it
   * was kept before: a report repeated by a replay or a second host is one
   * exchange. Only the Session's latest `TITLE_WINDOW` are kept.
   */
  noteExchange(input: TitleExchange): boolean {
    return this.write(() => {
      const session = this.canonical(input.session)
      if (!session) return false
      const inserted = this.sql("INSERT OR IGNORE INTO title_exchanges VALUES (?, ?, ?, ?, ?)").run(
        session, input.exchange, input.completedAt,
        input.prompt.slice(0, TITLE_PROMPT_CHARS), input.answer.slice(0, TITLE_ANSWER_CHARS))
      if (!inserted.changes) return false
      this.sql(`DELETE FROM title_exchanges WHERE session_id = ? AND exchange NOT IN (
        SELECT exchange FROM title_exchanges WHERE session_id = ? ORDER BY completed_at DESC, exchange DESC LIMIT ?)`)
        .run(session, session, TITLE_WINDOW)
      return true
    })
  }

  /**
   * What naming a Thread would start from: the latest `TITLE_WINDOW`
   * exchanges finished in any of its Sessions now, by when they finished,
   * oldest first. Which tab is open plays no part.
   */
  titleContext(id: ThreadId): TitleContext | undefined {
    const thread = this.thread(id)
    const row = thread && this.titleRow(thread.id)
    if (!thread || !row) return undefined
    const exchanges = this.sql(`SELECT e.session_id, e.exchange, e.completed_at, e.prompt, e.answer FROM title_exchanges e
      JOIN memberships m ON m.session_id = e.session_id WHERE m.thread_id = ?
      ORDER BY e.completed_at DESC, e.exchange DESC LIMIT ?`).all(thread.id, TITLE_WINDOW)
      .map((found): TitleExchange => {
        const exchange = TitleExchangeRowSchema.parse(found)
        return { session: SessionIdSchema.parse(exchange.session_id), exchange: exchange.exchange, completedAt: exchange.completed_at, prompt: exchange.prompt, answer: exchange.answer }
      })
      .reverse()
    const entry = titleEntry(row)
    return {
      thread: thread.id,
      manual: manualTitle(row),
      current: entry.title ?? undefined,
      answered: row.auto_context ?? undefined,
      revision: row.title_revision,
      exchanges,
      digest: createHash("sha256").update(JSON.stringify(exchanges.map((exchange) => [exchange.session, exchange.exchange]))).digest("hex"),
    }
  }

  /**
   * Take the window `digest` names for `holder` to ask a model about.
   * Undefined when there is nothing to ask: the name is the user's, the
   * window moved on or was already answered, or another host holds it.
   * Otherwise the title revision the answer must still find.
   */
  claimTitle(input: { thread: ThreadId; digest: string; holder: string }): number | undefined {
    return this.write(() => {
      const context = this.titleContext(input.thread)
      if (!context || context.manual || context.digest !== input.digest || context.answered === input.digest) return undefined
      const row = this.titleRow(context.thread)
      if (!row) return undefined
      if (row.title_pending === input.digest && row.title_pending_by !== input.holder &&
          this.now() - (row.title_pending_at ?? 0) < TITLE_LEASE_MS) return undefined
      this.sql("UPDATE threads SET title_pending = ?, title_pending_at = ?, title_pending_by = ? WHERE id = ?")
        .run(input.digest, this.now(), input.holder, context.thread)
      return context.revision
    })
  }

  /** Give a window back unanswered, so another host may ask about it. */
  releaseTitle(input: { thread: ThreadId; digest: string; holder: string }): void {
    this.write(() => {
      this.sql("UPDATE threads SET title_pending = NULL WHERE id = ? AND title_pending = ? AND title_pending_by = ?")
        .run(input.thread, input.digest, input.holder)
    })
  }

  /**
   * Write a model's title for the window `digest` names, if nothing moved
   * since `claimTitle` returned `revision`: the Thread still exists under
   * the same ID, has no name of its own, no other title was written and no
   * newer exchange finished. `original` is the name the row showed before.
   */
  applyAutoTitle(input: { thread: ThreadId; digest: string; revision: number; title: string; holder: string; original?: string }): AutoTitleOutcome {
    return this.write(() => {
      const thread = this.thread(input.thread)
      if (!thread || thread.id !== input.thread) return "gone"
      const context = this.titleContext(thread.id)
      const row = this.titleRow(thread.id)
      if (!context || !row) return "gone"
      const release = () => this.sql("UPDATE threads SET title_pending = NULL WHERE id = ? AND title_pending_by = ?").run(thread.id, input.holder)
      if (context.manual) {
        release()
        return "manual"
      }
      if (context.revision !== input.revision || context.digest !== input.digest) {
        release()
        return "stale"
      }
      if (row.auto_title === input.title) {
        this.sql("UPDATE threads SET auto_context = ?, title_pending = NULL WHERE id = ?").run(input.digest, thread.id)
        return "unchanged"
      }
      this.sql(`UPDATE threads SET auto_title = ?, auto_context = ?, auto_at = ?, original_title = coalesce(original_title, ?),
        title_revision = title_revision + 1, title_pending = NULL WHERE id = ?`)
        .run(input.title, input.digest, this.now(), input.original?.trim() || null, thread.id)
      return "applied"
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
    const current = this.canonical(session)
    return current ? this.executionState(current) : undefined
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
      .map((row) => {
        const session = SessionRowSchema.parse(row).session_id
        const natives = this.sql(`SELECT harness, native_id FROM locators WHERE device_id = ? AND session_id = ? AND native_id IS NOT NULL
          UNION SELECT harness, native_id FROM native_claims WHERE device_id = ? AND session_id = ?`).all(this.deviceId, session, this.deviceId, session)
          .map((native) => NativeRowSchema.parse(native))
          .map((native) => ({ harness: native.harness, nativeId: native.native_id }))
        return { session: SessionIdSchema.parse(session), journals: this.journalsOf(session), natives }
      })
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
      const sessions = thread.sessions.map((session): Handoff["sessions"][number] => {
        const row = this.sessionRow(session)
        const generation = this.executionState(session).generation + 1
        this.setExecution(session, null, generation, move.id, input.actor)
        const position = z.object({ position: z.number() })
          .parse(this.sql("SELECT position FROM memberships WHERE session_id = ?").get(session)).position
        const entry: Handoff["sessions"][number] = {
          id: session,
          origin: SessionOriginSchema.parse(row.origin),
          position,
          generation,
          journals: this.journalsOf(session),
        }
        if (row.parent_session) entry.parent = SessionIdSchema.parse(row.parent_session)
        return entry
      })
      const auto = this.titleRow(thread.id)?.auto_title
      const original = this.originalTitle(thread.id)
      const moved: Handoff["thread"] = { id: thread.id, owner: thread.owner, title: thread.title, titleSource: thread.titleSource }
      if (auto) moved.autoTitle = auto
      if (original) moved.originalTitle = original
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
    return this.write(() => {
      const known = this.moveRow(handoff.move)
      if (known?.phase === "arrived" && known.outcome) return ClaimReceiptSchema.parse(JSON.parse(known.outcome))
      if (known) throw new Error(`This move was already ${known.phase} here`)
      return this.receipt(input.operationId, "claim-move", { move: handoff.move, thread: handoff.thread.id }, input.actor, () => {
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
        this.acceptThread(handoff, input.actor)
        const receipt = ClaimReceiptSchema.parse({
          move: handoff.move,
          owner: this.self,
          sessions: handoff.sessions.map((session) => ({ id: session.id, generation: session.generation + 1 })),
        })
        for (const session of receipt.sessions) this.setExecution(session.id, this.self, session.generation, null, input.actor)
        this.recordArrival(handoff, "arrived", JSON.stringify(receipt), input.actor)
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
    this.sql("INSERT INTO journals VALUES (?, ?, ?, ?)").run(facts.conversationId, session, facts.createdAt, this.now())
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
        this.sql("INSERT INTO locators VALUES (?, ?, ?, ?, ?, 'journal')")
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
        this.sql("INSERT INTO native_claims VALUES (?, ?, ?, ?)").run(this.deviceId, binding.provider, binding.nativeId, current)
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

  private resolveOne(ref: SourceRef, actor: Actor): string {
    const key = ref.identity ?? ref.nativeId
    const located = this.locator(ref.path)
    const byPath = located && compatible(located, ref) ? located.session_id : undefined
    const bySource = this.source(ref.harness, key)
    // A pathless binding's claim speaks only for rows without a distinct
    // identity; a Cursor `chats/` copy never answers to its agent's claim.
    const claimed = key === ref.nativeId ? this.nativeClaim(ref.harness, ref.nativeId) : undefined
    let session = bySource ?? byPath ?? claimed
    for (const other of [byPath, claimed])
      if (session && other && other !== session)
        session = this.reconcile(session, other, `${ref.harness} catalog row's path, identity and native claims name different Sessions`, actor)
    if (session) this.adoptFork(session, ref, actor)
    session ??= this.mintImported(ref, actor)
    if (!bySource)
      this.sql("INSERT INTO sources VALUES (?, ?, ?, ?, ?)").run(this.deviceId, ref.harness, key, session, this.now())
    if (!located)
      this.sql("INSERT INTO locators VALUES (?, ?, ?, ?, ?, 'catalog')")
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
    if (!ref.parentNativeId) return
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
    if (row.merged_into || row.origin === "fork" || row.origin === "delegation" || row.origin === "new") return false
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
    this.sql("UPDATE OR IGNORE title_exchanges SET session_id = ? WHERE session_id = ?").run(winner, loser)
    this.sql("DELETE FROM title_exchanges WHERE session_id = ?").run(loser)
    this.sql("UPDATE sessions SET parent_session = ? WHERE parent_session = ?").run(winner, loser)
    this.sql("DELETE FROM memberships WHERE session_id = ?").run(loser)
    this.sql("UPDATE sessions SET merged_into = ? WHERE id = ?").run(winner, loser)
    // A loser that shared its Thread leaves only its tab; the Thread stays.
    const left = CountSchema.parse(this.sql("SELECT count(*) AS count FROM memberships WHERE thread_id = ?").get(membership.thread_id)).count
    if (!left && membership.thread_id !== winnerThread) {
      this.sql("UPDATE threads SET merged_into = ? WHERE id = ?").run(winnerThread, membership.thread_id)
      this.keepOneWorktreePerThread()
    }
    this.sql("INSERT INTO operations VALUES (?, 'merge', ?, ?, ?, ?)")
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
   * A fork or delegated child. Its inherited history names its parent's
   * native session, so only the link to the parent counts, never a match
   * through it. A fork made to join its parent's Thread does so when it can.
   */
  private mintDescendant(ancestry: NonNullable<JournalFacts["ancestry"]>, actor: Actor): string {
    const found = this.sql("SELECT session_id FROM journals WHERE conversation_id = ?").get(ancestry.parentId)
    const parent = found ? this.canonical(SessionRowSchema.parse(found).session_id) ?? null : null
    const home = parent && ancestry.placement === "parent-thread" ? this.forkHome(parent) : undefined
    if (!home) return this.mintSingleton(ancestry.kind, parent, actor)
    const session = this.mintSession(ancestry.kind, parent, actor)
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

  private mintSingleton(origin: SessionOrigin, parent: string | null, actor: Actor): string {
    const session = this.mintSession(origin, parent, actor)
    const thread = randomUUID()
    this.sql("INSERT INTO threads (id, owner_id, created_at, created_by) VALUES (?, ?, ?, ?)")
      .run(thread, this.localPrincipal, this.now(), JSON.stringify(actor))
    this.addMember(ThreadIdSchema.parse(thread), session, actor)
    return session
  }

  private mintSession(origin: SessionOrigin, parent: string | null, actor: Actor): string {
    const session = randomUUID()
    this.sql("INSERT INTO sessions (id, origin, parent_session, created_at, created_by) VALUES (?, ?, ?, ?, ?)")
      .run(session, origin, parent, this.now(), JSON.stringify(actor))
    this.setExecution(session, this.self, 1, null, actor)
    return session
  }

  private addMember(thread: ThreadId, session: string, actor: Actor): void {
    const next = CountSchema.parse(this.sql("SELECT coalesce(max(position) + 1, 0) AS count FROM memberships WHERE thread_id = ?").get(thread)).count
    this.sql("INSERT INTO memberships VALUES (?, ?, ?, ?, ?)").run(session, thread, next, this.now(), JSON.stringify(actor))
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
    this.sql("INSERT INTO operations VALUES (?, ?, ?, ?, ?, ?)").run(id, kind, digest, JSON.stringify(actor), JSON.stringify(result), this.now())
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
      if (seen.has(key)) this.db.prepare("DELETE FROM thread_worktrees WHERE path = ?").run(row.path)
      else seen.add(key)
    }
  }

  private migrate(self: ExecutionOwner | undefined): void {
    this.db.exec(EXECUTION_TABLES)
    this.db.exec(PLACEMENT_LOG)
    this.db.prepare("DELETE FROM placement_changes WHERE seq <= (SELECT max(seq) FROM placement_changes) - ?").run(PLACEMENT_LOG_KEEP)
    this.db.exec("DROP TABLE IF EXISTS regroups")
    this.db.exec(WORKTREE_TABLE)
    this.keepOneWorktreePerThread()
    this.db.exec(ENVIRONMENT_TABLE)
    this.db.exec(PURPOSE_TABLE)
    const columns = new Set(this.db.prepare("PRAGMA table_info(threads)").all().map((row) => ColumnRowSchema.parse(row).name))
    for (const column of TITLE_COLUMNS)
      if (!columns.has(column.slice(0, column.indexOf(" ")))) this.db.exec(`ALTER TABLE threads ADD COLUMN ${column}`)
    this.db.exec(TITLE_TABLES)
    this.db.prepare("DELETE FROM title_changes WHERE seq <= (SELECT max(seq) FROM title_changes) - ?").run(PLACEMENT_LOG_KEEP)
    const stored = this.meta("self")
    if (stored === undefined) {
      const owner = self ?? { kind: "device", device: DeviceIdSchema.parse(this.meta("device")) }
      this.db.prepare("INSERT INTO store_meta VALUES ('self', ?)").run(JSON.stringify(ExecutionOwnerSchema.parse(owner)))
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
    this.db.prepare("INSERT OR IGNORE INTO store_migrations VALUES (?, ?)").run(THREAD_STORE_MIGRATION, this.now())
  }

  /** A Session without a row was minted here by a build that predates ownership. */
  private executionState(session: string): SessionExecution {
    const found = this.sql("SELECT owner_kind, owner_id, generation, move_id FROM executions WHERE session_id = ?").get(session)
    if (!found) return { state: "here", owner: this.self, generation: 1 }
    const row = ExecutionRowSchema.parse(found)
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
    this.sql(`INSERT INTO executions VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (session_id) DO UPDATE SET
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
    this.sql("INSERT OR IGNORE INTO principals VALUES (?, 'person', NULL, ?)").run(thread.owner, now)
    const existing = this.sql("SELECT id, owner_id, title, title_source, revision, merged_into FROM threads WHERE id = ?").get(thread.id)
    if (!existing) {
      this.sql("INSERT INTO threads (id, owner_id, title, title_source, auto_title, original_title, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(thread.id, thread.owner, thread.title ?? null, thread.titleSource ?? null, thread.autoTitle ?? null, thread.originalTitle ?? null, handoff.releasedAt, JSON.stringify(actor))
    } else {
      if (ThreadRowSchema.parse(existing).merged_into) throw new Error("The Thread in this handoff was merged here")
      this.sql(`UPDATE threads SET title = ?, title_source = ?, auto_title = coalesce(?, auto_title), original_title = coalesce(original_title, ?),
        title_revision = title_revision + 1, revision = revision + 1 WHERE id = ?`)
        .run(thread.title ?? null, thread.titleSource ?? null, thread.autoTitle ?? null, thread.originalTitle ?? null, thread.id)
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
        this.sql("INSERT INTO memberships VALUES (?, ?, ?, ?, ?)").run(session.id, thread.id, session.position, now, JSON.stringify(actor))
      for (const journal of session.journals)
        this.sql("INSERT OR IGNORE INTO journals VALUES (?, ?, ?, ?)").run(journal, session.id, handoff.releasedAt, now)
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
    const version = VersionSchema.parse(this.sql("PRAGMA data_version").get()).data_version
    if (version === this.dataVersion) return
    this.dataVersion = version
    this.executions.clear()
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

  private remember(key: string, placed: ThreadPlacement): void {
    this.placements.set(key, placed)
    const keys = this.keysBySession.get(placed.session)
    if (keys) keys.add(key)
    else this.keysBySession.set(placed.session, new Set([key]))
  }

  private forgetSession(session: string): void {
    for (const key of this.keysBySession.get(session) ?? []) this.placements.delete(key)
    this.keysBySession.delete(session)
  }

  private forgetPlacements(): void {
    this.placements.clear()
    this.keysBySession.clear()
  }

  private write<T>(work: () => T): T {
    if (this.depth > 0) return work()
    this.db.exec("BEGIN IMMEDIATE")
    this.depth += 1
    try {
      // Other hosts' commits before this one are theirs; the rest are this write's.
      this.syncVersion()
      const result = work()
      this.db.exec("COMMIT")
      this.consumeChanges(false)
      return result
    } catch (error) {
      this.db.exec("ROLLBACK")
      this.forgetPlacements()
      this.executions.clear()
      throw error
    } finally {
      this.depth -= 1
    }
  }
}

interface JournalPath { path: string; harness: string; nativeId?: string }

/** A title is the Thread's own unless it says it was automatic; an unsourced title is never assumed to be. */
function manualTitle(row: TitleRow): boolean {
  return row.title !== null && row.title_source !== "auto"
}

function titleEntry(row: TitleRow): ThreadTitleEntry {
  const thread = ThreadIdSchema.parse(row.id)
  if (manualTitle(row)) return { thread, title: row.title, source: row.title_source === "frozen" ? "frozen" : "user" }
  const auto = row.auto_title ?? row.title
  return auto === null ? { thread, title: null } : { thread, title: auto, source: "auto" }
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
