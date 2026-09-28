import { DatabaseSync } from "node:sqlite"
import { createHash } from "node:crypto"
import { z } from "zod"
import { threadShownKey, type ArchiveCommand, type ThreadArchiveSnapshot } from "./contracts/thread-lifecycle.js"

export class ThreadArchives {
  private readonly db: DatabaseSync
  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS archives (key TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, digest TEXT NOT NULL); CREATE TABLE IF NOT EXISTS revision (id INTEGER PRIMARY KEY CHECK (id=1), value INTEGER NOT NULL); INSERT OR IGNORE INTO revision VALUES (1,0)")
  }
  snapshot(): ThreadArchiveSnapshot {
    const revision = z.object({ value: z.number() }).parse(this.db.prepare("SELECT value FROM revision WHERE id=1").get()).value
    const keys = this.db.prepare("SELECT key FROM archives ORDER BY key").all().map((row) => z.object({ key: z.string() }).parse(row).key)
    return { revision, keys }
  }
  /**
   * `natively` says the harness itself archived the target. Restoring such a
   * Session records that it's shown anyway; archiving it again forgets that.
   */
  set(command: ArchiveCommand, keys: string[], natively = false): ThreadArchiveSnapshot {
    const digest = createHash("sha256").update(JSON.stringify(command)).digest("hex")
    this.db.exec("BEGIN IMMEDIATE")
    try {
      const old = this.db.prepare("SELECT digest FROM receipts WHERE id=?").get(command.id)
      if (old) {
        if (z.object({ digest: z.string() }).parse(old).digest !== digest) throw new Error("This archive request ID was already used for another action")
      } else {
        const insert = this.db.prepare("INSERT OR IGNORE INTO archives VALUES (?)")
        const remove = this.db.prepare("DELETE FROM archives WHERE key=?")
        for (const key of new Set(keys)) {
          if (command.archived) {
            insert.run(key)
            remove.run(threadShownKey(key))
          } else {
            remove.run(key)
            if (natively) insert.run(threadShownKey(key))
          }
        }
        this.db.prepare("INSERT INTO receipts VALUES (?, ?)").run(command.id, digest)
        this.db.prepare("UPDATE revision SET value=value+1 WHERE id=1").run()
      }
      this.db.exec("COMMIT")
    } catch (error) { this.db.exec("ROLLBACK"); throw error }
    return this.snapshot()
  }
  close() { this.db.close() }
}
