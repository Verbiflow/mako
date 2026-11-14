import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { mkdtempSync, realpathSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { test } from "node:test"
import { contentRef } from "@mako/host/attribution/content"
import { vacuumIfSparse } from "@mako/host/attribution/journal-vacuum"
import { JournalStore } from "@mako/host/attribution/journal-store"

/* The record of changes is compacted as its owner opens it only when its free pages are many, and keeps what it holds. */

function sparse(folder: string, kept: number, dropped: number) {
  const path = join(folder, "journal.sqlite")
  const store = JournalStore.open(path, { device: "vacuum" })
  const keptRefs: string[] = []
  store.transaction(() => {
    for (let index = 0; index < kept + dropped; index++) {
      const bytes = randomBytes(16 * 1024)
      const ref = contentRef(bytes)
      store.putBlob(ref, bytes, Date.now())
      if (index < kept) keptRefs.push(ref)
    }
  })
  store.close()
  // The rest go, as a collection drops them: their pages are free.
  const db = new DatabaseSync(path)
  db.prepare(`DELETE FROM blobs WHERE ref NOT IN (${keptRefs.map(() => "?").join(", ")})`).run(...keptRefs)
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
  db.close()
  return { path, keptRefs }
}

test("a journal mostly free pages is compacted, and keeps what it holds", async () => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "mako-journal-vacuum-")))
  try {
    const { path, keptRefs } = sparse(folder, 20, 400)
    const before = statSync(path).size
    const done = await vacuumIfSparse(path, { freeBytes: 1024 * 1024, freeShare: 0.25 })
    assert.ok(done.ok && done.vacuumed, JSON.stringify(done))
    assert.ok(statSync(path).size < before / 4, `${statSync(path).size} not under a quarter of ${before}`)
    const store = JournalStore.open(path, { device: "vacuum" })
    for (const ref of keptRefs) assert.ok(store.hasBlob(ref))
    store.close()
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})

test("a journal with few free pages is left as it is", async () => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "mako-journal-vacuum-")))
  try {
    const { path } = sparse(folder, 400, 20)
    const done = await vacuumIfSparse(path, { freeBytes: 1024 * 1024, freeShare: 0.25 })
    assert.ok(done.ok && !done.vacuumed, JSON.stringify(done))
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})
