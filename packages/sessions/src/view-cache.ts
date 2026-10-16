import { constants } from "node:fs"
import { createHash, randomUUID } from "node:crypto"
import { copyFile, mkdir, readdir, rename, rm, stat, utimes } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { DatabaseSync, type SQLOutputValue, type StatementSync } from "node:sqlite"
import { zstdCompressSync, zstdDecompressSync } from "node:zlib"
import { z } from "zod"
import { EntrySchema, type Entry } from "./entries.js"
import { entryChars, trimToolOutput, VIEWER_PAGE, type Thread, type ThreadPageOptions, type ThreadTail } from "./format.js"
import type { ResumePoint } from "./jsonl.js"
import { ResumePointSchema, ThreadRefSchema, UnreadRecordSchema } from "./thread-schema.js"

/** Where Mako keeps decoded sessions on this machine, beside the records they're decoded from. */
export function makoViews(home = homedir()): string {
  return join(home, ".mako", "views")
}

/** What the cache holds at most, on disk or in memory; the views read longest ago go first. */
export const VIEW_CACHE_BYTES = 512 * 1024 * 1024
/**
 * A session that decodes faster than this isn't worth a file. A view reads
 * back in 0.3 to 3 ms, and a decode measured warm runs at about half its
 * cold time, so a session that decodes in 30 ms here costs 40 to 60 at launch.
 */
export const VIEW_MIN_DECODE_MS = 10
/** The view format; a file of another is decoded again. The zstd-blob views before it were format 1. */
const FORMAT = 2
const EXTENSION = ".view.db"
/** Format 1's files, removed where they're found. */
const LEGACY_EXTENSION = ".view"
/** A body longer than this is kept zstd-compressed. */
const COMPRESS_FROM = 1024
/**
 * Each entry is kept whole and, when a page would trim it, as the page
 * shows it: tool output cut to this many characters (`trimToolOutput`).
 * A page reads the brief form and never the whole of a long output.
 */
const BRIEF_CHARS = VIEWER_PAGE.toolOutputChars
/** The most entries a page holds, as `ThreadPage`s have always been cut. */
const PAGE_ENTRIES = 200
/** Views kept open for paging, newest use last. */
const OPEN_VIEWS = 8
/** Views a catalog keeps in memory at most, whatever they weigh. */
const MEMORY_VIEWS = 16
/**
 * A view in memory of a thread this small holds it as decoded: a database
 * of its own costs more to build and page (about half a millisecond) than
 * the whole thread weighs.
 */
const WHOLE_VIEW_CHARS = 64 * 1024

/** The native file a view was decoded from, as the catalog stamps it. */
export interface ViewStamp {
  bytes: number
  mtimeMs: number
  revision?: string
}

const MetaSchema = z.object({
  format: z.literal(FORMAT),
  path: z.string(),
  bytes: z.number(),
  mtimeMs: z.number(),
  revision: z.string().optional(),
  translator: z.string(),
  decodeMs: z.number(),
  at: z.number(),
  ref: ThreadRefSchema,
  checkpoint: z.number().optional(),
  unread: z.array(UnreadRecordSchema).optional(),
  /** Where a decode of the record once it grew can start again (`Thread.resume`). */
  resume: ResumePointSchema.optional(),
  /** Decodes continued from `resume` since the record was last decoded whole, and the last's time. */
  continued: z.object({ count: z.number().int().positive(), ms: z.number() }).optional(),
  /** Entries, and their characters (`entryChars`). */
  total: z.number().int().nonnegative(),
  chars: z.number().int().nonnegative(),
})
/** What a view says of itself: where it was decoded from, by which build, and what it holds. */
export type ViewMeta = z.infer<typeof MetaSchema>

export interface ViewCacheStats {
  views: number
  bytes: number
}

/** A view on disk, without its entries. */
export type ViewSummary = ViewMeta & { file: string; size: number; usedAt: number }

const SCHEMA = `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE entries (
    seq INTEGER PRIMARY KEY,
    id TEXT UNIQUE,
    type TEXT NOT NULL,
    chars INTEGER NOT NULL,
    brief_chars INTEGER NOT NULL,
    body BLOB NOT NULL,
    brief BLOB
  );
`

/** A decoded session as the catalog serves it: a view on disk or in memory, or a thread held whole. */
/** A run of a view's entries and the index of its first. */
export interface ViewPage {
  entries: Entry[]
  start: number
}

export interface SessionView {
  readonly ref: Thread["ref"]
  readonly checkpoint?: number
  readonly unread?: Thread["unread"]
  readonly resume?: ResumePoint
  /** Entries in the session. */
  readonly total: number
  /** Their characters (`entryChars`), where a view on disk counted them. */
  readonly chars?: number
  /** `translatorBuild()` of the decoder that made it. */
  readonly translator: string
  page(before: number | undefined, limit: number, options: ThreadPageOptions): ViewPage
  entry(id: string): Entry | null
  /** The entry at `index`, whole. */
  at(index: number): Entry | null
  /** Every entry from `from` on, whole. */
  entries(from?: number): Entry[]
  thread(): Thread
}

/**
 * At most `limit` entries of `entries` ending before `end`, as
 * `ThreadPageOptions` asks for them, and the index of the first: tool output
 * cut to its head, and earlier entries dropped once the page holds
 * `maxChars`. The newest entry always stays.
 */
export function pageOf(entries: readonly Entry[], end: number, limit: number, options: ThreadPageOptions): ViewPage {
  const start = Math.max(0, end - Math.min(PAGE_ENTRIES, Math.max(1, limit)))
  let page = entries.slice(start, end)
  if (options.toolOutputChars !== undefined) page = trimToolOutput(page, options.toolOutputChars)
  const keep = kept(page.map(entryChars), options.maxChars)
  return { entries: keep ? page.slice(keep) : page, start: start + keep }
}

/** A thread held whole, served as a view: an archive's copy, which has no view of its own. */
export class ThreadView implements SessionView {
  constructor(private readonly whole: Thread, readonly translator: string) {}

  get ref() { return this.whole.ref }
  get checkpoint() { return this.whole.checkpoint }
  get unread() { return this.whole.unread }
  get resume() { return this.whole.resume }
  get total() { return this.whole.entries.length }

  page(before: number | undefined, limit: number, options: ThreadPageOptions): ViewPage {
    return pageOf(this.whole.entries, Math.min(this.total, Math.max(0, before ?? this.total)), limit, options)
  }

  entry(id: string): Entry | null {
    return this.whole.entries.find((entry) => entry.id === id) ?? null
  }

  at(index: number): Entry | null {
    return this.whole.entries[index] ?? null
  }

  entries(from = 0): Entry[] {
    return this.whole.entries.slice(from)
  }

  thread(): Thread {
    return this.whole
  }
}

/** A small view in memory (`WHOLE_VIEW_CHARS`): its thread held as decoded, with the meta a view in a database has. */
class WholeView extends ThreadView {
  constructor(readonly meta: ViewMeta, whole: Thread) {
    super(whole, meta.translator)
  }

  get chars() { return this.meta.chars }

  holdsBefore(entries: readonly Entry[], index: number): boolean {
    const before = new Set(this.thread().entries.slice(0, index).map((entry) => entry.id))
    return entries.some((entry) => entry.id !== undefined && before.has(entry.id))
  }

  close(): void {}
}

/**
 * One decoded session: its meta and its entries in order, each entry a row
 * read on its own. A page reads a range of rows and an entry its one row,
 * so neither costs the session's size.
 */
export class View implements SessionView {
  private statements = new Map<string, StatementSync>()

  constructor(readonly meta: ViewMeta, private readonly db: DatabaseSync) {}

  get ref() { return this.meta.ref }
  get checkpoint() { return this.meta.checkpoint }
  get unread() { return this.meta.unread }
  get resume() { return this.meta.resume }
  get total() { return this.meta.total }
  get chars() { return this.meta.chars }
  get translator() { return this.meta.translator }

  /**
   * At most `limit` entries ending before `before`, as `ThreadPageOptions`
   * asks for them, and the index of the first: tool output cut to its head,
   * and earlier entries dropped once the page holds `maxChars`. The newest
   * entry always stays.
   */
  page(before: number | undefined, limit: number, options: ThreadPageOptions): ViewPage {
    const end = Math.min(this.meta.total, Math.max(0, before ?? this.meta.total))
    let start = Math.max(0, end - Math.min(PAGE_ENTRIES, Math.max(1, limit)))
    const cut = options.toolOutputChars
    if (cut !== undefined && cut !== BRIEF_CHARS) {
      // Another cut than the brief one: trim the whole entries as a page always has.
      let entries = trimToolOutput(this.range(start, end, "body"), cut)
      const keep = kept(entries.map(entryChars), options.maxChars)
      entries = entries.slice(keep)
      return { entries, start: start + keep }
    }
    if (options.maxChars !== undefined && end - start > 1) {
      const column = cut === undefined ? "chars" : "brief_chars"
      const sizes = this.prepare(`SELECT ${column} AS chars FROM entries WHERE seq >= ? AND seq < ? ORDER BY seq`)
        .all(start, end)
        .map((row) => Number(row["chars"]))
      start += kept(sizes, options.maxChars)
    }
    return { entries: this.range(start, end, cut === undefined ? "body" : "brief"), start }
  }

  /** The entry `id` whole. */
  entry(id: string): Entry | null {
    const row = this.prepare("SELECT body FROM entries WHERE id = ?").get(id)
    return row ? decodeEntry(row["body"]) : null
  }

  entries(from = 0): Entry[] {
    return this.range(from, this.meta.total, "body")
  }

  at(index: number): Entry | null {
    const row = this.prepare("SELECT body FROM entries WHERE seq = ?").get(index)
    return row ? decodeEntry(row["body"]) : null
  }

  /** Whether an entry before `index` has the id of one of `entries`. */
  holdsBefore(entries: readonly Entry[], index: number): boolean {
    const statement = this.prepare("SELECT seq FROM entries WHERE id = ?")
    return entries.some((entry) => {
      if (entry.id === undefined) return false
      const row = statement.get(entry.id)
      return row !== undefined && Number(row["seq"]) < index
    })
  }

  thread(): Thread {
    const thread: Thread = { ref: this.meta.ref, entries: this.entries() }
    if (this.meta.checkpoint !== undefined) thread.checkpoint = this.meta.checkpoint
    if (this.meta.unread) thread.unread = this.meta.unread
    if (this.meta.resume) thread.resume = this.meta.resume
    return thread
  }

  close(): void {
    this.statements.clear()
    if (this.db.isOpen) this.db.close()
  }

  private range(start: number, end: number, form: "body" | "brief"): Entry[] {
    if (end <= start) return []
    const column = form === "brief" ? "COALESCE(brief, body)" : "body"
    return this.prepare(`SELECT ${column} AS body FROM entries WHERE seq >= ? AND seq < ? ORDER BY seq`)
      .all(start, end)
      .map((row) => decodeEntry(row["body"]))
  }

  private prepare(sql: string): StatementSync {
    let statement = this.statements.get(sql)
    if (!statement) this.statements.set(sql, (statement = this.db.prepare(sql)))
    return statement
  }
}

/** How many of a page's leading entries `maxChars` drops, counting back from the newest, which always stays. */
function kept(sizes: readonly number[], maxChars: number | undefined): number {
  if (maxChars === undefined || sizes.length <= 1) return 0
  let chars = 0
  let keep = sizes.length
  while (keep > 0) {
    chars += sizes[keep - 1]!
    if (chars > maxChars && keep < sizes.length) break
    keep -= 1
  }
  return keep
}

function encodeBody(entry: Entry): Buffer {
  const json = Buffer.from(JSON.stringify(entry))
  return json.length > COMPRESS_FROM ? zstdCompressSync(json) : json
}

/** A body as `encodeBody` kept it: JSON as written (it opens with `{`), else a zstd frame. */
function decodeEntry(value: SQLOutputValue | undefined): Entry {
  if (!(value instanceof Uint8Array)) throw new Error("A view's entry is not a blob")
  const bytes = value[0] === 0x7b ? value : zstdDecompressSync(value)
  return EntrySchema.parse(JSON.parse(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8")))
}

/** Writes `entries` into `db`, one row each, from `seq`: the whole form, and the brief one when a page would trim it. Returns the characters they hold. */
function insertEntries(db: DatabaseSync, entries: readonly Entry[], seq: number): number {
  const insert = db.prepare("INSERT INTO entries (seq, id, type, chars, brief_chars, body, brief) VALUES (?, ?, ?, ?, ?, ?, ?)")
  const seen = new Set<string>()
  let chars = 0
  for (const entry of entries) {
    const [brief] = trimToolOutput([entry], BRIEF_CHARS)
    const shown = brief ?? entry
    const size = entryChars(entry)
    chars += size
    // Ids are unique in a decode (`EntrySink`); a repeat is kept, unnamed, rather than lose the entry.
    const id = entry.id !== undefined && !seen.has(entry.id) ? entry.id : null
    if (id !== null) seen.add(id)
    insert.run(seq++, id, entry.type, size, shown === entry ? size : entryChars(shown), encodeBody(entry), shown === entry ? null : encodeBody(shown))
  }
  return chars
}

function readMeta(db: DatabaseSync): ViewMeta | null {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'view'").get()
    const value = z.string().safeParse(row?.["value"])
    const parsed = MetaSchema.safeParse(value.success ? JSON.parse(value.data) : null)
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** Builds a view of `thread` in an empty database. */
function build(db: DatabaseSync, meta: Omit<ViewMeta, "total" | "chars">, thread: Thread): ViewMeta {
  db.exec(SCHEMA)
  db.exec("BEGIN")
  try {
    const chars = insertEntries(db, thread.entries, 0)
    const full: ViewMeta = { ...meta, total: thread.entries.length, chars }
    db.prepare("INSERT INTO meta (key, value) VALUES ('view', ?)").run(JSON.stringify(full))
    db.exec("COMMIT")
    return full
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }
}

/** Replaces `db`'s entries from `from` on with `tail`'s, and its meta with `meta`. */
function extend(db: DatabaseSync, meta: Omit<ViewMeta, "total" | "chars">, kept: ViewMeta, from: number, tail: ThreadTail): ViewMeta {
  db.exec("BEGIN")
  try {
    const dropped = Number(db.prepare("SELECT COALESCE(SUM(chars), 0) AS chars FROM entries WHERE seq >= ?").get(from)?.["chars"] ?? 0)
    db.prepare("DELETE FROM entries WHERE seq >= ?").run(from)
    const chars = insertEntries(db, tail.entries, from)
    const full: ViewMeta = { ...meta, total: from + tail.entries.length, chars: kept.chars - dropped + chars }
    db.prepare("UPDATE meta SET value = ? WHERE key = 'view'").run(JSON.stringify(full))
    db.exec("COMMIT")
    return full
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }
}

function sameStamp(meta: ViewMeta, stamp: ViewStamp): boolean {
  return meta.bytes === stamp.bytes && meta.mtimeMs === stamp.mtimeMs && meta.revision === stamp.revision
}

/** The size a view in memory weighs against the budget: its rows' bytes. */
function memoryBytes(db: DatabaseSync): number {
  const row = db.prepare("SELECT COALESCE(SUM(LENGTH(body) + COALESCE(LENGTH(brief), 0)), 0) AS bytes FROM entries").get()
  return Number(row?.["bytes"] ?? 0)
}

/**
 * Sessions as this build decodes them, so reading one again needn't decode
 * it again, and a page of one needn't read the rest: a large Codex rollout
 * takes seconds to decode, and a page of its view a millisecond. A view is
 * one SQLite file per session (`View`), or one database in memory for a
 * catalog that writes nothing. It is used while the session's stamp and the
 * decoder build both match the ones it was made from, and deleting any or
 * all of them is always safe.
 */
export class ViewCache {
  private writes: Promise<void> = Promise.resolve()
  /** Views open for reading, by session path, with the file each was opened from; newest use last. */
  private open = new Map<string, { view: View; ino: number }>()
  /** A catalog without a folder keeps its views here, newest use last. */
  private memory = new Map<string, { view: View | WholeView; bytes: number }>()

  /** `folder` null keeps the views in memory. */
  constructor(
    private readonly folder: string | null,
    private readonly translator: () => string,
    private readonly budget = VIEW_CACHE_BYTES
  ) {}

  /** The view of `path` made from exactly `stamp`: by this build, or by any when `current` is false. */
  async view(path: string, stamp: ViewStamp, current = true): Promise<View | WholeView | null> {
    const view = await this.opened(path)
    if (!view) return null
    if (!sameStamp(view.meta, stamp) || (current && view.meta.translator !== this.translator())) return null
    const open = this.open.get(path)
    if (open) {
      this.open.delete(path)
      this.open.set(path, open)
    }
    if (this.folder) {
      const now = new Date()
      await utimes(this.file(path), now, now).catch(() => undefined)
    } else {
      const held = this.memory.get(path)
      if (held) {
        this.memory.delete(path)
        this.memory.set(path, held)
      }
    }
    return view
  }

  /** The view of `path` made from exactly `stamp` by this build, whole; null otherwise. */
  async read(path: string, stamp: ViewStamp): Promise<Thread | null> {
    return (await this.view(path, stamp))?.thread() ?? null
  }

  /** The view of `path` made from exactly `stamp` by whichever build made it, whole, and that build's `translatorBuild()`. */
  async readAny(path: string, stamp: ViewStamp): Promise<{ thread: Thread; translator: string } | null> {
    const view = await this.view(path, stamp, false)
    return view && { thread: view.thread(), translator: view.meta.translator }
  }

  /** Keeps `thread`, decoded from `stamp` in `decodeMs`, once the writes before it are done. */
  write(path: string, stamp: ViewStamp, thread: Thread, decodeMs: number): Promise<void> {
    const meta: Omit<ViewMeta, "total" | "chars"> = {
      format: FORMAT, path, bytes: stamp.bytes, mtimeMs: stamp.mtimeMs, translator: this.translator(), decodeMs: Math.round(decodeMs), at: Date.now(), ref: thread.ref,
    }
    if (stamp.revision !== undefined) meta.revision = stamp.revision
    if (thread.checkpoint !== undefined) meta.checkpoint = thread.checkpoint
    if (thread.unread) meta.unread = thread.unread
    if (thread.resume) meta.resume = thread.resume
    const run = this.writes.then(() => this.writeNow(meta, thread))
    this.writes = run.catch(() => undefined)
    return run
  }

  /**
   * The view of `path` brought up to `stamp` from the last one this build
   * made of it, for a record that only grew: `read` continues that view's
   * decode from where it can start again (`ViewMeta.resume`), and the
   * entries from there on are replaced by what it read. Null where `read`
   * can't, or what it read names an entry the view holds before it: only a
   * whole decode can say what changed then.
   */
  async continued(path: string, stamp: ViewStamp, read: (from: ResumePoint, after: string | undefined) => Promise<ThreadTail | null>): Promise<View | WholeView | null> {
    if (!this.folder) return null
    await this.writes
    const previous = await this.opened(path)
    const from = previous?.meta.resume
    if (!previous || !from || previous.meta.translator !== this.translator() || stamp.bytes < previous.meta.bytes || sameStamp(previous.meta, stamp)) return null
    const started = performance.now()
    const tail = await read(from, from.entry > 0 ? previous.at(from.entry - 1)?.id : undefined)
    if (!tail || previous.holdsBefore(tail.entries, from.entry)) return null
    const ms = performance.now() - started
    const meta: Omit<ViewMeta, "total" | "chars"> = {
      format: FORMAT, path, bytes: stamp.bytes, mtimeMs: stamp.mtimeMs, translator: previous.meta.translator, decodeMs: previous.meta.decodeMs, at: Date.now(), ref: tail.ref,
      checkpoint: tail.checkpoint, continued: { count: (previous.meta.continued?.count ?? 0) + 1, ms: Math.round(ms * 10) / 10 },
    }
    if (stamp.revision !== undefined) meta.revision = stamp.revision
    if (tail.unread) meta.unread = tail.unread
    if (tail.resume) meta.resume = tail.resume
    const run = this.writes.then(() => this.continueNow(previous.meta, meta, from.entry, tail))
    this.writes = run.catch(() => undefined)
    await run
    return this.view(path, stamp)
  }

  async remove(path: string): Promise<void> {
    await this.writes
    this.forget(path)
    if (this.folder) await rm(this.file(path), { force: true })
  }

  /** Every view, newest use first. */
  async list(): Promise<ViewSummary[]> {
    const views: ViewSummary[] = []
    if (!this.folder) {
      for (const [path, held] of this.memory) views.push({ ...held.view.meta, file: path, size: held.bytes, usedAt: 0 })
      return views.reverse()
    }
    for (const file of await this.files()) {
      let db: DatabaseSync | undefined
      try {
        db = new DatabaseSync(file.path, { readOnly: true })
        const meta = readMeta(db)
        if (meta) views.push({ ...meta, file: file.path, size: file.size, usedAt: file.usedAt })
      } catch {
        // A file being replaced, or not a view: it isn't listed.
      } finally {
        db?.close()
      }
    }
    return views.sort((a, b) => b.usedAt - a.usedAt)
  }

  async stats(): Promise<ViewCacheStats> {
    if (!this.folder) return { views: this.memory.size, bytes: [...this.memory.values()].reduce((sum, held) => sum + held.bytes, 0) }
    let views = 0
    let bytes = 0
    for (const { size } of await this.files()) {
      views++
      bytes += size
    }
    return { views, bytes }
  }

  /** Resolves once every write asked for so far is done. */
  settled(): Promise<void> {
    return this.writes
  }

  /**
   * Drops the views in memory of the sessions `which` names. A store whose
   * stamp can miss a write (one database many sessions share) drops its
   * sessions' views when it's written.
   */
  forgetWhere(which: (path: string) => boolean): void {
    for (const path of this.memory.keys()) if (which(path)) this.forget(path)
  }

  /** Closes every view held open. */
  close(): void {
    for (const { view } of this.open.values()) view.close()
    this.open.clear()
    for (const held of this.memory.values()) held.view.close()
    this.memory.clear()
  }

  /** The view open for `path`, opening its file when none is or the one open is out of date. */
  private async opened(path: string): Promise<View | WholeView | null> {
    const held = this.memory.get(path)
    if (held) return held.view
    if (!this.folder) return null
    const file = this.file(path)
    const info = await stat(file).catch(() => null)
    const open = this.open.get(path)
    // A view written again is a new file: the one open is of what was there.
    if (open && info?.ino === open.ino) return open.view
    if (open) this.forget(path)
    if (!info) return null
    let db: DatabaseSync
    try {
      db = new DatabaseSync(file, { readOnly: true })
    } catch {
      return null
    }
    const meta = readMeta(db)
    if (!meta || meta.path !== path) {
      db.close()
      await rm(file, { force: true })
      return null
    }
    const view = new View(meta, db)
    this.open.set(path, { view, ino: info.ino })
    while (this.open.size > OPEN_VIEWS) {
      const [oldest] = this.open.keys()
      if (oldest === undefined) break
      this.forget(oldest)
    }
    return view
  }

  private forget(path: string): void {
    this.open.get(path)?.view.close()
    this.open.delete(path)
    this.memory.get(path)?.view.close()
    this.memory.delete(path)
  }

  private async writeNow(meta: Omit<ViewMeta, "total" | "chars">, thread: Thread): Promise<void> {
    if (!this.folder) {
      this.forget(meta.path)
      const chars = thread.entries.reduce((sum, entry) => sum + entryChars(entry), 0)
      if (chars <= WHOLE_VIEW_CHARS) {
        this.memory.set(meta.path, { view: new WholeView({ ...meta, total: thread.entries.length, chars }, thread), bytes: chars * 2 })
      } else {
        const db = new DatabaseSync(":memory:")
        build(db, meta, thread)
        const built = readMeta(db)
        if (!built) {
          db.close()
          throw new Error(`a view of ${meta.path} doesn't read back`)
        }
        this.memory.set(meta.path, { view: new View(built, db), bytes: memoryBytes(db) })
      }
      let total = [...this.memory.values()].reduce((sum, held) => sum + held.bytes, 0)
      for (const [path, held] of this.memory) {
        if ((total <= this.budget && this.memory.size <= MEMORY_VIEWS) || this.memory.size <= 1) break
        total -= held.bytes
        this.forget(path)
      }
      return
    }
    await mkdir(this.folder, { recursive: true })
    const file = this.file(meta.path)
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      const db = new DatabaseSync(temporary)
      try {
        db.exec("PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF")
        build(db, meta, thread)
      } finally {
        db.close()
      }
      await rename(temporary, file)
    } catch (error) {
      await rm(temporary, { force: true })
      throw error
    }
    this.forget(meta.path)
    await this.evict()
  }

  /** `continued`'s write: a copy of the view's file with the entries from `from` on replaced, put in its place. */
  private async continueNow(kept: ViewMeta, meta: Omit<ViewMeta, "total" | "chars">, from: number, tail: ThreadTail): Promise<void> {
    const file = this.file(meta.path)
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      // A clone where the file system makes one, so the copy costs the pages it changes.
      await copyFile(file, temporary, constants.COPYFILE_FICLONE)
      const db = new DatabaseSync(temporary)
      try {
        db.exec("PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF")
        extend(db, meta, kept, from, tail)
      } finally {
        db.close()
      }
      await rename(temporary, file)
    } catch (error) {
      await rm(temporary, { force: true })
      throw error
    }
    this.forget(meta.path)
    await this.evict()
  }

  private async evict(): Promise<void> {
    const files = await this.files()
    let total = files.reduce((sum, file) => sum + file.size, 0)
    for (const file of files.sort((a, b) => a.usedAt - b.usedAt)) {
      if (total <= this.budget) return
      await rm(file.path, { force: true })
      total -= file.size
    }
  }

  /** This format's files; format 1's are removed on the way. */
  private async files(): Promise<{ path: string; size: number; usedAt: number }[]> {
    const folder = this.folder
    if (!folder) return []
    const names = await readdir(folder).catch(() => [])
    const files = await Promise.all(names.map(async (name) => {
      const path = join(folder, name)
      if (name.endsWith(LEGACY_EXTENSION)) {
        await rm(path, { force: true })
        return null
      }
      if (name.endsWith(".tmp")) {
        // A write a crash cut short; one under way is younger than a minute.
        const info = await stat(path).catch(() => null)
        if (info && Date.now() - info.mtimeMs > 60_000) await rm(path, { force: true })
        return null
      }
      if (!name.endsWith(EXTENSION)) return null
      const info = await stat(path).catch(() => null)
      return info ? { path, size: info.size, usedAt: info.mtimeMs } : null
    }))
    return files.filter((file) => file !== null)
  }

  private file(path: string): string {
    return join(this.folder ?? "", `${createHash("sha256").update(path).digest("hex").slice(0, 40)}${EXTENSION}`)
  }
}
