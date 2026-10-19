import { createHash } from "node:crypto"
import { createReadStream, existsSync, mkdirSync } from "node:fs"
import { mkdir, open, rename, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { DatabaseSync, StatementSync } from "node:sqlite"
import { z } from "zod"
import { Chunker, chunkHash, HASH_BYTES, Packs } from "./record-chunks.js"
import { plainRecordPath, recordChunks, statRecord } from "./record-files.js"
import type { ForkFile, ForkIds, ForkRow, RecordDatabase, RecordFork, RecordLines, RecordRoot, RecordRow, RecordTable, RecordValue, SessionRecords } from "./harness-records.js"
import { forkIds, forkLines } from "./record-fork.js"
import { checkRoots, placeIn, qualify, RootPlaces, rootFolders } from "./record-roots.js"
import {
  decodeRow, encodeRow, forkIdentity, KEY_DIGESTS, type KeyDigests, KeyDigestsSchema, keyColumns, keyLiteralSql, lookupSql, lookupStatement, positionColumns, type RowKey, quoted, registerKeyDigests, rowKeyOf, rowUnitKey,
  SqlValueSchema, tagged,
} from "./record-rows.js"
import { openReadOnly, type NativeStores } from "./read-only-sqlite.js"
import { declareStoreFormat, inspectStoreFormat, NewerStoreError, readStoreFormat, storeAccess, writeStoreFormat, type StoreStanding } from "./store-format.js"
import { STREAMS_ROOT } from "./record-streams.js"
import { DROPPED, repackStore, type RepackOptions, type RepackReport } from "./record-repack.js"
import { IntentOwner } from "./record-intents.js"

export { decodeRow, encodeRow, taggedRow } from "./record-rows.js"

/**
 * Mako's copy of every session's records, as the harness wrote them.
 *
 * A **unit** is the smallest thing a harness writes on its own: one file,
 * one row, a database's schema, or a session's lines in a shared index. Its
 * key is logical: named by the root it lies under (`record-roots.ts`),
 * without the encoding, and for Codex without the date folder or
 * `archived_sessions`, so a rollout Codex compressed or archived, or the same
 * session on another machine, is the same unit. A unit's history is a list of
 * **versions**, each appending to the one before, replacing it, or deleting
 * it. A version's bytes are content-defined chunks (`record-chunks.ts`), each
 * stored once by hash.
 *
 * Capture reads only what changed: a file whose placement (path, inode,
 * size, mtime) is unchanged isn't opened; an append-only file is read from
 * where the last version ended, once the bytes before that point check out;
 * a database unchanged since the last capture isn't opened, and rows are
 * compared by content hash. A harness's database is read in short
 * transactions, so a large first capture never holds back the harness's
 * checkpoint, and the store commits as it goes, so a capture cut short keeps
 * what it took and other work runs between its slices.
 *
 * Restore writes a session as its newest versions have it: whole where
 * nothing is there, appending where the destination holds an earlier
 * version. Where the destination went on without Mako, its copy is never
 * written: given the harness's fork rule (`RecordFork`), the arriving
 * version becomes a new session beside it, as the harness writes its own
 * forks, under an id the same restore always derives again; without one,
 * nothing is written.
 */

/**
 * The store's format, as two numbers kept in `meta`, the way SQLite keeps
 * its own file format's: `schema`, the format a build must know to write
 * the store, and `reads`, the oldest format whose builds can still read it.
 * A change an older build can live with (a column or a table it never
 * reads, such as each version's writer) changes neither: it's additive, and
 * named in `additions`. A build older than `schema` but not than `reads`
 * opens the store read-only: it lists and restores what it holds and
 * captures nothing, so it never writes what it doesn't know. One older than
 * `reads` leaves the store as it is and serves without it.
 */
const SCHEMA_VERSION = 2
/** Additive changes this build made to the format, each a name in `meta.additions`; a build that doesn't know one ignores what it added. */
const ADDITIONS = ["children", "intents"]
/** The most of a deferred file's first line a restore writes (`RestoreInput.files`). */
const HEAD_BYTES = 1024 * 1024
/** How many files a restore writes at once. */
const FILES_AT_ONCE = 8
/** How long a restore waits for a running harness to release its database's write lock. */
const WRITE_BUSY_TIMEOUT_MS = 30_000
/** How far back from an append cursor a capture checks that nothing before it was rewritten. */
const TAIL_BYTES = 64 * 1024
/** A capture that found nothing new is logged only when it took this long. */
const SLOW_CAPTURE_MS = 50
/** A long capture lets waiting work go first at its next slice; with none waiting, it commits what it took about this often. */
const SLICE_MS = 2_000
/** A read of a harness's database ends once it has held a snapshot this long, or read this many bytes of rows; those are stored with the read ended. */
const READ_MS = 100
const READ_BYTES = 8 * 1024 * 1024
/** Rows a capture asks for in one statement, by position. */
const FETCH_ROWS = 128
/** A report names this many of the versions it took and counts the rest, so a first capture of half a million rows doesn't keep a key for each. */
const VERSIONS_LISTED = 1_000
/** The mark (`marks`) that keeps `CaptureInput.stamp`. */
const HELD_STAMP = "held stamp"
/** The mark (`marks`) that keeps `CaptureInput.listing`. */
const LISTING = "listing"
/** The mark (`marks`) that says the session's children's paths are kept (`child_paths`): by a capture whose records named them, or the backfill's link (`keepChildPaths`). */
const CHILDREN_LINKED = "children linked"

const UnitRoleSchema = z.enum(["file", "row", "schema", "lines"])
const VersionKindSchema = z.enum(["append", "replace", "delete"])
export type UnitRole = z.infer<typeof UnitRoleSchema>
export type VersionKind = z.infer<typeof VersionKindSchema>

export interface CaptureInput {
  harness: string
  nativeId: string
  /** The machine's home: a restore elsewhere puts each root that was under it at the same place under the destination's home. */
  home: string
  records: SessionRecords
  /** Where the catalog reads the session (`ThreadRef.path`), so it can be found by that once its harness forgets it. */
  path?: string
  /**
   * The catalog's stamp of the session as it stood before this capture read
   * it (`RecordCapture`), kept once the capture finishes, in its last
   * transaction: a session whose stamp hasn't moved since is held, and the
   * backfill passes it by without reading it.
   */
  stamp?: string
  /**
   * The rail's row for the session as the catalog lists it now (a
   * `ThreadRef`, as JSON), kept with the capture: once the harness deletes
   * the session, the catalog lists it from this and reads it back from the
   * store.
   */
  listing?: string
}

export interface CaptureReport {
  /** The first `VERSIONS_LISTED` versions taken; `taken` counts them all. */
  versions: { unit: string; kind: VersionKind; bytes: number }[]
  taken: number
  /** Units whose placement or content hash showed nothing new. */
  unchanged: number
  newChunks: number
  /** Bytes of the new chunks, before and after compression. */
  newBytes: number
  storedBytes: number
  /** The capture's own time, from when it got the store until it was done. */
  ms: number
  /** Time it handed the store to work that was waiting, between its slices. */
  waitedMs: number
  /** Read transactions on harness databases: more than one for a database read in pieces so its harness could checkpoint meanwhile. */
  reads: number
  /** Rows read whole; a row never rewritten under its key, already held, isn't. */
  rowsRead: number
  /** Rows of such tables known held by one digest of the session's keys, without listing them. */
  rowsMatched: number
  /** The longest any one of them was open, during which its harness couldn't checkpoint past it. */
  longestReadMs: number
}

export interface RestoreInput {
  harness: string
  nativeId: string
  /** The destination's home. */
  home: string
  /** Where the destination keeps each root, by name. A root it doesn't name goes where it was under the source's home; one the source kept outside its home can't go anywhere unnamed. */
  roots?: RecordRoot[]
  /** The destination's own records for the session, when it has them: a file or row Mako never saw there means the session went on without it. Its roots count when `roots` isn't given. */
  destination?: SessionRecords
  /** True while something on the machine holds the session open; a restore then writes nothing. */
  held?: () => boolean | Promise<boolean>
  /**
   * The harness's fork rule (`SessionProvider.fork`). Given one, a
   * destination whose copy went on without Mako keeps it untouched and gets
   * the arriving version as a new session of the harness's own, a fork
   * (`RestoreReport.fork`); units no single session owns are written only
   * where the destination lacks them. Without one, such a restore writes
   * nothing.
   */
  fork?: RecordFork
  dryRun?: boolean
  /**
   * How the destination's databases are opened for writing, when not as the
   * store's own (`RecordStore`'s `stores`): a catalog whose store reads
   * sessions back only into its private homes restores into a harness's own
   * store, for the harness to resume a session it deleted, with the host's.
   */
  stores?: NativeStores
  /**
   * Which of the session's files to write, by where each goes; the rest
   * are left as the destination has them and listed in
   * `RestoreReport.deferred`. Unset writes every one. A private home a
   * session is read back into writes its children's transcripts only once
   * one is opened (`RecordReads`).
   */
  files?: (target: string) => boolean
}

export type RestoreActionKind = "skip" | "write" | "append" | "write-plain" | "delete"

/** What a restore does to a file, or to a session's lines in a shared file. */
export interface RestoreAction {
  unit: string
  action: RestoreActionKind
  /** As the store names it (`codex:sessions/…`). */
  path: string
  bytes: number
}

/** What a restore does to one table's rows of the session, counted: a session can own millions. */
export interface RestoreRows {
  /** The database, as the store names it (`cursor-sdk:index.db`). */
  path: string
  table: string
  insert: number
  replace: number
  delete: number
  /** Rows the destination already holds as Mako's newest version has them. */
  skip: number
  /** The bytes of the rows written. */
  bytes: number
}

export interface RestoreReport {
  actions: RestoreAction[]
  rows: RestoreRows[]
  /**
   * Units the destination holds a version of that Mako never captured, or
   * that have nowhere to go. None of them is written. Without a fork, nothing
   * at all is written when there are any; with one, the session's own units
   * go to the fork (`fork`).
   */
  diverged: { unit: string; reason: string }[]
  /** Units no single session owns (a project or migration row) that the destination holds otherwise, left as it has them. */
  kept: { unit: string; reason: string }[]
  /** The arriving version written as a new session beside the destination's, when its copy went on without Mako and a fork rule was given. */
  fork?: RestoreFork
  /** Values in rows that named a path in one of the session's roots, moved to where the root is in the destination. */
  movedPaths: number
  written: boolean
  /** Where the files `RestoreInput.files` left out would have gone. */
  deferred?: string[]
}

/** What a restore wrote as a fork: enough for the caller to log it (`fork` in Mako's log) and bind it. */
export interface RestoreFork {
  /** The fork's native id: the same for the same arriving version and destination, so a second restore finds it. */
  nativeId: string
  /** Each unit the destination went on from, with the bytes from its start it shares with the arriving version, cut back to a line's end in a transcript (0 for a row). */
  from: { unit: string; shared: number }[]
  /** The fork's files and lines, and its rows by table, as `actions` and `rows` report the session's. */
  actions: RestoreAction[]
  rows: RestoreRows[]
  /** The fork's own units the destination already holds otherwise: the fork went on there too, so nothing is written. */
  diverged: { unit: string; reason: string }[]
  written: boolean
}

// Mako's index, as its rows read back.

const Blob = z.instanceof(Uint8Array)

const SessionSummarySchema = z.object({ harness: z.string(), nativeId: z.string(), units: z.number(), bytes: z.number() })
export type SessionSummary = z.infer<typeof SessionSummarySchema>
const SessionAtSchema = z.object({ harness: z.string(), nativeId: z.string() })
const RecordedPathSchema = SessionAtSchema.extend({ path: z.string(), capturedAt: z.number().nullable() })
export type RecordedPath = Omit<z.infer<typeof RecordedPathSchema>, "path">

/**
 * Each path a capture named, with its session and when that session was last
 * captured; read without writing, for diagnostics. A store an earlier build
 * made names none until this build's first capture adds the table.
 */
export function recordedPaths(folder: string): Map<string, RecordedPath> {
  const file = join(folder, "records.sqlite")
  if (!existsSync(file)) return new Map()
  const { database } = openReadOnly(file, { timeout: 5_000 })
  try {
    if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_paths'").get()) return new Map()
    const rows = RecordedPathSchema.array().parse(database.prepare(`
      SELECT p.path, s.harness, s.native_id AS nativeId, (SELECT max(c.at) FROM captures c WHERE c.session = s.id) AS capturedAt
      FROM session_paths p JOIN sessions s ON s.id = p.session`).all())
    return new Map(rows.map(({ path, ...session }) => [path, session]))
  } finally {
    database.close()
  }
}

/** Where the record store in `folder` stands for this build, read without writing: for Settings › Diagnostics. */
export function recordStoreStanding(folder: string): StoreStanding {
  const format = inspectStoreFormat(join(folder, "records.sqlite"), "meta")
  return format ? { access: storeAccess(format, SCHEMA_VERSION), build: SCHEMA_VERSION, format } : { access: "write", build: SCHEMA_VERSION }
}

const UnitSummarySchema = z.object({
  id: z.number(), key: z.string(), role: UnitRoleSchema, path: z.string().nullable(), versions: z.number(), size: z.number(), kind: VersionKindSchema,
})
export type UnitSummary = z.infer<typeof UnitSummarySchema>

const CaptureSummarySchema = z.object({
  harness: z.string(), nativeId: z.string(), at: z.number(), versions: z.number(), newBytes: z.number(), storedBytes: z.number(), ms: z.number(),
  waitedMs: z.number(), reads: z.number(), longestReadMs: z.number(), rowsRead: z.number(), rowsMatched: z.number(),
})
export type CaptureSummary = z.infer<typeof CaptureSummarySchema>

const SchemaSnapshotSchema = z.object({ statements: z.array(z.string()), userVersion: z.number() })
/** A database's schema as one unit holds it. */
export type SchemaSnapshot = z.infer<typeof SchemaSnapshotSchema>

/** Where a session's records were when it was last captured: the machine's home, each root's folder, and the columns of each database that name a path in a root. */
const SessionLayoutSchema = z.object({
  home: z.string(),
  roots: z.record(z.string(), z.string()),
  paths: z.record(z.string(), z.record(z.string(), z.array(z.string()))),
})
type SessionLayout = z.infer<typeof SessionLayoutSchema>
const SessionRowSchema = z.object({ id: z.number(), layout: z.string().nullable() })

const UnitRowSchema = z.object({
  id: z.number(), key: z.string(), role: UnitRoleSchema, head: z.number(),
  seen_path: z.string().nullable(), seen_identity: z.string().nullable(), seen_mtime: z.number().nullable(), seen_bytes: z.number().nullable(),
  /** JSON: every plain path the harness may file it at (`RecordPlace.places`). */
  places: z.string().nullable(),
})
type UnitRow = z.infer<typeof UnitRowSchema>
/** A unit at the version a restore as of a time takes (`restoreAsOf`): `head` is that version, `kind` what it did. */
const PinnedUnitSchema = UnitRowSchema.extend({ kind: VersionKindSchema, size: z.number() })

/** A unit's newest version, as far as capture and restore compare it. */
const UnitHeadSchema = z.object({ id: z.number(), key: z.string(), role: UnitRoleSchema, head: z.number(), kind: VersionKindSchema, size: z.number(), digest: Blob.nullable() })
const HeadRowSchema = z.object({ kind: VersionKindSchema, size: z.number(), digest: Blob.nullable(), tail: Blob.nullable() })
const VersionRowSchema = z.object({
  seq: z.number(), kind: VersionKindSchema, at: z.number(), size: z.number(), chunkBytes: z.number(), captured_at: z.number(), digest: Blob.nullable(),
})
const ContentVersionSchema = z.object({ seq: z.number(), kind: VersionKindSchema, chunks: Blob })
const SizedVersionSchema = z.object({ kind: VersionKindSchema, size: z.number() })
const ChunkPlaceSchema = z.object({ pack: z.number(), offset: z.number(), stored: z.number(), size: z.number(), codec: z.union([z.literal(0), z.literal(1)]) })
const ChunkEntrySchema = ChunkPlaceSchema.extend({ hash: Blob })
const CountSchema = z.object({ n: z.number() })
const IdSchema = z.object({ id: z.number() })
const NewestSeqSchema = z.object({ seq: z.number().nullable() })
const DataVersionSchema = z.object({ data_version: z.number() })
const MetaValueSchema = z.object({ value: z.string() })
const HeldChunkSchema = z.object({ intent: z.number().nullable(), stored: z.number(), unnamed: z.number() })
const FingerprintSchema = z.object({ fingerprint: z.string() })
const PathRowSchema = z.object({ path: z.string() })
/** A table's mark: the session's highest rowid and the digest of its keys, when the capture that set it took every row it listed. */
const KeysMarkSchema = z.object({ through: z.string().regex(/^-?\d+$/).transform((value) => BigInt(value)), keys: z.string() })
type KeysMark = z.infer<typeof KeysMarkSchema>
const KeyDigestRowSchema = z.object({ digests: z.string().nullable(), through: z.bigint().nullable() })
const PlacesSchema = z.array(z.string())
const LinesKeySchema = z.record(z.string(), z.string())
const SchemaStatementSchema = z.object({ sql: z.string() })
const UserVersionSchema = z.object({ user_version: z.union([z.number(), z.bigint()]) })
const TableNameSchema = z.object({ name: z.string() })
const KeySchema = z.object({ key: z.string() })
const HeldStampSchema = z.object({ harness: z.string(), nativeId: z.string(), stamp: z.string() })
const SeqSchema = z.object({ seq: z.number() })
const BigIntSchema = z.bigint()
const ForkSeedSchema = z.object({ key: z.string(), kind: VersionKindSchema, size: z.number(), digest: Blob.nullable() })

export interface StoreStats {
  sessions: number
  units: number
  versions: number
  chunks: number
  /** Distinct chunk bytes, before and after compression. */
  bytes: number
  stored: number
}

export interface VersionSummary {
  seq: number
  kind: VersionKind
  at: number
  size: number
  chunks: number
  capturedAt: string
  digest: string | null
}

interface Head {
  unit: number
  seq: number
  kind: VersionKind
  size: number
  digest: Buffer | null
  tail: Buffer | null
}

/** A unit as capture and restore keep it in memory: enough to compare and to add a version, a few dozen bytes each. */
interface KnownUnit {
  id: number
  head: number
  kind: VersionKind
  digest: Buffer | null
  /** This capture listed it. */
  seen: boolean
}

/** One operation at a time, in the order they asked. */
class Turns {
  private busy = false
  private readonly queue: (() => void)[] = []

  take(): Promise<void> {
    if (!this.busy) {
      this.busy = true
      return Promise.resolve()
    }
    return new Promise((resolve) => this.queue.push(resolve))
  }

  give(): void {
    const next = this.queue.shift()
    if (next) next()
    else this.busy = false
  }

  get waiting(): boolean {
    return this.queue.length > 0
  }
}

/**
 * A harness's database, read in short transactions, each on a connection
 * of its own: a long read would keep the harness from checkpointing its
 * write-ahead log, and a writer that appeared since the last read is then
 * read as live rather than as an unchanging file.
 */
class SourceRead {
  private open: { db: DatabaseSync; statements: Map<string, StatementSync>; since: number } | null = null
  /** Reads begun so far. */
  reads = 0
  longestMs = 0

  constructor(private readonly path: string) {}

  get db(): DatabaseSync {
    return this.connection().db
  }

  /** A statement on the current read, prepared once per read; rows come back with SQLite's integers as integers, as arrays when asked. */
  statement(sql: string, arrays = false): StatementSync {
    const { db, statements } = this.connection()
    const cached = `${arrays ? "arrays" : "objects"}\t${sql}`
    let statement = statements.get(cached)
    if (!statement) {
      statement = db.prepare(sql)
      statement.setReadBigInts(true)
      statement.setReturnArrays(arrays)
      statements.set(cached, statement)
    }
    return statement
  }

  /** The current read has held its snapshot long enough. */
  get due(): boolean {
    return this.open !== null && Date.now() - this.open.since >= READ_MS
  }

  /** Ends the current read, if one is open; the next statement begins another. */
  end(): void {
    if (!this.open) return
    const { db, since } = this.open
    this.open = null
    this.longestMs = Math.max(this.longestMs, Date.now() - since)
    try {
      if (db.isTransaction) db.exec("COMMIT")
    } finally {
      db.close()
    }
  }

  private connection(): { db: DatabaseSync; statements: Map<string, StatementSync>; since: number } {
    if (this.open) return this.open
    const { database } = openReadOnly(this.path, { timeout: 5_000 })
    registerKeyDigests(database)
    database.exec("BEGIN")
    this.reads += 1
    return (this.open = { db: database, statements: new Map(), since: Date.now() })
  }
}

/** A listed rowid: the store's own reads of a harness's database take SQLite's integers as BigInts. */
const RowidSchema = z.bigint()

function countVersion(report: CaptureReport, version: CaptureReport["versions"][number]): void {
  report.taken += 1
  if (report.versions.length < VERSIONS_LISTED) report.versions.push(version)
}

/**
 * The positions a table's listing found, in the order it found them. A rowid
 * is kept in eight bytes of a typed array, outside the JavaScript heap, so a
 * listing of half a million rows takes 4 MB rather than an array and a
 * BigInt for each; other positions are kept as their columns.
 */
class Listed {
  private ids: BigInt64Array | null
  private readonly rows: RecordValue[][] = []
  length = 0

  constructor(rowid: boolean) {
    this.ids = rowid ? new BigInt64Array(4_096) : null
  }

  push(at: RecordValue[]): void {
    if (this.ids) {
      if (this.length === this.ids.length) {
        const grown = new BigInt64Array(this.ids.length * 2)
        grown.set(this.ids)
        this.ids = grown
      }
      this.ids[this.length] = RowidSchema.parse(at[0])
    } else this.rows.push(at)
    this.length += 1
  }

  slice(from: number, to: number): RecordValue[][] {
    if (!this.ids) return this.rows.slice(from, to)
    return Array.from(this.ids.subarray(from, Math.min(to, this.length)), (id) => [id])
  }
}

/** A row read from the harness, encoded and ready to store once the read has ended. */
interface ReadRow {
  key: string
  bytes: Buffer
  digest: Buffer
}

/** A capture's intent (`record-intents.ts`): its session, as the readout names it, and the intent's id once registered. */
interface CaptureIntent {
  session: string
  id: number | null
}

/**
 * Where a capture stands in its writes, for a test that kills its process
 * there (`RecordStoreOptions.step`): `written`, a new chunk's bytes staged
 * and indexed in the open transaction; `synced`, the transaction's pack
 * bytes on disk, the index not yet committed; `sliced`, a slice committed,
 * chunks a version doesn't name yet among it; `versioned`, a file's version
 * written in the open transaction; `stamped`, the last transaction holding
 * the stamp, not yet committed; `committed`, the capture done.
 */
export type CaptureStep = "written" | "synced" | "sliced" | "versioned" | "stamped" | "committed"

export interface RecordStoreOptions {
  /** How this build stamps a format it raises (`storeWriter`). */
  writer?: string
  /** Called at each step of a capture's writes; a test stops there to kill the process. */
  step?: (step: CaptureStep) => void | Promise<void>
}

export class RecordStore {
  readonly folder: string
  private readonly db: DatabaseSync
  private readonly packs: Packs
  private readonly statements = new Map<string, StatementSync>()
  private readonly turns = new Turns()
  /** Each session's capture in progress, so its next capture or a restore of it waits for it. */
  private readonly capturing = new Map<string, Promise<unknown>>()
  /** When the store's current write transaction began. */
  private sliceAt = 0
  private closed = false
  /** The repack's drop generation (`DROPPED`) each capture in progress began under. */
  private readonly generations = new WeakMap<CaptureReport, string>()
  /** This open store as the owner of its captures' intents (`record-intents.ts`). */
  private readonly owner: IntentOwner
  /** Each capture's session, and its intent once it has stored or claimed a chunk. */
  private readonly intents = new WeakMap<CaptureReport, CaptureIntent>()
  private intentsTaken = 0
  private readonly step: RecordStoreOptions["step"]

  /** How the restore running opens its destination's databases (`RestoreInput.stores`). */
  private writer: NativeStores
  /**
   * `read` for a store a newer Mako's format holds that this build can read
   * but not write (`SCHEMA_VERSION`): it lists and restores what it holds,
   * and refuses to capture, forget or repack, so nothing it doesn't know is
   * written over. A store another build raises while this one has it open
   * turns `read` at the first look after that build's commit
   * (`PRAGMA data_version`, a look at shared memory).
   */
  get access(): "write" | "read" {
    if (this.opened === "read" || this.closed) return this.opened
    const version = DataVersionSchema.parse(this.prepared("PRAGMA data_version").get()).data_version
    if (version !== this.formatVersion) {
      this.formatVersion = version
      this.raised = storeAccess(readStoreFormat(this.db, "meta"), SCHEMA_VERSION) !== "write"
    }
    return this.raised ? "read" : "write"
  }
  private readonly opened: "write" | "read"
  private formatVersion = -1
  private raised = false
  /** How this build stamps a format it raises (`storeWriter`), so an older build can name it. */
  private readonly formatWriter: string | undefined

  constructor(folder: string, private readonly stores: NativeStores, options: RecordStoreOptions = {}) {
    this.formatWriter = options.writer
    this.step = options.step
    this.writer = stores
    this.folder = folder
    this.owner = new IntentOwner(folder)
    mkdirSync(folder, { recursive: true })
    const { DatabaseSync } = process.getBuiltinModule("node:sqlite")
    this.db = new DatabaseSync(join(folder, "records.sqlite"), { timeout: 60_000 })
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL")
    declareStoreFormat(this.db, SCHEMA_VERSION)
    try {
      this.opened = this.migrate()
    } catch (error) {
      this.db.close()
      throw error
    }
    this.packs = new Packs(join(folder, "packs"))
  }

  private writable(): void {
    if (this.access === "read")
      throw new Error(`The record store at ${this.folder} is in a newer Mako's format: this build reads it and writes nothing to it`)
  }

  /** Takes what's new in a session's records. A session's captures run one after another; other work runs between the slices of a long one. */
  capture(input: CaptureInput): Promise<CaptureReport> {
    this.writable()
    const session = `${input.harness}\n${input.nativeId}`
    const before = this.capturing.get(session)
    const run = (before ? before.catch(() => undefined) : Promise.resolve()).then(() => this.serially(() => this.captureNow(input)))
    this.capturing.set(session, run)
    const settled = () => {
      if (this.capturing.get(session) === run) this.capturing.delete(session)
    }
    run.then(settled, settled)
    return run
  }

  /** Writes a session into a home; waits for a capture of it in progress, so it never restores half of one. */
  async restore(input: RestoreInput): Promise<RestoreReport> {
    await this.capturing.get(`${input.harness}\n${input.nativeId}`)?.catch(() => undefined)
    return this.serially(async () => {
      this.writer = input.stores ?? this.stores
      try {
        return await this.restoreNow(input)
      } finally {
        this.writer = this.stores
      }
    })
  }

  /**
   * The session as it stood when Mako had captured it by `asOf` (a capture
   * time), written whole into `home`, which holds none of it: each unit at
   * its newest version captured by then, a unit first captured later left
   * out. A journal that names a span of a session (`BaseSource.span`) reads
   * it back this way once the harness has rewritten the session since, so
   * the history it continues is the one it was. Nothing is compared or
   * forked: `home` is Mako's own, made for the read.
   */
  async restoreAsOf(input: { harness: string; nativeId: string; home: string; asOf: number }): Promise<RestoreReport> {
    await this.capturing.get(`${input.harness}\n${input.nativeId}`)?.catch(() => undefined)
    return this.serially(() => this.restoreAsOfNow(input))
  }

  private async restoreAsOfNow(input: { harness: string; nativeId: string; home: string; asOf: number }): Promise<RestoreReport> {
    const found = SessionRowSchema.optional().parse(this.prepared("SELECT id, layout FROM sessions WHERE harness = ? AND native_id = ?").get(input.harness, input.nativeId))
    if (!found?.layout) throw new Error(`Mako holds no records of ${input.harness} session ${input.nativeId}`)
    const layout = SessionLayoutSchema.parse(JSON.parse(found.layout))
    const places = new RootPlaces({ home: layout.home, roots: new Map(Object.entries(layout.roots)) }, { home: input.home })
    const report: RestoreReport = { actions: [], rows: [], diverged: places.missing.map(({ root, reason }) => ({ unit: `${root}:`, reason })), kept: [], movedPaths: 0, written: false }
    if (report.diverged.length) return report
    const pinned = PinnedUnitSchema.array().parse(this.prepared(`
      SELECT u.id, u.key, u.role, u.seen_path, u.seen_identity, u.seen_mtime, u.seen_bytes, u.places, p.seq AS head, v.kind, v.size
      FROM (SELECT su.unit AS unit, max(v.seq) AS seq FROM session_units su JOIN versions v ON v.unit = su.unit WHERE su.session = ? AND v.captured_at <= ? GROUP BY su.unit) p
      JOIN units u ON u.id = p.unit JOIN versions v ON v.unit = p.unit AND v.seq = p.seq ORDER BY u.key`).all(found.id, input.asOf))
    const databases = new Map<string, DatabasePlan & { bytes: number }>()
    for (const unit of pinned) {
      if (unit.kind === "delete") continue
      if (unit.role === "file") {
        if (!unit.seen_path) continue
        const target = places.place(plainRecordPath(unit.seen_path))
        await this.applyFile(unit, { action: "write", target, from: 0, seq: unit.head })
        report.actions.push({ unit: unit.key, action: "write", path: plainRecordPath(unit.seen_path), bytes: unit.size })
      } else if (unit.role === "lines") {
        const [name = ""] = unit.key.split("\t")
        const bytes = await this.versionBytes(unit.id, unit.head)
        await this.applyLines({ target: places.place(name), bytes })
        report.actions.push({ unit: unit.key, action: "append", path: name, bytes: bytes.length })
      } else {
        const [name = ""] = unit.key.split("\t")
        if (!this.mark(found.id, name)) {
          report.diverged.push({ unit: name, reason: "Mako's first capture of this database never finished, so it holds only part of the session's rows" })
          continue
        }
        const plan = databases.get(name) ?? { schema: null, rows: [], moves: layout.paths[name] ?? {}, bytes: 0 }
        databases.set(name, plan)
        if (unit.role === "schema") plan.schema = { id: unit.id, head: unit.head }
        else {
          plan.rows.push({ id: unit.id, head: unit.head, delete: false })
          plan.bytes += unit.size
        }
      }
    }
    if (report.diverged.length) return report
    for (const [name, plan] of databases) {
      await this.applyDatabase(places, name, plan)
      report.rows.push({ path: name, table: "*", insert: plan.rows.length, replace: 0, delete: 0, skip: 0, bytes: plan.bytes })
    }
    report.written = report.actions.length > 0 || report.rows.some((rows) => rows.insert > 0)
    return report
  }

  /**
   * Closes once the work in progress ends; work asked for after that fails.
   * A capture still under way (it waits for its next slice) ends here: its
   * intent is marked ended, so the repack drops what it stored and never
   * named, and this owner's lock goes.
   */
  async close(): Promise<void> {
    if (this.closed) return
    await this.turns.take()
    try {
      if (this.closed) return
      this.closed = true
      if (this.intentsTaken && this.opened === "write") {
        try {
          this.prepared("UPDATE intents SET ended = ? WHERE owner = ? AND ended IS NULL").run(Date.now(), this.owner.id)
        } catch (error) {
          // A store raised under this one refuses the write; the lock let go below says the same, once this process ends.
          console.warn("The record store's open captures could not be marked ended", this.folder, error instanceof Error ? error.message : error)
        }
      }
      await this.packs.close()
      this.db.close()
      await this.owner.release()
    } finally {
      this.turns.give()
    }
  }

  sessions(harness?: string): SessionSummary[] {
    return SessionSummarySchema.array().parse(this.prepared(`
      SELECT s.harness, s.native_id AS nativeId, count(u.id) AS units, coalesce(sum(v.size), 0) AS bytes
      FROM sessions s JOIN session_units su ON su.session = s.id JOIN units u ON u.id = su.unit
      LEFT JOIN versions v ON v.unit = u.id AND v.seq = u.head
      WHERE ?1 IS NULL OR s.harness = ?1 GROUP BY s.id ORDER BY s.harness, s.native_id`)
      .all(harness ?? null))
  }

  /** Captures that took versions or were slow, newest first. */
  captures(options: { harness?: string; nativeId?: string; limit?: number } = {}): CaptureSummary[] {
    return CaptureSummarySchema.array().parse(this.prepared(`
      SELECT s.harness, s.native_id AS nativeId, c.at, c.versions, c.new_bytes AS newBytes, c.stored_bytes AS storedBytes, c.ms, c.waited_ms AS waitedMs, c.reads, c.longest_read_ms AS longestReadMs, c.rows_read AS rowsRead, c.rows_matched AS rowsMatched
      FROM captures c JOIN sessions s ON s.id = c.session
      WHERE (?1 IS NULL OR s.harness = ?1) AND (?2 IS NULL OR s.native_id = ?2)
      ORDER BY c.id DESC LIMIT ?3`)
      .all(options.harness ?? null, options.nativeId ?? null, options.limit ?? 50))
  }

  /** The stamp the session's last finished capture was given (`CaptureInput.stamp`); null when none was. */
  heldStamp(harness: string, nativeId: string): string | null {
    const session = this.sessionId(harness, nativeId, false)
    return session === null ? null : this.mark(session, HELD_STAMP) ?? null
  }

  /**
   * Replaces the session's held stamp `from` with `to`, only if it's still
   * `from`: pruning a stream file the store holds whole changes what the
   * stamp says of the session's streams, not what the store holds of it.
   */
  restamp(harness: string, nativeId: string, from: string, to: string): Promise<boolean> {
    this.writable()
    return this.serially(async () => {
      const session = this.sessionId(harness, nativeId, false)
      if (session === null) return false
      return Number(this.prepared("UPDATE marks SET fingerprint = ? WHERE session = ? AND name = ? AND fingerprint = ?").run(to, session, HELD_STAMP, from).changes) > 0
    })
  }

  /** Every session's held stamp, by `<harness>\n<native id>`, in one read. */
  heldStamps(): Map<string, string> {
    const rows = HeldStampSchema.array().parse(this.prepared(`
      SELECT s.harness, s.native_id AS nativeId, m.fingerprint AS stamp FROM marks m JOIN sessions s ON s.id = m.session WHERE m.name = ?`).all(HELD_STAMP))
    return new Map(rows.map((row) => [`${row.harness}\n${row.nativeId}`, row.stamp]))
  }

  /** The rail's row kept with the session's captures (`CaptureInput.listing`), or null when none was. */
  listing(harness: string, nativeId: string): string | null {
    const session = this.sessionId(harness, nativeId, false)
    return session === null ? null : this.mark(session, LISTING) ?? null
  }

  /** Every session's kept row (`CaptureInput.listing`), in one read: what the catalog lists once a harness deletes a session. */
  listings(): string[] {
    return FingerprintSchema.array().parse(this.prepared("SELECT fingerprint FROM marks WHERE name = ?").all(LISTING)).map((row) => row.fingerprint)
  }

  /**
   * Keeps `listing` as the session's row, and `path` as a place it's found
   * by (`sessionAt`), without a capture: the row of a session its harness
   * deleted before captures kept one. False when the store holds no such
   * session.
   */
  keepListing(harness: string, nativeId: string, path: string, listing: string): Promise<boolean> {
    this.writable()
    return this.serially(async () => {
      const session = this.sessionId(harness, nativeId, false)
      if (session === null) return false
      this.db.exec("BEGIN IMMEDIATE")
      try {
        this.prepared("INSERT INTO session_paths (path, session) VALUES (?, ?) ON CONFLICT (path) DO UPDATE SET session = excluded.session").run(path, session)
        this.setMark(session, LISTING, listing)
        this.db.exec("COMMIT")
        return true
      } catch (error) {
        if (this.db.isTransaction) this.db.exec("ROLLBACK")
        throw error
      }
    })
  }

  /** Whether a capture of the session ever finished: one kept its stamp, or recorded itself. Slices of a capture that stopped don't count. */
  captured(harness: string, nativeId: string): boolean {
    const session = this.sessionId(harness, nativeId, false)
    if (session === null) return false
    return this.mark(session, HELD_STAMP) !== undefined || Boolean(this.prepared("SELECT 1 FROM captures WHERE session = ? LIMIT 1").get(session))
  }

  /** The paths captures of the session named (`CaptureInput.path`). */
  pathsOf(harness: string, nativeId: string): string[] {
    const session = this.sessionId(harness, nativeId, false)
    if (session === null) return []
    return PathRowSchema.array().parse(this.prepared("SELECT path FROM session_paths WHERE session = ? ORDER BY path").all(session)).map((row) => row.path)
  }

  /** The keys of `harness`'s units matching a GLOB `pattern`: a stream's file by its launch, once the session's id took it. */
  unitKeys(harness: string, pattern: string): string[] {
    return KeySchema.array().parse(this.prepared("SELECT key FROM units WHERE harness = ? AND key GLOB ? ORDER BY key").all(harness, pattern)).map((row) => row.key)
  }

  /**
   * Drops a session the person deleted in Mako: its units no other session
   * shares, with every version, and everything that names it. A session its
   * harness deleted is never forgotten; its records are what's left of it.
   * The chunks stay in the packs, unnamed, until a repack leaves them out.
   */
  async forget(harness: string, nativeId: string): Promise<{ units: number; versions: number }> {
    this.writable()
    await this.capturing.get(`${harness}\n${nativeId}`)?.catch(() => undefined)
    return this.serially(async () => {
      const session = this.sessionId(harness, nativeId, false)
      if (session === null) return { units: 0, versions: 0 }
      // Each of the session's units that no other session names, found by the unit index, not by listing every other session's units.
      const own = "SELECT su.unit FROM session_units su WHERE su.session = ?1 AND NOT EXISTS (SELECT 1 FROM session_units o WHERE o.unit = su.unit AND o.session != ?1)"
      this.db.exec("BEGIN IMMEDIATE")
      try {
        // What the dropped versions named is a candidate for the repack to drop, once it finds no other version names it.
        const orphan = this.prepared("INSERT OR IGNORE INTO orphans (hash) VALUES (?)")
        for (const row of this.prepared(`SELECT chunks FROM versions WHERE unit IN (${own})`).iterate(session)) {
          const list = ContentVersionSchema.pick({ chunks: true }).parse(row).chunks
          for (let at = 0; at < list.length; at += HASH_BYTES) orphan.run(list.subarray(at, at + HASH_BYTES))
        }
        const versions = Number(this.prepared(`DELETE FROM versions WHERE unit IN (${own})`).run(session).changes)
        const units = Number(this.prepared(`DELETE FROM units WHERE id IN (${own})`).run(session).changes)
        for (const table of ["session_units", "session_paths", "child_paths", "marks", "captures"]) this.prepared(`DELETE FROM ${table} WHERE session = ?`).run(session)
        this.prepared("DELETE FROM sessions WHERE id = ?").run(session)
        // A capture that found one of these chunks held before they became candidates, and hasn't named it yet, starts over.
        this.prepared(`INSERT INTO meta (key, value) VALUES (?, '1') ON CONFLICT (key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`).run(DROPPED)
        this.db.exec("COMMIT")
        return { units, versions }
      } catch (error) {
        if (this.db.isTransaction) this.db.exec("ROLLBACK")
        throw error
      }
    })
  }

  /** The session the catalog last read at `path`, by a capture that named it. */
  sessionAt(path: string): { harness: string; nativeId: string } | null {
    return SessionAtSchema.optional().parse(this.prepared(`
      SELECT s.harness, s.native_id AS nativeId FROM session_paths p JOIN sessions s ON s.id = p.session WHERE p.path = ?`).get(path)) ?? null
  }

  /** The session whose records hold the child agent read at `path` (`SessionRecords.children`): a child is read through its parent. */
  parentAt(path: string): { harness: string; nativeId: string } | null {
    return SessionAtSchema.optional().parse(this.prepared(`
      SELECT s.harness, s.native_id AS nativeId FROM child_paths p JOIN sessions s ON s.id = p.session WHERE p.path = ?`).get(path)) ?? null
  }

  /**
   * Keeps `paths` as the session's child agents' (`parentAt`) without a
   * capture: the children of a session captured before captures named
   * them, once they're listed from its records. Returns how many were new.
   */
  keepChildPaths(harness: string, nativeId: string, paths: readonly string[], options: { linked?: true } = {}): Promise<number> {
    this.writable()
    return this.serially(async () => {
      const session = this.sessionId(harness, nativeId, false)
      if (session === null || (!paths.length && !options.linked)) return 0
      this.db.exec("BEGIN IMMEDIATE")
      try {
        let added = 0
        for (const path of paths) added += Number(this.prepared("INSERT INTO child_paths (path, session) VALUES (?, ?) ON CONFLICT (path) DO NOTHING").run(path, session).changes)
        if (options.linked) this.setMark(session, CHILDREN_LINKED, "1")
        this.db.exec("COMMIT")
        return added
      } catch (error) {
        if (this.db.isTransaction) this.db.exec("ROLLBACK")
        throw error
      }
    })
  }

  /**
   * Sessions whose children's paths nothing has kept yet: captured before
   * captures named them, and not linked since (`keepChildPaths` with
   * `linked`), newest capture first, with the paths captures read them at.
   */
  sessionsWithoutChildLinks(): { harness: string; nativeId: string; paths: string[] }[] {
    const rows = z.object({ id: z.number(), harness: z.string(), nativeId: z.string() }).array().parse(this.prepared(`
      SELECT s.id, s.harness, s.native_id AS nativeId FROM sessions s
      WHERE NOT EXISTS (SELECT 1 FROM marks m WHERE m.session = s.id AND m.name = ?)
      ORDER BY (SELECT max(c.at) FROM captures c WHERE c.session = s.id) DESC`).all(CHILDREN_LINKED))
    const paths = this.prepared("SELECT path FROM session_paths WHERE session = ? ORDER BY path")
    return rows.map((row) => ({ harness: row.harness, nativeId: row.nativeId, paths: PathRowSchema.array().parse(paths.all(row.id)).map((path) => path.path) }))
  }

  /** The paths of the session's child agents its captures named. */
  childPaths(harness: string, nativeId: string): string[] {
    const session = this.sessionId(harness, nativeId, false)
    if (session === null) return []
    return PathRowSchema.array().parse(this.prepared("SELECT path FROM child_paths WHERE session = ? ORDER BY path").all(session)).map((row) => row.path)
  }

  units(harness: string, nativeId: string): UnitSummary[] {
    return UnitSummarySchema.array().parse(this.prepared(`
      SELECT u.id, u.key, u.role, u.seen_path AS path, u.head + 1 AS versions, v.size, v.kind
      FROM sessions s JOIN session_units su ON su.session = s.id JOIN units u ON u.id = su.unit
      JOIN versions v ON v.unit = u.id AND v.seq = u.head
      WHERE s.harness = ? AND s.native_id = ? ORDER BY u.role, u.key`)
      .all(harness, nativeId))
  }

  versions(harness: string, key: string): VersionSummary[] {
    const unit = this.unitByKey(harness, key)
    if (!unit) return []
    return VersionRowSchema.array().parse(this.prepared("SELECT seq, kind, at, size, length(chunks) AS chunkBytes, captured_at, digest FROM versions WHERE unit = ? ORDER BY seq").all(unit.id)).map((row) => ({
      seq: row.seq, kind: row.kind, at: row.at, size: row.size, chunks: row.chunkBytes / HASH_BYTES,
      capturedAt: new Date(row.captured_at).toISOString(), digest: row.digest ? Buffer.from(row.digest).toString("hex") : null,
    }))
  }

  /** A unit's bytes as of version `seq` (the newest by default): a file's content, a row or schema in its encoding, a session's lines. */
  async *content(harness: string, key: string, seq?: number): AsyncGenerator<Buffer> {
    const unit = this.unitByKey(harness, key)
    if (!unit) throw new Error(`No unit ${key} of ${harness}`)
    yield* this.unitContent(unit.id, seq ?? unit.head)
  }

  /** A row or schema version decoded. */
  async decoded(harness: string, key: string, seq?: number): Promise<RecordRow | SchemaSnapshot> {
    const unit = this.unitByKey(harness, key)
    if (!unit || (unit.role !== "row" && unit.role !== "schema")) throw new Error(`${key} isn't a row or schema of ${harness}`)
    const bytes = await collect(this.unitContent(unit.id, seq ?? unit.head))
    return unit.role === "schema" ? SchemaSnapshotSchema.parse(JSON.parse(bytes.toString("utf8"))) : decodeRow(bytes)
  }

  stats(): StoreStats {
    const count = (sql: string) => CountSchema.parse(this.prepared(sql).get()).n
    return {
      sessions: count("SELECT count(*) AS n FROM sessions"),
      units: count("SELECT count(*) AS n FROM units"),
      versions: count("SELECT count(*) AS n FROM versions"),
      chunks: count("SELECT count(*) AS n FROM chunks"),
      bytes: count("SELECT coalesce(sum(size), 0) AS n FROM chunks"),
      stored: count("SELECT coalesce(sum(stored), 0) AS n FROM chunks"),
    }
  }

  /** Reads every chunk back and checks its hash; the chunks that fail. */
  async verify(): Promise<string[]> {
    return this.serially(async () => {
      const failures: string[] = []
      for (const row of this.prepared("SELECT hash, pack, offset, stored, size, codec FROM chunks").iterate()) {
        const entry = ChunkEntrySchema.parse(row)
        const hash = Buffer.from(entry.hash)
        try {
          const bytes = await this.packs.read(entry)
          if (!chunkHash(bytes).equals(hash)) failures.push(`${hash.toString("hex")}: its bytes hash differently`)
        } catch (error) {
          failures.push(`${hash.toString("hex")}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      return failures
    })
  }

  private async serially<T>(work: () => Promise<T>): Promise<T> {
    await this.turns.take()
    try {
      if (this.closed) throw new Error(`The record store at ${this.folder} is closed`)
      return await work()
    } finally {
      this.turns.give()
    }
  }

  private migrate(): "write" | "read" {
    this.db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID")
    const meta = (key: string) => MetaValueSchema.optional().parse(this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key))?.value
    const version = meta("schema")
    const format = readStoreFormat(this.db, "meta")
    const access = storeAccess(format, SCHEMA_VERSION)
    if (access === "read") return "read"
    if (format && access === "refused") throw new NewerStoreError(`the record store at ${this.folder}`, format, SCHEMA_VERSION)
    if (version !== undefined && Number(version) < SCHEMA_VERSION)
      throw new Error(`The record store at ${this.folder} has schema ${version}, from before Mako's first release of it; this build reads ${SCHEMA_VERSION}. Move the folder aside to start a new store.`)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        hash BLOB PRIMARY KEY, pack INTEGER NOT NULL, offset INTEGER NOT NULL,
        stored INTEGER NOT NULL, size INTEGER NOT NULL, codec INTEGER NOT NULL
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS units (
        id INTEGER PRIMARY KEY, harness TEXT NOT NULL, key TEXT NOT NULL, role TEXT NOT NULL,
        head INTEGER NOT NULL DEFAULT -1,
        seen_path TEXT, seen_identity TEXT, seen_mtime REAL, seen_bytes INTEGER, places TEXT,
        UNIQUE (harness, key)
      );
      CREATE TABLE IF NOT EXISTS versions (
        unit INTEGER NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL,
        at INTEGER NOT NULL, size INTEGER NOT NULL, digest BLOB, tail BLOB, chunks BLOB NOT NULL,
        captured_at INTEGER NOT NULL, detail TEXT,
        PRIMARY KEY (unit, seq)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY, harness TEXT NOT NULL, native_id TEXT NOT NULL, layout TEXT, UNIQUE (harness, native_id)
      );
      CREATE TABLE IF NOT EXISTS session_units (session INTEGER NOT NULL, unit INTEGER NOT NULL, PRIMARY KEY (session, unit)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS session_paths (path TEXT PRIMARY KEY, session INTEGER NOT NULL) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS child_paths (path TEXT PRIMARY KEY, session INTEGER NOT NULL) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS child_paths_by_session ON child_paths (session);
      CREATE INDEX IF NOT EXISTS session_units_by_unit ON session_units (unit);
      CREATE TABLE IF NOT EXISTS marks (session INTEGER NOT NULL, name TEXT NOT NULL, fingerprint TEXT NOT NULL, PRIMARY KEY (session, name)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS captures (
        id INTEGER PRIMARY KEY, session INTEGER NOT NULL, at INTEGER NOT NULL,
        versions INTEGER NOT NULL, new_bytes INTEGER NOT NULL, stored_bytes INTEGER NOT NULL, ms INTEGER NOT NULL,
        waited_ms INTEGER NOT NULL, reads INTEGER NOT NULL, longest_read_ms INTEGER NOT NULL, rows_read INTEGER NOT NULL, rows_matched INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS orphans (hash BLOB PRIMARY KEY) WITHOUT ROWID;
    `)
    // Additions: the intent of each capture in progress, the chunks it stored and claimed, and chunks a sweep found unnamed (`record-orphans.ts`).
    // An older build inserts chunks without an intent; the repack's sweep judges those by how long they stay unnamed.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS intents (
        id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, scope TEXT NOT NULL, pid INTEGER NOT NULL, start INTEGER,
        locked INTEGER NOT NULL, session TEXT NOT NULL, began INTEGER NOT NULL, ended INTEGER
      );
      CREATE TABLE IF NOT EXISTS intent_claims (hash BLOB NOT NULL, intent INTEGER NOT NULL, PRIMARY KEY (hash, intent)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS unnamed (hash BLOB PRIMARY KEY, since INTEGER NOT NULL) WITHOUT ROWID;
    `)
    if (!z.object({ name: z.string() }).array().parse(this.db.prepare("PRAGMA table_info(chunks)").all()).some((column) => column.name === "intent"))
      this.db.exec("ALTER TABLE chunks ADD COLUMN intent INTEGER")
    const additions = new Set((meta("additions") ?? "").split(" ").filter(Boolean))
    if (ADDITIONS.some((name) => !additions.has(name)))
      this.db.prepare("INSERT INTO meta (key, value) VALUES ('additions', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run([...new Set([...additions, ...ADDITIONS])].join(" "))
    if (version === undefined) writeStoreFormat(this.db, "meta", { writableBy: SCHEMA_VERSION, readableBy: SCHEMA_VERSION }, this.formatWriter)
    return "write"
  }

  private prepared(sql: string): StatementSync {
    let statement = this.statements.get(sql)
    if (!statement) this.statements.set(sql, statement = this.db.prepare(sql))
    return statement
  }

  private unitByKey(harness: string, key: string): UnitRow | undefined {
    const row = this.prepared("SELECT * FROM units WHERE harness = ? AND key = ?").get(harness, key)
    return row && UnitRowSchema.parse(row)
  }

  private head(unit: { id: number; head: number }): Head | null {
    if (unit.head < 0) return null
    const found = this.prepared("SELECT kind, size, digest, tail FROM versions WHERE unit = ? AND seq = ?").get(unit.id, unit.head)
    if (!found) return null
    const row = HeadRowSchema.parse(found)
    return {
      unit: unit.id, seq: unit.head, kind: row.kind, size: row.size,
      digest: row.digest ? Buffer.from(row.digest) : null,
      tail: row.tail ? Buffer.from(row.tail) : null,
    }
  }

  private sessionId(harness: string, nativeId: string, create: boolean): number | null {
    if (create) this.prepared("INSERT INTO sessions (harness, native_id) VALUES (?, ?) ON CONFLICT DO NOTHING").run(harness, nativeId)
    return IdSchema.optional().parse(this.prepared("SELECT id FROM sessions WHERE harness = ? AND native_id = ?").get(harness, nativeId))?.id ?? null
  }

  private unit(harness: string, key: string, role: UnitRole, session: number): UnitRow {
    this.prepared("INSERT INTO units (harness, key, role) VALUES (?, ?, ?) ON CONFLICT DO NOTHING").run(harness, key, role)
    // SAFETY: the row was inserted just above, or already existed under the same unique key.
    const unit = this.unitByKey(harness, key)!
    this.prepared("INSERT INTO session_units (session, unit) VALUES (?, ?) ON CONFLICT DO NOTHING").run(session, unit.id)
    return unit
  }

  private mark(session: number, name: string): string | undefined {
    return FingerprintSchema.optional().parse(this.prepared("SELECT fingerprint FROM marks WHERE session = ? AND name = ?").get(session, name))?.fingerprint
  }

  private setMark(session: number, name: string, fingerprint: string): void {
    this.prepared("INSERT INTO marks (session, name, fingerprint) VALUES (?, ?, ?) ON CONFLICT (session, name) DO UPDATE SET fingerprint = excluded.fingerprint")
      .run(session, name, fingerprint)
  }

  private clearMark(session: number, name: string): void {
    this.prepared("DELETE FROM marks WHERE session = ? AND name = ?").run(session, name)
  }

  private keysMark(session: number, name: string): KeysMark | null {
    const mark = this.mark(session, name)
    return mark === undefined ? null : KeysMarkSchema.parse(JSON.parse(mark))
  }

  /** The digests of the session's keys in `table`, and its highest rowid, in the current read. Null when a row's key holds a NULL. */
  private keyDigests(source: SourceRead, table: RecordTable, rowid: string, keys: readonly string[], through: bigint | null): { keys: KeyDigests; through: bigint | null } | null {
    const where = table.where ? ` WHERE ${table.where}` : ""
    const sql = `SELECT ${KEY_DIGESTS}(${keyLiteralSql(keys)}, ${quoted(rowid)} <= ?) AS digests, max(${quoted(rowid)}) AS through FROM ${quoted(table.table)}${where}`
    const row = KeyDigestRowSchema.parse(source.statement(sql).get(through, ...(table.params ?? [])))
    return row.digests === null ? null : { keys: KeyDigestsSchema.parse(JSON.parse(row.digests)), through: row.through }
  }

  // The store's write transaction

  private async begin(): Promise<void> {
    this.db.exec("BEGIN IMMEDIATE")
    this.sliceAt = Date.now()
    await this.packs.begin()
  }

  private async commit(): Promise<void> {
    await this.packs.sync()
    if (this.step) await this.step("synced")
    this.db.exec("COMMIT")
  }

  /**
   * Between two slices of a long capture: what it took so far is committed
   * once it has run a while, and anything waiting runs before it goes on. Never
   * called while a harness's database is being read, so a capture that hands
   * over never holds the harness back.
   */
  private async slice(report: CaptureReport): Promise<void> {
    const waiting = this.turns.waiting
    if (!waiting && Date.now() - this.sliceAt < SLICE_MS) return
    await this.commit()
    if (this.step) await this.step("sliced")
    if (waiting) {
      const handed = Date.now()
      this.turns.give()
      await this.turns.take()
      report.waitedMs += Date.now() - handed
      if (this.closed) throw new Error(`The record store at ${this.folder} closed during a capture`)
    }
    await this.begin()
    // A chunk this capture found held in an earlier slice may have been dropped since by a repack, or found unnamed and soon to be: it starts over, and stores or claims it again.
    if (this.generations.get(report) !== this.dropGeneration())
      throw new Error("A repack dropped chunks, or found some unnamed, while this capture ran; it is taken again")
  }

  /** Raised by `forget` and by each repack that drops chunks or finds new unnamed ones (`record-repack.ts`), in the transaction that does it. */
  private dropGeneration(): string {
    return MetaValueSchema.optional().parse(this.prepared("SELECT value FROM meta WHERE key = ?").get(DROPPED))?.value ?? "0"
  }

  /**
   * Drops the chunks no version names, of those `forget` left as candidates,
   * and lays each quiet session's chunks out together in packs of their own
   * (`record-repack.ts`). It reads and copies between turns, and takes the
   * store's turn only to switch the index over.
   */
  repack(options: RepackOptions = {}): Promise<RepackReport> {
    this.writable()
    return repackStore({ folder: this.folder, packs: this.packs, turn: (work) => this.serially(work), format: SCHEMA_VERSION }, options)
  }

  // Capture

  private async captureNow({ harness, nativeId, home, records, path: read, stamp, listing }: CaptureInput): Promise<CaptureReport> {
    checkRoots(records.roots)
    const folders = rootFolders(records.roots)
    const started = Date.now()
    const report: CaptureReport = { versions: [], taken: 0, unchanged: 0, newChunks: 0, newBytes: 0, storedBytes: 0, ms: 0, waitedMs: 0, reads: 0, longestReadMs: 0, rowsRead: 0, rowsMatched: 0 }
    await this.begin()
    this.generations.set(report, this.dropGeneration())
    const intent: CaptureIntent = { session: `${harness} ${nativeId}`, id: null }
    this.intents.set(report, intent)
    try {
      // SAFETY: created just above when it didn't exist.
      const session = this.sessionId(harness, nativeId, true)!
      this.prepared("UPDATE sessions SET layout = ? WHERE id = ?").run(JSON.stringify(layoutOf(home, records)), session)
      if (read) this.prepared("INSERT INTO session_paths (path, session) VALUES (?, ?) ON CONFLICT (path) DO UPDATE SET session = excluded.session").run(read, session)
      // Its child agents' paths, read through it once its harness deletes it; a child the harness drops later keeps its path, and its records' last version.
      for (const child of records.children ?? [])
        if (child !== read) this.prepared("INSERT INTO child_paths (path, session) VALUES (?, ?) ON CONFLICT (path) DO UPDATE SET session = excluded.session WHERE session != excluded.session").run(child, session)
      const seen = new Set<number>()
      for (const path of records.files) {
        const unit = await this.captureFile(harness, session, records, path, report)
        if (unit !== null) seen.add(unit)
        await this.slice(report)
      }
      await this.captureGoneFiles(session, folders, seen, report)
      for (const lines of records.lines ?? []) await this.captureLines(harness, session, records.roots, lines, report)
      for (const database of records.databases) await this.captureDatabase(harness, session, records.roots, database, report)
      report.ms = Date.now() - started - report.waitedMs
      if (report.taken || report.ms >= SLOW_CAPTURE_MS)
        this.prepared("INSERT INTO captures (session, at, versions, new_bytes, stored_bytes, ms, waited_ms, reads, longest_read_ms, rows_read, rows_matched) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(session, started, report.taken, report.newBytes, report.storedBytes, report.ms, report.waitedMs, report.reads, report.longestReadMs, report.rowsRead, report.rowsMatched)
      if (stamp !== undefined) this.setMark(session, HELD_STAMP, stamp)
      if (listing !== undefined) this.setMark(session, LISTING, listing)
      if (records.children) this.setMark(session, CHILDREN_LINKED, "1")
      // Every chunk it stored is named now, with the stamp: the intent goes in the same transaction.
      if (intent.id !== null) this.prepared("DELETE FROM intents WHERE id = ?").run(intent.id)
      if (this.step) await this.step("stamped")
      await this.commit()
      if (this.step) await this.step("committed")
      return report
    } catch (error) {
      // Slices already committed stay: each is true of the records as they were read.
      if (!this.closed && this.db.isTransaction) this.db.exec("ROLLBACK")
      this.endIntent(intent.id)
      throw error
    }
  }

  /**
   * A capture that failed: what it stored and never named is the repack's
   * to drop (`record-orphans.ts`). Still in its turn, right after the
   * rollback, so no other capture's intent can have taken a rolled-back id.
   */
  private endIntent(id: number | null): void {
    if (id === null || this.closed) return
    try {
      this.db.exec("BEGIN IMMEDIATE")
      this.prepared("UPDATE intents SET ended = ? WHERE id = ? AND owner = ? AND ended IS NULL").run(Date.now(), id, this.owner.id)
      this.db.exec("COMMIT")
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK")
      // Left open, it ends with this store's lock, when the store closes or the process does.
      console.warn("A failed capture's intent could not be marked ended", this.folder, error instanceof Error ? error.message : error)
    }
  }

  private async captureFile(harness: string, session: number, records: SessionRecords, path: string, report: CaptureReport): Promise<number | null> {
    const seenPath = qualify(records.roots, path)
    const placed = records.place?.(plainRecordPath(seenPath)) ?? null
    const unit = this.unit(harness, placed?.key ?? plainRecordPath(seenPath), "file", session)
    const info = await statRecord(path)
    if (!info) return null
    if (unit.seen_path === seenPath && unit.seen_identity === info.identity && unit.seen_mtime === info.mtimeMs && unit.seen_bytes === info.bytes && unit.head >= 0) {
      report.unchanged += 1
      return unit.id
    }
    const head = this.head(unit)
    const tail = head && head.kind !== "delete" && info.bytes >= head.size && appendsOnly(seenPath) ? head.tail : null
    if (head && tail && (await tailHash(path, head.size)).equals(tail)) {
      if (info.bytes > head.size) {
        const { chunks } = await this.storeStream(recordChunks(path, head.size, info.bytes), report, true)
        this.addVersion(unit, "append", head.size, info.bytes, null, await tailHash(path, info.bytes), chunks, { path: seenPath })
        countVersion(report, { unit: unit.key, kind: "append", bytes: info.bytes - head.size })
        if (this.step) await this.step("versioned")
      } else report.unchanged += 1
    } else {
      const { chunks, digest, tail } = await this.storeStream(recordChunks(path, 0, info.bytes), report, true)
      if (head && head.kind !== "delete" && head.digest?.equals(digest) && head.size === info.bytes) report.unchanged += 1
      else {
        this.addVersion(unit, "replace", 0, info.bytes, digest, tail, chunks, { path: seenPath })
        countVersion(report, { unit: unit.key, kind: "replace", bytes: info.bytes })
        if (this.step) await this.step("versioned")
      }
    }
    this.prepared("UPDATE units SET seen_path = ?, seen_identity = ?, seen_mtime = ?, seen_bytes = ?, places = ? WHERE id = ?")
      .run(seenPath, info.identity, info.mtimeMs, info.bytes, placed ? JSON.stringify(placed.places) : null, unit.id)
    return unit.id
  }

  /**
   * A file of the session the harness no longer lists is deleted only once
   * it's gone from every place the harness keeps it. A capture runs only
   * while the session exists, so this is the harness moving or dropping one
   * of its files (Grok's folder for another directory), never the session
   * expiring. A stream is Mako's own record of a launch that is over once
   * its file stops growing: the store keeps it whether or not the file is
   * still there.
   */
  private async captureGoneFiles(session: number, folders: ReadonlyMap<string, string>, seen: Set<number>, report: CaptureReport): Promise<void> {
    const units = UnitRowSchema.array().parse(this.prepared(`SELECT u.* FROM session_units su JOIN units u ON u.id = su.unit WHERE su.session = ? AND u.role = 'file'`).all(session))
    for (const unit of units) {
      if (seen.has(unit.id) || unit.head < 0 || !unit.seen_path || unit.seen_path.startsWith(`${STREAMS_ROOT}:`)) continue
      const head = this.head(unit)
      if (!head || head.kind === "delete") continue
      const present = await Promise.all(placements(unit.seen_path, unit.places).map((place) => {
        try {
          return statRecord(placeIn(folders, place))
        } catch {
          // A root the harness no longer declares holds nothing of it.
          return null
        }
      }))
      if (present.some(Boolean)) continue
      this.addVersion(unit, "delete", 0, 0, null, null, Buffer.alloc(0), { path: unit.seen_path })
      countVersion(report, { unit: unit.key, kind: "delete", bytes: 0 })
    }
  }

  /** The session's lines in a shared JSON Lines file, as one unit; the file is read only when it changed. */
  private async captureLines(harness: string, session: number, roots: readonly RecordRoot[], lines: RecordLines, report: CaptureReport): Promise<void> {
    const key = linesUnitKey(qualify(roots, lines.path), lines)
    const info = await stat(lines.path).catch(() => null)
    const fingerprint = info ? `${info.ino}:${info.size}:${info.mtimeMs}` : "missing"
    if (this.mark(session, key) === fingerprint) {
      report.unchanged += 1
      return
    }
    const found = info ? await linesOf(lines.path, lines) : Buffer.alloc(0)
    if (found.length) await this.captureValue(harness, session, key, "lines", found, sha256(found), report)
    else {
      const unit = this.unitByKey(harness, key)
      const head = unit && this.head(unit)
      if (unit && head && head.kind !== "delete") {
        this.addVersion(unit, "delete", 0, 0, null, null, Buffer.alloc(0), null)
        countVersion(report, { unit: key, kind: "delete", bytes: 0 })
      }
    }
    this.setMark(session, key, fingerprint)
  }

  private async captureDatabase(harness: string, session: number, roots: readonly RecordRoot[], database: RecordDatabase, report: CaptureReport): Promise<void> {
    if (!existsSync(database.path)) return
    const name = qualify(roots, database.path)
    // A database neither written nor checkpointed since the last whole capture, asked for the same rows, holds nothing new.
    const fingerprint = await databaseFingerprint(database)
    if (this.mark(session, name) === fingerprint) {
      report.unchanged += 1
      return
    }
    const source = new SourceRead(database.path)
    try {
      const statements = SchemaStatementSchema.array().parse(source.statement("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all()).map((row) => row.sql)
      const userVersion = Number(UserVersionSchema.parse(source.statement("PRAGMA user_version").get()).user_version)
      const schema = Buffer.from(JSON.stringify({ statements, userVersion }))
      const schemaDigest = sha256(schema)
      await this.captureValue(harness, session, `${name}\tschema`, "schema", schema, schemaDigest, report)
      // A migration that adds a column changes every row, rewritten or not, so rows are skipped by key only under the schema this session last read whole.
      const settled = this.mark(session, `${name}\tschema`) === schemaDigest.toString("hex")
      const tables = new Set(TableNameSchema.array().parse(source.statement("SELECT name FROM sqlite_master WHERE type = 'table'").all()).map((row) => row.name))
      for (const table of database.tables) {
        if (tables.has(table.table)) await this.captureTable(harness, session, name, source, table, settled, report)
      }
      // Only a capture that read every table marks the database, so a restore can tell one cut short, and the next capture rereads what this one didn't reach.
      this.setMark(session, `${name}\tschema`, schemaDigest.toString("hex"))
    } finally {
      source.end()
      report.reads += source.reads
      report.longestReadMs = Math.max(report.longestReadMs, source.longestMs)
    }
    this.setMark(session, name, fingerprint)
  }

  /**
   * One table's rows of the session. The rows are listed by where they are
   * in one read, then read whole in reads of their own, each ended before
   * what it read is stored. A row of an immutable table whose key Mako holds
   * is never read whole again while the database's schema is `settled`.
   *
   * Nor, where its position is its rowid, listed again. A capture that took
   * every row it listed, and found none of the session's it didn't list,
   * marks the table with the session's highest rowid and a digest of its
   * keys, both taken in the listing's own read. The next capture, with the
   * schema settled, digests the keys again: the same digest, nothing changed;
   * the same below that rowid, only rows above it, where SQLite puts each new
   * row, are listed. Anything else lists the table as if unmarked.
   */
  private async captureTable(harness: string, session: number, name: string, source: SourceRead, table: RecordTable, settled: boolean, report: CaptureReport): Promise<void> {
    const keys = keyColumns(source.db, table.table)
    const located = positionColumns(source.db, table.table, keys)
    const positions = located?.columns
    const immutable = Boolean(table.immutable && keys.length && settled)
    const params = table.params ?? []
    const rowid = table.immutable && keys.length && located?.rowid ? located.columns[0] : undefined
    const marked = `${name}\tkeys\t${table.table}`
    const mark = this.keysMark(session, marked)
    let digests = immutable && rowid && mark ? this.keyDigests(source, table, rowid, keys, mark.through) : null
    if (mark && digests?.keys.all === mark.keys) {
      report.rowsMatched += digests.keys.rows
      return
    }
    const above = mark && digests?.keys.below === mark.keys ? mark.through : null
    let known = new Map<string, KnownUnit>()
    if (above === null) {
      // A capture cut short leaves no mark for rows it may not have reached.
      if (mark) this.clearMark(session, marked)
      // What the session holds loads with no read open, which would keep the harness from checkpointing meanwhile.
      source.end()
      known = this.known(session, harness, `${name}\trow\t${table.table}\t`, `${name}\trow\t${table.table}\n`)
      // In the read that lists the rows, so the mark names the rows this capture takes; under a schema not yet settled too, when it reads every row whole.
      digests = rowid ? this.keyDigests(source, table, rowid, keys, null) : null
    } else if (digests) report.rowsMatched += digests.keys.rowsBelow
    const conditions: string[] = []
    if (table.where) conditions.push(`(${table.where})`)
    if (above !== null && rowid) conditions.push(`${quoted(rowid)} > ?`)
    const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : ""
    const listParams = above === null ? params : [...params, above]
    let whole = true
    const page: ReadRow[] = []
    let pageBytes = 0
    const read = (row: RecordRow) => {
      report.rowsRead += 1
      const bytes = encodeRow(row)
      page.push({ key: rowUnitKey(name, table.table, keys, row), bytes, digest: sha256(bytes) })
      pageBytes += bytes.length
    }
    const store = async () => {
      source.end()
      pageBytes = 0
      // A page read in 100 ms can take seconds to store: waiting work goes between its rows.
      for (const row of page.splice(0)) {
        await this.captureRow(harness, session, row, known.get(row.key), report)
        await this.slice(report)
      }
    }
    if (!located || !positions) {
      // Its rows can't be found again by position: read as SQLite lists them, in one read, each stored as it comes.
      for (const row of source.statement(`SELECT * FROM ${quoted(table.table)}${where}`).iterate(...listParams)) {
        read({ ...row })
        for (const each of page.splice(0)) await this.captureRow(harness, session, each, known.get(each.key), report)
      }
      pageBytes = 0
    } else {
      // SQLite names a selected rowid after the column aliasing it, so each position is read under a name of its own.
      const named = positions.map((_, index) => `mako_position_${index}`)
      const listed = [...positions.map((column, index) => `${quoted(column)} AS ${named[index]}`), ...(immutable ? keys.map(quoted) : [])]
      const pending = new Listed(located.rowid)
      const listing = source.statement(`SELECT ${listed.join(", ")} FROM ${quoted(table.table)}${where}`, true)
      // Without keys to tell held rows by, positions are kept as the listing reads them, rows as arrays, column N at N, skip an object each.
      if (!immutable) {
        for (const row of listing.iterate(...listParams)) {
          const at = positions.map((_, index) => row[index] ?? null)
          if (at.includes(null)) throw new Error(`A row of ${name} ${table.table} has no position to read it again by (${positions.join(", ")})`)
          pending.push(at)
        }
        if (source.due) source.end()
      }
      // Telling held rows by their keys takes longer than listing them: the read ends first.
      const keyed = immutable ? listing.all(...listParams) : []
      if (immutable) source.end()
      for (const row of keyed) {
        const at = positions.map((_, index) => row[index] ?? null)
        if (keys.every((_, index) => row[positions.length + index] !== null)) {
          const key = rowUnitKey(name, table.table, keys, Object.fromEntries(keys.map((column, index) => [column, row[positions.length + index] ?? null])))
          const have = known.get(key)
          if (have) {
            have.seen = true
            if (have.kind !== "delete") {
              report.unchanged += 1
              continue
            }
          } else {
            const unit = this.unitByKey(harness, key)
            const head = unit && this.head(unit)
            if (head && head.kind !== "delete") {
              // Another session holds the same row, or this one took it in a capture that didn't finish: it's this session's, with nothing to read.
              this.unit(harness, key, "row", session)
              report.unchanged += 1
              continue
            }
          }
        }
        if (at.includes(null)) throw new Error(`A row of ${name} ${table.table} has no position to read it again by (${positions.join(", ")})`)
        pending.push(at)
      }
      // Rows are read FETCH_ROWS positions at a time, so the session's condition (a subquery, for some) is evaluated once per batch, not per row.
      const tuple = positions.length === 1 ? quoted(positions[0] ?? "") : `(${positions.map(quoted).join(", ")})`
      const slot = positions.length === 1 ? "?" : `(${positions.map(() => "?").join(", ")})`
      const fetch = (count: number) => `SELECT *, ${positions.map((column, index) => `${quoted(column)} AS ${named[index]}`).join(", ")} FROM ${quoted(table.table)} ${located.access}
        WHERE ${tuple} IN (${positions.length === 1 ? "" : "VALUES "}${Array.from({ length: count }, () => slot).join(", ")})${table.where ? ` AND (${table.where})` : ""}`
      const spot = (at: readonly RecordValue[]) => JSON.stringify(at.map((value) => tagged(SqlValueSchema.parse(value))))
      let next = 0
      let carried: RecordValue[][] = []
      while (carried.length || next < pending.length) {
        const batch = [...carried, ...pending.slice(next, next + FETCH_ROWS - carried.length)]
        next += batch.length - carried.length
        carried = []
        const done = new Set<string>()
        let cut = false
        for (const row of source.statement(fetch(batch.length)).iterate(...batch.flat(), ...params)) {
          done.add(spot(named.map((column) => row[column] ?? null)))
          read(Object.fromEntries(Object.entries(row).filter(([column]) => !named.includes(column))))
          if (pageBytes >= READ_BYTES || source.due) {
            cut = true
            break
          }
        }
        // What the batch didn't reach goes first in the next read. A position it reached without a row is gone, or no longer the session's: the write that did it brings another capture.
        if (cut) carried = batch.filter((at) => !done.has(spot(at)))
        else if (done.size < batch.length) whole = false
        if (cut || pageBytes >= READ_BYTES || source.due) await store()
      }
    }
    if (page.length) await store()
    if (above === null && await this.captureMissing(harness, session, name, source, table, known, report)) whole = false
    if (digests && digests.through !== null && whole) this.setMark(session, marked, JSON.stringify({ through: String(digests.through), keys: digests.keys.all }))
  }

  /**
   * The table's units this capture didn't list: still the session's (written
   * again under the key after the listing), taken now; still there but
   * another's, no longer this session's; gone, deleted. True when it took one.
   */
  private async captureMissing(harness: string, session: number, name: string, source: SourceRead, table: RecordTable, known: Map<string, KnownUnit>, report: CaptureReport): Promise<boolean> {
    const prefix = `${name}\trow\t${table.table}\t`
    const params = table.params ?? []
    let took = false
    for (const [key, have] of known) {
      if (have.seen || have.kind === "delete" || !key.startsWith(prefix)) continue
      const lookup = rowKeyOf(key)
      const own = source.statement(lookupSql(table.table, lookup.columns, table.where)).get(...lookup.values, ...params)
      if (own) {
        took = true
        report.rowsRead += 1
        const bytes = encodeRow({ ...own })
        await this.captureRow(harness, session, { key, bytes, digest: sha256(bytes) }, have, report)
      } else if (source.statement(lookupSql(table.table, lookup.columns)).get(...lookup.values)) {
        this.prepared("DELETE FROM session_units WHERE session = ? AND unit = ?").run(session, have.id)
      } else {
        this.addVersion(have, "delete", 0, 0, null, null, Buffer.alloc(0), null)
        countVersion(report, { unit: key, kind: "delete", bytes: 0 })
      }
      if (source.due) {
        source.end()
        await this.slice(report)
      }
    }
    return took
  }

  private async captureRow(harness: string, session: number, row: ReadRow, have: KnownUnit | undefined, report: CaptureReport): Promise<void> {
    if (have) {
      have.seen = true
      if (have.kind !== "delete" && have.digest?.equals(row.digest)) {
        report.unchanged += 1
        return
      }
      const chunks = await this.storeValue(row.bytes, report)
      this.addVersion(have, "replace", 0, row.bytes.length, row.digest, null, chunks, null)
      have.kind = "replace"
      have.digest = row.digest
      countVersion(report, { unit: row.key, kind: "replace", bytes: row.bytes.length })
      return
    }
    await this.captureValue(harness, session, row.key, "row", row.bytes, row.digest, report)
  }

  /** The newest version of each of a session's units with keys in [from, to), in one read. */
  private known(session: number, harness: string, from: string, to: string): Map<string, KnownUnit> {
    const known = new Map<string, KnownUnit>()
    for (const row of this.prepared(`
      SELECT u.id, u.key, u.role, u.head, v.kind, v.size, v.digest FROM session_units su JOIN units u ON u.id = su.unit JOIN versions v ON v.unit = u.id AND v.seq = u.head
      WHERE su.session = ? AND u.harness = ? AND u.key >= ? AND u.key < ?`).iterate(session, harness, from, to)) {
      const head = UnitHeadSchema.parse(row)
      known.set(head.key, { id: head.id, head: head.head, kind: head.kind, digest: head.digest ? Buffer.from(head.digest) : null, seen: false })
    }
    return known
  }

  private async captureValue(harness: string, session: number, key: string, role: UnitRole, bytes: Buffer, digest: Buffer, report: CaptureReport): Promise<void> {
    const unit = this.unit(harness, key, role, session)
    const head = this.head(unit)
    if (head && head.kind !== "delete" && head.digest?.equals(digest)) {
      report.unchanged += 1
      return
    }
    const chunks = await this.storeValue(bytes, report)
    this.addVersion(unit, "replace", 0, bytes.length, digest, null, chunks, null)
    countVersion(report, { unit: key, kind: "replace", bytes: bytes.length })
  }

  private addVersion(unit: { id: number; head: number }, kind: VersionKind, at: number, size: number, digest: Buffer | null, tail: Buffer | null, chunks: Buffer, detail: { path: string } | null): void {
    const seq = unit.head + 1
    this.prepared("INSERT INTO versions (unit, seq, kind, at, size, digest, tail, chunks, captured_at, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(unit.id, seq, kind, at, size, digest, tail, chunks, Date.now(), detail ? JSON.stringify(detail) : null)
    this.prepared("UPDATE units SET head = ? WHERE id = ?").run(seq, unit.id)
    unit.head = seq
  }

  /**
   * Chunks a stream of bytes, storing each chunk not yet stored; the chunk
   * list, the whole digest and the tail hash. A long stream is `sliced`: what
   * it stored so far commits, and waiting work runs, between its chunks.
   */
  private async storeStream(source: AsyncIterable<{ bytes: Buffer }> | Iterable<{ bytes: Buffer }>, report: CaptureReport, sliced: boolean): Promise<{ chunks: Buffer; digest: Buffer; tail: Buffer }> {
    const chunker = new Chunker()
    const digest = createHash("sha256")
    const hashes: Buffer[] = []
    let size = 0
    let window: Buffer = Buffer.alloc(0)
    for await (const { bytes } of source) {
      digest.update(bytes)
      size += bytes.length
      window = keepTail(window, bytes)
      for (const chunk of chunker.push(bytes)) await this.storeChunk(chunk, hashes, report, sliced)
    }
    for (const chunk of chunker.end()) await this.storeChunk(chunk, hashes, report, sliced)
    return { chunks: Buffer.concat(hashes), digest: digest.digest(), tail: windowHash(window, size) }
  }

  /** A row, schema or lines version, whose digest the caller took: only its chunk list. */
  private async storeValue(bytes: Buffer, report: CaptureReport): Promise<Buffer> {
    const chunker = new Chunker()
    const hashes: Buffer[] = []
    for (const chunk of [...chunker.push(bytes), ...chunker.end()]) await this.storeChunk(chunk, hashes, report, false)
    return Buffer.concat(hashes)
  }

  private async storeChunk(chunk: Buffer, hashes: Buffer[], report: CaptureReport, sliced: boolean): Promise<void> {
    const hash = chunkHash(chunk)
    hashes.push(hash)
    const held = HeldChunkSchema.optional().parse(this.prepared(`
      SELECT c.intent, EXISTS (SELECT 1 FROM intents i WHERE i.id = c.intent) AS stored, EXISTS (SELECT 1 FROM unnamed u WHERE u.hash = c.hash) AS unnamed
      FROM chunks c WHERE c.hash = ?`).get(hash))
    if (held) {
      // Held, and about to be named again: no longer a candidate for the repack to drop.
      this.prepared("DELETE FROM orphans WHERE hash = ?").run(hash)
      if ((held.stored && held.intent !== this.intents.get(report)?.id) || held.unnamed) await this.claim(hash, held.stored ? held.intent : null, report)
      return
    }
    const intent = await this.intentOf(report)
    const place = await this.packs.write(hash, chunk)
    this.prepared("INSERT INTO chunks (hash, pack, offset, stored, size, codec, intent) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(hash, place.pack, place.offset, place.stored, place.size, place.codec, intent)
    report.newChunks += 1
    report.newBytes += place.size
    report.storedBytes += place.stored
    if (this.step) await this.step("written")
    // Committed before the version naming it, it carries this capture's intent: the repack drops it only once the capture failed or its process is gone.
    if (sliced) await this.slice(report)
  }

  /**
   * This capture's intent (`record-intents.ts`), registered in the open
   * transaction with the first chunk it stores or claims, and this owner's
   * lock taken before it commits.
   */
  private async intentOf(report: CaptureReport): Promise<number> {
    // SAFETY: set by `captureNow` before anything is stored, and every chunk is stored by a capture.
    const intent = this.intents.get(report)!
    if (intent.id !== null) return intent.id
    const locked = await this.owner.locked()
    intent.id = Number(this.prepared("INSERT INTO intents (owner, scope, pid, start, locked, session, began) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(this.owner.id, this.owner.scope, this.owner.pid, this.owner.start, locked ? 1 : 0, intent.session, Date.now()).lastInsertRowid)
    this.intentsTaken += 1
    return intent.id
  }

  /**
   * A held chunk this capture is about to name that another capture stored
   * or claimed (its intent is still there: running, failed or gone), or a
   * sweep found unnamed. Claimed in the transaction that found it: the
   * chunk's intent moves to this capture and the one before stays among its
   * claims, so a repack that read the versions before this capture names
   * the chunk finds it claimed when it judges it.
   */
  private async claim(hash: Buffer, from: number | null, report: CaptureReport): Promise<void> {
    const mine = await this.intentOf(report)
    if (from !== null && from !== mine) this.prepared("INSERT OR IGNORE INTO intent_claims (hash, intent) VALUES (?, ?)").run(hash, from)
    this.prepared("UPDATE chunks SET intent = ? WHERE hash = ?").run(mine, hash)
    this.prepared("DELETE FROM unnamed WHERE hash = ?").run(hash)
  }

  private async *unitContent(unit: number, upTo: number): AsyncGenerator<Buffer> {
    const versions = ContentVersionSchema.array().parse(this.prepared("SELECT seq, kind, chunks FROM versions WHERE unit = ? AND seq <= ? ORDER BY seq").all(unit, upTo))
    let from = 0
    versions.forEach((version, index) => {
      if (version.kind === "replace") from = index
    })
    for (const version of versions.slice(from)) {
      if (version.kind === "delete") continue
      yield* this.chunksOf(Buffer.from(version.chunks))
    }
  }

  /** One version's own bytes: a row, schema or lines version is whole in itself. */
  private versionBytes(unit: number, seq: number): Promise<Buffer> {
    const version = ContentVersionSchema.parse(this.prepared("SELECT seq, kind, chunks FROM versions WHERE unit = ? AND seq = ?").get(unit, seq))
    return collect(this.chunksOf(Buffer.from(version.chunks)))
  }

  private async *chunksOf(list: Buffer): AsyncGenerator<Buffer> {
    const placeOf = (hash: Buffer) => {
      const place = this.prepared("SELECT pack, offset, stored, size, codec FROM chunks WHERE hash = ?").get(hash)
      if (!place) throw new Error(`The chunk ${hash.toString("hex")} is missing from the record store`)
      return ChunkPlaceSchema.parse(place)
    }
    for (let at = 0; at < list.length; at += HASH_BYTES) {
      const hash = list.subarray(at, at + HASH_BYTES)
      const place = placeOf(hash)
      let bytes: Buffer
      try {
        bytes = await this.packs.read(place)
      } catch (error) {
        // A repack may have moved the chunk and removed its pack between the lookup and the read: its new place is in the index.
        const moved = placeOf(hash)
        if (moved.pack === place.pack && moved.offset === place.offset) throw error
        await this.packs.drop(place.pack)
        bytes = await this.packs.read(moved)
      }
      yield bytes
    }
  }

  private lastContentSeq(unit: number): number {
    return NewestSeqSchema.parse(this.prepared("SELECT max(seq) AS seq FROM versions WHERE unit = ? AND kind != 'delete'").get(unit)).seq ?? -1
  }

  /** The size a file unit has as of its last version holding content. */
  private contentSize(unit: number): number {
    const versions = SizedVersionSchema.array().parse(this.prepared("SELECT kind, size FROM versions WHERE unit = ? ORDER BY seq").all(unit))
    let size = 0
    for (const version of versions) if (version.kind !== "delete") size = version.size
    return size
  }

  // Restore

  private async restoreNow(input: RestoreInput): Promise<RestoreReport> {
    const { harness, nativeId } = input
    const found = SessionRowSchema.optional().parse(this.prepared("SELECT id, layout FROM sessions WHERE harness = ? AND native_id = ?").get(harness, nativeId))
    if (!found?.layout) throw new Error(`Mako holds no records of ${harness} session ${nativeId}`)
    const session = found.id
    const layout = SessionLayoutSchema.parse(JSON.parse(found.layout))
    const places = new RootPlaces({ home: layout.home, roots: new Map(Object.entries(layout.roots)) }, { home: input.home, roots: input.roots ?? input.destination?.roots })
    const report: RestoreReport = { actions: [], rows: [], diverged: places.missing.map(({ root, reason }) => ({ unit: `${root}:`, reason })), kept: [], movedPaths: 0, written: false }
    if (report.diverged.length) return report

    let plan = await this.planRestore(input, session, layout, places, report, null)
    let forkPlan: ForkPlan | null = null
    // Only a destination that went on pays for the fork's ids: every unit's newest version, read once.
    const owners = input.fork && report.diverged.length && !plan.incomplete ? this.forkOwners(input.fork, harness, nativeId, session, places) : null
    if (owners) {
      const own = await this.ownDiverged(owners, harness, places, report, plan.destinationRows)
      if (own.unknown.length) report.diverged.push(...own.unknown)
      else if (!own.units.length) {
        // Only units no single session owns went on here: they stay as the destination has them, and the session restores in place.
        report.kept.push(...report.diverged.splice(0))
      } else {
        const fresh: RestoreReport = { ...report, actions: [], rows: [], diverged: [], kept: [], movedPaths: 0 }
        plan = await this.planRestore(input, session, layout, places, fresh, owners)
        // What diverges now is shared, and stays as the destination has it; a unit the rule doesn't know keeps the session from forking.
        fresh.kept.push(...fresh.diverged.filter((entry) => entry.reason !== UNKNOWN_TO_FORK))
        fresh.diverged = fresh.diverged.filter((entry) => entry.reason === UNKNOWN_TO_FORK)
        Object.assign(report, fresh)
        if (!report.diverged.length) forkPlan = await this.planFork(owners, places, plan.own, own.units, report)
      }
    }
    if (report.diverged.length || report.fork?.diverged.length || input.dryRun) return report
    if (await input.held?.()) {
      report.diverged.push({ unit: nativeId, reason: "Something on this machine holds the session open" })
      return report
    }
    // Several files at a time: each waits on its own sync, which is most of restoring a session of many small files (its subagents' transcripts).
    // A file left out is there by its first line, which is what a reader listing it reads (a rollout's meta); the rest follows when it's restored.
    const files = [
      ...plan.files.flatMap((unit) => {
        const filePlan = plan.filePlans.get(unit.id)
        return filePlan ? [() => this.applyFile(unit, filePlan)] : []
      }),
      ...plan.deferred.flatMap(({ unit, target }) => (existsSync(target) ? [] : [() => this.writeHead(unit, target)])),
    ]
    let next = 0
    await Promise.all(Array.from({ length: Math.min(FILES_AT_ONCE, files.length) }, async () => {
      for (let write = files[next++]; write; write = files[next++]) await write()
    }))
    for (const linePlan of plan.linePlans) await this.applyLines(linePlan)
    for (const [name, rowPlan] of plan.rowPlans) await this.applyDatabase(places, name, rowPlan)
    if (forkPlan && report.fork) await this.applyFork(owners!, places, forkPlan, report.fork)
    report.written = wrote(report) || Boolean(report.fork?.written)
    return report
  }

  /**
   * What a restore writes to the session's own place: its files, lines and
   * rows as the destination lacks them. With the fork rule (`own`), units it
   * calls the session's own are left out and listed for the fork instead,
   * and the destination isn't checked for units Mako never saw: those are
   * the destination's own turns, which the fork leaves.
   */
  private async planRestore(input: RestoreInput, session: number, layout: SessionLayout, places: RootPlaces, report: RestoreReport, own: ForkOwners | null): Promise<RestorePlan> {
    const plan: RestorePlan = { files: [], filePlans: new Map(), linePlans: [], rowPlans: new Map(), incomplete: false, own: { files: [], lines: [], rows: [] }, destinationRows: new Map(), deferred: [] }
    plan.files = UnitRowSchema.array().parse(this.prepared("SELECT u.* FROM session_units su JOIN units u ON u.id = su.unit WHERE su.session = ? AND u.role = 'file' ORDER BY u.key").all(session))
    for (const unit of plan.files) {
      if (!unit.seen_path || this.lastContentSeq(unit.id) < 0) continue
      const rule = own?.file(unit.seen_path)
      if (rule === null) {
        report.diverged.push({ unit: unit.key, reason: UNKNOWN_TO_FORK })
        continue
      }
      if (rule && rule !== "shared") {
        plan.own.files.push({ unit, rule })
        continue
      }
      // A file its harness deleted is planned as one: nothing is written for it, deferred or not.
      const target = input.files && this.head(unit)?.kind !== "delete" && places.place(plainRecordPath(unit.seen_path))
      if (target && !input.files?.(target)) {
        (report.deferred ??= []).push(target)
        plan.deferred.push({ unit, target })
        continue
      }
      const filePlan = await this.planFile(places, unit, report)
      if (filePlan) plan.filePlans.set(unit.id, filePlan)
    }
    const lines = UnitHeadSchema.array().parse(this.prepared(`
      SELECT u.id, u.key, u.role, u.head, v.kind, v.size, v.digest FROM session_units su JOIN units u ON u.id = su.unit JOIN versions v ON v.unit = u.id AND v.seq = u.head
      WHERE su.session = ? AND u.role = 'lines' ORDER BY u.key`).all(session))
    for (const unit of lines) {
      if (own?.linesOwn(unit.key)) {
        plan.own.lines.push(unit)
        continue
      }
      const linePlan = await this.planLines(places, unit, report)
      if (linePlan) plan.linePlans.push(linePlan)
    }
    const databases = TableNameSchema.array().parse(this.prepared(`
      SELECT DISTINCT substr(u.key, 1, instr(u.key, char(9)) - 1) AS name FROM session_units su JOIN units u ON u.id = su.unit
      WHERE su.session = ? AND u.role IN ('row', 'schema') ORDER BY name`).all(session)).map((row) => row.name)
    for (const name of databases) {
      if (!this.mark(session, name)) {
        plan.incomplete = true
        report.diverged.push({ unit: name, reason: "Mako's first capture of this database never finished, so it holds only part of the session's rows" })
        continue
      }
      const forkRows = own ? this.forkRows(own, places, layout, name) : null
      try {
        plan.rowPlans.set(name, await this.planDatabase(input.harness, session, places, name, layout.paths[name] ?? {}, report, forkRows))
      } finally {
        forkRows?.close()
      }
      if (forkRows && (forkRows.plan.rows.length || forkRows.plan.tallies.length || forkRows.plan.diverged.length)) plan.own.rows.push(forkRows.plan)
    }
    if (input.destination && !own) this.checkDestination(input.destination, new Set([...plan.files.map((unit) => unit.key), ...this.sessionKeys(session)]), report, input.fork ? plan.destinationRows : null)
    return plan
  }

  // Forks

  /**
   * How the fork rule sorts this session's units: the fork's id and every
   * id derived for it come from the arriving version (each unit's newest
   * version) and where the restore places the roots, so the same restore
   * again names the same fork.
   */
  private forkOwners(fork: RecordFork, harness: string, nativeId: string, session: number, places: RootPlaces): ForkOwners {
    const hash = createHash("sha256").update(`mako fork 1\n${harness}\n${nativeId}\n`)
    for (const [name, folder] of [...places.folders].sort(([left], [right]) => left.localeCompare(right))) hash.update(`${name}\t${folder}\n`)
    for (const row of this.prepared(`
      SELECT u.key, v.kind, v.size, coalesce(v.digest, v.tail) AS digest FROM session_units su JOIN units u ON u.id = su.unit JOIN versions v ON v.unit = u.id AND v.seq = u.head
      WHERE su.session = ? ORDER BY u.key`).iterate(session)) {
      const version = ForkSeedSchema.parse(row)
      hash.update(`${version.key}\t${version.kind}\t${version.size}\t`).update(version.digest ?? new Uint8Array()).update("\n")
    }
    const seed = hash.digest()
    const to = fork.id(seed, nativeId)
    if (to === nativeId) throw new Error(`The fork rule for ${harness} gave the fork the session's own id ${nativeId}`)
    const ids = forkIds(seed, nativeId, to)
    const renamed = new Map<string, string>()
    const database = (name: string) => {
      let named = renamed.get(name)
      if (named === undefined) renamed.set(name, named = fork.database?.(name, ids) ?? name)
      return named
    }
    const rules = new Map<string, ForkRow | "shared" | null>()
    const tableRule = (name: string, table: string) => {
      const key = `${name}\t${table}`
      if (!rules.has(key)) rules.set(key, fork.table(name, table, ids))
      return rules.get(key) ?? null
    }
    const rowOf = (name: string, table: string, row: RecordRow): { row: RecordRow } | "shared" | null => {
      const rule = tableRule(name, table)
      if (rule === null) return null
      const moved = database(name) !== name
      if (rule === "shared") return moved ? { row } : "shared"
      const forked = rule(row)
      return forked === "shared" ? (moved ? { row } : "shared") : { row: forked }
    }
    return {
      fork, ids, database, rowOf,
      file: (path) => fork.file(plainRecordPath(path), ids),
      linesOwn: (key) => {
        const [, , encoded = "{}"] = key.split("\t")
        return Object.values(LinesKeySchema.parse(JSON.parse(encoded))).includes(nativeId)
      },
      rowOwn: async (name, table, unit) => {
        const rule = tableRule(name, table)
        if (rule === null) return "unknown"
        if (database(name) !== name) return { row: null, same: rule === "shared" }
        if (rule === "shared" || unit.kind === "delete") return "shared"
        const forked = rule(decodeRow(await this.versionBytes(unit.id, unit.head)))
        return forked === "shared" ? "shared" : { row: forked, same: false }
      },
    }
  }

  /** The diverged units the fork would hold, with what each shares with the arriving version; and units the rule doesn't know, which keep the session from forking. */
  private async ownDiverged(owners: ForkOwners, harness: string, places: RootPlaces, report: RestoreReport, destinationRows: ReadonlyMap<string, RecordRow>): Promise<{ units: { unit: string; shared: number }[]; unknown: { unit: string; reason: string }[] }> {
    const units: { unit: string; shared: number }[] = []
    const unknown: { unit: string; reason: string }[] = []
    const unrecognized = (unit: string) => unknown.push({ unit, reason: UNKNOWN_TO_FORK })
    for (const { unit: key } of report.diverged) {
      const parts = key.split("\t")
      const captured = this.unitByKey(harness, key)
      if (parts[1] === "lines") {
        if (owners.linesOwn(key)) units.push({ unit: key, shared: 0 })
      } else if (parts[1] === "row") {
        const table = parts[2] ?? ""
        const head = captured && this.head(captured)
        const seq = head?.kind === "delete" ? this.lastContentSeq(captured!.id) : captured?.head
        const row = captured && seq !== undefined && seq >= 0 ? decodeRow(await this.versionBytes(captured.id, seq)) : destinationRows.get(key)
        const found = row ? owners.rowOf(parts[0] ?? "", table, row) : null
        if (found === null) unrecognized(key)
        else if (found !== "shared") units.push({ unit: key, shared: 0 })
      } else {
        const rule = owners.file(captured?.seen_path ?? key)
        if (rule === null) unrecognized(key)
        else if (rule !== "shared") units.push({ unit: key, shared: captured ? await this.sharedBytes(places, captured) : 0 })
      }
    }
    return { units, unknown }
  }

  /** How many bytes from the start the destination's copy of a file shares with Mako's newest version, cut back to a line's end in a transcript. */
  private async sharedBytes(places: RootPlaces, unit: UnitRow): Promise<number> {
    // SAFETY: only a unit planFile compared, which has a seen path, reaches here.
    const path = unit.seen_path!
    for (const place of placements(path, unit.places)) {
      const at = places.place(place)
      const info = await statRecord(at)
      if (!info) continue
      let shared = 0
      let lineEnd = 0
      const ours = this.unitContent(unit.id, this.lastContentSeq(unit.id))
      let pending: Buffer = Buffer.alloc(0)
      compare: for await (const { bytes } of recordChunks(at, 0, info.bytes)) {
        let offset = 0
        while (offset < bytes.length) {
          if (!pending.length) {
            const next = await ours.next()
            if (next.done) break compare
            pending = next.value
          }
          const take = Math.min(pending.length, bytes.length - offset)
          let same = 0
          while (same < take && pending[same] === bytes[offset + same]) same++
          const newline = pending.subarray(0, same).lastIndexOf(0x0a)
          if (newline !== -1) lineEnd = shared + newline + 1
          shared += same
          if (same < take) break compare
          pending = pending.subarray(take)
          offset += take
        }
      }
      await ours.return(undefined)
      return appendsOnly(path) ? lineEnd : shared
    }
    return 0
  }

  /**
   * The fork's rows of one database, sorted as `planDatabase` reads the
   * session's: each own row is looked up where the fork keeps it, by the
   * columns that name it there, and is new there, already there as the fork
   * has it, or there otherwise (the fork went on). A database the fork keeps
   * apart (`RecordFork.database`) that doesn't exist yet takes every row
   * without a lookup or a read.
   */
  private forkRows(owners: ForkOwners, places: RootPlaces, layout: SessionLayout, name: string): ForkRowsPlanner {
    const forkName = owners.database(name)
    const target = places.place(forkName)
    const db = existsSync(target) ? openReadOnly(target, { timeout: 5_000 }).database : null
    const moves = places.moving ? layout.paths[name] ?? {} : {}
    const plan: ForkDatabasePlan = { name, forkName, schema: this.schemaUnit(name), rows: [], moves, tallies: [], diverged: [] }
    const tables = new Map<string, { lookup: StatementSync; columns: string[]; alias: string | null } | null>()
    const tallies = new Map<string, RestoreRows>()
    const tableOf = (table: string) => {
      if (!tables.has(table)) {
        const present = db && TableNameSchema.optional().parse(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table))
        if (!present) tables.set(table, null)
        else {
          const { columns, alias } = forkIdentity(db, table)
          tables.set(table, { lookup: lookupStatement(db, table, columns), columns, alias })
        }
      }
      return tables.get(table) ?? null
    }
    const owns = async (unit: z.infer<typeof UnitHeadSchema>, table: string): Promise<"own" | "shared" | "unknown"> => {
      const owner = await owners.rowOwn(name, table, unit)
      if (owner === "unknown" || owner === "shared") return owner
      if (unit.kind === "delete") return "own"
      let rows = tallies.get(table)
      if (!rows) tallies.set(table, rows = { path: forkName, table, insert: 0, replace: 0, delete: 0, skip: 0, bytes: 0 })
      const existing = tableOf(table)
      const key = owner.same && existing && !existing.alias && !moves[table]?.length ? rowKeyOf(unit.key) : null
      if (existing && key && key.columns.join("\n") === existing.columns.join("\n")) {
        // A row the fork holds as it is: found by its own key, and compared by the digest its version keeps, without reading it.
        const found = existing.lookup.get(...key.values)
        if (found) {
          if (unit.digest && sha256(encodeRow({ ...found })).equals(Buffer.from(unit.digest))) rows.skip += 1
          else plan.diverged.push({ unit: `${forkName}\t${table}\t${unit.key.split("\t")[3] ?? ""}`, reason: FORK_WENT_ON })
          return "own"
        }
      } else if (existing) {
        const forked = moveRow(places, owner.row ?? await this.forkRow(owners, name, table, unit.id, unit.head), moves[table] ?? [])
        const found = existing.lookup.get(...existing.columns.map((column) => forked[column] ?? null))
        if (found) {
          const present: RecordRow = { ...found }
          if (existing.alias) {
            delete present[existing.alias]
            delete forked[existing.alias]
          }
          if (sha256(encodeRow(present)).equals(sha256(encodeRow(forked)))) rows.skip += 1
          else plan.diverged.push({ unit: `${forkName}\t${table}\t${JSON.stringify(existing.columns.map((column) => tagged(SqlValueSchema.parse(forked[column] ?? null))))}`, reason: FORK_WENT_ON })
          return "own"
        }
      }
      rows.insert += 1
      rows.bytes += unit.size
      plan.rows.push({ id: unit.id, head: unit.head, table })
      return "own"
    }
    return {
      plan, owns,
      close: () => {
        db?.close()
        plan.tallies = [...tallies.values()]
      },
    }
  }

  /**
   * The fork's rows with those of a table keyed by a rowid alias in the order
   * of the session's own numbers: the destination numbers them anew, in the
   * order they're written, as the harness numbered them. `aliases` is filled
   * with each table's alias as the destination declares it.
   */
  private inRowidOrder(db: DatabaseSync, rows: ForkDatabasePlan["rows"], aliases: Map<string, string | null>): ForkDatabasePlan["rows"] {
    const order = new Map<number, bigint>()
    for (const row of rows) {
      if (!aliases.has(row.table)) aliases.set(row.table, forkIdentity(db, row.table).alias)
      if (!aliases.get(row.table)) continue
      const [value] = rowKeyOf(KeySchema.parse(this.prepared("SELECT key FROM units WHERE id = ?").get(row.id)).key).values
      order.set(row.id, BigIntSchema.catch(0n).parse(value))
    }
    if (!order.size) return rows
    // Table by table, as they came; within a numbered table, by the session's numbers.
    const tables = new Map<string, ForkDatabasePlan["rows"]>()
    for (const row of rows) {
      const list = tables.get(row.table)
      if (list) list.push(row)
      else tables.set(row.table, [row])
    }
    const number = (row: ForkDatabasePlan["rows"][number]) => order.get(row.id) ?? 0n
    return [...tables.values()].flatMap((list) => (aliases.get(list[0]!.table) ? [...list].sort((left, right) => (number(left) < number(right) ? -1 : number(left) > number(right) ? 1 : 0)) : list))
  }

  /** A row of the session as the fork holds it, read from its version. */
  private async forkRow(owners: ForkOwners, name: string, table: string, id: number, head: number): Promise<RecordRow> {
    const row = decodeRow(await this.versionBytes(id, head))
    const forked = owners.rowOf(name, table, row)
    return forked !== null && forked !== "shared" && forked.row ? forked.row : row
  }

  /** The schema unit of a database, as the store names it. */
  private schemaUnit(name: string): { id: number; head: number } | null {
    const unit = UnitHeadSchema.optional().parse(this.prepared(`
      SELECT u.id, u.key, u.role, u.head, v.kind, v.size, v.digest FROM units u JOIN versions v ON v.unit = u.id AND v.seq = u.head
      WHERE u.key >= ? AND u.key < ? AND u.role = 'schema' LIMIT 1`).get(`${name}\t`, `${name}\n`))
    return unit ? { id: unit.id, head: unit.head } : null
  }

  /** The fork's files and lines: written where the destination has none, skipped where it holds them as the fork has them. */
  private async planFork(owners: ForkOwners, places: RootPlaces, own: OwnUnits, from: { unit: string; shared: number }[], report: RestoreReport): Promise<ForkPlan> {
    const fork: RestoreFork = { nativeId: owners.ids.to, from, actions: [], rows: [], diverged: [], written: false }
    report.fork = fork
    const plan: ForkPlan = { files: [], lines: [], databases: own.rows }
    for (const { unit, rule } of own.files) {
      const record = (action: RestoreActionKind, bytes: number) => fork.actions.push({ unit: unit.key, action, path: rule.path, bytes })
      if (this.head(unit)?.kind === "delete") {
        record("skip", 0)
        continue
      }
      const target = places.place(rule.path)
      const existing = (await statRecord(target)) ? target : (await statRecord(`${target}.zst`)) ? `${target}.zst` : null
      if (!existing) {
        record("write", this.contentSize(unit.id))
        plan.files.push({ unit, rule, target })
      } else if (await sameBytes(this.forkContent(unit, rule), recordChunks(existing, 0, Number.MAX_SAFE_INTEGER))) record("skip", 0)
      else fork.diverged.push({ unit: rule.path, reason: FORK_WENT_ON })
    }
    for (const unit of own.lines) {
      const [name = "", , encoded = "{}"] = unit.key.split("\t")
      const [field = ""] = Object.keys(LinesKeySchema.parse(JSON.parse(encoded)))
      const rule = owners.file(name)
      if (rule === null || rule === "shared") {
        report.diverged.push({ unit: unit.key, reason: UNKNOWN_TO_FORK })
        continue
      }
      const record = (action: RestoreActionKind, bytes: number) => fork.actions.push({ unit: unit.key, action, path: rule.path, bytes })
      if (unit.kind === "delete") {
        record("skip", 0)
        continue
      }
      const ours = await collect(forkLines([await this.versionBytes(unit.id, unit.head)], rule.line ?? ((line) => line)))
      const target = places.place(rule.path)
      const theirs = existsSync(target) ? await linesOf(target, { field, value: owners.ids.to }) : Buffer.alloc(0)
      if (theirs.equals(ours)) record("skip", 0)
      else if (theirs.length) fork.diverged.push({ unit: unit.key, reason: FORK_WENT_ON })
      else {
        record("append", ours.length)
        plan.lines.push({ target, bytes: ours })
      }
    }
    for (const database of own.rows) {
      fork.rows.push(...database.tallies)
      fork.diverged.push(...database.diverged)
    }
    return plan
  }

  /** A file unit's newest bytes as the fork holds them. */
  private async *forkContent(unit: UnitRow, rule: ForkFile): AsyncGenerator<Buffer> {
    const source = this.unitContent(unit.id, this.lastContentSeq(unit.id))
    if (rule.whole) yield rule.whole(await collect(source))
    else if (rule.line) yield* forkLines(source, rule.line)
    else yield* source
  }

  private async applyFork(owners: ForkOwners, places: RootPlaces, plan: ForkPlan, fork: RestoreFork): Promise<void> {
    for (const { unit, rule, target } of plan.files) {
      await mkdir(dirname(target), { recursive: true })
      const temporary = `${target}.mako-restore-${process.pid}`
      const handle = await open(temporary, "w")
      let size = 0
      try {
        for await (const chunk of this.forkContent(unit, rule)) {
          await handle.write(chunk)
          size += chunk.length
        }
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temporary, target)
      const action = fork.actions.find((candidate) => candidate.unit === unit.key)
      if (action) action.bytes = size
    }
    for (const lines of plan.lines) await this.applyLines(lines)
    for (const database of plan.databases) await this.applyForkRows(owners, places, database)
    fork.written = fork.actions.some((action) => action.action !== "skip") || fork.rows.some((rows) => rows.insert > 0)
  }

  /** The fork's new rows of one database, in one transaction; a rowid alias is left for the destination to give, since the session's copy holds the same numbers. */
  private async applyForkRows(owners: ForkOwners, places: RootPlaces, plan: ForkDatabasePlan): Promise<void> {
    if (!plan.rows.length) return
    const target = places.place(plan.forkName)
    await mkdir(dirname(target), { recursive: true })
    const db = this.writer.openForWriting(target)
    db.exec(`PRAGMA busy_timeout = ${WRITE_BUSY_TIMEOUT_MS}`)
    db.exec("PRAGMA foreign_keys = OFF")
    db.exec("BEGIN IMMEDIATE")
    try {
      if (plan.schema) {
        const { statements, userVersion } = SchemaSnapshotSchema.parse(JSON.parse((await this.versionBytes(plan.schema.id, plan.schema.head)).toString("utf8")))
        const has = db.prepare("SELECT 1 FROM sqlite_master WHERE sql = ?")
        for (const statement of statements) if (!has.get(statement)) db.exec(statement)
        const current = Number(UserVersionSchema.parse(db.prepare("PRAGMA user_version").get()).user_version)
        if (current === 0 && userVersion !== 0) db.exec(`PRAGMA user_version = ${Math.trunc(userVersion)}`)
      }
      const aliases = new Map<string, string | null>()
      const statements = new Map<string, StatementSync>()
      for (const row of this.inRowidOrder(db, plan.rows, aliases)) {
        const alias = aliases.get(row.table) ?? null
        const values = moveRow(places, await this.forkRow(owners, plan.name, row.table, row.id, row.head), plan.moves[row.table] ?? [])
        if (alias) delete values[alias]
        const names = Object.keys(values)
        // A row the plan found missing that is there now (a trigger of the harness's added it, or the harness itself meanwhile) stays as it is.
        const sql = `INSERT INTO ${quoted(row.table)} (${names.map(quoted).join(", ")}) VALUES (${names.map(() => "?").join(", ")}) ON CONFLICT DO NOTHING`
        let statement = statements.get(sql)
        if (!statement) statements.set(sql, statement = db.prepare(sql))
        if (Number(statement.run(...names.map((column) => values[column] ?? null)).changes) === 0) {
          const tally = plan.tallies.find((rows) => rows.table === row.table)
          if (tally) {
            tally.insert -= 1
            tally.skip += 1
          }
        }
      }
      db.exec("COMMIT")
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK")
      throw error
    } finally {
      db.close()
    }
  }

  /** Every row, schema and lines key of a session, for comparing with what a destination holds. */
  private sessionKeys(session: number): string[] {
    return KeySchema.array().parse(this.prepared("SELECT u.key FROM session_units su JOIN units u ON u.id = su.unit WHERE su.session = ? AND u.role != 'file'").all(session)).map((row) => row.key)
  }

  /**
   * A file as its newest version has it. One the harness has since dropped
   * from the session is left out, and taken out of a destination that still
   * holds a version of it Mako knows.
   */
  private async planFile(places: RootPlaces, unit: UnitRow, report: RestoreReport): Promise<FilePlan | null> {
    // SAFETY: the caller passes only units with a seen path.
    const path = unit.seen_path!
    const size = this.contentSize(unit.id)
    const target = places.place(plainRecordPath(path))
    let existing: string | undefined
    let info: Awaited<ReturnType<typeof statRecord>> = null
    for (const place of placements(path, unit.places)) {
      info = await statRecord(places.place(place))
      if (info) {
        existing = places.place(place)
        break
      }
    }
    const record = (action: RestoreActionKind, bytes: number) => report.actions.push({ unit: unit.key, action, path: plainRecordPath(path), bytes })
    const dropped = this.head(unit)?.kind === "delete"
    if (!existing || !info) {
      if (dropped) {
        record("skip", 0)
        return null
      }
      record("write", size)
      return { action: "write", target, from: 0 }
    }
    if (info.bytes > size) {
      report.diverged.push({ unit: unit.key, reason: `The destination holds ${info.bytes} bytes; Mako's newest version has ${size}` })
      return null
    }
    if (!(await this.prefixMatches(unit.id, existing, info.bytes))) {
      report.diverged.push({ unit: unit.key, reason: `The destination's ${info.bytes} bytes differ from Mako's version` })
      return null
    }
    if (dropped) {
      record("delete", 0)
      return { action: "delete", target: existing, from: 0 }
    }
    if (info.bytes === size) {
      record("skip", 0)
      return null
    }
    if (info.encoding === "plain") {
      record("append", size - info.bytes)
      return { action: "append", target: existing, from: info.bytes }
    }
    record("write-plain", size)
    return { action: "write-plain", target, from: 0, existing }
  }

  /** A file's first line, at most `HEAD_BYTES` of it, where it goes. */
  private async writeHead(unit: UnitRow, target: string): Promise<void> {
    const parts: Buffer[] = []
    let held = 0
    for await (const chunk of this.unitContent(unit.id, this.lastContentSeq(unit.id))) {
      const end = chunk.indexOf(0x0a)
      const piece = end === -1 ? chunk : chunk.subarray(0, end + 1)
      parts.push(piece)
      held += piece.length
      if (end !== -1 || held >= HEAD_BYTES) break
    }
    const head = Buffer.concat(parts, held)
    const line = head.indexOf(0x0a)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, line === -1 ? Buffer.alloc(0) : head.subarray(0, line + 1))
  }

  /** Whether the destination's first `length` bytes are the store's. */
  private async prefixMatches(unit: number, path: string, length: number): Promise<boolean> {
    if (length === 0) return true
    const ours = this.unitContent(unit, this.lastContentSeq(unit))
    let pending: Buffer = Buffer.alloc(0)
    for await (const { bytes } of recordChunks(path, 0, length)) {
      let offset = 0
      while (offset < bytes.length) {
        if (!pending.length) {
          const next = await ours.next()
          if (next.done) return false
          pending = next.value
        }
        const take = Math.min(pending.length, bytes.length - offset)
        if (!pending.subarray(0, take).equals(bytes.subarray(offset, offset + take))) return false
        pending = pending.subarray(take)
        offset += take
      }
    }
    await ours.return(undefined)
    return true
  }

  private async applyFile(unit: UnitRow, plan: FilePlan): Promise<void> {
    if (plan.action === "delete") {
      await rm(plan.target, { force: true })
      return
    }
    const seq = plan.seq ?? this.lastContentSeq(unit.id)
    if (plan.action === "append") {
      const handle = await open(plan.target, "a")
      try {
        const { size } = await handle.stat()
        if (size !== plan.from) throw new Error(`${plan.target} changed while restoring: ${size} bytes, expected ${plan.from}`)
        let at = 0
        for await (const chunk of this.unitContent(unit.id, seq)) {
          const end = at + chunk.length
          if (end > plan.from) await handle.write(chunk.subarray(Math.max(0, plan.from - at)))
          at = end
        }
        await handle.sync()
      } finally {
        await handle.close()
      }
      return
    }
    await mkdir(dirname(plan.target), { recursive: true })
    const temporary = `${plan.target}.mako-restore-${process.pid}`
    const handle = await open(temporary, "w")
    try {
      for await (const chunk of this.unitContent(unit.id, seq)) await handle.write(chunk)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, plan.target)
    if (plan.existing && plan.existing !== plan.target) await rm(plan.existing, { force: true })
  }

  /** A session's lines go at the end of the destination's file, after whatever of them it already holds; lines it holds that Mako never saw mean it went on there. */
  private async planLines(places: RootPlaces, unit: z.infer<typeof UnitHeadSchema>, report: RestoreReport): Promise<LinesPlan | null> {
    const [name = "", , encoded = "{}"] = unit.key.split("\t")
    const [[field = "", value = ""] = []] = Object.entries(LinesKeySchema.parse(JSON.parse(encoded)))
    const target = places.place(name)
    const record = (action: RestoreActionKind, bytes: number) => report.actions.push({ unit: unit.key, action, path: name, bytes })
    if (unit.kind === "delete") {
      record("skip", 0)
      return null
    }
    const ours = await this.versionBytes(unit.id, unit.head)
    const theirs = existsSync(target) ? await linesOf(target, { field, value }) : Buffer.alloc(0)
    if (theirs.equals(ours)) {
      record("skip", 0)
      return null
    }
    if (theirs.length > ours.length || !ours.subarray(0, theirs.length).equals(theirs)) {
      report.diverged.push({ unit: unit.key, reason: "The destination holds lines of the session Mako never captured" })
      return null
    }
    record("append", ours.length - theirs.length)
    return { target, bytes: ours.subarray(theirs.length) }
  }

  private async applyLines(plan: LinesPlan): Promise<void> {
    await mkdir(dirname(plan.target), { recursive: true })
    const handle = await open(plan.target, "a+")
    try {
      const { size } = await handle.stat()
      const last = Buffer.alloc(1)
      if (size > 0) await handle.read(last, 0, 1, size - 1)
      await handle.write(size > 0 && last[0] !== 0x0a ? Buffer.concat([Buffer.from("\n"), plan.bytes]) : plan.bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  /**
   * Each row and the schema of one database, as the destination should hold
   * them. Values naming a path in one of the session's roots are compared,
   * and written, as they are where the root goes.
   */
  private async planDatabase(
    harness: string, session: number, places: RootPlaces, name: string, paths: Record<string, string[]>, report: RestoreReport,
    forking: { owns: (unit: z.infer<typeof UnitHeadSchema>, table: string) => Promise<"own" | "shared" | "unknown"> } | null = null
  ): Promise<DatabasePlan> {
    const path = places.place(name)
    const db = existsSync(path) ? openReadOnly(path, { timeout: 5_000 }).database : null
    const moving = places.moving && Object.keys(paths).length > 0
    const plan: DatabasePlan = { schema: null, rows: [], moves: moving ? paths : {} }
    const lookups = new Map<string, StatementSync>()
    const tallies = new Map<string, RestoreRows>()
    try {
      const tables = new Set(db ? TableNameSchema.array().parse(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).map((row) => row.name) : [])
      for (const row of this.prepared(`
        SELECT u.id, u.key, u.role, u.head, v.kind, v.size, v.digest FROM session_units su JOIN units u ON u.id = su.unit JOIN versions v ON v.unit = u.id AND v.seq = u.head
        WHERE su.session = ? AND u.harness = ? AND u.key >= ? AND u.key < ? ORDER BY u.key`).iterate(session, harness, `${name}\t`, `${name}\n`)) {
        const unit = UnitHeadSchema.parse(row)
        if (unit.role === "schema") {
          plan.schema = { id: unit.id, head: unit.head }
          continue
        }
        const key = rowKeyOf(unit.key)
        if (forking) {
          // A fork's own rows go to the fork; a shared row is only ever added or brought up to date, never deleted.
          const owner = await forking.owns(unit, key.table)
          if (owner === "unknown") report.diverged.push({ unit: unit.key, reason: UNKNOWN_TO_FORK })
          if (owner !== "shared" || unit.kind === "delete") continue
        }
        const moves = movesOf(plan, key.table)
        let present: RecordRow | undefined
        if (db && tables.has(key.table)) {
          const sql = `${key.table}\n${key.columns.join("\n")}`
          let lookup = lookups.get(sql)
          if (!lookup) lookups.set(sql, lookup = lookupStatement(db, key.table, key.columns))
          const found = lookup.get(...movedKey(places, key, moves))
          present = found && { ...found }
        }
        // The newest version as the destination would hold it, read only when a value in it may move.
        const newest = moves && unit.kind !== "delete" ? decodeRow(await this.versionBytes(unit.id, unit.head)) : null
        const moved = newest && moves ? moveRow(places, newest, moves) : null
        const action = await (async (): Promise<"skip" | "insert" | "replace" | "delete" | null> => {
          if (!present) return unit.kind === "delete" ? "skip" : "insert"
          const digest = sha256(encodeRow(present))
          const expected = unit.kind === "delete" ? null : moved ? sha256(encodeRow(moved)) : unit.digest && Buffer.from(unit.digest)
          if (expected?.equals(digest)) return "skip"
          if (!(await this.knownVersion(unit.id, digest, moves ? (bytes) => sha256(encodeRow(moveRow(places, decodeRow(bytes), moves))) : null))) return null
          return unit.kind === "delete" ? "delete" : "replace"
        })()
        if (action === null) report.diverged.push({ unit: unit.key, reason: "The destination's row differs from every version Mako captured" })
        else {
          let rows = tallies.get(key.table)
          if (!rows) tallies.set(key.table, rows = { path: name, table: key.table, insert: 0, replace: 0, delete: 0, skip: 0, bytes: 0 })
          rows[action] += 1
          if (action === "insert" || action === "replace") rows.bytes += unit.size
          if (action !== "skip") {
            plan.rows.push({ id: unit.id, head: unit.head, delete: action === "delete" })
            if (newest && moved) report.movedPaths += Object.keys(newest).filter((column) => newest[column] !== moved[column]).length
          }
        }
      }
    } finally {
      db?.close()
    }
    report.rows.push(...tallies.values())
    return plan
  }

  /** Whether `digest` is the digest of a version Mako captured, as the destination would hold it. */
  private async knownVersion(unit: number, digest: Buffer, as: ((bytes: Buffer) => Buffer) | null): Promise<boolean> {
    if (!as) return Boolean(this.prepared("SELECT 1 FROM versions WHERE unit = ? AND digest = ?").get(unit, digest))
    for (const { seq } of SeqSchema.array().parse(this.prepared("SELECT seq FROM versions WHERE unit = ? AND kind = 'replace' ORDER BY seq DESC").all(unit)))
      if (as(await this.versionBytes(unit, seq)).equals(digest)) return true
    return false
  }

  private async applyDatabase(places: RootPlaces, name: string, plan: DatabasePlan): Promise<void> {
    if (!plan.rows.length) return
    const target = places.place(name)
    await mkdir(dirname(target), { recursive: true })
    const db = this.writer.openForWriting(target)
    // The harness may be running and writing the same database; its write lock is waited for, then held for the whole restore.
    db.exec(`PRAGMA busy_timeout = ${WRITE_BUSY_TIMEOUT_MS}`)
    // Rows arrive table by table, children before parents, and replacing a parent row must not cascade into rows already restored.
    db.exec("PRAGMA foreign_keys = OFF")
    db.exec("BEGIN IMMEDIATE")
    try {
      if (plan.schema) {
        const { statements, userVersion } = SchemaSnapshotSchema.parse(JSON.parse((await this.versionBytes(plan.schema.id, plan.schema.head)).toString("utf8")))
        const has = db.prepare("SELECT 1 FROM sqlite_master WHERE sql = ?")
        // A virtual table creates its shadow tables itself, and a home that already holds the store keeps its schema.
        for (const statement of statements) if (!has.get(statement)) db.exec(statement)
        const current = Number(UserVersionSchema.parse(db.prepare("PRAGMA user_version").get()).user_version)
        if (current === 0 && userVersion !== 0) db.exec(`PRAGMA user_version = ${Math.trunc(userVersion)}`)
      }
      // One statement per table and set of columns, however many rows use it.
      const statements = new Map<string, StatementSync>()
      const statement = (sql: string) => {
        let prepared = statements.get(sql)
        if (!prepared) statements.set(sql, prepared = db.prepare(sql))
        return prepared
      }
      for (const row of plan.rows) {
        const key = rowKeyOf(KeySchema.parse(this.prepared("SELECT key FROM units WHERE id = ?").get(row.id)).key)
        const moves = movesOf(plan, key.table)
        if (row.delete) {
          statement(`DELETE FROM ${quoted(key.table)} WHERE ${key.columns.map((column) => `${quoted(column)} IS ?`).join(" AND ")}`).run(...movedKey(places, key, moves))
          continue
        }
        const decoded = decodeRow(await this.versionBytes(row.id, row.head))
        const values = moves ? moveRow(places, decoded, moves) : decoded
        const names = Object.keys(values)
        statement(`INSERT OR REPLACE INTO ${quoted(key.table)} (${names.map(quoted).join(", ")}) VALUES (${names.map(() => "?").join(", ")})`)
          .run(...names.map((column) => values[column] ?? null))
      }
      db.exec("COMMIT")
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK")
      throw error
    } finally {
      db.close()
    }
  }

  /** A file or owned row at the destination that Mako never captured means the session went on there. */
  private checkDestination(destination: SessionRecords, known: Set<string>, report: RestoreReport, rows: Map<string, RecordRow> | null): void {
    for (const path of destination.files) {
      const key = fileUnitKey(destination, path)
      if (!known.has(key)) report.diverged.push({ unit: key, reason: "The destination holds a file of the session Mako never captured" })
    }
    for (const database of destination.databases) {
      if (!existsSync(database.path)) continue
      const name = qualify(destination.roots, database.path)
      const { database: db } = openReadOnly(database.path, { timeout: 5_000 })
      try {
        const tables = new Set(TableNameSchema.array().parse(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).map((row) => row.name))
        for (const table of database.tables) {
          if (!tables.has(table.table)) continue
          const keys = keyColumns(db, table.table)
          const statement = db.prepare(`SELECT * FROM ${quoted(table.table)}${table.where ? ` WHERE ${table.where}` : ""}`)
          statement.setReadBigInts(true)
          for (const row of statement.iterate(...(table.params ?? []))) {
            const key = rowUnitKey(name, table.table, keys, { ...row })
            if (known.has(key)) continue
            report.diverged.push({ unit: key, reason: "The destination holds a row of the session Mako never captured" })
            rows?.set(key, { ...row })
          }
        }
      } finally {
        db.close()
      }
    }
  }
}

interface FilePlan {
  action: "write" | "append" | "write-plain" | "delete"
  /** Where it's written; for an append or a delete, the file there now. */
  target: string
  from: number
  /** A compressed copy the plain one replaces. */
  existing?: string
  /** The version written; the newest holding content by default. */
  seq?: number
}

interface LinesPlan {
  target: string
  bytes: Buffer
}

interface DatabasePlan {
  schema: { id: number; head: number } | null
  /** Each row to write or delete by its unit and newest version, its key read again when it's written: a session can own millions. */
  rows: { id: number; head: number; delete: boolean }[]
  /** Path columns by table, moved as the plan compared them. */
  moves: Record<string, string[]>
}

/** What a restore writes to the session's own place, and, when forking, the units it leaves for the fork. */
interface RestorePlan {
  files: UnitRow[]
  filePlans: Map<number, FilePlan>
  linePlans: LinesPlan[]
  rowPlans: Map<string, DatabasePlan>
  /** A database whose first capture never finished: the session can't be restored whole, nor forked. */
  incomplete: boolean
  own: OwnUnits
  /** Rows the destination holds that Mako never captured, by unit key, so the fork rule can say whose they are. */
  destinationRows: Map<string, RecordRow>
  /** Files `RestoreInput.files` left out, with where each would go. */
  deferred: { unit: UnitRow; target: string }[]
}

interface OwnUnits {
  files: { unit: UnitRow; rule: ForkFile }[]
  lines: z.infer<typeof UnitHeadSchema>[]
  rows: ForkDatabasePlan[]
}

/** The fork rule as the restore asks it, with the fork's ids. */
interface ForkOwners {
  fork: RecordFork
  ids: ForkIds
  /** Where the fork keeps a database's rows. */
  database(name: string): string
  file(path: string): ForkFile | "shared" | null
  /** Whether a lines unit names the session itself. */
  linesOwn(key: string): boolean
  /** A row as the fork holds it, or whose it is when that isn't the fork's. */
  rowOf(name: string, table: string, row: RecordRow): { row: RecordRow } | "shared" | null
  /** A row unit's owner from its newest version, and the row as the fork holds it when reading it told; null when the row needn't be read to know. */
  rowOwn(name: string, table: string, unit: z.infer<typeof UnitHeadSchema>): Promise<{ row: RecordRow | null; same: boolean } | "shared" | "unknown">
}

interface ForkPlan {
  files: { unit: UnitRow; rule: ForkFile; target: string }[]
  lines: LinesPlan[]
  databases: ForkDatabasePlan[]
}

interface ForkDatabasePlan {
  /** The database as the session's rows name it, and where the fork's go. */
  name: string
  forkName: string
  schema: { id: number; head: number } | null
  /** Each row the fork lacks, by its unit and newest version, read again when it's written. */
  rows: { id: number; head: number; table: string }[]
  moves: Record<string, string[]>
  tallies: RestoreRows[]
  diverged: { unit: string; reason: string }[]
}

interface ForkRowsPlanner {
  plan: ForkDatabasePlan
  owns(unit: z.infer<typeof UnitHeadSchema>, table: string): Promise<"own" | "shared" | "unknown">
  close(): void
}

const UNKNOWN_TO_FORK = "The harness's fork rule doesn't know this unit, so the session can't be forked"
const FORK_WENT_ON = "The destination holds the fork with other content: it went on there too, so it's left as it is"

/** Whether a restore wrote anything to the session's own place. */
const wrote = (report: RestoreReport) => report.actions.some((action) => action.action !== "skip") || report.rows.some((rows) => rows.insert + rows.replace + rows.delete > 0)

/** Whether two byte streams hold the same bytes. */
async function sameBytes(left: AsyncIterable<Buffer>, right: AsyncIterable<{ bytes: Buffer }>): Promise<boolean> {
  const theirs = right[Symbol.asyncIterator]()
  let pending: Buffer = Buffer.alloc(0)
  try {
    for await (const ours of left) {
      let offset = 0
      while (offset < ours.length) {
        if (!pending.length) {
          const next = await theirs.next()
          if (next.done) return false
          pending = next.value.bytes
        }
        const take = Math.min(pending.length, ours.length - offset)
        if (!pending.subarray(0, take).equals(ours.subarray(offset, offset + take))) return false
        pending = pending.subarray(take)
        offset += take
      }
    }
    if (pending.length) return false
    return Boolean((await theirs.next()).done)
  } finally {
    await theirs.return?.(undefined)
  }
}

// Keys

/** A file's unit key: the one its harness gives it wherever it files it, else its plain path as the store names it. */
export function fileUnitKey(records: Pick<SessionRecords, "place" | "roots">, path: string): string {
  const plain = plainRecordPath(qualify(records.roots, path))
  return records.place?.(plain)?.key ?? plain
}

/** Where a file unit may be now, in every encoding: where it was last seen, then every place its harness files it. */
function placements(seenPath: string, places: string | null): string[] {
  const filed = places ? PlacesSchema.parse(JSON.parse(places)) : []
  return [...new Set([plainRecordPath(seenPath), ...filed])].flatMap((place) => [place, `${place}.zst`])
}

function linesUnitKey(name: string, lines: Pick<RecordLines, "field" | "value">): string {
  return `${name}\tlines\t${JSON.stringify({ [lines.field]: lines.value })}`
}

function layoutOf(home: string, records: SessionRecords): SessionLayout {
  const paths: SessionLayout["paths"] = {}
  for (const database of records.databases) {
    const declared = database.tables.filter((table) => table.paths?.length)
    if (declared.length) paths[qualify(records.roots, database.path)] = Object.fromEntries(declared.map((table) => [table.table, table.paths ?? []]))
  }
  return { home, roots: Object.fromEntries(records.roots.map((root) => [root.name, root.path])), paths }
}

// Moving paths

function movedValue(places: RootPlaces, value: RecordValue): RecordValue {
  const text = z.string().safeParse(value)
  return text.success ? places.moved(text.data) : value
}

function movesOf(plan: DatabasePlan, table: string): string[] | null {
  const columns = plan.moves[table]
  return columns?.length ? columns : null
}

/** A row key's values as the destination holds them. */
function movedKey(places: RootPlaces, key: RowKey, moves: readonly string[] | null): RecordValue[] {
  return moves ? key.values.map((value, index) => (moves.includes(key.columns[index] ?? "") ? movedValue(places, value) : value)) : key.values
}

function moveRow(places: RootPlaces, row: RecordRow, columns: readonly string[]): RecordRow {
  const moved = { ...row }
  for (const column of columns) if (column in moved) moved[column] = movedValue(places, moved[column] ?? null)
  return moved
}

// Files and lines

async function databaseFingerprint(database: RecordDatabase): Promise<string> {
  const files = await Promise.all(["", "-wal"].map(async (suffix) => {
    const info = await stat(`${database.path}${suffix}`).catch(() => null)
    return info ? [info.ino, info.size, info.mtimeMs] : null
  }))
  const tables = database.tables.map((table) => [table.table, table.where ?? null, (table.params ?? []).map((param) => tagged(SqlValueSchema.parse(param))), table.immutable ?? false])
  return sha256(Buffer.from(JSON.stringify([files, tables]))).toString("hex")
}

/** The lines of a JSON Lines file whose `field` is `value`, each as its own bytes and a newline, in the file's order. */
async function linesOf(path: string, { field, value }: Pick<RecordLines, "field" | "value">): Promise<Buffer> {
  const matching = z.object({ [field]: z.literal(value) })
  const needle = Buffer.from(JSON.stringify(value))
  const found: Buffer[] = []
  let rest: Buffer = Buffer.alloc(0)
  const take = (line: Buffer) => {
    if (!line.includes(needle)) return
    try {
      if (matching.safeParse(JSON.parse(line.toString("utf8"))).success) found.push(line, NEWLINE)
    } catch {
      // A line the harness is still writing, or one that isn't JSON, is no session's.
    }
  }
  for await (const piece of createReadStream(path)) {
    const bytes: Buffer = rest.length ? Buffer.concat([rest, piece]) : piece
    let start = 0
    for (let end = bytes.indexOf(0x0a, start); end !== -1; end = bytes.indexOf(0x0a, start)) {
      take(bytes.subarray(start, end))
      start = end + 1
    }
    rest = Buffer.from(bytes.subarray(start))
  }
  return Buffer.concat(found)
}

const NEWLINE = Buffer.from("\n")

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest()

async function collect(source: AsyncIterable<Buffer>): Promise<Buffer> {
  const parts: Buffer[] = []
  for await (const part of source) parts.push(part)
  return Buffer.concat(parts)
}

/** A transcript the harness only ever appends to, so a capture can take just the new bytes. */
const appendsOnly = (path: string) => /\.(?:jsonl|ndjson)$/.test(plainRecordPath(path))

function keepTail(window: Buffer, bytes: Buffer): Buffer {
  if (bytes.length >= TAIL_BYTES) return Buffer.from(bytes.subarray(bytes.length - TAIL_BYTES))
  const joined = Buffer.concat([window, bytes])
  return joined.length > TAIL_BYTES ? joined.subarray(joined.length - TAIL_BYTES) : joined
}

function windowHash(window: Buffer, size: number): Buffer {
  return createHash("sha256").update(`${size}\n`).update(window).digest()
}

/** The hash of the bytes just before `size`, which a rewrite of the transcript changes. */
async function tailHash(path: string, size: number): Promise<Buffer> {
  let window: Buffer = Buffer.alloc(0)
  for await (const { bytes } of recordChunks(path, Math.max(0, size - TAIL_BYTES), size)) window = keepTail(window, bytes)
  return windowHash(window, size)
}
