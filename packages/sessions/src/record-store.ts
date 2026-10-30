import { createHash } from "node:crypto"
import { createReadStream, existsSync, mkdirSync } from "node:fs"
import { mkdir, open, rename, rm, stat, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, sep } from "node:path"
import { DatabaseSync as DatabaseSyncConstructor, type DatabaseSync, type StatementSync } from "node:sqlite"
import { z } from "zod"
import { checkStoredChunk, Chunker, chunkHash, HASH_BYTES, Packs, type StoredChunk } from "./record-chunks.js"
import { planRecordImport, recordChunks as versionChunks, type HeldUnit, type RecordBundle, type RecordHoldings, type RecordUnit, type RecordVersion } from "@mako/protocol/records"
import { plainRecordPath, recordChunks, recordFilePath, statRecord } from "./record-files.js"
import type { ForkFile, ForkIds, ForkRow, RecordDatabase, RecordFork, RecordLines, RecordRoot, RecordRow, RecordTable, RecordValue, SessionRecords } from "./harness-records.js"
import { forkIds, forkLines } from "./record-fork.js"
import { checkRoots, placeIn, qualify, RootPlaces, rootFolders } from "./record-roots.js"
import {
  decodeRow, encodeRow, forkIdentity, type ForkIdentity, rowIdentity, KEY_DIGESTS, type KeyDigests, KeyDigestsSchema, keyColumns, keyLiteralSql, lookupSql, lookupStatement, positionColumns, type RowKey, quoted, registerKeyDigests, rowKeyOf, rowUnitKey,
  SqlValueSchema, tagged,
} from "./record-rows.js"
import { openReadOnly, type NativeStores } from "./read-only-sqlite.js"
import { declareStoreFormat, guardStoreWrites, inspectStoreFormat, NewerStoreError, readStoreFormat, storeAccess, writeStoreFormat, type StoreStanding } from "./store-format.js"
import { STREAMS_ROOT } from "./record-streams.js"
import { DROPPED, repackStore, type RepackOptions, type RepackReport } from "./record-repack.js"
import { IntentOwner } from "./record-intents.js"
import { EVIDENCE_RULES, givenVersion, mergeWriters, outdatedOf, restoreGate, STREAM_RUNTIME_SCAN, writersOf, type InstalledReading, type OutdatedRuntime, type RecordWriter, type RecordWriterRule, type SessionWriters, SessionWritersSchema, type WriterEvidence, type WriterScan, type WriterSource } from "./record-writers.js"
import type { RecordRef } from "./entries.js"
import { namesBuild } from "./runtime-version.js"

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
const SCHEMA_VERSION = 3
/**
 * The oldest format whose builds can read the store. Format 3 names a row's unit by what its table says names it
 * (`keyColumns`: Devin's `(session_id, node_id)`), where format 2 named some by their rowid; a format-2 build reads
 * either, and writes only its own names, which is why it may read but not write.
 */
const READS_VERSION = 2
/** The first format Mako released: a store from before it is moved aside. */
const RELEASED_SCHEMA = 2
/** Every table of the store, each guarded against an older build's writes once the format is raised (`guardStoreWrites`). */
const RECORD_TABLES = ["chunks", "units", "versions", "sessions", "session_units", "session_paths", "child_paths", "marks", "captures", "orphans", "intents", "intent_claims", "unnamed", "remote_units", "remote_sessions", "remote_session_units", "remote_pushed", "meta"] as const
/** Additive changes this build made to the format, each a name in `meta.additions`; a build that doesn't know one ignores what it added. */
const ADDITIONS = ["writers", "children", "intents", "remotes", "remote-sessions", "remote-pushed"]
/** Each session's newest capture by `<harness>\n<native id>` (`RecordStore.captureHeads`), and the newest capture of all. */
export type CaptureHeads = { heads: Map<string, number>; through: number }
/** One batch of `RecordStore.exportFor`: at most `limit` versions, from the unit after `cursor`. */
export type ExportPage = { limit?: number; cursor?: number }
/** A unit as an export reads it, with what a remote is known to hold of it. */
const ExportUnitSchema = z.object({ id: z.number(), key: z.string(), role: z.enum(["file", "row", "schema", "lines"]), head: z.number(), seen_path: z.string().nullable(), places: z.string().nullable(), held: z.number().nullable() })
/** A version's columns as an export reads them. */
const EXPORT_VERSION_COLUMNS = {
  seq: z.number(), kind: z.enum(["append", "replace", "delete"]), at: z.number(), size: z.number(),
  digest: z.instanceof(Uint8Array).nullable(), tail: z.instanceof(Uint8Array).nullable(), chunks: z.instanceof(Uint8Array),
  detail: z.string().nullable(), writer: z.string().nullable(), writer_source: z.enum(["record", "observed"]).nullable(),
}
const ExportVersionSchema = z.object(EXPORT_VERSION_COLUMNS)
/** A version and its unit, as one batch of `RecordStore.exportFor` reads them together. */
const ExportRowSchema = ExportUnitSchema.omit({ held: true }).extend(EXPORT_VERSION_COLUMNS)

/** A version as it crosses to another store: its bytes in hex. */
function exportedVersion(version: z.infer<typeof ExportVersionSchema>): RecordVersion {
  const hex = (bytes: Uint8Array | null) => (bytes ? Buffer.from(bytes).toString("hex") : null)
  return {
    seq: version.seq, kind: version.kind, at: version.at, size: version.size, digest: hex(version.digest), tail: hex(version.tail),
    chunks: Buffer.from(version.chunks).toString("hex"), detail: version.detail, writer: version.writer, writerSource: version.writer_source,
  }
}
/** The most of a deferred file's first line a restore writes (`RestoreInput.files`). */
const HEAD_BYTES = 1024 * 1024
/** How many files a restore writes at once. */
const FILES_AT_ONCE = 8
/** Rows a restore's plan reads at once for the columns they hold: each read is a small one of a pack, mostly waiting. */
const ROWS_READ_AT_ONCE = 16
/** The most of those rows' bytes a plan keeps for its write, which reads the rest again. */
const ROW_BYTES_KEPT = 64 * 1024 * 1024
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
/** The mark (`marks`) that keeps every version that wrote the session (`SessionWriters`), as its versions' `writer` columns say. */
const WRITERS = "writers"
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
   * The rail's row for the session (a `ThreadRef`, as JSON), kept with the
   * capture: once the harness deletes the session, the catalog lists it from
   * this and reads it back from the store. Asked as the capture commits, not
   * as it's asked for: one that waited behind another capture of the session
   * doesn't put back a row the catalog has since moved or stopped listing
   * (null keeps the row the store has).
   */
  listing?: () => string | null
  /**
   * The harness version observed writing the session as this capture runs,
   * for a write heard as it landed (`observedInstall`): stamped, as
   * `observed`, on each version this capture takes whose bytes state no
   * version of their own. A backfill gives none: it reads what was written
   * long ago, by whichever build was installed then.
   */
  observed?: string
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
  /** The harness versions the versions taken were stamped with, by where each is known from. */
  writers: { record: string[]; observed: string[] }
}

/** What `importSession` took: versions added, versions it already held, and the chunks it stored. */
export interface ImportReport {
  versions: number
  held: number
  chunks: number
  /** Bytes once decoded, and as stored. */
  bytes: number
  storedBytes: number
  ms: number
  /** Time waiting for the store's turn before the import began. */
  queuedMs?: number
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
   * The version of the harness installed where the session goes. Records go
   * only into the same version or a newer one (`restoreGate`): when this is
   * older than the newest version that wrote them, nothing is written and
   * the report says so (`RestoreReport.outdated`). Unset, or a version
   * that's unknown, blocks nothing; Mako's own private homes, which no
   * harness resumes from, give none. A reading with when its binary was put
   * there lets a session nothing names the writer of go into an install
   * provably at least as new (`restoreGate`).
   */
  installed?: string | InstalledReading | null
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
  /**
   * The destination's harness is older than the newest version that wrote
   * the records (`RestoreInput.installed`), or its store has no column for
   * one the rows hold (`OutdatedRuntime.lacks`): nothing was written.
   */
  outdated?: OutdatedRuntime
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

/**
 * Every harness version that wrote the session the catalog read at `path`
 * (`RecordStore.writers`), read without writing: what the host's continuation
 * plan weighs against the installed version before it offers a restore.
 * Null when the store holds no session at `path`; a store an older build
 * made, with no writers, names none.
 */
export function recordWritersAt(folder: string, path: string): { harness: string; nativeId: string; writers: SessionWriters } | null {
  const file = join(folder, "records.sqlite")
  if (!existsSync(file)) return null
  const { database } = openReadOnly(file, { timeout: 5_000 })
  try {
    const session = z.object({ id: z.number(), harness: z.string(), nativeId: z.string() }).optional().parse(database.prepare(`
      SELECT s.id, s.harness, s.native_id AS nativeId FROM session_paths p JOIN sessions s ON s.id = p.session WHERE p.path = ?`).get(path))
    if (!session) return null
    const kept = FingerprintSchema.optional().parse(database.prepare("SELECT fingerprint FROM marks WHERE session = ? AND name = ?").get(session.id, WRITERS))
    return { harness: session.harness, nativeId: session.nativeId, writers: kept ? SessionWritersSchema.parse(JSON.parse(kept.fingerprint)) : { record: [], observed: [] } }
  } finally {
    database.close()
  }
}

/**
 * Which harness version wrote the bytes an entry names (`Entry.record`),
 * read from a record store without writing: what counts an unread record
 * by version (`unread-index.ts`). A session one version wrote takes that
 * version whole; one several wrote (its harness was updated mid-session)
 * takes the version that captured the bytes at the record's first offset,
 * or a row's newest version. Null where the store doesn't hold the session
 * or nothing stated or observed a version: never a guess.
 */
/** Where the record store in `folder` stands for this build, read without writing: for Settings › Diagnostics. */
export function recordStoreStanding(folder: string): StoreStanding {
  const format = inspectStoreFormat(join(folder, "records.sqlite"), "meta")
  return format ? { access: storeAccess(format, SCHEMA_VERSION), build: SCHEMA_VERSION, format } : { access: "write", build: SCHEMA_VERSION }
}

export class RecordWriterLookup {
  private readonly db: DatabaseSync
  private readonly sessions = new Map<string, LookupSession | null>()

  constructor(folder: string) {
    this.db = openReadOnly(join(folder, "records.sqlite"), { timeout: 5_000 }).database
  }

  writerOf(harness: string, nativeId: string, sessionPath: string, record: RecordRef | null): RecordWriter | null {
    const session = this.session(harness, nativeId)
    if (!session) return null
    if (session.writers.length <= 1) return session.writers[0] ?? null
    const file = recordFilePath(sessionPath, record ?? {})
    let name: string
    try {
      name = qualify(session.roots, plainRecordPath(file))
    } catch {
      // Read back from a copy elsewhere, or a file under no root the capture named.
      return null
    }
    const row = record?.rows?.[0]
    if (row) {
      const unit = this.db.prepare("SELECT id FROM units WHERE harness = ? AND key = ?").get(harness, rowUnitKey(name, row.table, Object.keys(row.key), row.key))
      return unit ? this.newestWriter(Number(unit["id"])) : null
    }
    const unit = session.files.get(name)
    if (unit === undefined) return null
    const offset = record?.ranges?.[0]?.[0] ?? 0
    let owner: RecordWriter | null = null
    for (const version of WriterVersionSchema.array().parse(this.db.prepare("SELECT kind, at, size, writer, writer_source FROM versions WHERE unit = ? ORDER BY seq").all(unit))) {
      const covers = version.kind === "replace" ? offset < version.size : version.kind === "append" && version.at <= offset && offset < version.size
      if (covers) owner = version.writer && version.writer_source ? { version: version.writer.split(" ").at(-1)!, source: version.writer_source } : null
    }
    return owner
  }

  /** The newest version that could have written a session nothing names the writer of, where its harness's evidence bounds it (`WriterEvidence.upTo`). */
  upToOf(harness: string, nativeId: string): string | null {
    return this.session(harness, nativeId)?.upTo ?? null
  }

  /** What sets that bound (`WriterEvidence.bound`). */
  boundOf(harness: string, nativeId: string): WriterEvidence["bound"] | null {
    return this.session(harness, nativeId)?.bound ?? null
  }

  close(): void {
    if (this.db.isOpen) this.db.close()
  }

  private session(harness: string, nativeId: string): LookupSession | null {
    const key = `${harness}\n${nativeId}`
    if (this.sessions.has(key)) return this.sessions.get(key) ?? null
    const found = z.object({ id: z.number(), layout: z.string().nullable() }).optional().parse(this.db.prepare("SELECT id, layout FROM sessions WHERE harness = ? AND native_id = ?").get(harness, nativeId))
    let session: LookupSession | null = null
    if (found) {
      const kept = FingerprintSchema.optional().parse(this.db.prepare("SELECT fingerprint FROM marks WHERE session = ? AND name = ?").get(found.id, WRITERS))
      const parsed = kept ? SessionWritersSchema.parse(JSON.parse(kept.fingerprint)) : null
      const writers = writersOf(parsed)
      const layout = found.layout ? SessionLayoutSchema.parse(JSON.parse(found.layout)) : null
      const files = new Map<string, number>()
      if (writers.length > 1)
        for (const unit of z.object({ id: z.number(), seen_path: z.string().nullable() }).array().parse(this.db.prepare("SELECT u.id, u.seen_path FROM session_units su JOIN units u ON u.id = su.unit WHERE su.session = ? AND u.role = 'file'").all(found.id)))
          if (unit.seen_path) files.set(plainRecordPath(unit.seen_path), unit.id)
      session = { writers, roots: Object.entries(layout?.roots ?? {}).map(([name, path]) => ({ name, path })), files, ...parsed?.evidence?.source === "range" && parsed.evidence.upTo && { upTo: parsed.evidence.upTo, ...parsed.evidence.bound && { bound: parsed.evidence.bound } } }
    }
    this.sessions.set(key, session)
    return session
  }

  private newestWriter(unit: number): RecordWriter | null {
    const row = z.object({ writer: z.string().nullable(), writer_source: z.enum(["record", "observed"]).nullable() }).optional()
      .parse(this.db.prepare("SELECT writer, writer_source FROM versions WHERE unit = ? AND writer IS NOT NULL ORDER BY seq DESC LIMIT 1").get(unit))
    return row?.writer && row.writer_source ? { version: row.writer.split(" ").at(-1)!, source: row.writer_source } : null
  }
}

interface LookupSession {
  writers: RecordWriter[]
  roots: RecordRoot[]
  /** Each file unit by its plain path as the store names it, for a session several versions wrote. */
  files: Map<string, number>
  upTo?: string
  bound?: WriterEvidence["bound"]
}

const WriterVersionSchema = z.object({ kind: VersionKindSchema, at: z.number(), size: z.number(), writer: z.string().nullable(), writer_source: z.enum(["record", "observed"]).nullable() })

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
const UnitKeySchema = z.object({ id: z.number(), key: z.string() })
const CapturedAtSchema = z.object({ captured_at: z.number() })
const UnitHeadSchema = z.object({ id: z.number(), key: z.string(), role: UnitRoleSchema, head: z.number(), kind: VersionKindSchema, size: z.number(), digest: Blob.nullable() })
const HeadRowSchema = z.object({ kind: VersionKindSchema, size: z.number(), digest: Blob.nullable(), tail: Blob.nullable() })
const VersionRowSchema = z.object({
  seq: z.number(), kind: VersionKindSchema, at: z.number(), size: z.number(), chunkBytes: z.number(), captured_at: z.number(), digest: Blob.nullable(),
  writer: z.string().nullable(), writer_source: z.enum(["record", "observed"]).nullable(),
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
const WriterRowSchema = z.object({ writer: z.string() })
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
const SchemaObjectSchema = z.object({ name: z.string(), sql: z.string().nullable() })

/**
 * The object a schema statement creates, as `sqlite_master` names it. SQLite keeps each statement normalized
 * (`CREATE <kind> <name>`, no `IF NOT EXISTS`, no schema qualifier), so the name is the token after the kind,
 * in any of SQLite's quotings. Undefined for a statement of another shape.
 */
export function schemaObjectName(statement: string): string | undefined {
  const kind = /^CREATE (?:UNIQUE INDEX|VIRTUAL TABLE|TABLE|INDEX|VIEW|TRIGGER) /.exec(statement)
  if (!kind) return undefined
  const rest = statement.slice(kind[0].length)
  const close = { '"': '"', "`": "`", "'": "'", "[": "]" }[rest[0] ?? ""]
  if (!close) return /^[^\s(]+/.exec(rest)?.[0]
  let name = ""
  for (let at = 1; at < rest.length; at++) {
    if (rest[at] !== close) name += rest[at]
    // A doubled quote is the quote itself; brackets have no escape.
    else if (close !== "]" && rest[at + 1] === close) name += rest[at++]
    else return name
  }
  return undefined
}

/** Each virtual table a schema creates, by the prefix its shadow tables' names take, with its statement. */
function virtualTables(statements: readonly string[]): Map<string, string> {
  const tables = new Map<string, string>()
  for (const statement of statements) {
    const name = statement.startsWith("CREATE VIRTUAL TABLE ") ? schemaObjectName(statement) : undefined
    if (name !== undefined) tables.set(`${name.toLowerCase()}_`, statement)
  }
  return tables
}

/** The virtual table whose shadow table `statement` creates, among `tables`. */
function shadowOwner(tables: ReadonlyMap<string, string>, statement: string): string | undefined {
  const name = statement.startsWith("CREATE TABLE ") ? schemaObjectName(statement) : undefined
  return name === undefined ? undefined : [...tables].find(([prefix]) => name.toLowerCase().startsWith(prefix))?.[1]
}

/**
 * A database's schema in the order it's made: `rowid` order, with each virtual table's shadow tables right after
 * it, as creating it writes them. `VACUUM` moves shadow tables ahead of their table (it makes every table with pages
 * first), so a store and its restore, made by creating, list the same schema once it's in this order.
 */
function schemaInOrder(statements: readonly string[]): string[] {
  const tables = virtualTables(statements)
  const ordered: string[] = []
  for (const statement of statements) {
    if (shadowOwner(tables, statement) !== undefined) continue
    ordered.push(statement)
    if (tables.has(`${schemaObjectName(statement)?.toLowerCase()}_`) && statement.startsWith("CREATE VIRTUAL TABLE "))
      ordered.push(...statements.filter((shadow) => shadowOwner(tables, shadow) === statement))
  }
  return ordered
}

/**
 * A captured schema written into the database a restore opened: each object the database lacks, by name, and
 * the user version when it has none. One it already holds stays as it is, whatever its text: a store its harness
 * migrated keeps statements `ALTER TABLE` rewrote, and a virtual table makes its shadow tables itself (Devin 3000.11's
 * `message_search`, FTS5, makes `message_search_data` and the rest).
 */
function applySchema(db: DatabaseSync, snapshot: SchemaSnapshot): void {
  const virtual = virtualTables(snapshot.statements)
  const objects = () => SchemaObjectSchema.array().parse(db.prepare("SELECT name, sql FROM sqlite_master").all())
  const names = new Set<string>()
  const texts = new Set<string>()
  const list = () => {
    for (const object of objects()) {
      names.add(object.name.toLowerCase())
      if (object.sql !== null) texts.add(object.sql)
    }
  }
  list()
  for (const statement of snapshot.statements) {
    const name = schemaObjectName(statement)
    if (name === undefined ? texts.has(statement) : names.has(name.toLowerCase())) continue
    // A schema captured in `rowid` order from a vacuumed store lists a shadow table first: its table makes it.
    db.exec(shadowOwner(virtual, statement) ?? statement)
    // A virtual table's shadow tables come with it.
    list()
  }
  const current = Number(UserVersionSchema.parse(db.prepare("PRAGMA user_version").get()).user_version)
  if (current === 0 && snapshot.userVersion !== 0) db.exec(`PRAGMA user_version = ${Math.trunc(snapshot.userVersion)}`)
}
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
  /** The harness version that wrote what the version took, and where that's known from; null when nothing says. */
  writer: { versions: string[]; source: WriterSource } | null
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
  /** The version the row's own columns state (`RecordWriterRule.row`). */
  writer?: string | null
}

/** What a version is stamped with: the harness versions its bytes state, or the one observed, and which. */
interface Writer {
  versions: readonly string[]
  source: WriterSource
}

/** What one capture knows of the versions it takes as it goes: the version observed running the session, once known, and what it stamped. */
interface Taking {
  observed: string | null
  writers: CaptureReport["writers"]
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
  /** What each capture in progress observed of its session's writers. */
  private readonly takings = new WeakMap<CaptureReport, Taking>()
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
        const plan = databases.get(name) ?? { schema: null, rows: [], moves: layout.paths[name] ?? {}, resolved: new Set<string>(), lacks: [], bytes: 0 }
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

  /**
   * The names of the roots a session's records lie under: those its layout keeps (whose store they're from), and any
   * its units name besides.
   */
  rootNames(harness: string, nativeId: string): string[] {
    const found = SessionRowSchema.optional().parse(this.prepared("SELECT id, layout FROM sessions WHERE harness = ? AND native_id = ?").get(harness, nativeId))
    if (!found?.layout) return []
    return [...new Set([...Object.keys(SessionLayoutSchema.parse(JSON.parse(found.layout)).roots), ...this.unitRoots(found.id)])]
  }

  /** The roots a session's units are named under (`codex:sessions/…` is under `codex`). */
  private unitRoots(session: number): string[] {
    const rows = z.object({ root: z.string() }).array().parse(this.prepared("SELECT DISTINCT substr(u.key, 1, instr(u.key, ':') - 1) AS root FROM session_units s JOIN units u ON u.id = s.unit WHERE s.session = ? AND instr(u.key, ':') > 1").all(session))
    return rows.map((row) => row.root)
  }

  /**
   * A capture's layout: its records' roots, and every root it doesn't name that the session's units still lie under,
   * where the layout before had it (a pruned stream's, a folder gone since), so each unit has a place to be restored
   * to. One the layout before kept under its home is put under this one's.
   */
  private layoutKept(session: number, home: string, records: SessionRecords): SessionLayout {
    const layout = layoutOf(home, records)
    const found = z.object({ layout: z.string().nullable() }).optional().parse(this.prepared("SELECT layout FROM sessions WHERE id = ?").get(session))
    if (!found?.layout) return layout
    const before = SessionLayoutSchema.parse(JSON.parse(found.layout))
    const named = new Set(this.unitRoots(session))
    for (const [name, path] of Object.entries(before.roots)) {
      if (name in layout.roots || !named.has(name)) continue
      const below = relative(before.home, path)
      const underHome = below !== "" && below !== ".." && !below.startsWith(`..${sep}`) && !isAbsolute(below)
      layout.roots[name] = underHome ? join(home, below) : path
    }
    return layout
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
        for (const table of ["session_units", "session_paths", "child_paths", "marks", "captures", "remote_pushed"]) this.prepared(`DELETE FROM ${table} WHERE session = ?`).run(session)
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
    return VersionRowSchema.array().parse(this.prepared("SELECT seq, kind, at, size, length(chunks) AS chunkBytes, captured_at, digest, writer, writer_source FROM versions WHERE unit = ? ORDER BY seq").all(unit.id)).map((row) => ({
      seq: row.seq, kind: row.kind, at: row.at, size: row.size, chunks: row.chunkBytes / HASH_BYTES,
      capturedAt: new Date(row.captured_at).toISOString(), digest: row.digest ? Buffer.from(row.digest).toString("hex") : null,
      writer: row.writer && row.writer_source ? { versions: row.writer.split(" "), source: row.writer_source } : null,
    }))
  }

  /**
   * Every harness version that wrote the session, as its captured versions
   * were stamped (`record-writers.ts`), from one read: null when the store
   * holds no such session, empty lists when nothing stated or observed one.
   */
  writers(harness: string, nativeId: string): SessionWriters | null {
    const session = this.sessionId(harness, nativeId, false)
    if (session === null) return null
    const kept = this.mark(session, WRITERS)
    return kept ? SessionWritersSchema.parse(JSON.parse(kept)) : { record: [], observed: [] }
  }

  /**
   * Sessions nothing names a writer of yet: no version their records state
   * or Mako observed, and no evidence beside the store, or only `unknown`
   * or `range` evidence read before the session's last capture (a log or an
   * install may since say more), by older rules (`EVIDENCE_RULES`), or, for
   * `unknown`, before `unknownBefore`. What the backfill's pass looks at
   * (`fillWriters`), newest capture first.
   */
  sessionsWithoutWriters(options: { unknownBefore?: number } = {}): { harness: string; nativeId: string; paths: string[] }[] {
    const rows = z.object({ id: z.number(), harness: z.string(), nativeId: z.string(), writers: z.string().nullable(), captured: z.number().nullable() }).array().parse(this.prepared(`
      SELECT s.id, s.harness, s.native_id AS nativeId, (SELECT fingerprint FROM marks m WHERE m.session = s.id AND m.name = ?) AS writers,
        (SELECT max(c.at) FROM captures c WHERE c.session = s.id) AS captured
      FROM sessions s ORDER BY captured DESC`).all(WRITERS))
    return rows.flatMap((row) => {
      const writers = row.writers ? SessionWritersSchema.parse(JSON.parse(row.writers)) : null
      // A version that names no build (Devin's handshake's `0.0.0-dev`) names no writer: the evidence beside the store is read for it.
      if (writers && [...writers.record, ...writers.observed].some(namesBuild)) return []
      const evidence = writers?.evidence
      // Named versions stand. A range or nothing is looked at again once the session is captured anew, once the rules learn more, or, for nothing, once there's newer evidence to read (`unknownBefore`: the release dates were read again).
      const settled = evidence && (evidence.source === "log" || evidence.source === "install")
      const stale = evidence && ((row.captured ?? 0) > evidence.at || (evidence.rules ?? 1) < EVIDENCE_RULES || (evidence.source === "unknown" && evidence.at < (options.unknownBefore ?? 0)))
      if (evidence && (settled || !stale)) return []
      return [{ harness: row.harness, nativeId: row.nativeId, paths: PathRowSchema.array().parse(this.prepared("SELECT path FROM session_paths WHERE session = ? ORDER BY path").all(row.id)).map((path) => path.path) }]
    })
  }

  /**
   * Reads the versions a session's own records state from what the store
   * holds of them (`rule`, its harness's `RecordWriterRule`), for versions
   * captured before the rule existed: each version still unstamped is
   * scanned whole, a file's appended bytes or a row as it was, and stamped
   * `record`. Returns the versions found.
   */
  rescanWriters(harness: string, nativeId: string, rule: RecordWriterRule): Promise<string[]> {
    this.writable()
    return this.serially(async () => {
      const session = this.sessionId(harness, nativeId, false)
      if (session === null) return []
      const versions = z.object({ unit: z.number(), seq: z.number(), key: z.string(), role: UnitRoleSchema, kind: VersionKindSchema }).array().parse(this.prepared(`
        SELECT v.unit, v.seq, u.key, u.role, v.kind FROM session_units su JOIN units u ON u.id = su.unit JOIN versions v ON v.unit = u.id
        WHERE su.session = ? AND v.writer IS NULL AND v.kind != 'delete' AND u.role IN ('file', 'row') ORDER BY v.unit, v.seq`).all(session))
      const found: string[] = []
      const stamps: { unit: number; seq: number; versions: string[] }[] = []
      for (const version of versions) {
        let stated: string[] = []
        if (version.role === "file") {
          const scan = rule.file?.(version.key)
          if (!scan) continue
          scan.push(await this.versionBytes(version.unit, version.seq))
          stated = scan.end()
        } else if (rule.row) {
          const table = rowKeyOf(version.key).table
          const value = rule.row(table, decodeRow(await this.versionBytes(version.unit, version.seq)))
          if (value) stated = [value]
        }
        if (!stated.length) continue
        note(found, stated)
        stamps.push({ unit: version.unit, seq: version.seq, versions: stated })
      }
      if (!stamps.length) return found
      this.db.exec("BEGIN IMMEDIATE")
      try {
        const stamp = this.prepared("UPDATE versions SET writer = ?, writer_source = 'record' WHERE unit = ? AND seq = ? AND writer IS NULL")
        for (const each of stamps) stamp.run(each.versions.join(" "), each.unit, each.seq)
        const known = this.mark(session, WRITERS)
        this.setMark(session, WRITERS, JSON.stringify(mergeWriters(known ? SessionWritersSchema.parse(JSON.parse(known)) : null, { record: found })))
        this.db.exec("COMMIT")
      } catch (error) {
        if (this.db.isTransaction) this.db.exec("ROLLBACK")
        throw error
      }
      return found
    })
  }

  /** Keeps what the harness left beside its store about who wrote the session (`WriterEvidence`), with whatever its records or Mako already said. */
  noteEvidence(harness: string, nativeId: string, evidence: WriterEvidence): Promise<boolean> {
    this.writable()
    return this.serially(async () => {
      const session = this.sessionId(harness, nativeId, false)
      if (session === null) return false
      const known = this.mark(session, WRITERS)
      const writers = known ? SessionWritersSchema.parse(JSON.parse(known)) : { record: [], observed: [] }
      this.setMark(session, WRITERS, JSON.stringify({ ...writers, evidence }))
      return true
    })
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
    if (version !== undefined && Number(version) < RELEASED_SCHEMA)
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
    // Additions: each version's writer (`record-writers.ts`), the harness version that wrote what the version took and where that's known from.
    const columns = new Set(z.object({ name: z.string() }).array().parse(this.db.prepare("PRAGMA table_info(versions)").all()).map((column) => column.name))
    if (!columns.has("writer")) this.db.exec("ALTER TABLE versions ADD COLUMN writer TEXT")
    if (!columns.has("writer_source")) this.db.exec("ALTER TABLE versions ADD COLUMN writer_source TEXT")
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
    // Additions: what each remote store is known to hold of a unit, and how far this store has pulled each session from it (`exportSession`, `importSession`).
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS remote_units (remote TEXT NOT NULL, unit INTEGER NOT NULL, head INTEGER NOT NULL, PRIMARY KEY (remote, unit)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS remote_sessions (remote TEXT NOT NULL, session INTEGER NOT NULL, pulled INTEGER NOT NULL, PRIMARY KEY (remote, session)) WITHOUT ROWID;
    `)
    // Addition: what a remote holds of a unit, for each session, as a remote keeps them. A unit several sessions share (OpenCode's
    // project row, a database's schema) is a unit of each session there, so what one session's push took says nothing of
    // another's. `remote_units` stays for older builds; this one neither reads nor writes it, and a push it never noted
    // sends again what the remote holds, which the remote takes as held.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS remote_session_units (remote TEXT NOT NULL, session INTEGER NOT NULL, unit INTEGER NOT NULL, head INTEGER NOT NULL, PRIMARY KEY (remote, session, unit)) WITHOUT ROWID;
    `)
    // Addition: how far each remote holds a session, by the last capture a push of it took whole (`notePushed`): what a
    // device's uploads read to know which Sessions are in the account, without reading their units.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS remote_pushed (remote TEXT NOT NULL, session INTEGER NOT NULL, capture INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (remote, session)) WITHOUT ROWID;
    `)
    if (!z.object({ name: z.string() }).array().parse(this.db.prepare("PRAGMA table_info(chunks)").all()).some((column) => column.name === "intent"))
      this.db.exec("ALTER TABLE chunks ADD COLUMN intent INTEGER")
    const additions = new Set((meta("additions") ?? "").split(" ").filter(Boolean))
    if (ADDITIONS.some((name) => !additions.has(name)))
      this.db.prepare("INSERT INTO meta (key, value) VALUES ('additions', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run([...new Set([...additions, ...ADDITIONS])].join(" "))
    if (version === undefined) writeStoreFormat(this.db, "meta", { writableBy: SCHEMA_VERSION, readableBy: READS_VERSION }, this.formatWriter)
    else if (format && format.writableBy < SCHEMA_VERSION) this.raise()
    return "write"
  }

  /**
   * Raises a store an older build wrote to this build's format, so an older build reads it and writes nothing: it would
   * name rows by their rowid beside this build's names for them, and the two would split one row's history. One that has
   * it open now is stopped inside SQLite (`guardStoreWrites`), and turns read-only at its next look at the format.
   */
  private raise(): void {
    this.db.exec("BEGIN IMMEDIATE")
    try {
      writeStoreFormat(this.db, "meta", { writableBy: SCHEMA_VERSION, readableBy: READS_VERSION }, this.formatWriter)
      guardStoreWrites(this.db, RECORD_TABLES, SCHEMA_VERSION)
      this.db.exec("COMMIT")
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK")
      throw error
    }
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

  // Crossing between stores

  /** What this store holds of a session: each unit's newest `seq`, by key, for another store's `exportSession`. */
  holdings(harness: string, nativeId: string): RecordHoldings {
    const session = this.sessionId(harness, nativeId, false)
    if (session === null) return {}
    const units = z.object({ key: z.string(), head: z.number() }).array()
      .parse(this.prepared("SELECT u.key, u.head FROM session_units su JOIN units u ON u.id = su.unit WHERE su.session = ?").all(session))
    return Object.fromEntries(units.map((unit) => [unit.key, unit.head]))
  }

  /**
   * The session's records past what another store holds (`have`, its `holdings`): its units and their newer
   * versions, each naming its chunks, with the session's layout and marks; no units when there's nothing newer. Null
   * when this store holds none of it. Its chunks cross apart (`readChunk`, `missingChunks`).
   */
  exportSession(harness: string, nativeId: string, have: RecordHoldings = {}): RecordBundle | null {
    return this.exportPast(harness, nativeId, null, (unit) => have[unit.key] ?? -1)
  }

  /**
   * `exportSession` past what `remote`, a store this one pushes to, is known to hold (`remoteHolds`), a batch at a
   * time: at most `limit` versions, from the unit after `cursor` on. A long session's hundreds of thousands of rows
   * are read once across its batches and never held whole; `cursor` says where the next batch begins, null after the
   * last. A unit cut short is taken up again past what the remote then holds.
   */
  exportFor(remote: string, harness: string, nativeId: string, page: ExportPage = {}): { bundle: RecordBundle; cursor: number | null } | null {
    const found = SessionRowSchema.optional().parse(this.prepared("SELECT id, layout FROM sessions WHERE harness = ? AND native_id = ?").get(harness, nativeId))
    if (!found?.layout) return null
    const limit = page.limit ?? Number.POSITIVE_INFINITY
    // One read for the whole batch, the versions in unit order, and one past it to tell whether a unit or the session
    // goes on. A version a query, as this was, held the sync daemon 1.4 s for a batch of a Cursor chat's 342,965 rows.
    const rows = ExportRowSchema.array().parse(this.prepared(`SELECT u.id, u.key, u.role, u.head, u.seen_path, u.places,
        v.seq, v.kind, v.at, v.size, v.digest, v.tail, v.chunks, v.detail, v.writer, v.writer_source
      FROM session_units su JOIN units u ON u.id = su.unit
      LEFT JOIN remote_session_units r ON r.remote = ? AND r.session = su.session AND r.unit = u.id
      JOIN versions v ON v.unit = u.id AND v.seq > coalesce(r.head, -1)
      WHERE su.session = ? AND su.unit > ? AND u.head > coalesce(r.head, -1) ORDER BY su.unit, v.seq LIMIT ?`)
      .all(remote, found.id, page.cursor ?? 0, Number.isFinite(limit) ? limit + 1 : -1))
    const more = rows.length > limit ? rows.pop() : undefined
    const bundled: RecordUnit[] = []
    let current: { id: number; unit: RecordUnit } | undefined
    for (const row of rows) {
      if (current?.id !== row.id) {
        current = { id: row.id, unit: { key: row.key, role: row.role, path: row.seen_path, places: row.places, versions: [] } }
        bundled.push(current.unit)
      }
      current.unit.versions.push(exportedVersion(row))
    }
    if (!more) return { bundle: { ...this.sessionHead(found.id, harness, nativeId, found.layout), units: bundled }, cursor: null }
    // A unit taken whole moves the cursor past it; one cut short is the next batch's first, taken up past what the
    // remote holds by then.
    let whole = current?.id
    if (more.id === whole) whole = bundled.length > 1 ? rows[rows.length - 1 - (bundled.at(-1)?.versions.length ?? 0)]?.id : undefined
    return { bundle: { ...this.sessionHead(found.id, harness, nativeId, found.layout), units: bundled }, cursor: whole ?? page.cursor ?? 0 }
  }

  private exportPast(harness: string, nativeId: string, remote: string | null, after: (unit: { key: string; held: number | null }) => number): RecordBundle | null {
    const found = SessionRowSchema.optional().parse(this.prepared("SELECT id, layout FROM sessions WHERE harness = ? AND native_id = ?").get(harness, nativeId))
    if (!found?.layout) return null
    const units = ExportUnitSchema.array()
      .parse(this.prepared(`SELECT u.id, u.key, u.role, u.head, u.seen_path, u.places, r.head AS held FROM session_units su JOIN units u ON u.id = su.unit
        LEFT JOIN remote_session_units r ON r.remote = ? AND r.session = su.session AND r.unit = u.id WHERE su.session = ? ORDER BY u.id`).all(remote, found.id))
    const bundled = units.flatMap((unit) => {
      const past = after(unit)
      if (unit.head <= past) return []
      return [{ key: unit.key, role: unit.role, path: unit.seen_path, places: unit.places, versions: this.versionsPast(unit.id, past, Number.POSITIVE_INFINITY) }]
    })
    return { ...this.sessionHead(found.id, harness, nativeId, found.layout), units: bundled }
  }

  /** A unit's versions past `after`, in order, at most `most`. */
  private versionsPast(unit: number, after: number, most: number): RecordVersion[] {
    const rows = ExportVersionSchema.array().parse(this.prepared("SELECT seq, kind, at, size, digest, tail, chunks, detail, writer, writer_source FROM versions WHERE unit = ? AND seq > ? ORDER BY seq LIMIT ?")
      .all(unit, after, Number.isFinite(most) ? most : -1))
    return rows.map(exportedVersion)
  }

  /** What a bundle of the session carries besides its units: its layout, and its marks but the stamp naming one machine's files. */
  private sessionHead(session: number, harness: string, nativeId: string, layout: string): Omit<RecordBundle, "units"> {
    const marks = z.object({ name: z.string(), fingerprint: z.string() }).array()
      .parse(this.prepared("SELECT name, fingerprint FROM marks WHERE session = ? AND name != ?").all(session, HELD_STAMP))
    return { harness, nativeId, layout: SessionLayoutSchema.parse(JSON.parse(layout)), marks: Object.fromEntries(marks.map((mark) => [mark.name, mark.fingerprint])) }
  }

  /**
   * A remote store took `bundle` (or already held it): from now on `exportFor(remote, …)` sends only what's
   * past it. `holdings` instead replaces what's known of the session there with what the remote says it holds, as
   * after a push it refused for a gap.
   */
  remoteHolds(remote: string, harness: string, nativeId: string, held: RecordBundle | { holdings: RecordHoldings }): Promise<void> {
    this.writable()
    return this.serially(async () => {
      const session = this.sessionId(harness, nativeId, false)
      if (session === null) return
      this.db.exec("BEGIN IMMEDIATE")
      try {
        if ("holdings" in held) {
          this.prepared("DELETE FROM remote_session_units WHERE remote = ? AND session = ?").run(remote, session)
          for (const [key, head] of Object.entries(held.holdings)) this.noteRemoteHead(remote, session, harness, key, head)
        } else for (const unit of held.units) this.noteRemoteHead(remote, session, harness, unit.key, unit.versions.at(-1)?.seq ?? -1)
        this.db.exec("COMMIT")
      } catch (error) {
        if (this.db.isTransaction) this.db.exec("ROLLBACK")
        throw error
      }
    })
  }

  /**
   * Each session's newest capture that took something, by `<harness>\n<native id>`, past capture `after` only: a
   * session the store holds with no such capture (pulled, not captured) reads 0 when `after` is 0. With the newest
   * capture's number, which the next call passes as `after` to read only what landed since, from any process.
   */
  captureHeads(after = 0): CaptureHeads {
    const heads = new Map<string, number>()
    const rows = z.object({ harness: z.string(), nativeId: z.string(), capture: z.number() }).array()
    const found = after > 0
      ? this.prepared("SELECT s.harness, s.native_id AS nativeId, max(c.id) AS capture FROM captures c JOIN sessions s ON s.id = c.session WHERE c.id > ? GROUP BY c.session").all(after)
      : this.prepared("SELECT s.harness, s.native_id AS nativeId, coalesce(max(c.id), 0) AS capture FROM sessions s LEFT JOIN captures c ON c.session = s.id WHERE s.layout IS NOT NULL GROUP BY s.id").all()
    for (const row of rows.parse(found)) heads.set(`${row.harness}\n${row.nativeId}`, row.capture)
    const through = z.object({ id: z.number().nullable() }).parse(this.prepared("SELECT max(id) AS id FROM captures").get()).id ?? 0
    return { heads, through }
  }

  /** What `remote` holds whole of each session, by the capture its last whole push took (`notePushed`), and when. */
  pushed(remote: string): Map<string, { capture: number; at: number }> {
    const rows = z.object({ harness: z.string(), nativeId: z.string(), capture: z.number(), at: z.number() }).array()
      .parse(this.prepared("SELECT s.harness, s.native_id AS nativeId, p.capture, p.at FROM remote_pushed p JOIN sessions s ON s.id = p.session WHERE p.remote = ?").all(remote))
    return new Map(rows.map((row) => [`${row.harness}\n${row.nativeId}`, { capture: row.capture, at: row.at }]))
  }

  /** `remote` took every version of the session there was as of capture `capture` (`captureHeads`): a push of it ended with nothing left. */
  notePushed(remote: string, harness: string, nativeId: string, capture: number, at: number): Promise<void> {
    this.writable()
    return this.serially(async () => {
      const session = this.sessionId(harness, nativeId, false)
      if (session === null) return
      this.prepared("INSERT INTO remote_pushed (remote, session, capture, at) VALUES (?, ?, ?, ?) ON CONFLICT (remote, session) DO UPDATE SET capture = max(capture, excluded.capture), at = excluded.at").run(remote, session, capture, at)
    })
  }

  /** How far this store has pulled the session from `remote`: the remote's own number for the last version taken, 0 before any. */
  pulledThrough(remote: string, harness: string, nativeId: string): number {
    const session = this.sessionId(harness, nativeId, false)
    if (session === null) return 0
    return z.object({ pulled: z.number() }).optional().parse(this.prepared("SELECT pulled FROM remote_sessions WHERE remote = ? AND session = ?").get(remote, session))?.pulled ?? 0
  }

  private noteRemoteHead(remote: string, session: number, harness: string, key: string, head: number): void {
    const unit = this.unitByKey(harness, key)
    if (!unit || head < 0) return
    this.prepared("INSERT INTO remote_session_units (remote, session, unit, head) VALUES (?, ?, ?, ?) ON CONFLICT (remote, session, unit) DO UPDATE SET head = max(head, excluded.head)").run(remote, session, unit.id, head)
  }

  /** Of `hashes`, the chunks this store lacks. */
  missingChunks(hashes: readonly string[]): string[] {
    const held = this.prepared("SELECT 1 FROM chunks WHERE hash = ?")
    return hashes.filter((hash) => !held.get(Buffer.from(hash, "hex")))
  }

  /** A chunk as this store keeps it, for another store's import; null when it lacks the chunk. */
  async readChunk(hash: string): Promise<StoredChunk | null> {
    const key = Buffer.from(hash, "hex")
    const placeOf = () => {
      const place = this.prepared("SELECT pack, offset, stored, size, codec FROM chunks WHERE hash = ?").get(key)
      return place ? ChunkPlaceSchema.parse(place) : null
    }
    const place = placeOf()
    if (!place) return null
    try {
      return await this.packs.readStored(place)
    } catch (error) {
      // A repack may have moved it between the lookup and the read: its new place is in the index.
      const moved = placeOf()
      if (!moved || (moved.pack === place.pack && moved.offset === place.offset)) throw error
      return this.packs.readStored(moved)
    }
  }

  /**
   * Takes a session's records from another store: `bundle` (that store's `exportSession` past this one's
   * `holdings`), and from `fetch` the chunks this store lacks, each checked against its hash before it's kept. Versions
   * go on after the ones held by `planRecordImport`'s rule: one this store already holds must be the same, and a gap
   * is refused, so a session that went on in two places is never stitched together (a restore then forks it). Runs in
   * the session's capture turn, so it never interleaves with a capture of it; `restore` then writes it where its
   * harness reads it. `from`: the remote it came from, and its number for the bundle's last version, kept with the
   * versions in one commit, so the next pull asks only past it and the next push sends none of it back.
   */
  importSession(bundle: RecordBundle, fetch: (hashes: string[]) => AsyncIterable<{ hash: string; chunk: StoredChunk }>, from?: { remote: string; through: number }, describesStore?: (unit: RecordUnit) => boolean): Promise<ImportReport> {
    this.writable()
    const session = `${bundle.harness}\n${bundle.nativeId}`
    const before = this.capturing.get(session)
    const asked = Date.now()
    const run = (before ? before.catch(() => undefined) : Promise.resolve()).then(() => this.serially(async () => {
      const queuedMs = Date.now() - asked
      return { ...await this.importNow(bundle, fetch, from, describesStore), queuedMs }
    }))
    this.capturing.set(session, run)
    const settled = () => {
      if (this.capturing.get(session) === run) this.capturing.delete(session)
    }
    run.then(settled, settled)
    return run
  }

  /** What this store holds of one unit, as `planRecordImport` asks it. */
  private heldUnit(harness: string, key: string): HeldUnit | undefined {
    const unit = this.unitByKey(harness, key)
    if (!unit) return undefined
    const version = this.prepared("SELECT kind, chunks FROM versions WHERE unit = ? AND seq = ?")
    return {
      head: unit.head,
      version: (seq) => {
        const held = z.object({ kind: VersionKindSchema, chunks: z.instanceof(Uint8Array) }).optional().parse(version.get(unit.id, seq))
        return held && { kind: held.kind, chunks: Buffer.from(held.chunks).toString("hex") }
      },
    }
  }

  private async importNow(bundle: RecordBundle, fetch: (hashes: string[]) => AsyncIterable<{ hash: string; chunk: StoredChunk }>, from: { remote: string; through: number } | undefined, describesStore: ((unit: RecordUnit) => boolean) | undefined): Promise<ImportReport> {
    const started = Date.now()
    const report: CaptureReport = { versions: [], taken: 0, unchanged: 0, newChunks: 0, newBytes: 0, storedBytes: 0, ms: 0, waitedMs: 0, reads: 0, longestReadMs: 0, rowsRead: 0, rowsMatched: 0, writers: { record: [], observed: [] } }
    const imported: ImportReport = { versions: 0, held: 0, chunks: 0, bytes: 0, storedBytes: 0, ms: 0 }
    const held = (key: string) => this.heldUnit(bundle.harness, key)
    // Refused before anything is written or fetched.
    const planned = planRecordImport(bundle, held, describesStore)
    await this.begin()
    this.generations.set(report, this.dropGeneration())
    const intent: CaptureIntent = { session: `${bundle.harness} ${bundle.nativeId}`, id: null }
    this.intents.set(report, intent)
    try {
      // The chunks first, each under the import's intent: a long fetch commits in slices, and what a failure leaves is the repack's to drop.
      const needed = new Set(this.missingChunks(versionChunks(planned.taking.map(({ version }) => version))))
      if (needed.size)
        for await (const { hash, chunk } of fetch([...needed])) {
          if (!needed.delete(hash)) continue
          const key = Buffer.from(hash, "hex")
          checkStoredChunk(key, chunk)
          // Another import or capture may have stored it since this one asked what it lacked (the store's turn passes
          // between them at each slice): named again, as a capture names one it finds held, never stored twice.
          if (await this.namedAgain(key, report)) continue
          const stored = await this.intentOf(report)
          const place = await this.packs.writeStored(key, chunk)
          this.prepared("INSERT INTO chunks (hash, pack, offset, stored, size, codec, intent) VALUES (?, ?, ?, ?, ?, ?, ?)")
            .run(key, place.pack, place.offset, place.stored, place.size, place.codec, stored)
          imported.chunks += 1
          imported.bytes += place.size
          imported.storedBytes += place.stored
          await this.slice(report)
        }
      if (needed.size) throw new Error(`${needed.size} chunks of ${bundle.harness} session ${bundle.nativeId} didn't come`)
      // Then the versions, in the last commit, by the rule again: a slice may have let another session sharing a unit go first.
      const { taking, held: already, kept } = planRecordImport(bundle, held, describesStore)
      if (this.missingChunks(versionChunks(taking.map(({ version }) => version))).length)
        throw new Error(`The records of ${bundle.harness} session ${bundle.nativeId} changed while they were imported; import them again`)
      imported.held = already
      // SAFETY: created just above when it didn't exist.
      const session = this.sessionId(bundle.harness, bundle.nativeId, true)!
      // This store's own layout stands where it captured the session itself; a restore moves paths from whichever it kept.
      this.prepared("UPDATE sessions SET layout = ? WHERE id = ? AND layout IS NULL").run(JSON.stringify(bundle.layout), session)
      for (const { unit: arriving, version } of taking) {
        const unit = this.unit(bundle.harness, arriving.key, arriving.role, session)
        // Where its root names it: this store's own sight of the file, which its captures stamp, stays where it has one.
        if (arriving.path !== null) this.prepared("UPDATE units SET seen_path = coalesce(seen_path, ?), places = coalesce(places, ?) WHERE id = ?").run(arriving.path, arriving.places, unit.id)
        const detail = version.detail ? z.object({ path: z.string() }).parse(JSON.parse(version.detail)) : null
        const writer = version.writer && version.writerSource ? { versions: version.writer.split(" "), source: version.writerSource } : null
        this.addVersion(unit, version.kind, version.at, version.size, version.digest ? Buffer.from(version.digest, "hex") : null, version.tail ? Buffer.from(version.tail, "hex") : null, Buffer.from(version.chunks, "hex"), detail, writer)
        imported.versions += 1
      }
      // A unit held already but not yet in this session's list (a bundle can name one another session brought).
      for (const unit of bundle.units) this.unit(bundle.harness, unit.key, unit.role, session)
      for (const [name, fingerprint] of Object.entries(bundle.marks))
        if (name !== HELD_STAMP && this.mark(session, name) === undefined) this.setMark(session, name, fingerprint)
      if (from) {
        // A schema unit kept as this store's own numbers its versions apart from the remote's: nothing of it is noted.
        for (const unit of bundle.units) if (!kept.includes(unit.key)) this.noteRemoteHead(from.remote, session, bundle.harness, unit.key, unit.versions.at(-1)?.seq ?? -1)
        this.prepared("INSERT INTO remote_sessions (remote, session, pulled) VALUES (?, ?, ?) ON CONFLICT (remote, session) DO UPDATE SET pulled = max(pulled, excluded.pulled)").run(from.remote, session, from.through)
      }
      if (intent.id !== null) this.prepared("DELETE FROM intents WHERE id = ?").run(intent.id)
      await this.commit()
      imported.ms = Date.now() - started
      return imported
    } catch (error) {
      if (!this.closed && this.db.isTransaction) this.db.exec("ROLLBACK")
      this.endIntent(intent.id)
      throw error
    }
  }

  // Capture

  private async captureNow({ harness, nativeId, home, records, path: read, stamp, listing, observed }: CaptureInput): Promise<CaptureReport> {
    checkRoots(records.roots)
    const folders = rootFolders(records.roots)
    const started = Date.now()
    const report: CaptureReport = { versions: [], taken: 0, unchanged: 0, newChunks: 0, newBytes: 0, storedBytes: 0, ms: 0, waitedMs: 0, reads: 0, longestReadMs: 0, rowsRead: 0, rowsMatched: 0, writers: { record: [], observed: [] } }
    // The session's own file gone is its harness deleting or moving it, which is never captured: a deleted session
    // reads back as its newest versions (`RecordReads`), and a moved one is captured where it's listed now. A capture
    // asked for before the harness deleted it, and run after, takes nothing.
    const own = read !== undefined && records.files.includes(read)
    if (own && !(await statRecord(read))) return report
    await this.begin()
    this.generations.set(report, this.dropGeneration())
    this.takings.set(report, { observed: observed ?? null, writers: report.writers })
    const intent: CaptureIntent = { session: `${harness} ${nativeId}`, id: null }
    this.intents.set(report, intent)
    try {
      // SAFETY: created just above when it didn't exist.
      const session = this.sessionId(harness, nativeId, true)!
      this.prepared("UPDATE sessions SET layout = ? WHERE id = ?").run(JSON.stringify(this.layoutKept(session, home, records)), session)
      if (read) this.prepared("INSERT INTO session_paths (path, session) VALUES (?, ?) ON CONFLICT (path) DO UPDATE SET session = excluded.session").run(read, session)
      // Its child agents' paths, read through it once its harness deletes it; a child the harness drops later keeps its path, and its records' last version.
      for (const child of records.children ?? [])
        if (child !== read) this.prepared("INSERT INTO child_paths (path, session) VALUES (?, ?) ON CONFLICT (path) DO UPDATE SET session = excluded.session WHERE session != excluded.session").run(child, session)
      const seen = new Set<number>()
      // A launch's stream names the version that ran it, which stamps what the capture takes after it where the records state none: streams go first.
      const streams = `${STREAMS_ROOT}:`
      const files = [...records.files.filter((path) => qualify(records.roots, path).startsWith(streams)), ...records.files.filter((path) => !qualify(records.roots, path).startsWith(streams))]
      let ownGone = false
      for (const path of files) {
        const unit = await this.captureFile(harness, session, records, path, report)
        if (unit !== null) seen.add(unit)
        else if (own && path === read) ownGone = true
        await this.slice(report)
      }
      // Gone as this capture read it: what else of the session is gone says nothing either.
      if (!ownGone) await this.captureGoneFiles(session, folders, seen, report)
      for (const lines of records.lines ?? []) await this.captureLines(harness, session, records.roots, lines, report)
      for (const database of records.databases) await this.captureDatabase(harness, session, records, database, report)
      if (report.writers.record.length || report.writers.observed.length) {
        const known = this.mark(session, WRITERS)
        this.setMark(session, WRITERS, JSON.stringify(mergeWriters(known ? SessionWritersSchema.parse(JSON.parse(known)) : null, report.writers)))
      }
      report.ms = Date.now() - started - report.waitedMs
      if (report.taken || report.ms >= SLOW_CAPTURE_MS)
        this.prepared("INSERT INTO captures (session, at, versions, new_bytes, stored_bytes, ms, waited_ms, reads, longest_read_ms, rows_read, rows_matched) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(session, started, report.taken, report.newBytes, report.storedBytes, report.ms, report.waitedMs, report.reads, report.longestReadMs, report.rowsRead, report.rowsMatched)
      if (stamp !== undefined) this.setMark(session, HELD_STAMP, stamp)
      const row = listing?.() ?? null
      if (row !== null) this.setMark(session, LISTING, row)
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
    // A launch's stream states the version that ran it; the harness's own files state theirs where its rule says.
    const stream = seenPath.startsWith(`${STREAMS_ROOT}:`)
    const scan = stream ? STREAM_RUNTIME_SCAN() : records.writer?.file?.(unit.key) ?? null
    if (head && tail && (await tailHash(path, head.size)).equals(tail)) {
      if (info.bytes > head.size) {
        const { chunks } = await this.storeStream(recordChunks(path, head.size, info.bytes), report, true, scan)
        this.addVersion(unit, "append", head.size, info.bytes, null, await tailHash(path, info.bytes), chunks, { path: seenPath }, this.stamped(report, unit.id, scan, stream))
        countVersion(report, { unit: unit.key, kind: "append", bytes: info.bytes - head.size })
        if (this.step) await this.step("versioned")
      } else report.unchanged += 1
    } else {
      const { chunks, digest, tail } = await this.storeStream(recordChunks(path, 0, info.bytes), report, true, scan)
      if (head && head.kind !== "delete" && head.digest?.equals(digest) && head.size === info.bytes) report.unchanged += 1
      else {
        this.addVersion(unit, "replace", 0, info.bytes, digest, tail, chunks, { path: seenPath }, this.stamped(report, unit.id, scan, stream))
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

  private async captureDatabase(harness: string, session: number, records: SessionRecords, database: RecordDatabase, report: CaptureReport): Promise<void> {
    const roots = records.roots
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
      const statements = schemaInOrder(SchemaStatementSchema.array().parse(source.statement("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all()).map((row) => row.sql))
      const userVersion = Number(UserVersionSchema.parse(source.statement("PRAGMA user_version").get()).user_version)
      const schema = Buffer.from(JSON.stringify({ statements, userVersion }))
      const schemaDigest = sha256(schema)
      await this.captureValue(harness, session, `${name}\tschema`, "schema", schema, schemaDigest, report)
      // A migration that adds a column changes every row, rewritten or not, so rows are skipped by key only under the schema this session last read whole.
      const settled = this.mark(session, `${name}\tschema`) === schemaDigest.toString("hex")
      const tables = new Set(TableNameSchema.array().parse(source.statement("SELECT name FROM sqlite_master WHERE type = 'table'").all()).map((row) => row.name))
      for (const table of database.tables) {
        if (tables.has(table.table)) await this.captureTable(harness, session, name, source, table, settled, report, records.writer?.row)
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
  private async captureTable(harness: string, session: number, name: string, source: SourceRead, table: RecordTable, settled: boolean, report: CaptureReport, writerOf?: RecordWriterRule["row"]): Promise<void> {
    const keys = keyColumns(source.db, table.table)
    // An earlier build named this table's rows by its rowid alias, which names no row (`keyColumns`): the session lets
    // go of those units, and this capture takes the rows again under their identity, with bytes the store holds already.
    const alias = rowIdentity(source.db, table.table).alias
    if (alias) this.retireAliasKeys(harness, session, `${name}\trow\t${table.table}\t`, alias)
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
      page.push({ key: rowUnitKey(name, table.table, keys, row), bytes, digest: sha256(bytes), writer: writerOf?.(table.table, row) ?? null })
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
    if (above === null && await this.captureMissing(harness, session, name, source, table, known, report, writerOf)) whole = false
    if (digests && digests.through !== null && whole) this.setMark(session, marked, JSON.stringify({ through: String(digests.through), keys: digests.keys.all }))
  }

  /**
   * The table's units this capture didn't list: still the session's (written
   * again under the key after the listing), taken now; still there but
   * another's, no longer this session's; gone, deleted. True when it took one.
   */
  private async captureMissing(harness: string, session: number, name: string, source: SourceRead, table: RecordTable, known: Map<string, KnownUnit>, report: CaptureReport, writerOf?: RecordWriterRule["row"]): Promise<boolean> {
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
        const row: RecordRow = { ...own }
        const bytes = encodeRow(row)
        await this.captureRow(harness, session, { key, bytes, digest: sha256(bytes), writer: writerOf?.(table.table, row) ?? null }, have, report)
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
      this.addVersion(have, "replace", 0, row.bytes.length, row.digest, null, chunks, null, this.stated(report, row.writer ? [row.writer] : []))
      have.kind = "replace"
      have.digest = row.digest
      countVersion(report, { unit: row.key, kind: "replace", bytes: row.bytes.length })
      return
    }
    await this.captureValue(harness, session, row.key, "row", row.bytes, row.digest, report, row.writer)
  }

  /**
   * Lets go of `session`'s units of a table that an earlier build named by its rowid alias `alias` alone, and drops
   * each no other session names, with what the store noted a remote holds of it. Their chunks are left unnamed, for a
   * sweep to take once nothing names them.
   */
  private retireAliasKeys(harness: string, session: number, prefix: string, alias: string): void {
    const from = `${prefix}{${JSON.stringify(alias)}:`
    const units = UnitKeySchema.array().parse(this.prepared(`
      SELECT u.id, u.key FROM session_units su JOIN units u ON u.id = su.unit
      WHERE su.session = ? AND u.harness = ? AND u.key >= ? AND u.key < ?`).all(session, harness, from, `${from}\uffff`))
    for (const unit of units) {
      const key = rowKeyOf(unit.key)
      if (key.columns.length !== 1 || key.columns[0] !== alias) continue
      this.prepared("DELETE FROM session_units WHERE session = ? AND unit = ?").run(session, unit.id)
      this.prepared("DELETE FROM remote_session_units WHERE session = ? AND unit = ?").run(session, unit.id)
      if (this.prepared("SELECT 1 FROM session_units WHERE unit = ?").get(unit.id)) continue
      this.prepared("DELETE FROM remote_session_units WHERE unit = ?").run(unit.id)
      this.prepared("DELETE FROM remote_units WHERE unit = ?").run(unit.id)
      this.prepared("DELETE FROM versions WHERE unit = ?").run(unit.id)
      this.prepared("DELETE FROM units WHERE id = ?").run(unit.id)
    }
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

  private async captureValue(harness: string, session: number, key: string, role: UnitRole, bytes: Buffer, digest: Buffer, report: CaptureReport, writer?: string | null): Promise<void> {
    const unit = this.unit(harness, key, role, session)
    const head = this.head(unit)
    if (head && head.kind !== "delete" && head.digest?.equals(digest)) {
      report.unchanged += 1
      return
    }
    const chunks = await this.storeValue(bytes, report)
    this.addVersion(unit, "replace", 0, bytes.length, digest, null, chunks, null, this.stated(report, writer ? [writer] : []))
    countVersion(report, { unit: key, kind: "replace", bytes: bytes.length })
  }

  /**
   * What a file's version is stamped with: the versions its bytes state, or
   * else the version observed running the session. A launch's stream states
   * the version that ran it (`runtime`) once, as it starts; what it appends
   * later is that same launch's, so it takes the version an earlier version
   * of the stream stated. Either is the observed version for the rest of the
   * capture, ahead of the install the host read.
   */
  private stamped(report: CaptureReport, unit: number, scan: WriterScan | null, stream: boolean): Writer | null {
    const versions = scan?.end() ?? []
    if (!stream) return versions.length ? this.stated(report, versions) : this.observedWriter(report)
    const ran = versions.length ? versions : [WriterRowSchema.optional().parse(this.prepared("SELECT writer FROM versions WHERE unit = ? AND writer IS NOT NULL ORDER BY seq DESC LIMIT 1").get(unit))?.writer.split(" ").at(-1)].filter((version): version is string => Boolean(version))
    if (!ran.length) return this.observedWriter(report)
    const taking = this.takings.get(report)
    if (taking) taking.observed = ran.at(-1)!
    note(report.writers.observed, ran)
    return { versions: ran, source: "observed" }
  }

  /** A version stamped with what its own bytes or columns state, or else with the version observed. */
  private stated(report: CaptureReport, versions: readonly string[]): Writer | null {
    if (!versions.length) return this.observedWriter(report)
    note(report.writers.record, versions)
    return { versions, source: "record" }
  }

  private observedWriter(report: CaptureReport): Writer | null {
    const observed = this.takings.get(report)?.observed
    if (!observed) return null
    note(report.writers.observed, [observed])
    return { versions: [observed], source: "observed" }
  }

  private addVersion(unit: { id: number; head: number }, kind: VersionKind, at: number, size: number, digest: Buffer | null, tail: Buffer | null, chunks: Buffer, detail: { path: string } | null, writer: Writer | null = null): void {
    const seq = unit.head + 1
    this.prepared("INSERT INTO versions (unit, seq, kind, at, size, digest, tail, chunks, captured_at, detail, writer, writer_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(unit.id, seq, kind, at, size, digest, tail, chunks, Date.now(), detail ? JSON.stringify(detail) : null, writer?.versions.length ? writer.versions.join(" ") : null, writer?.versions.length ? writer.source : null)
    this.prepared("UPDATE units SET head = ? WHERE id = ?").run(seq, unit.id)
    unit.head = seq
  }

  /**
   * Chunks a stream of bytes, storing each chunk not yet stored; the chunk
   * list, the whole digest and the tail hash. A long stream is `sliced`: what
   * it stored so far commits, and waiting work runs, between its chunks.
   */
  private async storeStream(source: AsyncIterable<{ bytes: Buffer }> | Iterable<{ bytes: Buffer }>, report: CaptureReport, sliced: boolean, scan: WriterScan | null = null): Promise<{ chunks: Buffer; digest: Buffer; tail: Buffer }> {
    const chunker = new Chunker()
    const digest = createHash("sha256")
    const hashes: Buffer[] = []
    let size = 0
    let window: Buffer = Buffer.alloc(0)
    for await (const { bytes } of source) {
      digest.update(bytes)
      scan?.push(bytes)
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
    if (await this.namedAgain(hash, report)) return
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
   * Whether a chunk about to be named is held already, and if so names it again for this capture or import: no longer
   * a candidate for the repack to drop, and claimed if another one's intent stored it or a sweep found it unnamed.
   */
  private async namedAgain(hash: Buffer, report: CaptureReport): Promise<boolean> {
    const held = HeldChunkSchema.optional().parse(this.prepared(`
      SELECT c.intent, EXISTS (SELECT 1 FROM intents i WHERE i.id = c.intent) AS stored, EXISTS (SELECT 1 FROM unnamed u WHERE u.hash = c.hash) AS unnamed
      FROM chunks c WHERE c.hash = ?`).get(hash))
    if (!held) return false
    this.prepared("DELETE FROM orphans WHERE hash = ?").run(hash)
    if ((held.stored && held.intent !== this.intents.get(report)?.id) || held.unnamed) await this.claim(hash, held.stored ? held.intent : null, report)
    return true
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
    // Records go only into the version of their harness that wrote them, or a newer one: asked first, so the answer never depends on where they'd go.
    const outdated = input.installed === undefined ? null : outdatedOf(restoreGate(this.writers(harness, nativeId), input.installed))
    if (outdated) {
      report.outdated = outdated
      return report
    }
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
    // A row the store here has no column for is one an older build of the harness can't hold, whatever the versions
    // said: refused as the gate refuses, before anything is written, a dry run included.
    const lacks = [...new Set([...plan.rowPlans.values()].flatMap((rows) => rows.lacks))]
    if (lacks.length) {
      report.outdated = { installed: givenVersion(input.installed), lacks }
      return report
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
    if (input.destination && !own) {
      const known = new Set([...plan.files.map((unit) => unit.key), ...this.sessionKeys(session)])
      for (const rows of plan.rowPlans.values()) for (const key of rows.resolved) known.add(key)
      this.checkDestination(input.destination, known, report, input.fork ? plan.destinationRows : null)
    }
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
      // A launch's stream is Mako's record of what its driver received, a file of its own per launch, not the harness's:
      // no fork rule names it, and the fork never takes it. It's written where the destination lacks it, as any shared unit.
      file: (path) => (path.startsWith(`${STREAMS_ROOT}:`) ? "shared" : fork.file(plainRecordPath(path), ids)),
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
  private async inRowidOrder(db: DatabaseSync, rows: ForkDatabasePlan["rows"], aliases: Map<string, string | null>): Promise<ForkDatabasePlan["rows"]> {
    const order = new Map<number, bigint>()
    for (const row of rows) {
      if (!aliases.has(row.table)) aliases.set(row.table, forkIdentity(db, row.table).alias)
      const alias = aliases.get(row.table)
      if (!alias) continue
      // The session's number is the row's own, not its unit's key, which names the row by its identity (`keyColumns`).
      order.set(row.id, BigIntSchema.catch(0n).parse(decodeRow(await this.versionBytes(row.id, row.head))[alias]))
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
      if (plan.schema) applySchema(db, SchemaSnapshotSchema.parse(JSON.parse((await this.versionBytes(plan.schema.id, plan.schema.head)).toString("utf8"))))
      const aliases = new Map<string, string | null>()
      const statements = new Map<string, StatementSync>()
      for (const row of await this.inRowidOrder(db, plan.rows, aliases)) {
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
    if (info.bytes > size || !(await this.prefixMatches(unit.id, existing, info.bytes))) {
      // A file its harness writes whole again (Grok's summary.json, prompt_context.json and system prompt on every load)
      // holding a version Mako captured is behind the newest, not gone on without Mako: the newest replaces it.
      if (!(await this.capturedWhole(unit.id, existing, info.bytes))) {
        report.diverged.push({ unit: unit.key, reason: info.bytes > size ? `The destination holds ${info.bytes} bytes; Mako's newest version has ${size}` : `The destination's ${info.bytes} bytes differ from Mako's version` })
        return null
      }
      if (dropped) {
        record("delete", 0)
        return { action: "delete", target: existing, from: 0 }
      }
      record("write", size)
      return { action: "write", target, from: 0, ...existing !== target && { existing } }
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

  /**
   * Whether the destination's file is, whole, a version Mako captured of the unit: an earlier state of the session,
   * which the newest descends from (a unit's versions are one line, `planRecordImport`). Only a version taken whole
   * (`replace`) has its digest; a file that only appends is compared by its prefix instead.
   */
  private async capturedWhole(unit: number, path: string, length: number): Promise<boolean> {
    if (!this.prepared("SELECT 1 FROM versions WHERE unit = ? AND kind = 'replace' AND size = ? LIMIT 1").get(unit, length)) return false
    const digest = createHash("sha256")
    for await (const { bytes } of recordChunks(path, 0, length)) digest.update(bytes)
    return Boolean(this.prepared("SELECT 1 FROM versions WHERE unit = ? AND kind = 'replace' AND size = ? AND digest = ? LIMIT 1").get(unit, length, digest.digest()))
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
    const plan: DatabasePlan = { schema: null, rows: [], moves: moving ? paths : {}, resolved: new Set(), lacks: [] }
    const lookups = new Map<string, StatementSync>()
    const tallies = new Map<string, RestoreRows>()
    /** Rows to write whose columns are still to be read: after the rows are planned, several at a time. */
    const unread: { row: DatabasePlan["rows"][number]; table: string }[] = []
    let closeIdentities = () => {}
    try {
      const tables = new Set(db ? TableNameSchema.array().parse(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).map((row) => row.name) : [])
      const identity = await this.rowIdentities(name, db, tables)
      closeIdentities = identity.close
      const fits = (table: string, row: RecordRow) => {
        const columns = identity.columns(table)
        for (const column of Object.keys(row)) {
          const lacking = `${table}.${column}`
          if (!columns?.has(column) && !plan.lacks.includes(lacking)) plan.lacks.push(lacking)
        }
      }
      /** A row unit, found at the destination by `found`: as `key` names it, or as its content does. */
      const consider = async (unit: z.infer<typeof UnitHeadSchema>, key: RowKey, found: RowKey): Promise<void> => {
        if (forking) {
          // A fork's own rows go to the fork; a shared row is only ever added or brought up to date, never deleted.
          const owner = await forking.owns(unit, key.table)
          if (owner === "unknown") report.diverged.push({ unit: unit.key, reason: UNKNOWN_TO_FORK })
          if (owner !== "shared" || unit.kind === "delete") return
        }
        const moves = movesOf(plan, key.table)
        let present: RecordRow | undefined
        if (db && tables.has(key.table)) {
          const sql = `${found.table}\n${found.columns.join("\n")}`
          let lookup = lookups.get(sql)
          if (!lookup) lookups.set(sql, lookup = lookupStatement(db, found.table, found.columns))
          const row = lookup.get(...movedKey(places, found, moves))
          present = row && { ...row }
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
            const planned: DatabasePlan["rows"][number] = { id: unit.id, head: unit.head, delete: action === "delete", replace: action === "replace" }
            plan.rows.push(planned)
            if (newest && moved) report.movedPaths += Object.keys(newest).filter((column) => newest[column] !== moved[column]).length
            // A row goes in whole, every column it was captured with: one the table here has no place for fails the write.
            if (action !== "delete") {
              if (newest) fits(key.table, newest)
              else unread.push({ row: planned, table: key.table })
            }
          }
        }
      }
      // A table with a rowid alias may hold units an earlier build named by the alias: each is found by its content,
      // and where two units name one row, the newest capture of it stands.
      const numbered: { unit: z.infer<typeof UnitHeadSchema>; key: RowKey; capturedAt: number }[] = []
      for (const row of this.prepared(`
        SELECT u.id, u.key, u.role, u.head, v.kind, v.size, v.digest, v.captured_at FROM session_units su JOIN units u ON u.id = su.unit JOIN versions v ON v.unit = u.id AND v.seq = u.head
        WHERE su.session = ? AND u.harness = ? AND u.key >= ? AND u.key < ? ORDER BY u.key`).iterate(session, harness, `${name}\t`, `${name}\n`)) {
        const unit = UnitHeadSchema.parse(row)
        if (unit.role === "schema") {
          plan.schema = { id: unit.id, head: unit.head }
          continue
        }
        const key = rowKeyOf(unit.key)
        if (identity.of(key.table)?.alias) numbered.push({ unit, key, capturedAt: CapturedAtSchema.parse(row).captured_at })
        else await consider(unit, key, key)
      }
      const standing = new Map<string, { unit: z.infer<typeof UnitHeadSchema>; key: RowKey; found: RowKey; capturedAt: number }>()
      for (const { unit, key, capturedAt } of numbered) {
        const spec = identity.of(key.table)!
        let found = key
        if (!sameColumns(key.columns, spec.columns)) {
          const seq = unit.kind === "delete" ? this.lastContentSeq(unit.id) : unit.head
          if (seq < 0) continue
          const content = decodeRow(await this.versionBytes(unit.id, seq))
          found = { table: key.table, columns: spec.columns, values: spec.columns.map((column) => content[column] ?? null) }
        }
        const named = rowUnitKey(name, key.table, found.columns, Object.fromEntries(found.columns.map((column, index) => [column, found.values[index] ?? null])))
        const held = standing.get(named)
        if (!held || held.capturedAt < capturedAt) standing.set(named, { unit, key, found, capturedAt })
      }
      for (const [named, { unit, key, found }] of standing) {
        plan.resolved.add(named)
        await consider(unit, key, found)
      }
      // Asked as the plan is made, so a dry run sees it too, and a restore it refuses writes nothing (`RestoreReport.outdated`).
      // What's read is kept for the write, up to a bound, so a restore reads each row once.
      let next = 0
      let kept = 0
      await Promise.all(Array.from({ length: Math.min(ROWS_READ_AT_ONCE, unread.length) }, async () => {
        for (let each = unread[next++]; each; each = unread[next++]) {
          const bytes = await this.versionBytes(each.row.id, each.row.head)
          fits(each.table, decodeRow(bytes))
          if (kept + bytes.length <= ROW_BYTES_KEPT) {
            kept += bytes.length
            each.row.bytes = bytes
          }
        }
      }))
    } finally {
      db?.close()
      closeIdentities()
    }
    report.rows.push(...tallies.values())
    return plan
  }

  /**
   * How a row of each table is found and written (`rowIdentity`): as the destination's table declares it, else, for a
   * table it lacks, as the schema the rows were captured under does, read into a database of its own.
   */
  private async rowIdentities(name: string, db: DatabaseSync | null, tables: ReadonlySet<string>): Promise<{ of: (table: string) => ForkIdentity | null; columns: (table: string) => ReadonlySet<string> | null; close: () => void }> {
    const schema = this.schemaUnit(name)
    let captured: DatabaseSync | null = null
    let capturedTables = new Set<string>()
    if (schema) {
      captured = new DatabaseSyncConstructor(":memory:")
      applySchema(captured, SchemaSnapshotSchema.parse(JSON.parse((await this.versionBytes(schema.id, schema.head)).toString("utf8"))))
      capturedTables = new Set(TableNameSchema.array().parse(captured.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).map((row) => row.name))
    }
    const found = new Map<string, ForkIdentity | null>()
    const columns = new Map<string, ReadonlySet<string> | null>()
    /** Where a table's rows are written: the destination's table, else the one the restore makes from the captured schema. */
    const holder = (table: string) => (db && tables.has(table) ? db : captured && capturedTables.has(table) ? captured : null)
    return {
      of: (table) => {
        if (!found.has(table)) {
          const at = holder(table)
          found.set(table, at && rowIdentity(at, table))
        }
        return found.get(table) ?? null
      },
      columns: (table) => {
        if (!columns.has(table)) {
          const at = holder(table)
          columns.set(table, at && new Set(TableNameSchema.array().parse(at.prepare("SELECT name FROM pragma_table_xinfo(?)").all(table)).map((column) => column.name)))
        }
        return columns.get(table) ?? null
      },
      close: () => captured?.close(),
    }
  }

  /** A row unit's identity as its last content gives it: for one an earlier build named by the alias. */
  private async contentKey(unit: number, table: string, columns: readonly string[]): Promise<RowKey | null> {
    const seq = this.lastContentSeq(unit)
    if (seq < 0) return null
    const content = decodeRow(await this.versionBytes(unit, seq))
    return { table, columns: [...columns], values: columns.map((column) => content[column] ?? null) }
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
      if (plan.schema) applySchema(db, SchemaSnapshotSchema.parse(JSON.parse((await this.versionBytes(plan.schema.id, plan.schema.head)).toString("utf8"))))
      // One statement per table and set of columns, however many rows use it.
      const statements = new Map<string, StatementSync>()
      const statement = (sql: string) => {
        let prepared = statements.get(sql)
        if (!prepared) statements.set(sql, prepared = db.prepare(sql))
        return prepared
      }
      // A table whose rowid alias isn't its rows' name (`keyColumns`) has them found by their name, a row there updated in
      // place, and new rows added in the order the session numbered them: under the same number where it's free, so the
      // row reads as it did; under one SQLite gives it where another session's row has it.
      const identities = new Map<string, ForkIdentity>()
      const identityOf = (table: string) => {
        let found = identities.get(table)
        if (!found) identities.set(table, found = rowIdentity(db, table))
        return found
      }
      const where = (columns: readonly string[]) => columns.map((column) => `${quoted(column)} IS ?`).join(" AND ")
      const numbered = new Map<string, { values: RecordRow; at: bigint }[]>()
      for (const row of plan.rows) {
        const key = rowKeyOf(KeySchema.parse(this.prepared("SELECT key FROM units WHERE id = ?").get(row.id)).key)
        const moves = movesOf(plan, key.table)
        const { columns, alias } = identityOf(key.table)
        if (row.delete) {
          // A unit an earlier build named by the alias is found by what its last content says.
          const found = !alias || sameColumns(key.columns, columns) ? key : await this.contentKey(row.id, key.table, columns)
          if (found) statement(`DELETE FROM ${quoted(key.table)} WHERE ${where(found.columns)}`).run(...movedKey(places, found, moves))
          continue
        }
        const decoded = decodeRow(row.bytes ?? await this.versionBytes(row.id, row.head))
        const values = moves ? moveRow(places, decoded, moves) : decoded
        if (!alias) {
          const names = Object.keys(values)
          statement(`INSERT OR REPLACE INTO ${quoted(key.table)} (${names.map(quoted).join(", ")}) VALUES (${names.map(() => "?").join(", ")})`)
            .run(...names.map((column) => values[column] ?? null))
          continue
        }
        const { [alias]: at, ...rest } = values
        const names = Object.keys(rest)
        if (row.replace) {
          statement(`UPDATE ${quoted(key.table)} SET ${names.map((column) => `${quoted(column)} = ?`).join(", ")} WHERE ${where(columns)}`)
            .run(...names.map((column) => rest[column] ?? null), ...columns.map((column) => rest[column] ?? null))
          continue
        }
        const list = numbered.get(key.table) ?? []
        list.push({ values: rest, at: BigIntSchema.catch(0n).parse(at) })
        numbered.set(key.table, list)
      }
      for (const [table, rows] of numbered) {
        const { alias } = identityOf(table)
        rows.sort((left, right) => (left.at < right.at ? -1 : left.at > right.at ? 1 : 0))
        for (const { values, at } of rows) {
          const taken = statement(`SELECT 1 FROM ${quoted(table)} WHERE ${quoted(alias!)} = ?`).get(at)
          const row = taken ? values : { [alias!]: at, ...values }
          const names = Object.keys(row)
          statement(`INSERT OR REPLACE INTO ${quoted(table)} (${names.map(quoted).join(", ")}) VALUES (${names.map(() => "?").join(", ")})`)
            .run(...names.map((column) => row[column] ?? null))
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
  /**
   * Each row to write or delete by its unit and newest version, its key read again when it's written: a session can own
   * millions. `bytes`: the version as the plan read it for its columns, while they fit `ROW_BYTES_KEPT`.
   */
  rows: { id: number; head: number; delete: boolean; replace?: boolean; bytes?: Buffer }[]
  /** The unit keys, by identity, of the rows of tables with a rowid alias, for what the destination holds that Mako saw. */
  resolved: Set<string>
  /** Path columns by table, moved as the plan compared them. */
  moves: Record<string, string[]>
  /** Columns the rows to write hold that the table they go into has no place for, as `table.column` (`OutdatedRuntime.lacks`). */
  lacks: string[]
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

function sameColumns(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((column, index) => column === right[index])
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

/** Adds each of `versions` to `list` once, in the order they first come. */
function note(list: string[], versions: readonly string[]): void {
  for (const version of versions) if (!list.includes(version)) list.push(version)
}
