import { createHash, randomUUID } from "node:crypto"
import { mkdirSync, realpathSync } from "node:fs"
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
import { hostWarn } from "./host-log.js"

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
export const THREAD_STORE_MIGRATION = 2

/** What an operation acts on; its digest tells a replay from a conflict. */
interface OperationContent {
  thread?: ThreadId
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

export type SessionOrigin = "imported" | "started" | "captured" | "fork" | "delegation" | "new"

/** What a journal's metadata says about where it came from. */
export interface JournalFacts {
  conversationId: string
  createdAt: number
  harness: string
  threadPath?: string
  bindings: ReadonlyArray<{ provider: string; nativeId?: string; path?: string }>
  ancestry?: { kind: "fork" | "delegation"; parentId: string }
  /** A journal started inside a Session that already exists (a `+` tab). */
  session?: SessionId
}

export type SourceRef = Pick<ThreadRef, "harness" | "nativeId" | "path" | "identity">

export interface ThreadRecord {
  id: ThreadId
  owner: PrincipalId
  title?: string
  titleSource?: "user" | "frozen" | "auto"
  revision: number
  sessions: SessionId[]
}

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
  private readonly executions = new Map<string, SessionExecution>()
  private dataVersion = -1
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
      this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;
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
      this.localPrincipal = PrincipalIdSchema.parse(this.meta("principal"))
      this.self = ExecutionOwnerSchema.parse(JSON.parse(z.string().parse(this.meta("self"))))
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

  journalPlacement(conversationId: string): ThreadPlacement | undefined {
    const row = this.sql("SELECT session_id FROM journals WHERE conversation_id = ?").get(conversationId)
    return row ? this.placeSession(SessionRowSchema.parse(row).session_id) : undefined
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
      const unknown = located.filter((entry) => !this.locator(entry.path))
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
      this.placements.set(placementKey(ref), current)
    }
    return placed
  }

  /**
   * A served row's placement, answered from memory after the first time.
   * Another host's commit (a merge) clears the memory.
   */
  place(ref: SourceRef, actor: Actor): ThreadPlacement {
    this.syncVersion()
    const cached = this.placements.get(placementKey(ref))
    if (cached) return cached
    const placed = this.resolveRefs([ref], actor).get(ref.path)
    if (!placed) throw new Error("The Thread store did not place a catalog row")
    return placed
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

  renameThread(input: { operationId: string; thread: ThreadId; title: string; actor: Actor }): ThreadRecord {
    const title = input.title.trim()
    if (!title) throw new Error("A Thread title cannot be empty")
    return this.write(() => {
      this.receipt(input.operationId, "rename-thread", { thread: input.thread, title }, input.actor, () => {
        const thread = this.thread(input.thread)
        if (!thread) throw new Error("That Thread no longer exists")
        this.sql("UPDATE threads SET title = ?, title_source = 'user', revision = revision + 1 WHERE id = ?").run(title, thread.id)
        return { thread: thread.id }
      }, z.object({ thread: ThreadIdSchema }))
      const renamed = this.thread(input.thread)
      if (!renamed) throw new Error("That Thread no longer exists")
      return renamed
    })
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
      const handoff = HandoffSchema.parse({
        move: move.id,
        source: this.self,
        target: ownerFrom(move.target_kind, move.target_id),
        releasedAt: this.now(),
        thread: { id: thread.id, owner: thread.owner, title: thread.title, titleSource: thread.titleSource },
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
    let session: string | undefined
    if (facts.session) {
      session = this.canonical(facts.session)
      if (!session) throw new Error("The Session this conversation was started in no longer exists")
    } else if (facts.ancestry) {
      // A fork's inherited history names its parent's native session; only
      // the link to the parent counts, never a match through it.
      const parent = this.sql("SELECT session_id FROM journals WHERE conversation_id = ?").get(facts.ancestry.parentId)
      session = this.mintSingleton(facts.ancestry.kind, parent ? SessionRowSchema.parse(parent).session_id : null, actor)
    } else {
      session = this.findJournalSession(facts)
        ?? this.mintSingleton(facts.threadPath ? "captured" : "started", null, actor)
    }
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
    session ??= this.mintSingleton("imported", null, actor)
    if (!bySource)
      this.sql("INSERT INTO sources VALUES (?, ?, ?, ?, ?)").run(this.deviceId, ref.harness, key, session, this.now())
    if (!located)
      this.sql("INSERT INTO locators VALUES (?, ?, ?, ?, ?, 'catalog')")
        .run(this.deviceId, ref.path, ref.harness, ref.nativeId, session)
    return session
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
    this.sql("UPDATE threads SET merged_into = ? WHERE id = ?").run(winnerThread, membership.thread_id)
    this.sql("INSERT INTO operations VALUES (?, 'merge', ?, ?, ?, ?)")
      .run(randomUUID(), JSON.stringify({ loser, winner, reason }), JSON.stringify(actor), JSON.stringify({ session: winner }), this.now())
    this.placements.clear()
    this.executions.clear()
  }

  private conflict(a: string, b: string, reason: string): void {
    const pair = [a, b].sort().join("\n")
    if (this.reported.has(pair)) return
    this.reported.add(pair)
    this.conflicts.push({ sessions: [SessionIdSchema.parse(a), SessionIdSchema.parse(b)], reason })
    hostWarn("threads", "two Sessions claim one native session; neither was merged", { sessions: `${a} ${b}`, reason })
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

  private migrate(self: ExecutionOwner | undefined): void {
    this.db.exec(EXECUTION_TABLES)
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
      this.sql("INSERT INTO threads (id, owner_id, title, title_source, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)")
        .run(thread.id, thread.owner, thread.title ?? null, thread.titleSource ?? null, handoff.releasedAt, JSON.stringify(actor))
    } else {
      if (ThreadRowSchema.parse(existing).merged_into) throw new Error("The Thread in this handoff was merged here")
      this.sql("UPDATE threads SET title = ?, title_source = ?, revision = revision + 1 WHERE id = ?")
        .run(thread.title ?? null, thread.titleSource ?? null, thread.id)
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
    this.placements.clear()
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

  private syncVersion(): void {
    const version = VersionSchema.parse(this.sql("PRAGMA data_version").get()).data_version
    if (version === this.dataVersion) return
    this.placements.clear()
    this.executions.clear()
    this.dataVersion = version
  }

  private write<T>(work: () => T): T {
    if (this.depth > 0) return work()
    this.db.exec("BEGIN IMMEDIATE")
    this.depth += 1
    try {
      const result = work()
      this.db.exec("COMMIT")
      return result
    } catch (error) {
      this.db.exec("ROLLBACK")
      this.placements.clear()
      this.executions.clear()
      throw error
    } finally {
      this.depth -= 1
    }
  }
}

interface JournalPath { path: string; harness: string; nativeId?: string }

function ownerColumns(owner: ExecutionOwner): ["device" | "cloud", string] {
  return owner.kind === "device" ? ["device", owner.device] : ["cloud", owner.runtime]
}

function ownerFrom(kind: "device" | "cloud", id: string): ExecutionOwner {
  return ExecutionOwnerSchema.parse(kind === "device" ? { kind, device: id } : { kind, runtime: id })
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
