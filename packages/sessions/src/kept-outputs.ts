import { chmodSync, existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { makoUserRoot } from "./mako-root.js"
import type { DatabaseSync } from "node:sqlite"
import { z } from "zod"
import type { NativeStores } from "./read-only-sqlite.js"
import { declareStoreFormat, inspectStoreFormat, readStoreFormat, storeAccess, writeStoreFormat, type StoreStanding } from "./store-format.js"

/**
 * Bounded copies of what background work printed, for harnesses that keep
 * it only in a file of their own that the system or the harness clears:
 * Claude Code under `/tmp/claude-<uid>`, which a reboot empties, and
 * Cursor's `terminals` folder. An event's body reads the file while it is
 * there and keeps what it read here, so the same body opens after the file
 * is gone. Only what the body shows is kept: the end of the output
 * (`outputTail`, at most 8 KB and 40 lines) and how it ended, never the
 * whole file.
 *
 * It lives beside the session archive (`~/.mako/archive/outputs.sqlite`),
 * which keeps the conversations themselves and the attachments their
 * harnesses keep only in temporary files, per user like the archive:
 * the live driver writes what it reads in the host, and the history reader
 * in whichever process reads the store.
 */

/** A body's native identity: the harness, the session (or the folder Cursor keeps the terminal under), and the task. */
export interface OutputKey {
  harness: string
  session: string
  task: string
}

/** What a body showed of a command's output, and how it ended when the file said. */
export interface KeptOutput {
  output?: string
  exitCode?: number
  durationMs?: number
}

/** Where a body came from: the harness's own file, or the copy kept of it. */
export type OutputOrigin = "output-file" | "kept-copy"

const KeptOutputSchema = z.object({
  output: z.string().optional(),
  exitCode: z.number().int().optional(),
  durationMs: z.number().int().nonnegative().optional(),
})
const ValueRow = z.object({ value: z.string() })
const DataVersionSchema = z.object({ data_version: z.number() })
const TotalsRow = z.object({ count: z.number(), bytes: z.number() })

/** The most one copy holds; a tail is at most 8 KB of text, but three bytes a character is possible. */
const MAX_COPY_BYTES = 32 * 1024
/** Copies kept at most, and their bytes together; the oldest go first. */
export const KEPT_OUTPUTS_BUDGET = { copies: 4096, bytes: 16 * 1024 * 1024 }
/** How many copies one store keeps between counts of the whole; the budget can be passed by this many per writer meanwhile. */
const EVICT_EVERY = 32
/** Keys this process already knows are kept as they are, so re-reading a thread writes nothing. */
const REMEMBERED = 2048

/** The kept outputs of the user whose home this is. */
export function keptOutputsPath(home: string): string {
  return keptOutputsIn(makoUserRoot(home))
}

/** The kept outputs in a user root (`mako-root.ts`): an isolated host keeps its own. */
export function keptOutputsIn(root: string): string {
  return join(root, "archive", "outputs.sqlite")
}

/**
 * The store's format (`meta`, `@mako/sessions/store-format`). A build older
 * than a newer Mako's `schema` reads its copies and keeps none, leaving the
 * body to the file as before there were copies.
 */
const SCHEMA = 1

/** Where the copies at `path` stand for this build, read without writing: for Settings › Diagnostics. */
export function keptOutputsStanding(path: string): StoreStanding {
  const format = inspectStoreFormat(path, "meta")
  return format ? { access: storeAccess(format, SCHEMA), build: SCHEMA, format } : { access: "write", build: SCHEMA }
}

export class KeptOutputs {
  private readonly path: string
  private readonly stores: NativeStores | undefined
  private readonly budget: typeof KEPT_OUTPUTS_BUDGET
  private database: DatabaseSync | null = null
  /** The value last kept or read for a key, so an unchanged body is never written twice. */
  private readonly known = new Map<string, string>()
  private written = 0
  private readonly evictEvery: number
  /** Set once the store turns out to be in a newer Mako's format, at its open or since: copies are read and none is kept. */
  private newer = false
  private formatVersion = -1

  /**
   * `stores` is the host's: a strict one (the fixture desk) reads copies
   * other hosts kept and writes none.
   */
  constructor(path: string, stores?: NativeStores, budget = KEPT_OUTPUTS_BUDGET) {
    this.path = path
    this.stores = stores
    this.budget = budget
    // A tenth of the budget at most, so passing it between counts stays small.
    this.evictEvery = Math.max(1, Math.min(EVICT_EVERY, Math.floor(budget.copies / 10), Math.floor(budget.bytes / 10 / MAX_COPY_BYTES)))
  }

  /** Keep `value` for `key`, unless the same is kept already; the oldest copies go once the budget is spent. */
  keep(key: OutputKey, value: KeptOutput): void {
    if (this.stores?.strict) return
    const text = JSON.stringify(value)
    const bytes = Buffer.byteLength(text)
    if (bytes > MAX_COPY_BYTES || (!value.output && value.exitCode === undefined)) return
    const id = keyText(key)
    if (this.known.get(id) === text) return
    try {
      const database = this.writer()
      if (this.raised(database)) return
      const held = ValueRow.safeParse(database.prepare("SELECT value FROM outputs WHERE harness = ? AND session = ? AND task = ?")
        .get(key.harness, key.session, key.task)).data?.value
      if (held !== text) {
        database.prepare(`INSERT INTO outputs (harness, session, task, value, bytes, kept_at) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT (harness, session, task) DO UPDATE SET value = excluded.value, bytes = excluded.bytes, kept_at = excluded.kept_at`)
          .run(key.harness, key.session, key.task, text, bytes, Date.now())
        // Counting the store costs a scan; every so many copies is enough to hold the budget.
        if (this.written++ % this.evictEvery === 0) this.evict(database)
      }
      this.remember(id, text)
    } catch {
      // A copy that can't be kept leaves the body to the file, as before there were copies.
    }
  }

  /** The copy kept for `key`, if any. */
  read(key: OutputKey): KeptOutput | undefined {
    try {
      const strict = this.stores?.strict
      if (strict && !existsSync(this.path)) return undefined
      const database = strict ? this.stores!.open(this.path, { timeout: 2000 }) : this.writer()
      try {
        const row = ValueRow.safeParse(database.prepare("SELECT value FROM outputs WHERE harness = ? AND session = ? AND task = ?")
          .get(key.harness, key.session, key.task)).data
        if (!row) return undefined
        const value = KeptOutputSchema.safeParse(JSON.parse(row.value)).data
        if (value) this.remember(keyText(key), row.value)
        return value
      } finally {
        if (strict) database.close()
      }
    } catch {
      return undefined
    }
  }

  /** How many copies are kept and their bytes, for the doctor. */
  totals(): { copies: number; bytes: number } | undefined {
    try {
      if (!existsSync(this.path)) return { copies: 0, bytes: 0 }
      const database = this.stores?.strict ? this.stores.open(this.path, { timeout: 2000 }) : this.writer()
      try {
        const row = TotalsRow.parse(database.prepare("SELECT count(*) AS count, total(bytes) AS bytes FROM outputs").get())
        return { copies: row.count, bytes: row.bytes }
      } finally {
        if (this.stores?.strict) database.close()
      }
    } catch {
      return undefined
    }
  }

  close(): void {
    this.database?.close()
    this.database = null
  }

  private writer(): DatabaseSync {
    if (this.database) return this.database
    mkdirSync(join(this.path, ".."), { recursive: true, mode: 0o700 })
    const { DatabaseSync } = process.getBuiltinModule("node:sqlite")
    const created = !existsSync(this.path)
    const database = new DatabaseSync(this.path)
    try {
      // What a command printed can be private; only this user reads the copies, as only they read `/tmp/claude-<uid>`.
      if (created) chmodSync(this.path, 0o600)
      database.exec("PRAGMA busy_timeout = 2000")
      const hasMeta = database.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get()
      const format = hasMeta ? readStoreFormat(database, "meta") : undefined
      const access = storeAccess(format, SCHEMA)
      if (access === "refused") throw new Error("The kept outputs are in a newer Mako's format this build can't read")
      if (access === "read") {
        // A newer Mako's layout: read its copies as they are, and create or change nothing.
        this.newer = true
        return (this.database = database)
      }
      declareStoreFormat(database, SCHEMA)
      database.exec("PRAGMA journal_mode = WAL")
      // A copy lost to a power cut is read from its file again while that is there; no fsync per body.
      database.exec("PRAGMA synchronous = NORMAL")
      database.exec(`CREATE TABLE IF NOT EXISTS outputs (
        harness TEXT NOT NULL,
        session TEXT NOT NULL,
        task TEXT NOT NULL,
        value TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        kept_at INTEGER NOT NULL,
        PRIMARY KEY (harness, session, task)
      ) WITHOUT ROWID`)
      database.exec("CREATE INDEX IF NOT EXISTS outputs_kept_at ON outputs (kept_at)")
      database.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID")
      if (format === undefined) writeStoreFormat(database, "meta", { writableBy: SCHEMA, readableBy: SCHEMA })
    } catch (error) {
      database.close()
      throw error
    }
    return (this.database = database)
  }

  /** Whether a newer Mako's format holds the copies, read again after another build's commit; said once. */
  private raised(database: DatabaseSync): boolean {
    if (this.newer) return true
    const version = DataVersionSchema.parse(database.prepare("PRAGMA data_version").get()).data_version
    if (version === this.formatVersion) return false
    this.formatVersion = version
    if (storeAccess(readStoreFormat(database, "meta"), SCHEMA) === "write") return false
    console.warn("Command output isn't kept here: a newer Mako changed the store's format, so this build keeps none until it's updated")
    return (this.newer = true)
  }

  /** Drops the oldest copies until the budget holds again. */
  private evict(database: DatabaseSync): void {
    const totals = TotalsRow.parse(database.prepare("SELECT count(*) AS count, total(bytes) AS bytes FROM outputs").get())
    if (totals.count <= this.budget.copies && totals.bytes <= this.budget.bytes) return
    // A tenth beyond the excess, so a full store doesn't evict on every write.
    const over = Math.max(totals.count - this.budget.copies, Math.ceil((totals.bytes - this.budget.bytes) / Math.max(1, totals.bytes / totals.count)), 0)
    const drop = over + Math.ceil(this.budget.copies / 10)
    database.prepare(`DELETE FROM outputs WHERE (harness, session, task) IN
      (SELECT harness, session, task FROM outputs ORDER BY kept_at LIMIT ?)`).run(drop)
    this.known.clear()
  }

  private remember(id: string, text: string): void {
    this.known.delete(id)
    this.known.set(id, text)
    if (this.known.size > REMEMBERED) this.known.delete(this.known.keys().next().value!)
  }
}

function keyText(key: OutputKey): string {
  return `${key.harness}\u0000${key.session}\u0000${key.task}`
}
