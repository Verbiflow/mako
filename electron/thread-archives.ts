import { DatabaseSync } from "node:sqlite"
import { createHash } from "node:crypto"
import { z } from "zod"
import { shownKeyOf, threadShownKey, type ArchiveCommand, type NativeArchive, type ThreadArchiveSnapshot } from "./contracts/thread-lifecycle.js"

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
   * Restore markers by the archive key each is for. A marker says a Session
   * its harness archived is shown here anyway (`threadShownKey`).
   */
  shown(): Map<string, string[]> {
    const markers = new Map<string, string[]>()
    const rows = this.db.prepare("SELECT key FROM archives WHERE key >= 'shown:' AND key < 'shownA'").all()
    for (const row of rows) {
      const marker = z.object({ key: z.string() }).parse(row).key
      const key = shownKeyOf(marker)
      if (key !== undefined) markers.set(key, [...(markers.get(key) ?? []), marker])
    }
    return markers
  }
  /**
   * `archive` is the harness's own archive of the target. Restoring a Session
   * it archived records that it's shown anyway, for that archive; archiving
   * it here forgets every such record.
   */
  set(command: ArchiveCommand, keys: string[], archive: NativeArchive = {}): ThreadArchiveSnapshot {
    const digest = createHash("sha256").update(JSON.stringify(command)).digest("hex")
    this.db.exec("BEGIN IMMEDIATE")
    try {
      const old = this.db.prepare("SELECT digest FROM receipts WHERE id=?").get(command.id)
      if (old) {
        if (z.object({ digest: z.string() }).parse(old).digest !== digest) throw new Error("This archive request ID was already used for another action")
      } else {
        const insert = this.db.prepare("INSERT OR IGNORE INTO archives VALUES (?)")
        const remove = this.db.prepare("DELETE FROM archives WHERE key=?")
        const shown = this.shown()
        for (const key of new Set(keys)) {
          const marker = archive.nativeArchived && !command.archived ? threadShownKey(key, archive.nativeArchiveStamp) : undefined
          for (const old of shown.get(key) ?? []) if (old !== marker) remove.run(old)
          if (command.archived) insert.run(key)
          else remove.run(key)
          if (marker) insert.run(marker)
        }
        this.db.prepare("INSERT INTO receipts VALUES (?, ?)").run(command.id, digest)
        this.db.prepare("UPDATE revision SET value=value+1 WHERE id=1").run()
      }
      this.db.exec("COMMIT")
    } catch (error) { this.db.exec("ROLLBACK"); throw error }
    return this.snapshot()
  }
  /** Drop restore markers a harness has moved past; unchanged when none of them is held. */
  forget(markers: readonly string[]): ThreadArchiveSnapshot | null {
    if (markers.length === 0) return null
    this.db.exec("BEGIN IMMEDIATE")
    try {
      const remove = this.db.prepare("DELETE FROM archives WHERE key=?")
      let removed = 0
      for (const marker of new Set(markers)) removed += Number(remove.run(marker).changes)
      if (removed > 0) this.db.prepare("UPDATE revision SET value=value+1 WHERE id=1").run()
      this.db.exec("COMMIT")
      return removed > 0 ? this.snapshot() : null
    } catch (error) { this.db.exec("ROLLBACK"); throw error }
  }
  close() { this.db.close() }
}
