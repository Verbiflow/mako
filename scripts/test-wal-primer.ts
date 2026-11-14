/**
 * `WalPrimer` writes a journal's WAL header off the host's thread: a journal closed cleanly has no WAL, and the
 * primer leaves one with its header and one frame, which changes nothing the journal reads, so the read-in's commit
 * appends to it. A WAL that already holds frames, and a stopped primer, are left alone. That the sync itself moves is
 * a system call's to show, not a test's here: on Linux, `strace -f -e trace=fsync` shows the WAL's sync on the
 * primer's thread and none on the host's at its first commit.
 *
 *   npx tsx scripts/test-wal-primer.ts
 */
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { WalPrimer } from "@mako/host/conversations/wal-primer"

const root = mkdtempSync(join(tmpdir(), "mako-wal-primer-"))
const walSize = (path: string) => statSync(`${path}-wal`, { throwIfNoEntry: false })?.size ?? 0
const journal = (path: string) => {
  const db = new DatabaseSync(path)
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; CREATE TABLE IF NOT EXISTS blocks (id INTEGER PRIMARY KEY, value TEXT NOT NULL)")
  return db
}
const primer = new WalPrimer()
try {
  // Closed cleanly: no WAL, primed to its header and a frame, the data and its version as they were.
  const path = join(root, `${randomUUID()}.sqlite`)
  let db = journal(path)
  db.exec("PRAGMA user_version=7; INSERT INTO blocks (value) VALUES ('first')")
  db.close()
  assert.equal(existsSync(`${path}-wal`), false, "a clean close leaves no WAL")
  db = journal(path)
  assert.equal(await primer.prime(path), true, "a journal with no WAL is primed")
  assert.ok(walSize(path) > 32, `its WAL holds its header and a frame (${walSize(path)} bytes)`)
  db.exec("INSERT INTO blocks (value) VALUES ('second')")
  assert.deepEqual(db.prepare("SELECT value FROM blocks ORDER BY id").all().map((row) => row.value), ["first", "second"], "the journal reads and commits as it did")
  assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 7, "its version is as it was")

  // A WAL that already holds frames, as a crash leaves it: nothing to prime.
  assert.equal(await primer.prime(path), false, "a WAL with frames is left alone")
  db.close()

  // Stopped, as the host stopping stops it: nothing is primed.
  const other = join(root, `${randomUUID()}.sqlite`)
  journal(other).close()
  primer.stop()
  assert.equal(await primer.prime(other), false, "a stopped primer primes nothing")
  assert.equal(existsSync(`${other}-wal`), false, "and writes nothing")
  console.log("WAL primer: a cleanly closed journal's WAL header written off the thread, its data and version kept; a WAL with frames and a stopped primer left alone")
} finally {
  primer.stop()
  rmSync(root, { recursive: true, force: true })
}
