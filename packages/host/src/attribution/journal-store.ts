import { createHash, randomUUID } from "node:crypto"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { DatabaseSync, type SQLOutputValue, type StatementSync } from "node:sqlite"
import { atOnce, type Steps } from "@mako/sessions/slices"
import { z } from "zod"
import {
  AttributionSchema,
  CarriedEffectSchema,
  FootprintBasisSchema,
  ObservedBySchema,
  type Attribution,
  type CarriedActivity,
  type CarriedChoice,
  type ChangeKind,
  type ContentRef,
  type FootprintEntry,
  type Gap,
  type ObservedBy,
  type ThreadHistoryPart,
  type TrackedRoot,
} from "@mako/protocol/attribution"
import { TurnChangesSchema, type TurnChanges } from "../contracts/turn-changes.js"
import { compress, decompress } from "./content.js"
import { StatCache } from "./stat-cache.js"
import { FootprintTurnSchema, type FootprintTurn } from "./footprint.js"
import { decodeMap, encodeMap, type Run } from "./line-map.js"

/*
 * The journal on disk: one SQLite file per host, in write-ahead mode with
 * `synchronous=NORMAL` (a commit appends to the log without an fsync; only a
 * power loss in the same instant can lose the last few). Entries are
 * numbered by SQLite's rowid, so numbers only ever grow, dense until
 * retention drops old ones (`JournalStore.pruneEntries`). Blobs
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
  /**
   * Git made it, not a writer: a checkout, pull, rebase, reset or stash put
   * back content Git holds, while no call named the file. What a Thread or a
   * turn changed leaves it out; its lines keep the writers they had.
   */
  git?: true
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

/** How a call ended, as its harness reported it: a refused or failed call changed nothing it said it would. */
export type CallStatus = "completed" | "failed" | "refused" | "running"
const CallStatusSchema = z.enum(["completed", "failed", "refused", "running"])

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
  author: z.string(), settled: z.number(), git: z.number().nullable().optional(), map: z.instanceof(Uint8Array).nullable(),
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
const ActivityRow = z.object({
  kind: z.enum(["turn", "call", "background"]), id: z.string(), session: z.string(), thread: z.string(), turn: z.string().nullable(), checkout: z.string().nullable(),
  cwd: z.string().nullable(), label: z.string().nullable(), named: z.string(), record: z.string().nullable(), started_at: z.number(), ended_at: z.number().nullable(), effects: z.string().nullable(),
  // A journal opened read-only from before these columns has neither.
  status: CallStatusSchema.nullable().optional(), run: z.string().nullable().optional(),
})
const ActivityTimesRow = z.object({ session: z.string(), kind: z.enum(["turn", "call", "background"]), id: z.string(), started_at: z.number(), ended_at: z.number().nullable() })
const Count = z.object({ count: z.number() })
const ThreadChangeRow = z.object({ seq: z.number(), moved: z.number() })
const ChangeSeqRow = z.object({ change_seq: z.number() })
const RootChangeRow = ChangeSeqRow.extend({ root: z.string() })
const ThreadWriteRow = z.object({ seq: z.number(), root: z.string(), path: z.string(), at: z.number(), kind: z.string(), certainty: z.string() })
const TurnChangesRow = z.object({ summary: z.string() })
const TurnSeqRow = z.object({ turn: z.string(), seq: z.number() })
const SeqRow = z.object({ seq: z.number() })
const NullableSeqRow = SeqRow.extend({ seq: z.number().nullable() })
const AuthorRow = z.object({ author: z.string() })
const ProvenanceRow = z.object({ git: z.number().nullable(), gap: z.number().nullable() })
const NamedPathsSchema = z.array(z.string())
const ActivitySessionRow = z.object({ session: z.string() })
const RootAtRow = z.object({ root: z.string(), at: z.number() })
const WorkedRow = z.object({ checkout: z.string().nullable(), cwd: z.string().nullable(), at: z.number() })
const WorkedKeyRow = WorkedRow.extend({ session: z.string(), kind: z.string(), id: z.string() })
const ThreadRow = z.object({ thread: z.string() })
const NullableThreadRow = z.object({ thread: z.string().nullable() })
const NullableRootRow = z.object({ root: z.string().nullable() })
const FolderAtRow = z.object({ folder: z.string(), at: z.number() })
const OpenWorkRow = z.object({ checkout: z.string().nullable(), cwd: z.string().nullable() })
const VersionRow = z.object({ seq: z.number(), map: z.instanceof(Uint8Array) })
const OldEntryRow = z.object({ seq: z.number(), thread: z.string().nullable(), root: z.string(), path: z.string(), from_path: z.string().nullable(), certainty: z.string() })
const CommitKeyRow = z.object({ root: z.string(), oid: z.string(), path: z.string(), at: z.number(), ref: z.string().nullable() })
const GapAgeRow = z.object({ id: z.number(), at: z.number() })
const SqlRow = z.object({ sql: z.string().nullable() })
const BeforeRow = z.object({ before: z.number() })
const MapRow = z.object({ map: z.instanceof(Uint8Array) })

/** Entries `JournalStore.recency` reads a step the one time it fills `RECENCY`'s tables: a window of the journal's numbering. */
const RECENT_ENTRIES = 4_096
/** Read, decode and fold at most this many calls per step; 2,048 took a whole 9 ms slice on CI x64. */
const RECENT_CALLS = 512

/** A page of a turn's entries (`JournalStore.entriesOfTurnPage`), and where the next starts; none after the last. */
export interface TurnEntriesPage {
  entries: StoredEntry[]
  next?: number
}

/** When each root last changed and each folder was last worked in, by its root's ID or its path (`JournalStore.recency`). */
export interface Recency {
  changed: ReadonlyMap<string, number>
  /** Read only when `recency`'s caller wants it; empty otherwise. */
  worked: ReadonlyMap<string, number>
}

/** `at` into `into` under `key`, when it's later than what's there. */
function later(into: Map<string, number>, key: string, at: number): void {
  if (at > (into.get(key) ?? Number.NEGATIVE_INFINITY)) into.set(key, at)
}

/** A call's folders, as checkout and as working folder, into `worked`. */
function workedIn(worked: Map<string, number>, row: z.infer<typeof WorkedRow>): void {
  if (row.checkout) later(worked, row.checkout, row.at)
  if (row.cwd) later(worked, row.cwd, row.at)
}
const ChoiceRow = z.object({ spelling: z.string(), path: z.string(), at: z.number() })
const CarriedRow = z.object({ journal: z.string(), device: z.string(), through: z.number(), at: z.number(), received: z.number(), roots: z.string() })
const CarriedActivityRow = z.object({
  journal: z.string(), session: z.string(), kind: z.enum(["turn", "call", "background"]), id: z.string(), started_at: z.number(), ended_at: z.number().nullable(),
  checkout: z.string().nullable(), cwd: z.string().nullable(), named: z.string(), effects: z.string().nullable(),
})
const CarriedPathRow = z.object({ journal: z.string(), kind: z.enum(["write", "name"]), seq: z.number(), at: z.number(), path: z.string(), to_path: z.string().nullable() })
const Size = z.object({ bytes: z.number().nullable(), count: z.number() })
// Every schema a row or a column is read with is made once here: one built per row compiles anew for each.
const CarriedRootsSchema = z.array(z.object({ path: z.string(), repository: z.boolean() }))
const NamedSchema = z.array(z.string())
const CarriedEffectsSchema = z.array(CarriedEffectSchema)
const MoveTotalsRow = z.object({ kind: z.enum(["move", "put-back", "bring"]), count: z.number(), files: z.number(), guessed: z.number(), offered: z.number() })
const ChangedRootRow = z.object({ root: z.string(), files: z.number(), added: z.number(), removed: z.number(), threads: z.number() })
const TableInfoRow = z.object({ name: z.string() })
const ValueRow = z.object({ value: z.string() })
const CarriedVersionRow = z.object({ count: z.number(), through: z.number().nullable(), at: z.number().nullable() })
const CarriedStampRow = z.object({ through: z.number(), at: z.number() })
const DataVersionRow = z.object({ data_version: z.number() })
const KeyCountRow = z.object({ key: z.string(), count: z.number() })
const PathRow = z.object({ path: z.string() })
const EntryPathRow = z.object({ seq: z.number(), root: z.string(), path: z.string(), from_path: z.string().nullable(), kind: z.enum(["create", "modify", "delete", "rename"]) })
const EvidenceCountRow = z.object({ evidence: z.enum(["strong", "weak"]), count: z.number() })

/** A call's, turn's or background work's key in the journal. */
export interface ActivityKey {
  session: string
  kind: StoredActivity["kind"]
  id: string
}

export interface StoredActivity {
  kind: "turn" | "call" | "background"
  id: string
  session: string
  thread: string
  turn?: string
  /** A call's status as its reported effects last said; absent for a call that reported none. */
  status?: CallStatus
  /** The harness's own run id, for a turn it reported one for: metadata, never the key. */
  run?: string
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
  CREATE TABLE IF NOT EXISTS entry_candidates (seq INTEGER NOT NULL, thread TEXT NOT NULL, turn TEXT, PRIMARY KEY (seq, thread)) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS entry_candidates_thread ON entry_candidates(thread, turn);
  CREATE TABLE IF NOT EXISTS turn_changes (
    thread TEXT NOT NULL, turn TEXT NOT NULL, session TEXT NOT NULL, at INTEGER NOT NULL, summary TEXT NOT NULL, PRIMARY KEY (thread, turn)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS choices (thread TEXT NOT NULL, spelling TEXT NOT NULL, path TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (thread, spelling)) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS carried (
    thread TEXT NOT NULL, journal TEXT NOT NULL, device TEXT NOT NULL, through INTEGER NOT NULL, at INTEGER NOT NULL, received INTEGER NOT NULL, roots TEXT NOT NULL,
    PRIMARY KEY (thread, journal)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS carried_activity (
    thread TEXT NOT NULL, journal TEXT NOT NULL, session TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER,
    checkout TEXT, cwd TEXT, named TEXT NOT NULL, effects TEXT, PRIMARY KEY (thread, journal, session, kind, id)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS carried_paths (
    thread TEXT NOT NULL, journal TEXT NOT NULL, kind TEXT NOT NULL, seq INTEGER NOT NULL, at INTEGER NOT NULL, path TEXT NOT NULL, to_path TEXT,
    PRIMARY KEY (thread, journal, kind, path, seq)
  ) WITHOUT ROWID;
`

/**
 * Columns added after a table was first made, with what adds them. An
 * entry's turn is its author's, and the Threads an ambiguous entry names
 * are kept beside it, so a turn's changes and a Thread's maybe are an
 * indexed read; both are filled once from the authors already kept.
 */
const ADDED_COLUMNS = [
  { table: "footprint", column: "basis", add: "ALTER TABLE footprint ADD COLUMN basis TEXT" },
  { table: "commits", column: "ref", add: "ALTER TABLE commits ADD COLUMN ref TEXT; CREATE INDEX IF NOT EXISTS commits_ref ON commits(root, path, ref, at)" },
  {
    table: "entries",
    column: "turn",
    add: `ALTER TABLE entries ADD COLUMN turn TEXT;
      UPDATE entries SET turn = json_extract(author, '$.author.turn') WHERE thread IS NOT NULL;
      INSERT OR IGNORE INTO entry_candidates (seq, thread, turn)
        SELECT e.seq, json_extract(c.value, '$.thread'), json_extract(c.value, '$.turn') FROM entries e, json_each(e.author, '$.candidates') c WHERE e.certainty = 'ambiguous';
      CREATE INDEX IF NOT EXISTS entries_turn ON entries(thread, turn, seq) WHERE turn IS NOT NULL`,
  },
  { table: "activity", column: "status", add: "ALTER TABLE activity ADD COLUMN status TEXT" },
  { table: "activity", column: "run", add: "ALTER TABLE activity ADD COLUMN run TEXT" },
  { table: "entries", column: "git", add: "ALTER TABLE entries ADD COLUMN git INTEGER" },
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

/** At most this many blobs go in one pass collected off the host's thread: the rest go on the next. */
export const COLLECT_MOST = 20_000

/** Blobs a pass of collection drops, oldest first, and what the store held before it. */
export interface CollectPlan {
  refs: { ref: string; bytes: number }[]
  before: { count: number; bytes: number }
}

/**
 * Which kept content `JournalStore.collect` drops, read in one transaction on any connection to the journal, a
 * read-only one included (a worker's): blobs behind no uncommitted line and no entry younger than `retainAfter`,
 * then, while the store is past `budget` bytes, the oldest of the younger ones. At most `most`.
 */
export function collectPlan(db: DatabaseSync, retainAfter: number, budget: number, most = Infinity): CollectPlan {
  const size = () => {
    const row = Size.parse(db.prepare("SELECT sum(length(data)) AS bytes, count(*) AS count FROM blobs").get())
    return { count: row.count, bytes: row.bytes ?? 0 }
  }
  // One snapshot throughout; inside a caller's transaction, that one.
  const own = !db.isTransaction
  if (own) db.exec("BEGIN")
  try {
    const before = size()
    db.exec(`CREATE TEMP TABLE IF NOT EXISTS live_refs (ref TEXT PRIMARY KEY) WITHOUT ROWID; DELETE FROM live_refs; INSERT OR IGNORE INTO live_refs ${LIVE_REFS};`)
    const limit = Number.isFinite(most) ? most : -1
    const refs = db.prepare(`SELECT ref, length(data) AS bytes FROM blobs WHERE ref NOT IN (SELECT ref FROM live_refs) AND ref NOT IN (
      SELECT before FROM entries WHERE at >= ?1 AND before IS NOT NULL UNION SELECT after FROM entries WHERE at >= ?1 AND after IS NOT NULL) ORDER BY at LIMIT ?2`)
      .all(retainAfter, limit).map((row) => RefBytes.parse(row))
    let left = before.bytes - refs.reduce((sum, item) => sum + item.bytes, 0)
    if (left > budget && refs.length < (Number.isFinite(most) ? most : Infinity)) {
      const doomed = new Set(refs.map((item) => item.ref))
      for (const value of db.prepare("SELECT ref, length(data) AS bytes FROM blobs WHERE ref NOT IN (SELECT ref FROM live_refs) ORDER BY at").iterate()) {
        if (left <= budget || refs.length >= most) break
        const row = RefBytes.parse(value)
        if (doomed.has(row.ref)) continue
        refs.push(row)
        left -= row.bytes
      }
    }
    return { refs, before }
  } finally {
    if (own) db.exec("ROLLBACK")
  }
}

/** Content behind an uncommitted line: never collected. */
const LIVE_REFS = `SELECT base FROM files WHERE base IS NOT NULL UNION SELECT current FROM files WHERE current IS NOT NULL
    UNION SELECT e.before FROM entries e JOIN files f ON f.root = e.root AND f.path = e.path AND e.seq > f.base_seq WHERE e.before IS NOT NULL
    UNION SELECT e.after FROM entries e JOIN files f ON f.root = e.root AND f.path = e.path AND e.seq > f.base_seq WHERE e.after IS NOT NULL
    UNION SELECT ref FROM stats WHERE ref IS NOT NULL`
/** The same, without the stat cache's (a million rows): what a drop checks again, the stat cache's being in `touched`. */
/**
 * Indexes added since the journal's format was named, for reads that scanned a table whole. Outside `MIGRATION`, as
 * `CHANGE_TRACKING` is and for its reason; a journal without them (an older owner's) reads the same, only slower.
 */
const ADDED_INDEXES = `CREATE INDEX IF NOT EXISTS activity_ended ON activity(ended_at);`

/**
 * Activity overlapping a stretch, bound as (from, to, to): what ended since `from`, by `activity_ended`, and what is
 * still open. As one `WHERE` with an `OR` no index served it, and every flush inside a gap read the table whole
 * (210 MB on 2026-11-17). Rows come in no order: `byActivityKey` gives the table's own.
 */
export const ACTIVITY_OVERLAPPING = `SELECT * FROM activity WHERE ended_at >= ? AND started_at <= ?
  UNION ALL SELECT * FROM activity WHERE ended_at IS NULL AND started_at <= ?`

/** The activity table's own order, by its key. */
export function byActivityKey(a: { session: string; kind: string; id: string }, b: { session: string; kind: string; id: string }): number {
  return compareText(a.session, b.session) || compareText(a.kind, b.kind) || compareText(a.id, b.id)
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

const LIVE_FILE_REFS = `SELECT base FROM files WHERE base IS NOT NULL UNION SELECT current FROM files WHERE current IS NOT NULL
    UNION SELECT e.before FROM entries e JOIN files f ON f.root = e.root AND f.path = e.path AND e.seq > f.base_seq WHERE e.before IS NOT NULL
    UNION SELECT e.after FROM entries e JOIN files f ON f.root = e.root AND f.path = e.path AND e.seq > f.base_seq WHERE e.after IS NOT NULL`
const RefBytes = z.object({ ref: z.string(), bytes: z.number() })

/**
 * What changed for each Thread, kept by triggers so every writer is counted, a host of another build and a bulk update
 * alike. Not in `MIGRATION`: the shared journal's folder is named for that (`SHARED_FORMAT`), so a change there would
 * leave every host on a new, empty journal. Nothing needs these to read true, only to read less: where they're missing,
 * as under an older owner, `threadVersion` says so and a Thread is read whole on any write.
 */
const CHANGE_TRACKING = `
  CREATE TABLE IF NOT EXISTS change_clock (id INTEGER PRIMARY KEY CHECK (id = 1), seq INTEGER NOT NULL);
  INSERT OR IGNORE INTO change_clock (id, seq) VALUES (1, 0);
  CREATE TABLE IF NOT EXISTS thread_changes (thread TEXT PRIMARY KEY, seq INTEGER NOT NULL, moved INTEGER NOT NULL DEFAULT 0) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS activity_changes (
    session TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, thread TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY (session, kind, id)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS activity_changes_thread ON activity_changes(thread, seq);
  CREATE TRIGGER IF NOT EXISTS activity_inserted AFTER INSERT ON activity BEGIN
    UPDATE change_clock SET seq = seq + 1;
    INSERT INTO activity_changes VALUES (NEW.session, NEW.kind, NEW.id, NEW.thread, (SELECT seq FROM change_clock))
      ON CONFLICT (session, kind, id) DO UPDATE SET thread = excluded.thread, seq = excluded.seq;
    INSERT INTO thread_changes (thread, seq) VALUES (NEW.thread, (SELECT seq FROM change_clock))
      ON CONFLICT (thread) DO UPDATE SET seq = excluded.seq;
  END;
  CREATE TRIGGER IF NOT EXISTS activity_updated AFTER UPDATE ON activity BEGIN
    UPDATE change_clock SET seq = seq + 1;
    INSERT INTO activity_changes VALUES (NEW.session, NEW.kind, NEW.id, NEW.thread, (SELECT seq FROM change_clock))
      ON CONFLICT (session, kind, id) DO UPDATE SET thread = excluded.thread, seq = excluded.seq;
    INSERT INTO thread_changes (thread, seq) VALUES (NEW.thread, (SELECT seq FROM change_clock))
      ON CONFLICT (thread) DO UPDATE SET seq = excluded.seq;
    INSERT INTO thread_changes (thread, seq, moved) SELECT OLD.thread, (SELECT seq FROM change_clock), 1 WHERE OLD.thread <> NEW.thread
      ON CONFLICT (thread) DO UPDATE SET seq = excluded.seq, moved = moved + 1;
  END;
  CREATE TRIGGER IF NOT EXISTS activity_deleted AFTER DELETE ON activity BEGIN
    UPDATE change_clock SET seq = seq + 1;
    DELETE FROM activity_changes WHERE session = OLD.session AND kind = OLD.kind AND id = OLD.id;
    INSERT INTO thread_changes (thread, seq, moved) VALUES (OLD.thread, (SELECT seq FROM change_clock), 1)
      ON CONFLICT (thread) DO UPDATE SET seq = excluded.seq, moved = moved + 1;
  END;
  CREATE TRIGGER IF NOT EXISTS entries_inserted AFTER INSERT ON entries WHEN NEW.thread IS NOT NULL BEGIN
    UPDATE change_clock SET seq = seq + 1;
    INSERT INTO thread_changes (thread, seq) VALUES (NEW.thread, (SELECT seq FROM change_clock))
      ON CONFLICT (thread) DO UPDATE SET seq = excluded.seq;
  END;
  CREATE TRIGGER IF NOT EXISTS entries_updated AFTER UPDATE OF thread, certainty, root, path, kind, at ON entries BEGIN
    UPDATE change_clock SET seq = seq + 1;
    INSERT INTO thread_changes (thread, seq) SELECT NEW.thread, (SELECT seq FROM change_clock) WHERE NEW.thread IS NOT NULL
      ON CONFLICT (thread) DO UPDATE SET seq = excluded.seq;
    INSERT INTO thread_changes (thread, seq) SELECT OLD.thread, (SELECT seq FROM change_clock) WHERE OLD.thread IS NOT NULL
      ON CONFLICT (thread) DO UPDATE SET seq = excluded.seq;
  END;
  CREATE TRIGGER IF NOT EXISTS entries_deleted AFTER DELETE ON entries WHEN OLD.thread IS NOT NULL BEGIN
    UPDATE change_clock SET seq = seq + 1;
    INSERT INTO thread_changes (thread, seq) VALUES (OLD.thread, (SELECT seq FROM change_clock))
      ON CONFLICT (thread) DO UPDATE SET seq = excluded.seq;
  END;
`

/** Partition inputs have a clock per root: activity, stat refreshes and another checkout's writes don't move it. */
const CHECKPOINT_CHANGES = `
  CREATE TABLE IF NOT EXISTS checkpoint_root_changes (root TEXT PRIMARY KEY, seq INTEGER NOT NULL) WITHOUT ROWID;
  INSERT OR IGNORE INTO checkpoint_root_changes (root, seq) SELECT id, 0 FROM roots;
` + ["entries", "files", "roots"].flatMap((table) => ["INSERT", "DELETE", "UPDATE"].map((event) => {
  const root = table === "roots" ? "id" : "root"
  const columns = event !== "UPDATE" ? "" : table === "roots" ? " OF path, head, active" : table === "entries" ? " OF author, git, root, path, kind, from_path, before, after, map, gap, restores" : ""
  const changed = event === "UPDATE" && table === "roots" ? " WHEN NEW.path IS NOT OLD.path OR NEW.head IS NOT OLD.head OR NEW.active IS NOT OLD.active" : ""
  const from = event === "DELETE" ? "OLD" : "NEW"
  return `CREATE TRIGGER IF NOT EXISTS checkpoint_${table}_${event.toLowerCase()} AFTER ${event}${columns} ON ${table}${changed} BEGIN
    INSERT INTO checkpoint_root_changes (root, seq) VALUES (${from}.${root}, 1) ON CONFLICT(root) DO UPDATE SET seq = seq + 1;
    ${event === "UPDATE" ? `INSERT INTO checkpoint_root_changes (root, seq) SELECT OLD.${root}, 1 WHERE OLD.${root} IS NOT NEW.${root} ON CONFLICT(root) DO UPDATE SET seq = seq + 1;` : ""}
  END;`
})).join("\n")

/**
 * When each root last changed and each folder was last worked in, kept as it is written: what decides which roots are
 * idle (`JournalStore.recency`) read every entry and then paged every call, hourly, on a journal of 399,174 entries
 * and 175,857 calls. By triggers, as `CHANGE_TRACKING` is and outside `MIGRATION` for its reason, so a host of another
 * build that owns the journal keeps them too. A journal from before them is read the old way once (`recency`), and
 * `meta` says when that is done.
 */
const RECENCY = `
  CREATE TABLE IF NOT EXISTS root_changed (root TEXT PRIMARY KEY, at INTEGER NOT NULL) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS folder_worked (folder TEXT PRIMARY KEY, at INTEGER NOT NULL) WITHOUT ROWID;
  CREATE TRIGGER IF NOT EXISTS recency_entries_inserted AFTER INSERT ON entries BEGIN
    INSERT INTO root_changed (root, at) VALUES (NEW.root, NEW.at) ON CONFLICT (root) DO UPDATE SET at = excluded.at WHERE excluded.at > at;
  END;
  CREATE TRIGGER IF NOT EXISTS recency_activity_inserted AFTER INSERT ON activity BEGIN
    INSERT INTO folder_worked (folder, at) SELECT NEW.checkout, coalesce(NEW.ended_at, NEW.started_at) WHERE NEW.checkout IS NOT NULL
      ON CONFLICT (folder) DO UPDATE SET at = excluded.at WHERE excluded.at > at;
    INSERT INTO folder_worked (folder, at) SELECT NEW.cwd, coalesce(NEW.ended_at, NEW.started_at) WHERE NEW.cwd IS NOT NULL
      ON CONFLICT (folder) DO UPDATE SET at = excluded.at WHERE excluded.at > at;
  END;
  CREATE TRIGGER IF NOT EXISTS recency_activity_updated AFTER UPDATE OF checkout, cwd, started_at, ended_at ON activity BEGIN
    INSERT INTO folder_worked (folder, at) SELECT NEW.checkout, coalesce(NEW.ended_at, NEW.started_at) WHERE NEW.checkout IS NOT NULL
      ON CONFLICT (folder) DO UPDATE SET at = excluded.at WHERE excluded.at > at;
    INSERT INTO folder_worked (folder, at) SELECT NEW.cwd, coalesce(NEW.ended_at, NEW.started_at) WHERE NEW.cwd IS NOT NULL
      ON CONFLICT (folder) DO UPDATE SET at = excluded.at WHERE excluded.at > at;
  END;
`
/** `meta`'s key for a journal whose `RECENCY` tables hold everything written before their triggers were made. */
const RECENCY_FILLED = "recency"

/**
 * Threads whose records retention dropped (`JournalStore.pruneThread`), each with the instant its records were older
 * than: what tells "this Thread changed nothing" from "what it changed is no longer kept". Outside `MIGRATION`, as
 * `CHANGE_TRACKING` is; a build from before it never reads it.
 */
const RETENTION = `CREATE TABLE IF NOT EXISTS pruned_threads (thread TEXT PRIMARY KEY, before INTEGER NOT NULL) WITHOUT ROWID;`

/** The `footprint` table as `MIGRATION` makes it, columns in its order, keyed by its primary key alone (`JournalStore.beginCompactFootprint`). */
const FOOTPRINT_COMPACT = `CREATE TABLE footprint_compact (
    thread TEXT NOT NULL, session TEXT NOT NULL, turn TEXT NOT NULL, path TEXT NOT NULL, access TEXT NOT NULL, evidence TEXT NOT NULL,
    at INTEGER NOT NULL, size INTEGER, ref TEXT, secret INTEGER NOT NULL, basis TEXT, PRIMARY KEY (thread, session, turn, path, access)
  ) WITHOUT ROWID`

/**
 * The page cache of a connection that writes, in KiB (SQLite's `cache_size`, negative): the owner's flushes probe the
 * same few index pages of `entries`, `stats` and `activity` over and over, and SQLite's default of 2 MiB holds too
 * few of a 2.7 GB journal's to keep them. A read-only connection keeps the default: each host holds one on its own
 * thread and the readers' workers one each, and what they read is as varied as what windows ask. No connection maps
 * the file (`mmap_size` 0, said so it stays so): a mapped journal another host's compaction truncates ends its
 * readers with a bus error instead of an error SQLite returns.
 */
const WRITER_CACHE_KIB = 16 * 1024
const READER_CACHE_KIB = 2 * 1024

/** What a pass of retention dropped, by what it was. */
export interface Pruned {
  entries: number
  activity: number
  commits: number
  footprint: number
  turns: number
  gaps: number
  stats: number
  threads: number
}

/** A page of a sweep of retention: how many rows went, and where the next page starts, until the last. */
export interface PrunedPage<Cursor> {
  dropped: number
  next?: Cursor
}

/** A commit's line writers by their key, where a sweep of them goes on from. */
export interface CommitKey {
  root: string
  oid: string
  path: string
}

/** What a step of dropping old gaps did, and whether older ones may remain. */
export interface PrunedGaps {
  dropped: number
  more: boolean
}

/** What a Thread is kept alive by, for retention: asked once a pass for each Thread. */
export interface Liveness {
  /** Records older than this are past retention. */
  retainAfter: number
  /** The first entry journaled at `retainAfter` or after; one past the newest when none was. */
  horizon: number
  /** Each Thread asked so far. */
  known: Map<string, boolean>
}

/** What a Thread's work has reached: `key` moves with anything that could change it; `seq` and `moved` are only there when changes are tracked. */
export interface ThreadVersion {
  key: string
  seq?: number
  moved?: number
}

/** A row as SQLite returns it, before its schema reads it. */
/** A row as SQLite gives it, here or on another connection (a worker's). */
export type Row = Record<string, SQLOutputValue>

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
  /** Refs written while a collection planned off this connection runs (`touching`). */
  private touched: Set<string> | undefined
  /** While a pass of retention runs (`retaining`): the entries uncommitted lines name, and the Threads that worked since it began. */
  private retention: { seqs: Set<number>; threads: Set<string> } | undefined
  /** While `footprint` is being rebuilt (`beginCompactFootprint`): the last row number copied. */
  private compacting: { after: number } | undefined
  /** Whether this journal has `RETENTION`'s table: once it does, it always will. */
  private tombstones = false
  readonly id: string
  readonly device: string
  private readonly db: DatabaseSync
  /** Whether this journal keeps `CHANGE_TRACKING`: once it does, it always will. */
  private tracked = false
  private checkpointsTracked = false
  private readonly readOnly: boolean
  private readonly statements = new Map<string, StatementSync>()

  private constructor(path: string, db: DatabaseSync, id: string, device: string, readOnly = false) {
    this.readOnly = readOnly
    this.path = path
    this.db = db
    this.id = id
    this.device = device
  }

  /** Open or create the journal at `path`; a read-only open never creates or migrates. */
  static open(path: string, options: { device: string; readOnly?: boolean }): JournalStore {
    if (options.readOnly) {
      const db = new DatabaseSync(path, { readOnly: true })
      db.exec(`PRAGMA busy_timeout=2000; PRAGMA cache_size=-${READER_CACHE_KIB}; PRAGMA mmap_size=0;`)
      const meta = new Map(db.prepare("SELECT key, value FROM meta").all().map((row) => MetaRow.parse(row)).map((row) => [row.key, row.value]))
      return new JournalStore(path, db, meta.get("journal") ?? "", meta.get("device") ?? "", true)
    }
    mkdirSync(dirname(path), { recursive: true })
    const db = new DatabaseSync(path)
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000; PRAGMA cache_size=-${WRITER_CACHE_KIB}; PRAGMA mmap_size=0;`)
    db.exec(MIGRATION)
    for (const added of ADDED_COLUMNS) {
      const columns = db.prepare(`PRAGMA table_info(${added.table})`).all().map((row) => TableInfoRow.parse(row).name)
      if (!columns.includes(added.column)) db.exec(added.add)
    }
    db.exec(CHANGE_TRACKING)
    db.exec(ADDED_INDEXES)
    // A journal with nothing in it yet has nothing from before these triggers: they have kept it whole from the start.
    const empty = !db.prepare("SELECT 1 FROM entries LIMIT 1").get() && !db.prepare("SELECT 1 FROM activity LIMIT 1").get()
    db.exec(RECENCY)
    db.exec(RETENTION)
    if (empty) db.prepare("INSERT INTO meta (key, value) VALUES (?, '1') ON CONFLICT (key) DO NOTHING").run(RECENCY_FILLED)
    // The clock becomes visible with every trigger installed, including to older writers sharing this journal.
    db.exec("BEGIN IMMEDIATE")
    try { db.exec(CHECKPOINT_CHANGES); db.exec("COMMIT") }
    catch (error) { db.exec("ROLLBACK"); db.close(); throw error }
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
        id: row.id, path: row.path, kind: row.kind, carry: row.carry ? NamedSchema.parse(JSON.parse(row.carry)) : undefined,
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
    if (this.touched) for (const ref of [entry.before, entry.after]) if (ref) this.touched.add(ref)
    const named = "author" in entry.author ? entry.author.author : null
    if (this.retention && named) this.retention.threads.add(named.thread)
    const result = this.statement(`INSERT INTO entries (at, changed_at, root, path, kind, from_path, before, after, size, text, added, removed, stored, observed, gap, restores,
      certainty, thread, session, turn, author, settled, git, map) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(entry.at, entry.changedAt, entry.root, entry.path, entry.kind, entry.from ?? null, entry.before, entry.after, entry.size ?? null, entry.text ? 1 : 0,
        entry.added ?? null, entry.removed ?? null, entry.stored ? 1 : 0, entry.observed, entry.gap ?? null, entry.restores ?? null, entry.author.certainty,
        named?.thread ?? null, named?.session ?? null, named?.turn ?? null, JSON.stringify(entry.author), entry.settled ? 1 : 0, entry.git ? 1 : null, entry.map ? encodeMap(entry.map) : null)
    const seq = Number(result.lastInsertRowid)
    this.saveCandidates(seq, entry.author)
    return seq
  }

  /** Whether Git made an entry's change (`StoredEntry.git`). */
  markGit(seq: number, git: boolean): void {
    this.statement("UPDATE entries SET git=? WHERE seq=?").run(git ? 1 : null, seq)
  }

  updateAuthor(seq: number, author: Attribution, settled: boolean): void {
    const named = "author" in author ? author.author : null
    this.statement("UPDATE entries SET author=?, certainty=?, thread=?, session=?, turn=?, settled=? WHERE seq=?")
      .run(JSON.stringify(author), author.certainty, named?.thread ?? null, named?.session ?? null, named?.turn ?? null, settled ? 1 : 0, seq)
    this.statement("DELETE FROM entry_candidates WHERE seq=?").run(seq)
    this.saveCandidates(seq, author)
  }

  /** The Threads an ambiguous author names, each with its turn, beside the entry. */
  private saveCandidates(seq: number, author: Attribution): void {
    if (author.certainty !== "ambiguous") return
    const save = this.statement("INSERT OR IGNORE INTO entry_candidates (seq, thread, turn) VALUES (?, ?, ?)")
    for (const candidate of author.candidates) save.run(seq, candidate.thread, candidate.turn ?? null)
  }

  settle(seq: number): void {
    this.statement("UPDATE entries SET settled=1 WHERE seq=?").run(seq)
  }

  private entryOf(value: Row): StoredEntry {
    const row = EntryRow.parse(value)
    const entry: StoredEntry = {
      seq: row.seq, at: row.at, changedAt: row.changed_at, root: row.root, path: row.path, kind: row.kind, from: optional(row.from_path),
      before: row.before, after: row.after, size: optional(row.size), text: Boolean(row.text), added: optional(row.added), removed: optional(row.removed),
      stored: Boolean(row.stored), observed: row.observed, gap: optional(row.gap), restores: optional(row.restores),
      author: AttributionSchema.parse(JSON.parse(row.author)), settled: Boolean(row.settled), map: row.map ? decodeMap(row.map) : undefined,
    }
    if (row.git) entry.git = true
    return entry
  }

  entry(seq: number): StoredEntry | undefined {
    const row = this.statement("SELECT * FROM entries WHERE seq=?").get(seq)
    return row ? this.entryOf(row) : undefined
  }

  author(seq: number): Attribution | undefined {
    const row = this.statement("SELECT author FROM entries WHERE seq=?").get(seq)
    return row ? AttributionSchema.parse(JSON.parse(AuthorRow.parse(row).author)) : undefined
  }

  /** Whether Git wrote the entry, and whether it was found after lost events (a rescan or a restart's catch-up). */
  provenance(seq: number): { git: boolean; lost: boolean } | undefined {
    const row = this.statement("SELECT git, gap FROM entries WHERE seq=?").get(seq)
    if (!row) return undefined
    const { git, gap } = ProvenanceRow.parse(row)
    return { git: Boolean(git), lost: gap !== null }
  }

  setMeta(key: string, value: string): void {
    this.statement("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value)
  }

  meta(key: string): string | undefined {
    const row = this.statement("SELECT value FROM meta WHERE key=?").get(key)
    return row ? ValueRow.parse(row).value : undefined
  }

  /** Entries after `after`, without their line maps. */
  entries(after: number, limit = 1000): StoredEntry[] {
    return this.statement("SELECT seq, at, changed_at, root, path, kind, from_path, before, after, size, text, added, removed, stored, observed, gap, restores, author, settled, git, NULL AS map FROM entries WHERE seq > ? ORDER BY seq LIMIT ?")
      .all(after, limit).map((row) => this.entryOf(row))
  }

  /**
   * Where each entry after `after` put a file, and no more: what keeps an index of a root's paths up. `entries` reads
   * and parses every column, the author's JSON included, for the same three fields.
   */
  entryPaths(after: number, limit = 1000): { seq: number; root: string; path: string; from?: string; kind: ChangeKind }[] {
    return this.statement("SELECT seq, root, path, from_path, kind FROM entries WHERE seq > ? ORDER BY seq LIMIT ?").all(after, limit).map((value) => {
      const row = EntryPathRow.parse(value)
      return { seq: row.seq, root: row.root, path: row.path, from: optional(row.from_path), kind: row.kind }
    })
  }

  /**
   * The first entry of a file at `path` journaled at `from` or after and numbered before `before`, by the file's own
   * index: found among `entriesBetween`, it cost reading up to 10,000 entries of every file.
   */
  firstOfPathFrom(root: string, path: string, from: number, before: number): number | undefined {
    return NullableSeqRow.parse(this.statement("SELECT min(seq) AS seq FROM entries INDEXED BY entries_path WHERE root=? AND path=? AND seq < ? AND at >= ?").get(root, path, before, from)).seq ?? undefined
  }

  /** A file's entries after `after` through `upTo`, oldest first, with their line maps; a rename away from it counts. */
  chain(root: string, path: string, after = 0, upTo = Number.MAX_SAFE_INTEGER): StoredEntry[] {
    return this.statement("SELECT * FROM entries WHERE root=?1 AND (path=?2 OR from_path=?2) AND seq > ?3 AND seq <= ?4 ORDER BY seq").all(root, path, after, upTo).map((row) => this.entryOf(row))
  }

  /** A bounded page of a file's chain, without line maps; both paths use their index before the bounded merge. */
  chainPage(root: string, path: string, after: number, upTo: number, limit: number): StoredEntry[] {
    return this.statement(`SELECT seq, at, changed_at, root, path, kind, from_path, before, after, size, text, added, removed, stored, observed, gap, restores, author, settled, git, NULL AS map
      FROM entries WHERE seq IN (
        SELECT seq FROM (SELECT seq FROM entries WHERE root=?1 AND path=?2 AND seq > ?3 AND seq <= ?4 ORDER BY seq LIMIT ?5)
        UNION SELECT seq FROM (SELECT seq FROM entries WHERE root=?1 AND from_path=?2 AND seq > ?3 AND seq <= ?4 ORDER BY seq LIMIT ?5)
        ORDER BY seq LIMIT ?5) ORDER BY seq`).all(root, path, after, upTo, limit).map((row) => this.entryOf(row))
  }

  /** A file's entries after `after` that changed it after `since`, oldest first, without line maps; a rename away from it counts. */
  versions(root: string, path: string, after: number, since: number): StoredEntry[] {
    return this.statement(`SELECT seq, at, changed_at, root, path, kind, from_path, before, after, size, text, added, removed, stored, observed, gap, restores, author, settled, git, NULL AS map
      FROM entries WHERE root=?1 AND (path=?2 OR from_path=?2) AND seq > ?3 AND changed_at > ?4 ORDER BY seq`).all(root, path, after, since).map((row) => this.entryOf(row))
  }

  /** The latest entry before `before` that wrote `ref` at this path, Git's put-backs aside: who made the version Git restored. */
  madeVersion(root: string, path: string, ref: ContentRef | null, before: number): StoredEntry | undefined {
    const row = this.statement("SELECT seq, at, changed_at, root, path, kind, from_path, before, after, size, text, added, removed, stored, observed, gap, restores, author, settled, git, NULL AS map FROM entries WHERE root=?1 AND path=?2 AND after IS ?3 AND seq < ?4 AND (git IS NULL OR git = 0) ORDER BY seq DESC LIMIT 1").get(root, path, ref, before)
    return row ? this.entryOf(row) : undefined
  }

  /** A file's last entry after `after`, without its line map; a rename away from it counts. */
  last(root: string, path: string, after = 0): StoredEntry | undefined {
    const row = this.statement("SELECT seq, at, changed_at, root, path, kind, from_path, before, after, size, text, added, removed, stored, observed, gap, restores, author, settled, git, NULL AS map FROM entries WHERE root=?1 AND (path=?2 OR from_path=?2) AND seq > ?3 ORDER BY seq DESC LIMIT 1").get(root, path, after)
    return row ? this.entryOf(row) : undefined
  }

  /**
   * The newest entry of a file's chain after `after` that left it holding `ref` and kept a line map, with that map: the
   * version a change back to `ref` restores. One read through the file's own indexes that decodes one map; the chain
   * read whole decoded every entry's map and author to find it, on every change of a file edited many times since its base.
   */
  versionWith(root: string, path: string, after: number, ref: ContentRef): { seq: number; map: Run[] } | undefined {
    const row = this.statement(`SELECT seq, map FROM entries WHERE seq = (SELECT max(seq) FROM (
        SELECT seq FROM (SELECT seq FROM entries WHERE root=?1 AND path=?2 AND seq > ?3 AND after=?4 AND map IS NOT NULL ORDER BY seq DESC LIMIT 1)
        UNION ALL SELECT seq FROM (SELECT seq FROM entries WHERE root=?1 AND from_path=?2 AND seq > ?3 AND after=?4 AND map IS NOT NULL ORDER BY seq DESC LIMIT 1)))`)
      .get(root, path, after, ref)
    if (!row) return undefined
    const found = VersionRow.parse(row)
    return { seq: found.seq, map: decodeMap(found.map) }
  }

  /** Entries by a Thread or Session, without line maps. */
  entriesBy(column: "thread" | "session", id: string): StoredEntry[] {
    return this.statement(`SELECT seq, at, changed_at, root, path, kind, from_path, before, after, size, text, added, removed, stored, observed, gap, restores, author, settled, git, NULL AS map FROM entries WHERE ${column}=? ORDER BY seq`)
      .all(id).map((row) => this.entryOf(row))
  }

  /** Entries the journal may still change the author of. */
  unsettled(): StoredEntry[] {
    return this.statement("SELECT seq, at, changed_at, root, path, kind, from_path, before, after, size, text, added, removed, stored, observed, gap, restores, author, settled, git, NULL AS map FROM entries WHERE settled=0 ORDER BY seq")
      .all().map((row) => this.entryOf(row))
  }

  /** Entries that name `thread` among their candidates; Git's are nobody's. */
  ambiguousWith(thread: string): number {
    return Count.parse(this.statement("SELECT count(*) AS count FROM entry_candidates c JOIN entries e ON e.seq = c.seq WHERE c.thread=? AND e.git IS NULL").get(thread)).count
  }

  /**
   * A turn's entries, oldest first, without line maps: the Thread's own in
   * the turn, and the ambiguous ones that name it with that turn. Git's
   * (`StoredEntry.git`) are no turn's change: a checkout or pull the turn
   * ran put back what Git holds.
   */
  entriesOfTurn(thread: string, turn: string): StoredEntry[] {
    return this.statement(`SELECT seq, at, changed_at, root, path, kind, from_path, before, after, size, text, added, removed, stored, observed, gap, restores, author, settled, git, NULL AS map
      FROM entries WHERE seq IN (SELECT seq FROM entries WHERE thread=?1 AND turn=?2 UNION SELECT seq FROM entry_candidates WHERE thread=?1 AND turn=?2) AND git IS NULL ORDER BY seq`)
      .all(thread, turn).map((row) => this.entryOf(row))
  }

  /**
   * `entriesOfTurn` a page at a time: up to `limit` of them after `after`
   * through `upTo`, and where the next page starts, until the last.
   */
  entriesOfTurnPage(thread: string, turn: string, after: number, upTo: number, limit: number): TurnEntriesPage {
    const seqs = this.statement(`SELECT seq FROM (SELECT seq FROM entries WHERE thread=?1 AND turn=?2 AND seq > ?3 AND seq <= ?4 ORDER BY seq LIMIT ?5)
      UNION SELECT seq FROM (SELECT seq FROM entry_candidates WHERE thread=?1 AND turn=?2 AND seq > ?3 AND seq <= ?4 ORDER BY seq LIMIT ?5) ORDER BY seq LIMIT ?5`)
      .all(thread, turn, after, upTo, limit).map((row) => SeqRow.parse(row).seq)
    if (!seqs.length) return { entries: [] }
    const entries = this.statement(`SELECT seq, at, changed_at, root, path, kind, from_path, before, after, size, text, added, removed, stored, observed, gap, restores, author, settled, git, NULL AS map
      FROM entries WHERE seq IN (SELECT value FROM json_each(?)) AND git IS NULL ORDER BY seq`).all(JSON.stringify(seqs)).map((row) => this.entryOf(row))
    return { entries, ...(seqs.length === limit && { next: seqs.at(-1)! }) }
  }

  /** The Thread's turns with an entry after `after` (as `entriesOfTurn` reads them), each with its newest: a summary counted before then is behind. */
  turnsChangedAfter(thread: string, after: number): Map<string, number> {
    const rows = this.statement(`SELECT turn, max(seq) AS seq FROM (SELECT turn, seq FROM entries WHERE thread=?1 AND turn IS NOT NULL AND seq > ?2 AND git IS NULL
      UNION ALL SELECT c.turn, c.seq FROM entry_candidates c JOIN entries e ON e.seq = c.seq WHERE c.thread=?1 AND c.turn IS NOT NULL AND c.seq > ?2 AND e.git IS NULL) GROUP BY turn`).all(thread, after)
    return new Map(rows.map((row) => TurnSeqRow.parse(row)).map((row) => [row.turn, row.seq]))
  }

  /** The first entry journaled at `at` or after; undefined when none was. */
  firstSeqFrom(at: number): number | undefined {
    // Through the times' index: by the numbering, SQLite walked every entry older than `at` first.
    return NullableSeqRow.parse(this.statement("SELECT min(seq) AS seq FROM entries INDEXED BY entries_at WHERE at >= ?").get(at)).seq ?? undefined
  }

  /** `entriesBetween` over a window of the journal's numbering, `after` to `upTo`: up to `limit` of them. */
  entriesBetweenIn(from: number, to: number, after: number, upTo: number, limit: number): StoredEntry[] {
    return this.statement("SELECT seq, at, changed_at, root, path, kind, from_path, before, after, size, text, added, removed, stored, observed, gap, restores, author, settled, git, NULL AS map FROM entries WHERE seq > ? AND seq <= ? AND at >= ? AND at <= ? ORDER BY seq LIMIT ?")
      .all(after, upTo, from, to, limit).map((row) => this.entryOf(row))
  }

  /** Entries journaled between two instants, without line maps, oldest first. */
  entriesBetween(from: number, to: number, limit = 10_000): StoredEntry[] {
    return this.statement("SELECT seq, at, changed_at, root, path, kind, from_path, before, after, size, text, added, removed, stored, observed, gap, restores, author, settled, git, NULL AS map FROM entries WHERE at >= ? AND at <= ? ORDER BY seq LIMIT ?")
      .all(from, to, limit).map((row) => this.entryOf(row))
  }

  /** Whether any entry that changed by `at` may still be given another author. */
  unsettledThrough(at: number): boolean {
    return this.statement("SELECT 1 FROM entries WHERE settled=0 AND changed_at <= ? LIMIT 1").get(at) !== undefined
  }

  /** A turn's summary as last counted: kept per Thread and turn, the record "changes made" sums. */
  saveTurnChanges(summary: TurnChanges, session: string): void {
    this.statement("INSERT OR REPLACE INTO turn_changes (thread, turn, session, at, summary) VALUES (?, ?, ?, ?, ?)").run(summary.thread, summary.turn, session, summary.at, JSON.stringify(summary))
  }

  /** Every turn summary of a Thread, oldest first; one of a version this build doesn't read is left out. */
  turnChangesOf(thread: string): TurnChanges[] {
    return this.statement("SELECT summary FROM turn_changes WHERE thread=? ORDER BY at").all(thread).flatMap((row) => {
      const parsed = TurnChangesSchema.safeParse(JSON.parse(TurnChangesRow.parse(row).summary))
      return parsed.success ? [parsed.data] : []
    })
  }

  /** The newest entry's number: the last one given, which retention never drops (`pruneEntries`), so every build reads the same. */
  lastSeq(): number {
    return Count.parse(this.statement("SELECT max(coalesce((SELECT max(seq) FROM entries), 0), coalesce((SELECT seq FROM sqlite_sequence WHERE name='entries'), 0)) AS count").get()).count
  }

  files(): FileState[] {
    return this.statement("SELECT * FROM files").all().map((value) => {
      const row = FileRow.parse(value)
      return { root: row.root, path: row.path, base: row.base, baseSeq: row.base_seq, current: row.current, text: Boolean(row.text), map: decodeMap(row.map) }
    })
  }

  saveFile(state: FileState): void {
    if (this.touched) for (const ref of [state.base, state.current]) if (ref) this.touched.add(ref)
    if (this.retention) for (const run of state.map) for (const seq of [run.ins, run.del, run.over]) if (seq > 0) this.retention.seqs.add(seq)
    this.statement("INSERT OR REPLACE INTO files (root, path, base, base_seq, current, text, map) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(state.root, state.path, state.base, state.baseSeq, state.current, state.text ? 1 : 0, encodeMap(state.map))
  }

  deleteFile(root: string, path: string): void {
    this.statement("DELETE FROM files WHERE root=? AND path=?").run(root, path)
  }

  stats(root: string): StatCache {
    const statement = this.statement("SELECT path, dev, ino, size, mode, mtime_ns, ctime_ns, ref, checked_ns FROM stats WHERE root=?")
    statement.setReadBigInts(true)
    const out = new StatCache()
    for (const value of statement.all(root)) {
      const row = StatRowSchema.parse(value)
      out.set(row.path, {
        dev: Number(row.dev), ino: Number(row.ino), size: Number(row.size), mode: Number(row.mode),
        mtimeNs: row.mtime_ns, ctimeNs: row.ctime_ns, ref: row.ref, checkedNs: row.checked_ns,
      })
    }
    return out
  }

  /**
   * The paths a root's stat cache knows, in the cache's order, and nothing else of its rows: `stats` reads eight more
   * columns as BigInts and packs each row, which an index of a root's 7,700 paths never looked at.
   */
  statPaths(root: string): string[] {
    return this.statement("SELECT path FROM stats WHERE root=?").all(root).map((row) => PathRow.parse(row).path)
  }

  /** Whether the stat cache knows a path of a root, for a root whose cache isn't in memory (one asleep). */
  hasStat(root: string, path: string): boolean {
    return this.statement("SELECT 1 FROM stats WHERE root=? AND path=?").get(root, path) !== undefined
  }

  saveStat(root: string, path: string, row: StatRow): void {
    if (row.ref) this.touched?.add(row.ref)
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
    this.touched?.add(ref)
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
    this.retention?.threads.add(activity.thread)
    this.statement(`INSERT INTO activity (session, kind, id, thread, turn, checkout, cwd, label, named, record, started_at, ended_at, effects, status, run) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session, kind, id) DO UPDATE SET thread=excluded.thread, turn=coalesce(excluded.turn, turn), checkout=coalesce(excluded.checkout, checkout),
      cwd=coalesce(excluded.cwd, cwd), label=coalesce(excluded.label, label), named=excluded.named, record=coalesce(excluded.record, record),
      started_at=min(started_at, excluded.started_at), ended_at=coalesce(excluded.ended_at, ended_at), effects=coalesce(excluded.effects, effects),
      status=coalesce(excluded.status, status), run=coalesce(excluded.run, run)`)
      .run(activity.session, activity.kind, activity.id, activity.thread, activity.turn ?? null, activity.checkout ?? null, activity.cwd ?? null,
        activity.label ?? null, JSON.stringify(activity.named), activity.record ?? null, activity.start, activity.end, activity.effects ? JSON.stringify(activity.effects) : null,
        activity.status ?? null, activity.run ?? null)
  }

  private activityOf(value: Row): StoredActivity {
    const row = ActivityRow.parse(value)
    return {
      kind: row.kind, id: row.id, session: row.session, thread: row.thread, turn: optional(row.turn), checkout: optional(row.checkout), cwd: optional(row.cwd),
      label: optional(row.label), named: NamedPathsSchema.parse(JSON.parse(row.named)), record: optional(row.record), start: row.started_at, end: row.ended_at,
      effects: row.effects ? StoredEffectSchema.parse(JSON.parse(row.effects)) : undefined,
      ...(row.status && { status: row.status }),
      ...(row.run && { run: row.run }),
    }
  }

  /** A Thread's turn, by its id. */
  turn(thread: string, turn: string): StoredActivity | undefined {
    // Found by the Thread's index alone, then read: read whole as it went, a Thread of 85,000 calls took 140 ms.
    const key = this.statement("SELECT session FROM activity WHERE thread=? AND kind='turn' AND id=? ORDER BY started_at DESC LIMIT 1").get(thread, turn)
    return key ? this.activity(ActivitySessionRow.parse(key).session, "turn", turn) : undefined
  }

  /** Activity that overlaps `[from, to]`. */
  activityBetween(from: number, to: number): StoredActivity[] {
    return this.statement(ACTIVITY_OVERLAPPING).all(from, to, to).map((row) => this.activityOf(row)).sort(byActivityKey)
  }

  /**
   * Up to `limit` activity keys after `after` in key order, with when each started and ended: a page of a scan of
   * the whole table that reads no row's text. Nothing indexes when activity ended, and building an index on the
   * person's journal (175,857 rows, 152 MB) held the loop 3.3 s, so a stretch of time is found by scanning in pages.
   */
  activityTimes(after: ActivityKey | undefined, limit: number): (ActivityKey & { start: number; end: number | null })[] {
    const rows = after
      ? this.statement("SELECT session, kind, id, started_at, ended_at FROM activity WHERE (session, kind, id) > (?, ?, ?) ORDER BY session, kind, id LIMIT ?")
          .all(after.session, after.kind, after.id, limit)
      : this.statement("SELECT session, kind, id, started_at, ended_at FROM activity ORDER BY session, kind, id LIMIT ?").all(limit)
    return rows.map((row) => {
      const parsed = ActivityTimesRow.parse(row)
      return { session: parsed.session, kind: parsed.kind, id: parsed.id, start: parsed.started_at, end: parsed.ended_at }
    })
  }

  /** Activity rows read elsewhere (`JournalReader`), as this store reads its own. */
  activityOfRows(rows: readonly Row[]): StoredActivity[] {
    return rows.map((row) => this.activityOf(row))
  }

  /** The activity of these keys still in the journal, in their order. */
  activityOfKeys(keys: readonly ActivityKey[]): StoredActivity[] {
    const read = this.statement("SELECT * FROM activity WHERE session=? AND kind=? AND id=?")
    return keys.flatMap((key) => {
      const row = read.get(key.session, key.kind, key.id)
      return row ? [this.activityOf(row)] : []
    })
  }

  /** One call's, turn's or background work's activity. */
  activity(session: string, kind: StoredActivity["kind"], id: string): StoredActivity | undefined {
    const row = this.statement("SELECT * FROM activity WHERE session=? AND kind=? AND id=?").get(session, kind, id)
    return row ? this.activityOf(row) : undefined
  }

  /** Turns, calls and background work still running, on any host of this journal. */
  openActivity(): StoredActivity[] {
    return this.statement("SELECT * FROM activity WHERE ended_at IS NULL").all().map((row) => this.activityOf(row))
  }

  /**
   * How many commands a Thread's calls reported (`ThreadChanges.commands`, counted): SQLite reads each call's effects
   * and counts them. `activityOfThread` made every call of the Thread, 84,000 for one, to count the same.
   */
  commandsOf(thread: string): number {
    return Count.parse(this.statement(`SELECT count(*) AS count FROM activity a, json_each(a.effects) e
      WHERE a.thread=? AND instr(a.effects, '"command"') > 0 AND json_extract(e.value, '$.kind') = 'command'`).get(thread)).count
  }

  activityOfThread(thread: string): StoredActivity[] {
    return this.statement("SELECT * FROM activity WHERE thread=? ORDER BY started_at").all(thread).map((row) => this.activityOf(row))
  }

  /** Up to `limit` of a Thread's activity from `from` on, oldest first: a page of a history too long to read in one go. */
  activityFrom(thread: string, from: number, limit: number): StoredActivity[] {
    return this.statement("SELECT * FROM activity WHERE thread=? AND started_at>=? ORDER BY started_at LIMIT ?").all(thread, from, limit).map((row) => this.activityOf(row))
  }

  /**
   * What moves when a Thread's own work does, however busy the journal, and costs one lookup for a Thread of 84,000
   * calls. Without change tracking, the journal's own version: any write by anyone, as true and far less often still.
   */
  threadVersion(thread: string): ThreadVersion {
    if (!this.changesTracked()) return { key: `all:${this.version()}:${this.carriedVersion(thread)}` }
    const row = ThreadChangeRow.parse(this.statement("SELECT coalesce(max(seq), 0) AS seq, coalesce(max(moved), 0) AS moved FROM thread_changes WHERE thread=?").get(thread))
    return { key: `${row.seq}:${row.moved}:${this.carriedVersion(thread)}`, seq: row.seq, moved: row.moved }
  }

  private changesTracked(): boolean {
    this.tracked ||= Count.parse(this.statement("SELECT count(*) AS count FROM sqlite_master WHERE name IN ('thread_changes', 'activity_changes', 'activity_updated')").get()).count === 3
    return this.tracked
  }

  /** Up to `limit` of a Thread's calls changed after `seq`, in the order they changed. */
  activityChanged(thread: string, seq: number, limit: number): { seq: number; activity: StoredActivity }[] {
    return this.statement(`SELECT a.*, c.seq AS change_seq FROM activity_changes c JOIN activity a ON a.session = c.session AND a.kind = c.kind AND a.id = c.id
      WHERE c.thread = ? AND c.seq > ? ORDER BY c.seq LIMIT ?`).all(thread, seq, limit)
      .map((row) => ({ seq: ChangeSeqRow.parse(row).change_seq, activity: this.activityOf(row) }))
  }

  /** Up to `limit` of a Thread's writes after `seq`: where and when, no more, for a walk over all of them. */
  threadWrites(thread: string, seq: number, limit: number): { seq: number; root: string; path: string; at: number; kind: string; certainty: string }[] {
    return this.statement("SELECT seq, root, path, at, kind, certainty FROM entries WHERE thread=? AND seq>? ORDER BY seq LIMIT ?").all(thread, seq, limit).map((row) => ThreadWriteRow.parse(row))
  }

  /**
   * When each root's newest entry was journaled and, when `wanted` says so
   * of those, each folder Threads worked in (as checkout and as working
   * folder) when they last did, work still open counting as `now`. Read from
   * what `RECENCY`'s triggers keep: a row a root and a row a folder, and the
   * calls still open through their own index, never the entries or the calls
   * that ended. A journal from before those triggers is read whole once, a
   * window of entries or a page of calls a step (read at once, 100,000
   * entries and 137,000 calls held the loop for 1.6 s), and what that finds
   * is kept, so the next reading is the short one.
   */
  *recency(now: number, wanted: (changed: ReadonlyMap<string, number>) => boolean): Steps<Recency> {
    if (!this.recencyKept()) yield* this.fillRecency()
    if (!this.recencyKept()) return yield* this.recencyWhole(now, wanted)
    const changed = this.changedRoots()
    return { changed, worked: wanted(changed) ? this.workedFolders(now) : new Map() }
  }

  /** `recency` as the journal stands now, read at once: what other work changed since a reading. */
  recencyNow(now: number): Recency {
    if (!this.recencyKept()) return atOnce(this.recencyWhole(now, () => true))
    return { changed: this.changedRoots(), worked: this.workedFolders(now) }
  }

  /** Whether `RECENCY`'s tables hold all of this journal: made, and filled from what was written before them. */
  private recencyKept(): boolean {
    return Count.parse(this.statement("SELECT count(*) AS count FROM sqlite_master WHERE name IN ('root_changed', 'folder_worked', 'recency_entries_inserted', 'recency_activity_updated')").get()).count === 4
      && this.meta(RECENCY_FILLED) !== undefined
  }

  private changedRoots(): Map<string, number> {
    return new Map(this.statement("SELECT root, at FROM root_changed").all().map((row) => RootAtRow.parse(row)).map((row) => [row.root, row.at]))
  }

  private workedFolders(now: number): Map<string, number> {
    const worked = new Map(this.statement("SELECT folder, at FROM folder_worked").all().map((row) => FolderAtRow.parse(row)).map((row) => [row.folder, row.at]))
    for (const value of this.statement("SELECT checkout, cwd FROM activity WHERE ended_at IS NULL").all()) workedIn(worked, { ...OpenWorkRow.parse(value), at: now })
    return worked
  }

  /**
   * Fill `RECENCY`'s tables from a journal written before their triggers, a step at a time, on the connection that
   * writes; a read-only one fills nothing. What is journaled while this reads reaches the tables by the triggers, and
   * each row keeps the later of the two.
   */
  private *fillRecency(): Steps<void> {
    if (this.db.isTransaction || Count.parse(this.statement("SELECT count(*) AS count FROM sqlite_master WHERE name IN ('root_changed', 'folder_worked')").get()).count !== 2) return
    if (this.readOnly) return
    const read = yield* this.recencyWhole(0, () => true, true)
    this.transaction(() => {
      const root = this.statement("INSERT INTO root_changed (root, at) VALUES (?, ?) ON CONFLICT (root) DO UPDATE SET at = excluded.at WHERE excluded.at > at")
      for (const [id, at] of read.changed) root.run(id, at)
      const folder = this.statement("INSERT INTO folder_worked (folder, at) VALUES (?, ?) ON CONFLICT (folder) DO UPDATE SET at = excluded.at WHERE excluded.at > at")
      for (const [path, at] of read.worked) folder.run(path, at)
      this.statement("INSERT INTO meta (key, value) VALUES (?, '1') ON CONFLICT (key) DO NOTHING").run(RECENCY_FILLED)
    })
  }

  /**
   * `recency` read from the entries and the calls themselves: the one filling of `RECENCY`'s tables, and every
   * reading of a journal that has none (an older owner's, opened read-only). With `ended`, work still open counts
   * where it started, as the triggers keep it.
   */
  private *recencyWhole(now: number, wanted: (changed: ReadonlyMap<string, number>) => boolean, ended = false): Steps<Recency> {
    const changed = new Map<string, number>()
    const worked = new Map<string, number>()
    let read = 0
    for (let last = this.lastSeq(); read < last; ) {
      const upTo = Math.min(read + RECENT_ENTRIES, last)
      this.changedIn(changed, read, upTo)
      read = upTo
      yield
    }
    if (!wanted(changed)) return { changed, worked }
    for (let key = { session: "", kind: "", id: "" }; ;) {
      const rows = this.statement(`SELECT session, kind, id, checkout, cwd, coalesce(ended_at, ${ended ? "started_at" : "?1"}) AS at FROM activity WHERE (session, kind, id) > (?2, ?3, ?4) ORDER BY session, kind, id LIMIT ?5`)
        .all({ ...(!ended && { 1: now }), 2: key.session, 3: key.kind, 4: key.id, 5: RECENT_CALLS }).map((row) => WorkedKeyRow.parse(row))
      for (const row of rows) workedIn(worked, row)
      if (rows.length < RECENT_CALLS) break
      key = rows.at(-1)!
      yield
    }
    // What was journaled while the calls were read.
    this.changedIn(changed, read, this.lastSeq())
    return { changed, worked }
  }

  /** Each root's newest entry after `after` through `upTo`, into `changed`. */
  private changedIn(changed: Map<string, number>, after: number, upTo: number): void {
    for (const row of this.statement("SELECT root, MAX(at) AS at FROM entries WHERE seq > ? AND seq <= ? GROUP BY root").all(after, upTo)) {
      const { root, at } = RootAtRow.parse(row)
      later(changed, root, at)
    }
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
    for (const table of this.compacting && entry.evidence !== "weak" ? ["footprint", "footprint_compact"] : ["footprint"]) this.statement(`INSERT INTO ${table} (thread, session, turn, path, access, evidence, at, size, ref, secret, basis) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

  /** How many paths outside its checkouts a Thread's footprint holds by each evidence, each path once: `footprint` counted, without its rows. */
  outsideCounts(thread: string) {
    const counts = { named: 0, maybe: 0 }
    for (const value of this.statement("SELECT evidence, count(DISTINCT path) AS count FROM footprint WHERE thread=? GROUP BY evidence").all(thread)) {
      const row = EvidenceCountRow.parse(value)
      counts[row.evidence === "strong" ? "named" : "maybe"] = row.count
    }
    return counts
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
    return new Map(this.choiceRows(thread).map((choice) => [choice.spelling, choice.path]))
  }

  choiceRows(thread: string): CarriedChoice[] {
    return this.statement("SELECT spelling, path, at FROM choices WHERE thread=? ORDER BY spelling").all(thread).map((row) => ChoiceRow.parse(row))
  }

  /** A pick from another journal: the later of the two holds, and at the same instant the greater path, so every journal ends alike. Whether it changed. */
  mergeChoice(choice: FileChoice): boolean {
    return Number(this.statement(`INSERT INTO choices (thread, spelling, path, at) VALUES (?, ?, ?, ?)
      ON CONFLICT(thread, spelling) DO UPDATE SET path=excluded.path, at=excluded.at
      WHERE excluded.at > choices.at OR (excluded.at = choices.at AND excluded.path > choices.path)`)
      .run(choice.thread, choice.spelling, choice.path, choice.at).changes) > 0
  }

  /** The parts of a Thread's file history other journals carried here, oldest taken first. */
  carriedParts(thread: string): ThreadHistoryPart[] {
    const parts = new Map<string, ThreadHistoryPart>()
    for (const value of this.statement("SELECT * FROM carried WHERE thread=? ORDER BY at, journal").all(thread)) {
      const row = CarriedRow.parse(value)
      parts.set(row.journal, {
        journal: row.journal, device: row.device, through: row.through, at: row.at,
        roots: CarriedRootsSchema.parse(JSON.parse(row.roots)),
        activity: [], writes: [], names: [],
      })
    }
    if (!parts.size) return []
    for (const value of this.statement("SELECT * FROM carried_activity WHERE thread=? ORDER BY started_at").all(thread)) {
      const row = CarriedActivityRow.parse(value)
      const activity: CarriedActivity = { session: row.session, kind: row.kind, id: row.id, start: row.started_at, end: row.ended_at, named: NamedSchema.parse(JSON.parse(row.named)) }
      if (row.checkout) activity.checkout = row.checkout
      if (row.cwd) activity.cwd = row.cwd
      if (row.effects) activity.effects = CarriedEffectsSchema.parse(JSON.parse(row.effects))
      parts.get(row.journal)?.activity.push(activity)
    }
    for (const value of this.statement("SELECT * FROM carried_paths WHERE thread=? ORDER BY seq").all(thread)) {
      const row = CarriedPathRow.parse(value)
      const part = parts.get(row.journal)
      if (row.kind === "write") part?.writes.push({ seq: row.seq, at: row.at, path: row.path })
      else part?.names.push(row.to_path ? { seq: row.seq, at: row.at, path: row.path, to: row.to_path } : { seq: row.seq, at: row.at, path: row.path })
    }
    return [...parts.values()]
  }

  /** Changes whenever a part of the Thread's history is carried here: a part is only ever replaced by a later one. */
  carriedVersion(thread: string): string {
    const row = CarriedVersionRow
      .parse(this.statement("SELECT count(*) AS count, sum(through) AS through, sum(at) AS at FROM carried WHERE thread=?").get(thread))
    return `${row.count}:${row.through ?? 0}:${row.at ?? 0}`
  }

  /** When the part of a Thread's history kept from `journal` was taken. */
  carriedStamp(thread: string, journal: string): { through: number; at: number } | undefined {
    const row = this.statement("SELECT through, at FROM carried WHERE thread=? AND journal=?").get(thread, journal)
    return row ? CarriedStampRow.parse(row) : undefined
  }

  /** Put a carried part in place of the one kept from its journal, whole. Run inside a transaction. */
  replaceCarried(thread: string, part: ThreadHistoryPart, received: number): void {
    this.statement("DELETE FROM carried_activity WHERE thread=? AND journal=?").run(thread, part.journal)
    this.statement("DELETE FROM carried_paths WHERE thread=? AND journal=?").run(thread, part.journal)
    this.statement("INSERT OR REPLACE INTO carried (thread, journal, device, through, at, received, roots) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(thread, part.journal, part.device, part.through, part.at, received, JSON.stringify(part.roots))
    const activity = this.statement(`INSERT OR REPLACE INTO carried_activity (thread, journal, session, kind, id, started_at, ended_at, checkout, cwd, named, effects)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    for (const item of part.activity)
      activity.run(thread, part.journal, item.session, item.kind, item.id, item.start, item.end, item.checkout ?? null, item.cwd ?? null, JSON.stringify(item.named), item.effects ? JSON.stringify(item.effects) : null)
    const path = this.statement("INSERT OR REPLACE INTO carried_paths (thread, journal, kind, seq, at, path, to_path) VALUES (?, ?, ?, ?, ?, ?, ?)")
    for (const write of part.writes) path.run(thread, part.journal, "write", write.seq, write.at, write.path, null)
    for (const name of part.names) path.run(thread, part.journal, "name", name.seq, name.at, name.path, name.to ?? null)
  }

  /** Moves and the person's changes to them since `since`, by kind: how many, and their files summed. */
  moveTotals(since: number): Map<MoveRecord["kind"], { count: number; files: number; guessed: number; offered: number }> {
    const rows = this.statement("SELECT kind, count(*) AS count, sum(files) AS files, sum(guessed) AS guessed, sum(offered) AS offered FROM moves WHERE at >= ? GROUP BY kind").all(since)
    return new Map(rows.map((row) => {
      const { kind, ...totals } = MoveTotalsRow.parse(row)
      return [kind, totals]
    }))
  }

  changesSince(since: number): ChangesSince {
    const rows = this.statement(`SELECT root, count(DISTINCT path) AS files, coalesce(sum(added), 0) AS added, coalesce(sum(removed), 0) AS removed, count(DISTINCT thread) AS threads
      FROM entries WHERE at >= ? AND thread IS NOT NULL AND git IS NULL GROUP BY root`).all(since)
    const roots = rows.map((row) => ChangedRootRow.parse(row))
    const threads = Count.parse(this.statement("SELECT count(DISTINCT thread) AS count FROM entries WHERE at >= ? AND thread IS NOT NULL AND git IS NULL").get(since)).count
    return { roots, threads }
  }

  /** How many entries each certainty has, for the ambiguity rate. */
  certaintyMix(since = 0): Map<string, number> {
    const rows = this.statement("SELECT certainty AS key, count(*) AS count FROM entries WHERE at >= ? GROUP BY certainty").all(since)
    return new Map(rows.map((row) => KeyCountRow.parse(row)).map((row) => [row.key, row.count]))
  }

  /**
   * Drop kept content no one needs: blobs behind no uncommitted line and no
   * entry younger than `retainAfter`; then, while the store is past
   * `budget` bytes, the oldest of those younger ones too. Content behind an
   * uncommitted line is never dropped. On this connection, all at once:
   * `collectPlan` on a worker's and `dropPlanned` here leave this thread free.
   */
  collect(retainAfter: number, budget: number): Collected {
    this.statement("DELETE FROM footprint_turns WHERE at < ?").run(retainAfter)
    this.statement("DELETE FROM moves WHERE at < ?").run(retainAfter)
    return this.transaction(() => {
      const plan = collectPlan(this.db, retainAfter, budget)
      const drop = this.statement("DELETE FROM blobs WHERE ref=?")
      for (const { ref } of plan.refs) drop.run(ref)
      return { dropped: plan.refs.length, bytes: plan.refs.reduce((sum, item) => sum + item.bytes, 0) }
    })
  }

  /**
   * Note every ref written from now until `untouched`: content a collection planned on an older snapshot (a worker's)
   * may drop only if nothing here wrote it since. Every write that names content goes through `putBlob`, `saveStat`,
   * `saveFile` or `insertEntry`, and only the owner's connection writes.
   */
  touching(): void {
    this.touched = new Set()
  }

  untouched(): void {
    this.touched = undefined
  }

  /** Drop planned blobs nothing wrote since `touching` began and no uncommitted line holds now; the count and bytes dropped. */
  dropPlanned(refs: readonly { ref: string; bytes: number }[]): Collected {
    const touched = this.touched ?? new Set<string>()
    const candidates = refs.filter((item) => !touched.has(item.ref))
    if (!candidates.length) return { dropped: 0, bytes: 0 }
    return this.transaction(() => {
      const live = new Set(this.statement(LIVE_FILE_REFS).all().map((row) => Object.values(row)[0]))
      const drop = this.statement("DELETE FROM blobs WHERE ref=?")
      let dropped = 0
      let bytes = 0
      for (const item of candidates) {
        if (live.has(item.ref)) continue
        if (Number(drop.run(item.ref).changes)) {
          dropped++
          bytes += item.bytes
        }
      }
      return { dropped, bytes }
    })
  }

  /**
   * What a collection deletes besides content and what `pruneThread` takes Thread by Thread: moves past retention, by
   * their index, and folders nobody worked in since. A turn's footprint summary went here too, by a scan of all of
   * them (68 MB) every hour; each Thread's now go by their index as its turn in the sweep comes.
   */
  dropOld(retainAfter: number): void {
    this.statement("DELETE FROM moves WHERE at < ?").run(retainAfter)
    if (this.recencyKept()) this.statement("DELETE FROM folder_worked WHERE at < ?").run(retainAfter)
  }

  /**
   * Begin a pass of retention. `spared` holds the entries an uncommitted line or an open change names as the pass
   * begins; every file saved from now until `retained` adds the entries its lines name, and every Thread that works
   * meanwhile is kept whatever was read of it before. Only the owner's connection writes, so nothing else can make an
   * old record needed again.
   */
  retaining(spared: Set<number>): void {
    // Every uncommitted file's own map, read from the journal: what a line names is kept whether or not anything
    // holds the file in memory, and a line can name an entry from before its file's base or at another path.
    for (const value of this.statement("SELECT map FROM files").all())
      for (const run of decodeMap(MapRow.parse(value).map)) for (const seq of [run.ins, run.del, run.over]) if (seq > 0) spared.add(seq)
    this.retention = { seqs: spared, threads: new Set() }
  }

  retained(): void {
    this.retention = undefined
  }

  /** What `threadLive` and `pruneEntries` measure against, for a pass keeping what is younger than `retainAfter`. */
  liveness(retainAfter: number): Liveness {
    return { retainAfter, horizon: this.firstSeqFrom(retainAfter) ?? this.lastSeq() + 1, known: new Map() }
  }

  /**
   * Note as worked in every Thread with work that began before the window and ended from `from` to before `to`,
   * inside it: a server left running, a turn a restart closed. No index finds that by Thread, so a pass reads it for
   * all of them before it asks about any, a stretch of the window at a time, through the index of when work ended
   * (the whole window at once read 130,000 rows in 324 ms on the journal of 2026-11-17).
   */
  workEndedInside(live: Liveness, from: number, to: number): void {
    for (const value of this.statement("SELECT DISTINCT thread FROM activity INDEXED BY activity_ended WHERE ended_at >= ?1 AND ended_at < ?2 AND started_at < ?3").all(from, to, live.retainAfter))
      live.known.set(ThreadRow.parse(value).thread, true)
  }

  /**
   * Whether a Thread is still worked in: a turn, call or background work of its began or ended inside the window or
   * is open now, an entry of its was journaled inside it, or a turn of its was counted inside it. Everything kept by Thread
   * stays whole while it is; each answer is a probe of an index.
   */
  threadLive(thread: string, live: Liveness): boolean {
    if (this.retention?.threads.has(thread)) return true
    let found = live.known.get(thread)
    if (found === undefined) {
      found = this.statement("SELECT 1 FROM activity WHERE thread=? AND started_at >= ? LIMIT 1").get(thread, live.retainAfter) !== undefined
        || this.statement("SELECT 1 FROM entries WHERE thread=? AND seq >= ? LIMIT 1").get(thread, live.horizon) !== undefined
        || this.statement("SELECT 1 FROM activity INDEXED BY activity_open WHERE ended_at IS NULL AND thread=? LIMIT 1").get(thread) !== undefined
        || this.statement("SELECT 1 FROM turn_changes WHERE thread=? AND at >= ? LIMIT 1").get(thread, live.retainAfter) !== undefined
      live.known.set(thread, found)
    }
    return found
  }

  /**
   * Drop, of the next `limit` entries after `after` that are past retention, those nothing needs, in one short
   * transaction: how many went, and where the next page starts, until the last. An entry stays while an uncommitted
   * line names it (`retaining`), while its file is uncommitted and it is part of the file's chain since its base (all
   * of a file's that is created, deleted or binary, whose last writer is read from any of them), while its Thread is
   * still worked in, or while a Thread that is may be its writer. The newest entry of all stays whatever its age: the
   * next entry's number is read from it. A reader of an entry that went reads no author: the line is nobody's, as one
   * from before tracking is.
   */
  pruneEntries(after: number, limit: number, live: Liveness): PrunedPage<number> {
    const rows = this.statement("SELECT seq, thread, root, path, from_path, certainty FROM entries WHERE seq > ? AND seq < ? AND at < ? AND seq < (SELECT max(seq) FROM entries) ORDER BY seq LIMIT ?")
      .all(after, live.horizon, live.retainAfter, limit).map((row) => OldEntryRow.parse(row))
    if (!rows.length) return { dropped: 0 }
    const held = this.statement("SELECT 1 FROM files WHERE root=?1 AND path=?2 AND (?3 > base_seq OR base IS NULL OR current IS NULL OR text = 0)")
    const candidates = this.statement("SELECT thread FROM entry_candidates WHERE seq=?")
    const drop = this.statement("DELETE FROM entries WHERE seq=?")
    const dropCandidates = this.statement("DELETE FROM entry_candidates WHERE seq=?")
    const dropped = this.transaction(() => {
      let count = 0
      for (const row of rows) {
        if (this.retention?.seqs.has(row.seq) || (row.thread !== null && this.threadLive(row.thread, live))) continue
        if (held.get(row.root, row.path, row.seq) || (row.from_path !== null && held.get(row.root, row.from_path, row.seq))) continue
        if (row.certainty === "ambiguous" && candidates.all(row.seq).some((value) => this.threadLive(ThreadRow.parse(value).thread, live))) continue
        drop.run(row.seq)
        dropCandidates.run(row.seq)
        count++
      }
      return count
    })
    return { dropped, ...(rows.length === limit && { next: rows.at(-1)!.seq }) }
  }

  /** The first Thread after `after`, in the journal's order, that any table kept by Thread holds a row of. */
  nextThread(after: string): string | undefined {
    return NullableThreadRow.parse(this.statement(`SELECT min(thread) AS thread FROM (
      SELECT min(thread) AS thread FROM activity WHERE thread > ?1 UNION ALL SELECT min(thread) FROM footprint WHERE thread > ?1
      UNION ALL SELECT min(thread) FROM turn_changes WHERE thread > ?1 UNION ALL SELECT min(thread) FROM footprint_turns WHERE thread > ?1
      UNION ALL SELECT min(thread) FROM carried WHERE thread > ?1 UNION ALL SELECT min(thread) FROM entry_candidates WHERE thread > ?1)`).get(after)).thread ?? undefined
  }

  /**
   * Drop up to `most` rows of what the journal keeps by Thread, in one short transaction; `done` once nothing more of
   * this Thread is to go. Of every Thread: its turns' footprint summaries past retention (the paths only a turn's
   * timing tied to it, `weak`, go when the table is rebuilt, `beginCompactFootprint`: found Thread by Thread, each
   * pass read every row of a Thread with tens of thousands to find none). Of a Thread no longer worked in
   * (`threadLive`), everything else too: its calls and turns, its turns' counts, the paths outside its checkouts, the
   * history carried to it. That Thread is then noted in `pruned_threads`. The files a person picked for its answers
   * (`choices`) stay: a row each, and nothing else could say them again.
   */
  pruneThread(thread: string, live: Liveness, most: number): Pruned & { done: boolean } {
    const out = { entries: 0, activity: 0, commits: 0, footprint: 0, turns: 0, gaps: 0, stats: 0, threads: 0, done: false }
    const footprint = this.footprintCompact()
      ? "DELETE FROM footprint WHERE (thread, session, turn, path, access) IN (SELECT thread, session, turn, path, access FROM footprint WHERE thread=?1"
      : "DELETE FROM footprint WHERE rowid IN (SELECT rowid FROM footprint WHERE thread=?1"
    return this.transaction(() => {
      let left = most
      const drop = (sql: string, ...bound: (string | number)[]) => {
        if (left <= 0) return 0
        const dropped = Number(this.statement(sql).run(thread, left, ...bound).changes)
        left -= dropped
        return dropped
      }
      out.turns += drop("DELETE FROM footprint_turns WHERE (session, turn) IN (SELECT session, turn FROM footprint_turns WHERE thread=?1 AND at < ?3 LIMIT ?2)", live.retainAfter)
      if (left <= 0) return out
      if (this.threadLive(thread, live)) return { ...out, done: true }
      out.activity += drop("DELETE FROM activity WHERE (session, kind, id) IN (SELECT session, kind, id FROM activity WHERE thread=?1 LIMIT ?2)")
      out.turns += drop("DELETE FROM turn_changes WHERE (thread, turn) IN (SELECT thread, turn FROM turn_changes WHERE thread=?1 LIMIT ?2)")
      out.footprint += drop(`${footprint} LIMIT ?2)`)
      out.turns += drop("DELETE FROM footprint_turns WHERE (session, turn) IN (SELECT session, turn FROM footprint_turns WHERE thread=?1 LIMIT ?2)")
      drop("DELETE FROM entry_candidates WHERE (seq, thread) IN (SELECT seq, thread FROM entry_candidates WHERE thread=?1 LIMIT ?2)")
      drop("DELETE FROM carried_activity WHERE (thread, journal, session, kind, id) IN (SELECT thread, journal, session, kind, id FROM carried_activity WHERE thread=?1 LIMIT ?2)")
      drop("DELETE FROM carried_paths WHERE (thread, journal, kind, path, seq) IN (SELECT thread, journal, kind, path, seq FROM carried_paths WHERE thread=?1 LIMIT ?2)")
      drop("DELETE FROM carried WHERE (thread, journal) IN (SELECT thread, journal FROM carried WHERE thread=?1 LIMIT ?2)")
      if (left <= 0) return out
      this.statement("INSERT INTO pruned_threads (thread, before) VALUES (?, ?) ON CONFLICT (thread) DO UPDATE SET before = max(before, excluded.before)").run(thread, live.retainAfter)
      // Its calls' deletion wrote its row of the change clock again; with nothing of it left, that goes too.
      if (this.changesTracked()) this.statement("DELETE FROM thread_changes WHERE thread=?").run(thread)
      return { ...out, threads: 1, done: true }
    })
  }

  /**
   * The instant a Thread's records were older than when retention dropped them (`pruneThread`); undefined for a
   * Thread whose records are all here, and in a journal no build with retention has owned.
   */
  prunedBefore(thread: string): number | undefined {
    this.tombstones ||= this.statement("SELECT 1 FROM sqlite_master WHERE name = 'pruned_threads'").get() !== undefined
    if (!this.tombstones) return undefined
    const row = this.statement("SELECT before FROM pruned_threads WHERE thread=?").get(thread)
    return row ? BeforeRow.parse(row).before : undefined
  }

  /** Whether the journal still keeps a turn's record: false once its Thread's records went (`pruneThread`) and the turn's own mark with them. */
  turnKept(thread: string, turn: string): boolean {
    return this.prunedBefore(thread) === undefined || this.turn(thread, turn) !== undefined
  }

  /**
   * Drop the line writers kept for commits older than `retainAfter`, a page of the table after `after` in one short
   * transaction: how many went, and where the next page starts, until the last. One stays while an uncommitted file's
   * base is the content it was kept for, since the next move of that file's base reads it. Each names entries by
   * number, and those of its age are going too.
   */
  pruneCommits(after: CommitKey | undefined, retainAfter: number, limit: number): PrunedPage<CommitKey> {
    const key = after ?? { root: "", oid: "", path: "" }
    const rows = this.statement("SELECT root, oid, path, at, NULL AS ref FROM commits WHERE (root, oid, path) > (?, ?, ?) ORDER BY root, oid, path LIMIT ?")
      .all(key.root, key.oid, key.path, limit).map((row) => CommitKeyRow.parse(row))
    const based = this.statement("SELECT 1 FROM files f JOIN commits c ON c.root = f.root AND c.path = f.path AND c.ref = f.base WHERE c.root=? AND c.oid=? AND c.path=?")
    const drop = this.statement("DELETE FROM commits WHERE root=? AND oid=? AND path=?")
    const dropped = this.transaction(() => {
      let count = 0
      for (const row of rows) {
        if (row.at >= retainAfter || based.get(row.root, row.oid, row.path)) continue
        drop.run(row.root, row.oid, row.path)
        count++
      }
      return count
    })
    const last = rows.at(-1)
    return { dropped, ...(rows.length === limit && last && { next: { root: last.root, oid: last.oid, path: last.path } }) }
  }

  /** Drop up to `limit` of the oldest gaps of lost events that ended before `retainAfter`; whether older ones may remain. */
  pruneGaps(retainAfter: number, limit: number): PrunedGaps {
    const rows = this.statement("SELECT id, coalesce(to_at, from_at) AS at FROM gaps ORDER BY id LIMIT ?").all(limit).map((row) => GapAgeRow.parse(row))
    const old = rows.filter((row) => row.at < retainAfter)
    if (!old.length) return { dropped: 0, more: false }
    const drop = this.statement("DELETE FROM gaps WHERE id=?")
    this.transaction(() => {
      for (const row of old) drop.run(row.id)
    })
    return { dropped: old.length, more: old.length === rows.length && rows.length === limit }
  }

  /** The first root after `after` the stat cache holds rows of. */
  nextStatRoot(after: string): string | undefined {
    return NullableRootRow.parse(this.statement("SELECT min(root) AS root FROM stats WHERE root > ?").get(after)).root ?? undefined
  }

  /**
   * Drop up to `limit` stat rows of a root no longer tracked (let go, or never stored); how many went. A tracked
   * root's stay, asleep or not: its wake compares each file against them, and without them would read every file as new.
   */
  dropStrayStats(root: string, limit: number): number {
    if (this.statement("SELECT 1 FROM roots WHERE id=? AND active=1").get(root)) return 0
    return Number(this.statement("DELETE FROM stats WHERE (root, path) IN (SELECT root, path FROM stats WHERE root=? LIMIT ?)").run(root, limit).changes)
  }

  /** Whether `footprint` is keyed by its primary key alone (`beginCompactFootprint`). */
  footprintCompact(): boolean {
    const row = this.statement("SELECT sql FROM sqlite_master WHERE type='table' AND name='footprint'").get()
    return /WITHOUT\s+ROWID/i.test(row ? SqlRow.parse(row).sql ?? "" : "")
  }

  /**
   * Begin rebuilding `footprint` keyed by its primary key alone; false when it already is. As `MIGRATION` makes it,
   * the table has a row number, so its five-column key is kept a second time as an index nearly the size of the
   * table (265 MB beside 285 MB on 2026-11-17). `MIGRATION` can't change (`SHARED_FORMAT`), but its `CREATE TABLE IF
   * NOT EXISTS` leaves a table already there alone, so the rebuilt one stands for every build of this format: same
   * name, same columns in the same order, same key, read and written by the same statements. A key's column can no
   * longer be null there; every build has written a turn's absence as "". The rows are copied a step at a time
   * (`compactFootprintStep`), and `addFootprint` writes to both tables until the last step puts the new one in place.
   * Rows only a turn's timing tied to a Thread (`weak`) aren't copied: no build writes them any more and nothing lists them.
   */
  beginCompactFootprint(): boolean {
    if (this.footprintCompact()) return false
    this.transaction(() => this.db.exec(`DROP TABLE IF EXISTS footprint_compact; ${FOOTPRINT_COMPACT};`))
    this.compacting = { after: 0 }
    return true
  }

  /**
   * Copy the next `limit` rows of `footprint` into the table that replaces it, in one short transaction; with none
   * left, put that table in its place, and return true. Only this connection writes meanwhile, and what it writes
   * goes to both, so the copy never holds less than the table it replaces. Nothing else may delete from `footprint`
   * between `beginCompactFootprint` and the last step.
   */
  compactFootprintStep(limit: number): boolean {
    const copying = this.compacting
    if (!copying) return true
    return this.transaction(() => {
      const upTo = NullableSeqRow.parse(this.statement("SELECT max(rowid) AS seq FROM (SELECT rowid FROM footprint WHERE rowid > ? ORDER BY rowid LIMIT ?)").get(copying.after, limit)).seq
      if (upTo !== null) {
        this.statement(`INSERT INTO footprint_compact (thread, session, turn, path, access, evidence, at, size, ref, secret, basis)
          SELECT thread, session, coalesce(turn, ''), path, access, evidence, at, size, ref, secret, basis FROM footprint
          WHERE rowid > ? AND rowid <= ? AND evidence <> 'weak' ON CONFLICT DO NOTHING`).run(copying.after, upTo)
        copying.after = upTo
        return false
      }
      // Each statement kept was prepared against the table that goes.
      this.statements.clear()
      this.db.exec("DROP TABLE footprint; ALTER TABLE footprint_compact RENAME TO footprint;")
      this.compacting = undefined
      return true
    })
  }

  /** A number that changes whenever anything is written to the journal, by this connection or another: what a cache of what it holds is keyed by. */
  version(): string {
    const own = Count.parse(this.statement("SELECT total_changes() AS count").get()).count
    return `${this.dataVersion()}:${own}`
  }

  /** One indexed scalar for this checkout, shared by every writer. Older journals use their conservative version. */
  checkpointVersion(checkout: string): string {
    this.checkpointsTracked ||= Count.parse(this.statement("SELECT count(*) AS count FROM sqlite_master WHERE name = 'checkpoint_root_changes'").get()).count === 1
    if (!this.checkpointsTracked) return `legacy:${this.version()}`
    const found = this.statement("SELECT r.id AS root, coalesce(c.seq, 0) AS change_seq FROM roots r LEFT JOIN checkpoint_root_changes c ON c.root=r.id WHERE r.path=?").get(checkout)
    if (!found) return `${this.id}:absent`
    const row = RootChangeRow.parse(found)
    return `${this.id}:${row.root}:${row.change_seq}`
  }

  /** A number that changes whenever another connection commits: a reader's cue that what it read is stale. */
  dataVersion(): number {
    return DataVersionRow.parse(this.statement("PRAGMA data_version").get()).data_version
  }

  close(): void {
    this.statements.clear()
    this.db.close()
  }

  /** Whether `close` has run: work reading it in slices ends at its next step. */
  get closed(): boolean {
    return !this.db.isOpen
  }
}
