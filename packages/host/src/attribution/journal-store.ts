import { createHash, randomUUID } from "node:crypto"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { DatabaseSync, type SQLOutputValue, type StatementSync } from "node:sqlite"
import { z } from "zod"
import {
  AttributionSchema,
  FootprintBasisSchema,
  ObservedBySchema,
  type Attribution,
  type ChangeKind,
  type ContentRef,
  type FootprintEntry,
  type Gap,
  type ObservedBy,
  type TrackedRoot,
} from "@mako/protocol"
import { compress, decompress } from "./content.js"
import { FootprintTurnSchema, type FootprintTurn } from "./footprint.js"
import type { NoiseRow } from "./noise-baseline.js"
import { decodeMap, encodeMap, type Run } from "./line-map.js"

/*
 * The journal on disk: one SQLite file per host, in write-ahead mode with
 * `synchronous=NORMAL` (a commit appends to the log without an fsync; only a
 * power loss in the same instant can lose the last few). Entries are
 * numbered by SQLite's rowid, so numbers are dense and only ever grow. Blobs
 * are zstd-compressed content by address, in the same file so an entry and
 * the content it names commit together. A reader (the attribution script)
 * opens it read-only beside a running host.
 */

const SCHEMA_VERSION = "1"

export interface StoredRoot extends TrackedRoot {
  repository: boolean
  /** The commit tracking measures from, for a repository. */
  head: string | null
  /** The system's history position the root was last caught up to. */
  mark: string | null
  /** When the tracker last knew the root was fully heard. */
  seenAt: number
  trackedAt: number
  active: boolean
}

export interface StoredEntry {
  seq: number
  at: number
  changedAt: number
  root: string
  path: string
  kind: ChangeKind
  from?: string
  before: ContentRef | null
  after: ContentRef | null
  size?: number
  text: boolean
  added?: number
  removed?: number
  stored: boolean
  observed: ObservedBy
  gap?: number
  restores?: number
  author: Attribution
  settled: boolean
  /** The file's line map after this entry, for text. */
  map?: Run[]
}

/** A tracked file with changes since its base: the base, what's there now, and who wrote each line. */
export interface FileState {
  root: string
  path: string
  /** The content at the base; null when the file wasn't there. */
  base: ContentRef | null
  /** The last entry before the base moved here; entries after it are this file's chain. A whole-file change a commit didn't take began before it. */
  baseSeq: number
  current: ContentRef | null
  text: boolean
  map: Run[]
}

/** A file created, deleted or binary since its base: it goes whole, and its line map says nothing. */
export function wholeChange(file: FileState): boolean {
  return file.base === null || file.current === null || !file.text
}

/**
 * A move, or the person's change to one: what came (`files`, `guessed` of
 * them on timing alone, `offered` left for "Bring these"); what "Put back"
 * returned; what "Bring these" brought.
 */
/** A file the person picked for a spelling among several. */
export interface FileChoice {
  thread: string
  spelling: string
  path: string
  at: number
}

export interface MoveRecord {
  at: number
  thread: string
  kind: "move" | "put-back" | "bring"
  files: number
  guessed: number
  offered: number
}

/** Threads' changes in one root since a time: files counted once, lines summed over every change. */
export interface RootChanges {
  root: string
  files: number
  added: number
  removed: number
  threads: number
}

/** Threads' changes since a time, per root, and how many Threads in all. */
export interface ChangesSince {
  roots: RootChanges[]
  threads: number
}

/** What a collection dropped: versions and compressed bytes. */
export interface Collected {
  dropped: number
  bytes: number
}

export interface StatRow {
  dev: number
  ino: number
  size: number
  mode: number
  mtimeNs: bigint
  ctimeNs: bigint
  /** The content's address when the tracker hashed it; null for a file known only as its base. */
  ref: ContentRef | null
  /** When the stat was taken, to tell a racy timestamp. */
  checkedNs: bigint
}

const MetaRow = z.object({ key: z.string(), value: z.string() })
const RootRow = z.object({
  id: z.string(), path: z.string(), kind: z.enum(["workspace", "attached"]), carry: z.string().nullable(), repository: z.number(),
  head: z.string().nullable(), mark: z.string().nullable(), seen_at: z.number(), tracked_at: z.number(), active: z.number(),
})
const Ref = z.string().nullable()
const EntryRow = z.object({
  seq: z.number(), at: z.number(), changed_at: z.number(), root: z.string(), path: z.string(), kind: z.enum(["create", "modify", "delete", "rename"]),
  from_path: z.string().nullable(), before: Ref, after: Ref, size: z.number().nullable(), text: z.number(), added: z.number().nullable(), removed: z.number().nullable(),
  stored: z.number(), observed: ObservedBySchema, gap: z.number().nullable(), restores: z.number().nullable(),
  author: z.string(), settled: z.number(), map: z.instanceof(Uint8Array).nullable(),
})
const FileRow = z.object({ root: z.string(), path: z.string(), base: Ref, base_seq: z.number(), current: Ref, text: z.number(), map: z.instanceof(Uint8Array) })
const StatRowSchema = z.object({
  path: z.string(), dev: z.bigint(), ino: z.bigint(), size: z.bigint(), mode: z.bigint(), mtime_ns: z.bigint(), ctime_ns: z.bigint(), ref: Ref, checked_ns: z.bigint(),
})
const BlobRow = z.object({ data: z.instanceof(Uint8Array) })
const GapRow = z.object({ id: z.number(), root: z.string(), from_at: z.number(), to_at: z.number().nullable(), reason: z.enum(["dropped", "muted", "restart", "gone"]) })
const FootprintRow = z.object({
  thread: z.string(), session: z.string(), turn: z.string().nullable(), path: z.string(), access: z.enum(["read", "write"]), evidence: z.enum(["strong", "weak"]),
  at: z.number(), size: z.number().nullable(), ref: Ref, secret: z.number(), basis: FootprintBasisSchema.nullable().optional(),
})
const FootprintTurnRow = z.object({ summary: z.string() })
const NoiseRowSchema = z.object({ key: z.string(), kind: z.enum(["template", "folder"]), idle: z.number(), weak: z.number(), threads: z.string(), at: z.number() })
const ActivityRow = z.object({
  kind: z.enum(["turn", "call", "background"]), id: z.string(), session: z.string(), thread: z.string(), turn: z.string().nullable(), checkout: z.string().nullable(),
  cwd: z.string().nullable(), label: z.string().nullable(), named: z.string(), record: z.string().nullable(), started_at: z.number(), ended_at: z.number().nullable(), effects: z.string().nullable(),
})
const Count = z.object({ count: z.number() })
const ChoiceRow = z.object({ spelling: z.string(), path: z.string() })
const Size = z.object({ bytes: z.number().nullable(), count: z.number() })

export interface StoredActivity {
  kind: "turn" | "call" | "background"
  id: string
  session: string
  thread: string
  turn?: string
  checkout?: string
  cwd?: string
  label?: string
  named: string[]
  record?: string
  start: number
  end: number | null
  /** The reported effects' kinds and paths, never their content. */
  effects?: StoredEffect[]
}

/** A reported effect as the journal keeps it: no patch, no content. */
export type StoredEffect =
  | { kind: "create" | "modify" | "write" | "delete" | "read"; path: string }
  | { kind: "rename"; from: string; to: string }
  | { kind: "command"; command: string; cwd?: string; exitCode?: number; named?: string[] }
const StoredEffectSchema = z.array(z.union([
  z.object({ kind: z.enum(["create", "modify", "write", "delete", "read"]), path: z.string() }),
  z.object({ kind: z.literal("rename"), from: z.string(), to: z.string() }),
  z.object({ kind: z.literal("command"), command: z.string(), cwd: z.string().optional(), exitCode: z.number().optional(), named: z.array(z.string()).optional() }),
]))

const MIGRATION = `
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS roots (
    id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, carry TEXT, repository INTEGER NOT NULL,
    head TEXT, mark TEXT, seen_at INTEGER NOT NULL, tracked_at INTEGER NOT NULL, active INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS entries (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, changed_at INTEGER NOT NULL, root TEXT NOT NULL, path TEXT NOT NULL,
    kind TEXT NOT NULL, from_path TEXT, before TEXT, after TEXT, size INTEGER, text INTEGER NOT NULL, added INTEGER, removed INTEGER,
    stored INTEGER NOT NULL, observed TEXT NOT NULL, gap INTEGER, restores INTEGER, certainty TEXT NOT NULL, thread TEXT, session TEXT,
    author TEXT NOT NULL, settled INTEGER NOT NULL, map BLOB
  );
  CREATE INDEX IF NOT EXISTS entries_path ON entries(root, path, seq);
  CREATE INDEX IF NOT EXISTS entries_from ON entries(root, from_path, seq) WHERE from_path IS NOT NULL;
  CREATE INDEX IF NOT EXISTS entries_thread ON entries(thread, seq);
  CREATE INDEX IF NOT EXISTS entries_session ON entries(session, seq);
  CREATE INDEX IF NOT EXISTS entries_at ON entries(at);
  CREATE INDEX IF NOT EXISTS entries_unsettled ON entries(settled) WHERE settled = 0;
  CREATE TABLE IF NOT EXISTS files (
    root TEXT NOT NULL, path TEXT NOT NULL, base TEXT, base_seq INTEGER NOT NULL, current TEXT, text INTEGER NOT NULL, map BLOB NOT NULL,
    PRIMARY KEY (root, path)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS stats (
    root TEXT NOT NULL, path TEXT NOT NULL, dev INTEGER NOT NULL, ino INTEGER NOT NULL, size INTEGER NOT NULL, mode INTEGER NOT NULL,
    mtime_ns INTEGER NOT NULL, ctime_ns INTEGER NOT NULL, ref TEXT, checked_ns INTEGER NOT NULL, PRIMARY KEY (root, path)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS blobs (ref TEXT PRIMARY KEY, size INTEGER NOT NULL, at INTEGER NOT NULL, data BLOB NOT NULL) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS activity (
    session TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, thread TEXT NOT NULL, turn TEXT, checkout TEXT, cwd TEXT, label TEXT,
    named TEXT NOT NULL, record TEXT, started_at INTEGER NOT NULL, ended_at INTEGER, effects TEXT, PRIMARY KEY (session, kind, id)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS activity_thread ON activity(thread, started_at);
  CREATE INDEX IF NOT EXISTS activity_open ON activity(ended_at) WHERE ended_at IS NULL;
  CREATE TABLE IF NOT EXISTS gaps (id INTEGER PRIMARY KEY AUTOINCREMENT, root TEXT NOT NULL, from_at INTEGER NOT NULL, to_at INTEGER, reason TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS footprint (
    thread TEXT NOT NULL, session TEXT NOT NULL, turn TEXT, path TEXT NOT NULL, access TEXT NOT NULL, evidence TEXT NOT NULL,
    at INTEGER NOT NULL, size INTEGER, ref TEXT, secret INTEGER NOT NULL, PRIMARY KEY (thread, session, turn, path, access)
  );
  CREATE TABLE IF NOT EXISTS commits (
    root TEXT NOT NULL, oid TEXT NOT NULL, path TEXT NOT NULL, at INTEGER NOT NULL, authors BLOB NOT NULL, PRIMARY KEY (root, oid, path)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS footprint_turns (
    session TEXT NOT NULL, turn TEXT NOT NULL, thread TEXT NOT NULL, at INTEGER NOT NULL, summary TEXT NOT NULL, PRIMARY KEY (session, turn)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS footprint_turns_thread ON footprint_turns(thread, at);
  CREATE TABLE IF NOT EXISTS noise (
    key TEXT PRIMARY KEY, kind TEXT NOT NULL, idle REAL NOT NULL, weak REAL NOT NULL, threads TEXT NOT NULL, at INTEGER NOT NULL
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS moves (
    at INTEGER NOT NULL, thread TEXT NOT NULL, kind TEXT NOT NULL, files INTEGER NOT NULL, guessed INTEGER NOT NULL, offered INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS moves_at ON moves(at);
  CREATE TABLE IF NOT EXISTS choices (thread TEXT NOT NULL, spelling TEXT NOT NULL, path TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (thread, spelling)) WITHOUT ROWID;
`

/** Columns added after a table was first made, with what adds them. */
const ADDED_COLUMNS = [
  { table: "footprint", column: "basis", add: "ALTER TABLE footprint ADD COLUMN basis TEXT" },
  { table: "commits", column: "ref", add: "ALTER TABLE commits ADD COLUMN ref TEXT; CREATE INDEX IF NOT EXISTS commits_ref ON commits(root, path, ref, at)" },
] as const

const optional = <T>(value: T | null): T | undefined => value ?? undefined

/** A commit row's line authors, one 32-bit entry number a line. */
function lineAuthors(row: z.infer<typeof BlobRow> | undefined): Int32Array | undefined {
  if (!row) return undefined
  const bytes = row.data
  return new Int32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
}

/**
 * The tables and columns this code reads and writes, as a short hash: two
 * hosts share a journal only when theirs are the same, so neither reads a
 * column the other never made, nor starts over a journal the other keeps.
 */
export const JOURNAL_FORMAT = createHash("sha256").update(`${SCHEMA_VERSION}\n${MIGRATION}\n${JSON.stringify(ADDED_COLUMNS)}`).digest("hex").slice(0, 16)

/** A row as SQLite returns it, before its schema reads it. */
type Row = Record<string, SQLOutputValue>

/** Content kept by address: how many versions, and their compressed bytes. */
export interface BlobSize {
  count: number
  bytes: number
}

export interface JournalCounts {
  entries: number
  files: number
  stats: number
  activity: number
  footprint: number
  unsettled: number
}

export class JournalStore {
  readonly path: string
  readonly id: string
  readonly device: string
  private readonly db: DatabaseSync
  private readonly statements = new Map<string, StatementSync>()

  private constructor(path: string, db: DatabaseSync, id: string, device: string) {
    this.path = path
    this.db = db
    this.id = id
    this.device = device
  }

  /** Open or create the journal at `path`; a read-only open never creates or migrates. */
  static open(path: string, options: { device: string; readOnly?: boolean }): JournalStore {
    if (options.readOnly) {
      const db = new DatabaseSync(path, { readOnly: true })
      db.exec("PRAGMA busy_timeout=2000")
      const meta = new Map(db.prepare("SELECT key, value FROM meta").all().map((row) => MetaRow.parse(row)).map((row) => [row.key, row.value]))
      return new JournalStore(path, db, meta.get("journal") ?? "", meta.get("device") ?? "")
    }
    mkdirSync(dirname(path), { recursive: true })
    const db = new DatabaseSync(path)
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;")
    db.exec(MIGRATION)
    for (const added of ADDED_COLUMNS) {
      const columns = db.prepare(`PRAGMA table_info(${added.table})`).all().map((row) => z.object({ name: z.string() }).parse(row).name)
      if (!columns.includes(added.column)) db.exec(added.add)
    }
    const meta = new Map(db.prepare("SELECT key, value FROM meta").all().map((row) => MetaRow.parse(row)).map((row) => [row.key, row.value]))
    let id = meta.get("journal")
    if (!id || meta.get("schema") !== SCHEMA_VERSION) {
      // A journal from another schema is started over under a new id, so no peer trusts its numbers.
      if (id) db.exec("DELETE FROM entries; DELETE FROM files; DELETE FROM stats; DELETE FROM roots; DELETE FROM gaps; DELETE FROM sqlite_sequence")
      id = randomUUID()
      const set = db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")
      set.run("journal", id)
      set.run("schema", SCHEMA_VERSION)
      set.run("device", options.device)
      set.run("created", String(Date.now()))
    }
    return new JournalStore(path, db, id, meta.get("device") ?? options.device)
  }

  private statement(sql: string): StatementSync {
    let statement = this.statements.get(sql)
    if (!statement) this.statements.set(sql, (statement = this.db.prepare(sql)))
    return statement
  }

  transaction<T>(run: () => T): T {
    this.db.exec("BEGIN IMMEDIATE")
    try {
      const result = run()
      this.db.exec("COMMIT")
      return result
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
  }

  roots(): StoredRoot[] {
    return this.statement("SELECT * FROM roots ORDER BY tracked_at").all().map((value) => {
      const row = RootRow.parse(value)
      return {
        id: row.id, path: row.path, kind: row.kind, carry: row.carry ? z.array(z.string()).parse(JSON.parse(row.carry)) : undefined,
        repository: Boolean(row.repository), head: row.head, mark: row.mark, seenAt: row.seen_at, trackedAt: row.tracked_at, active: Boolean(row.active),
      }
    })
  }

  saveRoot(root: StoredRoot): void {
    this.statement(`INSERT INTO roots (id, path, kind, carry, repository, head, mark, seen_at, tracked_at, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET path=excluded.path, kind=excluded.kind, carry=excluded.carry, repository=excluded.repository, head=excluded.head,
      mark=excluded.mark, seen_at=excluded.seen_at, active=excluded.active`)
      .run(root.id, root.path, root.kind, root.carry ? JSON.stringify(root.carry) : null, root.repository ? 1 : 0, root.head, root.mark, root.seenAt, root.trackedAt, root.active ? 1 : 0)
  }

  insertEntry(entry: Omit<StoredEntry, "seq">): number {
    const thread = "author" in entry.author ? entry.author.author.thread : null
    const session = "author" in entry.author ? entry.author.author.session : null
    const result = this.statement(`INSERT INTO entries (at, changed_at, root, path, kind, from_path, before, after, size, text, added, removed, stored, observed, gap, restores,
      certainty, thread, session, author, settled, map) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(entry.at, entry.changedAt, entry.root, entry.path, entry.kind, entry.from ?? null, entry.before, entry.after, entry.size ?? null, entry.text ? 1 : 0,
        entry.added ?? null, entry.removed ?? null, entry.stored ? 1 : 0, entry.observed, entry.gap ?? null, entry.restores ?? null, entry.author.certainty,
        thread, session, JSON.stringify(entry.author), entry.settled ? 1 : 0, entry.map ? encodeMap(entry.map) : null)
    return Number(result.lastInsertRowid)
  }

  updateAuthor(seq: number, author: Attribution, settled: boolean): void {
    const thread = "author" in author ? author.author.thread : null
    const session = "author" in author ? author.author.session : null
    this.statement("UPDATE entries SET author=?, certainty=?, thread=?, session=?, settled=? WHERE seq=?").run(JSON.stringify(author), author.certainty, thread, session, settled ? 1 : 0, seq)
  }

  settle(seq: number): void {
    this.statement("UPDATE entries SET settled=1 WHERE seq=?").run(seq)
  }

  private entryOf(value: Row): StoredEntry {
    const row = EntryRow.parse(value)
    return {
      seq: row.seq, at: row.at, changedAt: row.changed_at, root: row.root, path: row.path, kind: row.kind, from: optional(row.from_path),
      before: row.before, after: row.after, size: optional(row.size), text: Boolean(row.text), added: optional(row.added), removed: optional(row.removed),
      stored: Boolean(row.stored), observed: row.observed, gap: optional(row.gap), restores: optional(row.restores),
      author: AttributionSchema.parse(JSON.parse(row.author)), settled: Boolean(row.settled), map: row.map ? decodeMap(row.map) : undefined,
    }
  }

  entry(seq: number): StoredEntry | undefined {
    const row = this.statement("SELECT * FROM entries WHERE seq=?").get(seq)
    return row ? this.entryOf(row) : undefined
  }

  author(seq: number): Attribution | undefined {
    const row = this.statement("SELECT author FROM entries WHERE seq=?").get(seq)
    return row ? AttributionSchema.parse(JSON.parse(z.object({ author: z.string() }).parse(row).author)) : undefined
  }

  setMeta(key: string, value: string): void {
    this.statement("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value)
  }

  meta(key: string): string | undefined {
    const row = this.statement("SELECT value FROM meta WHERE key=?").get(key)
    return row ? z.object({ value: z.string() }).parse(row).value : undefined
  }

  /** Entries after `after`, without their line maps. */
  entries(after: number, limit = 1000): StoredEntry[] {
    return this.statement("SELECT seq, at, changed_at, root, path, kind, from_path, before, after, size, text, added, removed, stored, observed, gap, restores, author, settled, NULL AS map FROM entries WHERE seq > ? ORDER BY seq LIMIT ?")
      .all(after, limit).map((row) => this.entryOf(row))
  }

  /** A file's entries after `after`, oldest first, with their line maps; a rename away from it counts. */
  chain(root: string, path: string, after = 0): StoredEntry[] {
    return this.statement("SELECT * FROM entries WHERE root=?1 AND (path=?2 OR from_path=?2) AND seq > ?3 ORDER BY seq").all(root, path, after).map((row) => this.entryOf(row))
  }

  /** A file's last entry after `after`, without its line map; a rename away from it counts. */
  last(root: string, path: string, after = 0): StoredEntry | undefined {
    const row = this.statement("SELECT seq, at, changed_at, root, path, kind, from_path, before, after, size, text, added, removed, stored, observed, gap, restores, author, settled, NULL AS map FROM entries WHERE root=?1 AND (path=?2 OR from_path=?2) AND seq > ?3 ORDER BY seq DESC LIMIT 1").get(root, path, after)
    return row ? this.entryOf(row) : undefined
  }

  /** Entries by a Thread or Session, without line maps. */
  entriesBy(column: "thread" | "session", id: string): StoredEntry[] {
    return this.statement(`SELECT seq, at, changed_at, root, path, kind, from_path, before, after, size, text, added, removed, stored, observed, gap, restores, author, settled, NULL AS map FROM entries WHERE ${column}=? ORDER BY seq`)
      .all(id).map((row) => this.entryOf(row))
  }

  /** Entries the journal may still change the author of. */
  unsettled(): StoredEntry[] {
    return this.statement("SELECT seq, at, changed_at, root, path, kind, from_path, before, after, size, text, added, removed, stored, observed, gap, restores, author, settled, NULL AS map FROM entries WHERE settled=0 ORDER BY seq")
      .all().map((row) => this.entryOf(row))
  }

  /** Entries that name `thread` among their candidates. */
  ambiguousWith(thread: string): number {
    return Count.parse(this.statement("SELECT count(*) AS count FROM entries WHERE certainty='ambiguous' AND instr(author, ?) > 0").get(JSON.stringify({ thread }).slice(1, -1))).count
  }

  lastSeq(): number {
    return Count.parse(this.statement("SELECT coalesce(max(seq), 0) AS count FROM entries").get()).count
  }

  files(): FileState[] {
    return this.statement("SELECT * FROM files").all().map((value) => {
      const row = FileRow.parse(value)
      return { root: row.root, path: row.path, base: row.base, baseSeq: row.base_seq, current: row.current, text: Boolean(row.text), map: decodeMap(row.map) }
    })
  }

  saveFile(state: FileState): void {
    this.statement("INSERT OR REPLACE INTO files (root, path, base, base_seq, current, text, map) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(state.root, state.path, state.base, state.baseSeq, state.current, state.text ? 1 : 0, encodeMap(state.map))
  }

  deleteFile(root: string, path: string): void {
    this.statement("DELETE FROM files WHERE root=? AND path=?").run(root, path)
  }

  stats(root: string): Map<string, StatRow> {
    const statement = this.statement("SELECT path, dev, ino, size, mode, mtime_ns, ctime_ns, ref, checked_ns FROM stats WHERE root=?")
    statement.setReadBigInts(true)
    const out = new Map<string, StatRow>()
    for (const value of statement.all(root)) {
      const row = StatRowSchema.parse(value)
      out.set(row.path, {
        dev: Number(row.dev), ino: Number(row.ino), size: Number(row.size), mode: Number(row.mode),
        mtimeNs: row.mtime_ns, ctimeNs: row.ctime_ns, ref: row.ref, checkedNs: row.checked_ns,
      })
    }
    return out
  }

  saveStat(root: string, path: string, row: StatRow): void {
    this.statement("INSERT OR REPLACE INTO stats (root, path, dev, ino, size, mode, mtime_ns, ctime_ns, ref, checked_ns) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(root, path, row.dev, row.ino, row.size, row.mode, row.mtimeNs, row.ctimeNs, row.ref, row.checkedNs)
  }

  deleteStat(root: string, path: string): void {
    this.statement("DELETE FROM stats WHERE root=? AND path=?").run(root, path)
  }

  forgetRoot(root: string): void {
    this.transaction(() => {
      this.statement("DELETE FROM stats WHERE root=?").run(root)
      this.statement("DELETE FROM files WHERE root=?").run(root)
      this.statement("UPDATE roots SET active=0 WHERE id=?").run(root)
    })
  }

  /** Keep `bytes` by address, compressed; a second write of the same content costs a lookup. */
  putBlob(ref: ContentRef, bytes: Uint8Array, at: number): void {
    if (this.hasBlob(ref)) return
    this.statement("INSERT OR IGNORE INTO blobs (ref, size, at, data) VALUES (?, ?, ?, ?)").run(ref, bytes.byteLength, at, compress(bytes))
  }

  hasBlob(ref: ContentRef): boolean {
    return this.statement("SELECT 1 FROM blobs WHERE ref=?").get(ref) !== undefined
  }

  blob(ref: ContentRef): Uint8Array | undefined {
    const row = this.statement("SELECT data FROM blobs WHERE ref=?").get(ref)
    return row ? decompress(BlobRow.parse(row).data) : undefined
  }

  saveActivity(activity: StoredActivity): void {
    this.statement(`INSERT INTO activity (session, kind, id, thread, turn, checkout, cwd, label, named, record, started_at, ended_at, effects) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session, kind, id) DO UPDATE SET thread=excluded.thread, turn=coalesce(excluded.turn, turn), checkout=coalesce(excluded.checkout, checkout),
      cwd=coalesce(excluded.cwd, cwd), label=coalesce(excluded.label, label), named=excluded.named, record=coalesce(excluded.record, record),
      started_at=min(started_at, excluded.started_at), ended_at=coalesce(excluded.ended_at, ended_at), effects=coalesce(excluded.effects, effects)`)
      .run(activity.session, activity.kind, activity.id, activity.thread, activity.turn ?? null, activity.checkout ?? null, activity.cwd ?? null,
        activity.label ?? null, JSON.stringify(activity.named), activity.record ?? null, activity.start, activity.end, activity.effects ? JSON.stringify(activity.effects) : null)
  }

  private activityOf(value: Row): StoredActivity {
    const row = ActivityRow.parse(value)
    return {
      kind: row.kind, id: row.id, session: row.session, thread: row.thread, turn: optional(row.turn), checkout: optional(row.checkout), cwd: optional(row.cwd),
      label: optional(row.label), named: z.array(z.string()).parse(JSON.parse(row.named)), record: optional(row.record), start: row.started_at, end: row.ended_at,
      effects: row.effects ? StoredEffectSchema.parse(JSON.parse(row.effects)) : undefined,
    }
  }

  /** Activity that overlaps `[from, to]`. */
  activityBetween(from: number, to: number): StoredActivity[] {
    return this.statement("SELECT * FROM activity WHERE started_at <= ? AND (ended_at IS NULL OR ended_at >= ?)").all(to, from).map((row) => this.activityOf(row))
  }

  /** One call's, turn's or background work's activity. */
  activity(session: string, kind: StoredActivity["kind"], id: string): StoredActivity | undefined {
    const row = this.statement("SELECT * FROM activity WHERE session=? AND kind=? AND id=?").get(session, kind, id)
    return row ? this.activityOf(row) : undefined
  }

  activityOfThread(thread: string): StoredActivity[] {
    return this.statement("SELECT * FROM activity WHERE thread=? ORDER BY started_at").all(thread).map((row) => this.activityOf(row))
  }

  /** When each root's newest entry was journaled. */
  lastChanged(): Map<string, number> {
    const rows = this.statement("SELECT root, MAX(at) AS at FROM entries GROUP BY root").all()
    return new Map(rows.map((row) => {
      const { root, at } = z.object({ root: z.string(), at: z.number() }).parse(row)
      return [root, at]
    }))
  }

  /** Each folder Threads worked in, as checkout and as working folder, with when they last did; work still open counts as `now`. */
  lastWorked(now: number): { folder: string; at: number }[] {
    const rows = this.statement("SELECT checkout, cwd, MAX(coalesce(ended_at, ?)) AS at FROM activity GROUP BY checkout, cwd").all(now)
    return rows.flatMap((row) => {
      const { checkout, cwd, at } = z.object({ checkout: z.string().nullable(), cwd: z.string().nullable(), at: z.number() }).parse(row)
      return [checkout, cwd].flatMap((folder) => (folder ? [{ folder, at }] : []))
    })
  }

  /** Close what a host that stopped left open: it ran until the host was last seen. */
  closeOpenActivity(at: number): void {
    this.statement("UPDATE activity SET ended_at=max(started_at, ?) WHERE ended_at IS NULL").run(at)
  }

  openGap(root: string, from: number, reason: Gap["reason"]): number {
    return Number(this.statement("INSERT INTO gaps (root, from_at, reason) VALUES (?, ?, ?)").run(root, from, reason).lastInsertRowid)
  }

  closeGap(id: number, to: number): void {
    this.statement("UPDATE gaps SET to_at=? WHERE id=?").run(to, id)
  }

  gaps(): Gap[] {
    return this.statement("SELECT * FROM gaps ORDER BY id").all().map((value) => {
      const row = GapRow.parse(value)
      return { id: row.id, root: row.root, from: row.from_at, to: row.to_at ?? row.from_at, reason: row.reason }
    })
  }

  addFootprint(entry: FootprintEntry): void {
    this.statement(`INSERT INTO footprint (thread, session, turn, path, access, evidence, at, size, ref, secret, basis) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(thread, session, turn, path, access) DO UPDATE SET evidence=min(evidence, excluded.evidence), at=excluded.at, size=excluded.size, ref=excluded.ref,
      basis=CASE WHEN excluded.evidence <= evidence THEN excluded.basis ELSE basis END`)
      .run(entry.thread, entry.session, entry.turn ?? "", entry.path, entry.access, entry.evidence, entry.at, entry.size ?? null, entry.ref ?? null, entry.secret ? 1 : 0, entry.basis ?? null)
  }

  /** What one turn's footprint read, kept and left out, by rule. */
  saveFootprintTurn(turn: FootprintTurn): void {
    this.statement("INSERT OR REPLACE INTO footprint_turns (session, turn, thread, at, summary) VALUES (?, ?, ?, ?, ?)")
      .run(turn.session, turn.turn ?? "", turn.thread, turn.end, JSON.stringify(turn))
  }

  footprintTurns(thread: string, limit = 200): FootprintTurn[] {
    return this.statement("SELECT summary FROM footprint_turns WHERE thread=? ORDER BY at DESC LIMIT ?").all(thread, limit)
      .map((value) => FootprintTurnSchema.parse(JSON.parse(FootprintTurnRow.parse(value).summary)))
      .reverse()
  }

  noise(): NoiseRow[] {
    return this.statement("SELECT * FROM noise").all().map((value) => {
      const row = NoiseRowSchema.parse(value)
      return { ...row, threads: z.array(z.string()).parse(JSON.parse(row.threads)) }
    })
  }

  saveNoise(rows: readonly NoiseRow[]): void {
    const save = this.statement("INSERT OR REPLACE INTO noise (key, kind, idle, weak, threads, at) VALUES (?, ?, ?, ?, ?, ?)")
    this.transaction(() => {
      for (const row of rows) save.run(row.key, row.kind, row.idle, row.weak, JSON.stringify(row.threads), row.at)
    })
  }

  dropNoise(keys: readonly string[]): void {
    const drop = this.statement("DELETE FROM noise WHERE key=?")
    this.transaction(() => {
      for (const key of keys) drop.run(key)
    })
  }

  footprint(column: "thread" | "session", id: string): FootprintEntry[] {
    return this.statement(`SELECT * FROM footprint WHERE ${column}=? ORDER BY at`).all(id).map((value) => {
      const row = FootprintRow.parse(value)
      const entry: FootprintEntry = {
        thread: row.thread, session: row.session, turn: row.turn || undefined, path: row.path, access: row.access, evidence: row.evidence,
        at: row.at, size: optional(row.size), ref: optional(row.ref), secret: Boolean(row.secret),
      }
      if (row.basis) entry.basis = row.basis
      return entry
    })
  }

  /** `ref`: the file's content as committed, so a later base with the same content finds who wrote its lines. */
  saveCommit(root: string, oid: string, path: string, at: number, authors: Int32Array, ref: ContentRef): void {
    this.statement("INSERT OR REPLACE INTO commits (root, oid, path, at, authors, ref) VALUES (?, ?, ?, ?, ?, ?)")
      .run(root, oid, path, at, new Uint8Array(authors.buffer, authors.byteOffset, authors.byteLength), ref)
  }

  /** Who last wrote each line of the file as a commit has it, by journal entry; 0 for lines from before tracking, -1 unknown. */
  commitAuthors(root: string, oid: string, path: string): Int32Array | undefined {
    return lineAuthors(BlobRow.optional().parse(this.statement("SELECT authors AS data FROM commits WHERE root=? AND oid=? AND path=?").get(root, oid, path)))
  }

  /** The same, for the newest commit whose content of `path` was `ref`. */
  committedAuthors(root: string, path: string, ref: ContentRef): Int32Array | undefined {
    return lineAuthors(BlobRow.optional().parse(this.statement("SELECT authors AS data FROM commits WHERE root=? AND path=? AND ref=? ORDER BY at DESC LIMIT 1").get(root, path, ref)))
  }

  /** Stored blobs' count and compressed bytes. */
  blobSize(): BlobSize {
    const row = Size.parse(this.statement("SELECT sum(length(data)) AS bytes, count(*) AS count FROM blobs").get())
    return { count: row.count, bytes: row.bytes ?? 0 }
  }

  counts(): JournalCounts {
    const count = (sql: string) => Count.parse(this.statement(sql).get()).count
    return {
      entries: count("SELECT count(*) AS count FROM entries"),
      files: count("SELECT count(*) AS count FROM files"),
      stats: count("SELECT count(*) AS count FROM stats"),
      activity: count("SELECT count(*) AS count FROM activity"),
      footprint: count("SELECT count(*) AS count FROM footprint"),
      unsettled: count("SELECT count(*) AS count FROM entries WHERE settled=0"),
    }
  }

  saveMove(move: MoveRecord): void {
    this.statement("INSERT INTO moves (at, thread, kind, files, guessed, offered) VALUES (?, ?, ?, ?, ?, ?)").run(move.at, move.thread, move.kind, move.files, move.guessed, move.offered)
  }

  /** The person picked `path` for `spelling` in a Thread's answers; kept for good, a row a spelling. */
  saveChoice(choice: FileChoice): void {
    this.statement("INSERT OR REPLACE INTO choices (thread, spelling, path, at) VALUES (?, ?, ?, ?)").run(choice.thread, choice.spelling, choice.path, choice.at)
  }

  /** The files the person picked in a Thread's answers, by spelling. */
  choices(thread: string): Map<string, string> {
    const rows = this.statement("SELECT spelling, path FROM choices WHERE thread=?").all(thread)
    return new Map(rows.map((row) => {
      const { spelling, path } = ChoiceRow.parse(row)
      return [spelling, path]
    }))
  }

  /** Moves and the person's changes to them since `since`, by kind: how many, and their files summed. */
  moveTotals(since: number): Map<MoveRecord["kind"], { count: number; files: number; guessed: number; offered: number }> {
    const rows = this.statement("SELECT kind, count(*) AS count, sum(files) AS files, sum(guessed) AS guessed, sum(offered) AS offered FROM moves WHERE at >= ? GROUP BY kind").all(since)
    return new Map(rows.map((row) => {
      const { kind, ...totals } = z.object({ kind: z.enum(["move", "put-back", "bring"]), count: z.number(), files: z.number(), guessed: z.number(), offered: z.number() }).parse(row)
      return [kind, totals]
    }))
  }

  changesSince(since: number): ChangesSince {
    const rows = this.statement(`SELECT root, count(DISTINCT path) AS files, coalesce(sum(added), 0) AS added, coalesce(sum(removed), 0) AS removed, count(DISTINCT thread) AS threads
      FROM entries WHERE at >= ? AND thread IS NOT NULL GROUP BY root`).all(since)
    const roots = rows.map((row) => z.object({ root: z.string(), files: z.number(), added: z.number(), removed: z.number(), threads: z.number() }).parse(row))
    const threads = Count.parse(this.statement("SELECT count(DISTINCT thread) AS count FROM entries WHERE at >= ? AND thread IS NOT NULL").get(since)).count
    return { roots, threads }
  }

  /** How many entries each certainty has, for the ambiguity rate. */
  certaintyMix(since = 0): Map<string, number> {
    const rows = this.statement("SELECT certainty AS key, count(*) AS count FROM entries WHERE at >= ? GROUP BY certainty").all(since)
    return new Map(rows.map((row) => z.object({ key: z.string(), count: z.number() }).parse(row)).map((row) => [row.key, row.count]))
  }

  /**
   * Drop kept content no one needs: blobs behind no uncommitted line and no
   * entry younger than `retainAfter`; then, while the store is past
   * `budget` bytes, the oldest of those younger ones too. Content behind an
   * uncommitted line is never dropped.
   */
  collect(retainAfter: number, budget: number): Collected {
    const live = `SELECT base FROM files WHERE base IS NOT NULL UNION SELECT current FROM files WHERE current IS NOT NULL
      UNION SELECT e.before FROM entries e JOIN files f ON f.root = e.root AND f.path = e.path AND e.seq > f.base_seq WHERE e.before IS NOT NULL
      UNION SELECT e.after FROM entries e JOIN files f ON f.root = e.root AND f.path = e.path AND e.seq > f.base_seq WHERE e.after IS NOT NULL
      UNION SELECT ref FROM stats WHERE ref IS NOT NULL`
    const before = this.blobSize()
    this.statement("DELETE FROM footprint_turns WHERE at < ?").run(retainAfter)
    this.statement("DELETE FROM moves WHERE at < ?").run(retainAfter)
    this.transaction(() => {
      this.db.exec(`CREATE TEMP TABLE IF NOT EXISTS live_refs (ref TEXT PRIMARY KEY) WITHOUT ROWID; DELETE FROM live_refs; INSERT OR IGNORE INTO live_refs ${live};`)
      this.statement(`DELETE FROM blobs WHERE ref NOT IN (SELECT ref FROM live_refs) AND ref NOT IN (
        SELECT before FROM entries WHERE at >= ?1 AND before IS NOT NULL UNION SELECT after FROM entries WHERE at >= ?1 AND after IS NOT NULL)`).run(retainAfter)
      let size = this.blobSize().bytes
      if (size > budget) {
        const candidates = this.statement("SELECT ref, length(data) AS bytes FROM blobs WHERE ref NOT IN (SELECT ref FROM live_refs) ORDER BY at").all()
        const drop = this.statement("DELETE FROM blobs WHERE ref=?")
        for (const value of candidates) {
          if (size <= budget) break
          const row = z.object({ ref: z.string(), bytes: z.number() }).parse(value)
          drop.run(row.ref)
          size -= row.bytes
        }
      }
    })
    const after = this.blobSize()
    return { dropped: before.count - after.count, bytes: before.bytes - after.bytes }
  }

  /** A number that changes whenever another connection commits: a reader's cue that what it read is stale. */
  dataVersion(): number {
    return z.object({ data_version: z.number() }).parse(this.statement("PRAGMA data_version").get()).data_version
  }

  close(): void {
    this.statements.clear()
    this.db.close()
  }
}
