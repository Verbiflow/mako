import { DatabaseSync } from "node:sqlite"
import type { JsonValue } from "./codex-app-json.js"
import type { UsageEvent } from "./usage-scan.js"

/** Where a file's last read stopped, and the reader's state there. */
export interface FileCursor {
  offset: number
  state: JsonValue
  /** Why part of the file was left unread; kept while the file is in the window. */
  unread?: string
}

/**
 * What harnesses' records said they spent, kept between summaries: each file
 * is read from where its last read stopped and each store from its own
 * cursor, so a summary costs what was written since the last one. Events
 * older than the window are dropped; a file's events stay after it is gone.
 */
export class UsageLedger {
  /** Bump when a reader or this schema changes what a record counts as: an older ledger is dropped and every file read again. */
  static readonly VERSION = 2

  private readonly db: DatabaseSync
  private queue: Promise<unknown> = Promise.resolve()

  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA journal_size_limit = 4194304;
      PRAGMA synchronous = NORMAL;
    `)
    if (Number(this.db.prepare("PRAGMA user_version").get()?.user_version) !== UsageLedger.VERSION) {
      this.db.exec(`
        DROP TABLE IF EXISTS files; DROP TABLE IF EXISTS stores; DROP TABLE IF EXISTS events; DROP TABLE IF EXISTS sessions;
        PRAGMA user_version = ${UsageLedger.VERSION};
      `)
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (source TEXT NOT NULL, identity TEXT NOT NULL, offset INTEGER NOT NULL, state TEXT NOT NULL, unread TEXT, PRIMARY KEY (source, identity));
      CREATE TABLE IF NOT EXISTS stores (source TEXT NOT NULL, id TEXT NOT NULL, cursor REAL NOT NULL, PRIMARY KEY (source, id));
      CREATE TABLE IF NOT EXISTS events (
        key TEXT PRIMARY KEY, source TEXT NOT NULL, session TEXT NOT NULL, at INTEGER NOT NULL, model TEXT NOT NULL, cwd TEXT NOT NULL,
        input INTEGER NOT NULL, output INTEGER NOT NULL, cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL, cache_write_1h INTEGER NOT NULL, cost REAL, summed INTEGER NOT NULL
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS events_at ON events (at);
      CREATE TABLE IF NOT EXISTS sessions (source TEXT NOT NULL, session TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (source, session)) WITHOUT ROWID;
    `)
  }

  /** Runs summaries one at a time: two reads of one file must not race on its cursor. */
  exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work)
    this.queue = run.catch(() => undefined)
    return run
  }

  /** A file's cursor by its identity on disk, wherever it has moved since. */
  cursor(source: string, identity: string): FileCursor | undefined {
    const row = this.db.prepare("SELECT offset, state, unread FROM files WHERE source = ? AND identity = ?").get(source, identity)
    if (!row) return undefined
    const state: JsonValue = JSON.parse(String(row.state))
    const cursor: FileCursor = { offset: Number(row.offset), state }
    if (row.unread !== null) cursor.unread = String(row.unread)
    return cursor
  }

  /** Records a file's events and where its read stopped, together. */
  advance(source: string, identity: string, cursor: FileCursor, events: readonly UsageEvent[]): void {
    this.transaction(() => {
      this.insert(events)
      this.db.prepare("INSERT OR REPLACE INTO files VALUES (?, ?, ?, ?, ?)")
        .run(source, identity, cursor.offset, JSON.stringify(cursor.state), cursor.unread ?? null)
    })
  }

  /** Files in the window with records left unread. */
  unreadFiles(): number {
    return Number(this.db.prepare("SELECT count(*) AS count FROM files WHERE unread IS NOT NULL").get()?.count ?? 0)
  }

  /** Forgets cursors of a source's files not seen in this summary: gone, or untouched for the whole window. */
  keepFiles(source: string, identities: ReadonlySet<string>): void {
    const rows = this.db.prepare("SELECT identity FROM files WHERE source = ?").all(source)
    const forget = this.db.prepare("DELETE FROM files WHERE source = ? AND identity = ?")
    this.transaction(() => {
      for (const row of rows) if (!identities.has(String(row.identity))) forget.run(source, String(row.identity))
    })
  }

  storeCursor(source: string, id: string): number | undefined {
    const row = this.db.prepare("SELECT cursor FROM stores WHERE source = ? AND id = ?").get(source, id)
    return row ? Number(row.cursor) : undefined
  }

  advanceStore(source: string, id: string, cursor: number | undefined, events: readonly UsageEvent[]): void {
    this.transaction(() => {
      this.insert(events)
      if (cursor === undefined) this.db.prepare("DELETE FROM stores WHERE source = ? AND id = ?").run(source, id)
      else this.db.prepare("INSERT OR REPLACE INTO stores VALUES (?, ?, ?)").run(source, id, cursor)
    })
  }

  /** Drops events before `since`; the window only moves forward. */
  forgetBefore(since: number): void {
    this.db.prepare("DELETE FROM events WHERE at < ?").run(since)
    this.db.prepare("DELETE FROM sessions WHERE at < ?").run(since)
  }

  /** Sessions with a call at or after `since`, a fork's copy of its parent's calls included. */
  sessions(since: number): number {
    return Number(this.db.prepare("SELECT count(*) AS count FROM sessions WHERE at >= ?").get(since)?.count ?? 0)
  }

  /** Every event at or after `since`, oldest first. */
  *events(since: number): Generator<UsageEvent> {
    for (const row of this.db.prepare("SELECT * FROM events WHERE at >= ? ORDER BY at, key").iterate(since)) {
      const event: UsageEvent = {
        key: String(row.key),
        source: String(row.source),
        session: String(row.session),
        timestamp: new Date(Number(row.at)).toISOString(),
        model: String(row.model),
        cwd: String(row.cwd),
        input: Number(row.input),
        output: Number(row.output),
        cacheRead: Number(row.cache_read),
        cacheWrite: Number(row.cache_write),
      }
      if (Number(row.cache_write_1h)) event.cacheWrite1h = Number(row.cache_write_1h)
      if (Number(row.summed)) event.summed = true
      if (row.cost !== null) event.reportedCost = Number(row.cost)
      yield event
    }
  }

  close(): void {
    this.db.close()
  }

  /** A key read again keeps the larger counts: a streamed call's later reading, or the same call in a fork. */
  private insert(events: readonly UsageEvent[]): void {
    if (!events.length) return
    const statement = this.db.prepare(`
      INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (key) DO UPDATE SET
        input = max(input, excluded.input), output = max(output, excluded.output),
        cache_read = max(cache_read, excluded.cache_read), cache_write = max(cache_write, excluded.cache_write),
        cache_write_1h = max(cache_write_1h, excluded.cache_write_1h),
        cost = CASE WHEN excluded.cost IS NULL THEN cost WHEN cost IS NULL THEN excluded.cost ELSE max(cost, excluded.cost) END
    `)
    const session = this.db.prepare("INSERT INTO sessions VALUES (?, ?, ?) ON CONFLICT (source, session) DO UPDATE SET at = max(at, excluded.at)")
    for (const event of events) {
      const at = Date.parse(event.timestamp)
      if (Number.isNaN(at)) continue
      statement.run(
        event.key, event.source, event.session, at, event.model, event.cwd,
        event.input, event.output, event.cacheRead, event.cacheWrite, event.cacheWrite1h ?? 0, event.reportedCost ?? null, event.summed ? 1 : 0
      )
      session.run(event.source, event.session, at)
    }
  }

  private transaction(work: () => void): void {
    this.db.exec("BEGIN")
    try {
      work()
      this.db.exec("COMMIT")
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
  }
}
