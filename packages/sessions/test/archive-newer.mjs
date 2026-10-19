import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { SessionArchive } from "../dist/archive.js"
import { keepCopies } from "./fixtures/archive-copies.mjs"

/**
 * An archive a newer Mako's format holds: this build opens it, reads the
 * copies it knows how to read, shows an entry it doesn't know raw, and
 * writes nothing, where it used to refuse with "Update Mako to open this
 * session archive format".
 */

const root = await mkdtemp(join(tmpdir(), "mako-archive-newer-"))
try {
  const ref = { harness: "codex", nativeId: "kept", path: "/sessions/kept.jsonl", title: "Kept", revision: "r" }
  await keepCopies(root, [{ ref, entries: [{ type: "user", text: "Remember FALCON." }, { type: "telepathy", payload: { from: "a newer Mako" } }, { type: "text", text: "OK" }] }])
  const db = new DatabaseSync(join(root, "archive.sqlite"))
  db.exec("PRAGMA user_version = 2; CREATE TABLE IF NOT EXISTS added_by_a_newer_mako (x)")
  db.close()

  for (const readOnly of [false, true]) {
    const archive = new SessionArchive(root, { readOnly })
    await archive.load()
    assert.deepEqual(archive.copies().map((copy) => copy.path), [ref.path], `${readOnly ? "a reader" : "a writer"} of this build lists the copy`)
    const thread = await archive.read(ref.path)
    assert.deepEqual(thread?.entries.map((entry) => entry.type), ["user", "unread", "text"], "an entry this build doesn't know shows raw, where it stood")
    const unread = thread?.entries[1]
    assert.equal(unread?.type === "unread" && unread.reason, "unreadable")
    assert.deepEqual(unread?.type === "unread" && unread.raw, { type: "telepathy", payload: { from: "a newer Mako" } })
    await assert.rejects(archive.drop(ref.path, "harness"), /read-only|ReadOnly|session archive/i, "and nothing is written to it")
    await archive.stop()
  }
  const after = new DatabaseSync(join(root, "archive.sqlite"), { readOnly: true })
  assert.equal(after.prepare("PRAGMA user_version").get().user_version, 2, "its format stays the newer one's")
  assert.equal(after.prepare("SELECT count(*) AS n FROM sessions").get().n, 1)
  assert.ok(after.prepare("SELECT 1 FROM sqlite_master WHERE name = 'added_by_a_newer_mako'").get(), "what it added is kept")
  assert.equal(after.prepare("SELECT 1 FROM sqlite_master WHERE name = 'archive_migration'").get(), undefined, "this build added nothing")
  after.close()
  console.log("archive in a newer format: read, unknown entries raw, nothing written")
} finally {
  await rm(root, { recursive: true, force: true })
}
