import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

/**
 * Copies as builds before the archive's migration kept them: the archive's
 * schema at `user_version` 1 with its writer triggers, one row per session,
 * its ref and its entries as JSON. This build writes no copies; tests make
 * the archives it migrates and reads with this.
 */
export async function keepCopies(root, threads) {
  await mkdir(root, { recursive: true })
  const database = new DatabaseSync(join(root, "archive.sqlite"))
  try {
    database.function("mako_archive_writer", () => 1)
    database.exec("PRAGMA journal_mode=WAL")
    if (database.prepare("PRAGMA user_version").get().user_version === 0) {
      database.exec(`
        CREATE TABLE sessions (path TEXT PRIMARY KEY, ref TEXT NOT NULL, entries TEXT NOT NULL, revision TEXT NOT NULL);
        CREATE TABLE archive_captures (path TEXT PRIMARY KEY, token TEXT NOT NULL, deleted INTEGER NOT NULL CHECK (deleted IN (0, 1)));
        CREATE INDEX sessions_capture_revision ON sessions(path, revision);
        CREATE TABLE archive_observations (path TEXT PRIMARY KEY, observed_revision TEXT NOT NULL, capture_token TEXT NOT NULL);
      `)
      for (const operation of ["INSERT", "UPDATE", "DELETE"])
        database.exec(`
          CREATE TRIGGER archive_writer_${operation.toLowerCase()} BEFORE ${operation} ON sessions BEGIN
            SELECT CASE WHEN mako_archive_writer() != 1 THEN RAISE(ABORT, 'Update Mako to write this session archive') END;
          END;
          CREATE TRIGGER archive_revision_${operation.toLowerCase()} AFTER ${operation} ON sessions BEGIN
            INSERT INTO archive_captures (path, token, deleted)
            VALUES (${operation === "DELETE" ? "OLD" : "NEW"}.path, lower(hex(randomblob(16))), ${operation === "DELETE" ? 1 : 0})
            ON CONFLICT(path) DO UPDATE SET token=excluded.token, deleted=excluded.deleted;
          END;
        `)
      database.exec("PRAGMA user_version=1")
    }
    const insert = database.prepare("INSERT OR REPLACE INTO sessions (path, ref, entries, revision) VALUES (?, ?, ?, ?)")
    database.exec("BEGIN")
    for (const thread of threads) insert.run(thread.ref.path, JSON.stringify(thread.ref), JSON.stringify(thread.entries), JSON.stringify(thread.ref))
    database.exec("COMMIT")
  } finally {
    database.close()
  }
}

/** A copy as the oldest builds kept one: a folder named by its path's hash, with `ref.json` and `entries.jsonl`. */
export async function keepLegacyCopy(root, thread) {
  const folder = join(root, createHash("sha1").update(thread.ref.path).digest("hex").slice(0, 24))
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, "ref.json"), JSON.stringify(thread.ref))
  await writeFile(join(folder, "entries.jsonl"), thread.entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n")
  return folder
}
