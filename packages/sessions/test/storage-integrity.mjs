import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, appendFile, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { DatabaseSync } from "node:sqlite"
import { SessionArchive } from "../dist/archive.js"
import { keepCopies } from "./fixtures/archive-copies.mjs"
import { SessionCatalog } from "../dist/catalog.js"
import { ClaudeProvider } from "../dist/providers/claude.js"
import { CursorProvider } from "../dist/providers/cursor.js"
import { emitCursorSession } from "../dist/emit.js"
import { userTextFrom } from "../dist/format.js"
import { NativeStores } from "../dist/read-only-sqlite.js"

const nativeStores = new NativeStores(false)

const home = await mkdtemp(join(tmpdir(), "mako-integrity-"))
const line = value => JSON.stringify(value) + "\n"
const archive = new SessionArchive(join(home, "archive"))
let db
let catalog
try {
  const ref = { harness: "claude", nativeId: "test", path: join(home, "native"), bytes: 2 }
  const entries = [{ type: "user", text: "run" }, { type: "tool", id: "call", name: "shell", output: "complete" }]
  await keepCopies(join(home, "archive"), [{ ref, entries }])
  assert.equal((await archive.read(ref.path)).entries[1].output, "complete")
  assert.equal((await archive.read(ref.path)).ref.bytes, 2)
  await archive.forget(ref.path)
  assert.equal(await archive.read(ref.path), null, "a forgotten copy is gone")

  const legacyRoot = join(home, "legacy-model-archive")
  const knownRef = { ...ref, settings: { model: "known", options: { fast: false } } }
  const unknownRef = { ...ref, nativeId: "unknown-model", path: join(home, "unknown-model"), settings: { options: { effort: "high" } } }
  const legacyRef = { ...unknownRef, model: "", settings: { ...unknownRef.settings, model: "" } }
  await mkdir(legacyRoot)
  const legacyDb = new DatabaseSync(join(legacyRoot, "archive.sqlite"))
  try {
    legacyDb.exec("CREATE TABLE sessions (path TEXT PRIMARY KEY, ref TEXT NOT NULL, entries TEXT NOT NULL, revision TEXT NOT NULL)")
    for (const saved of [knownRef, legacyRef])
      legacyDb.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?)").run(saved.path, JSON.stringify(saved), JSON.stringify(entries), "legacy")
  } finally {
    legacyDb.close()
  }
  const recovered = new SessionCatalog([], { archivePath: legacyRoot })
  try {
    assert.equal((await recovered.scan()).length, 2, "an archived empty model must not block catalog startup")
    assert.deepEqual((await recovered.open(ref.path)).ref.settings, knownRef.settings)
    const thread = await recovered.open(unknownRef.path)
    assert.equal(thread.ref.settings.model, undefined)
    assert.deepEqual(thread.ref.settings.options, unknownRef.settings.options)
    assert.deepEqual(thread.entries, entries, "model migration preserves the transcript")
  } finally {
    await recovered.stop()
  }
  const files = [{ path: join(home, "alias-a"), bytes: 1, mtimeMs: 1 }, { path: join(home, "alias-b"), bytes: 1, mtimeMs: 2 }]
  const indexed = new SessionCatalog([{ harness: "fixture", displayName: "Fixture", roots: () => [], discover: async () => files, peek: async file => ({ harness: "fixture", nativeId: "shared", path: file.path, cwd: file.path, updatedAt: new Date(file.mtimeMs).toISOString() }), read: async () => null }])
  try {
    await indexed.scan()
    assert.equal(indexed.count, 1)
    indexed.list().pop()
    assert.equal(indexed.count, 1, "list callers cannot mutate the cached count")
    assert.equal(indexed.list({ cwd: files[0].path })[0].path, files[0].path, "workspace filtering precedes alias deduplication")
    files.pop()
    await indexed.scan()
    assert.equal(indexed.list()[0].path, files[0].path, "removal invalidates catalogue ordering")
  } finally { await indexed.stop() }

  const dir = join(home, ".claude", "projects", "p")
  await mkdir(dir, { recursive: true })
  const path = join(dir, "session.jsonl")
  const first = line({ type: "user", sessionId: "s", cwd: home, message: { content: "first" } })
  const second = line({ type: "user", sessionId: "s", cwd: home, message: { content: "second" } })
  await writeFile(path, first + second.slice(0, 20))
  const provider = new ClaudeProvider(home)
  const opened = await provider.read(path)
  assert.equal(opened.checkpoint, Buffer.byteLength(first))
  const follower = provider.createFollower(path, opened.checkpoint)
  await appendFile(path, second.slice(20))
  assert.equal((await follower.next()).entries[0].text, "second")

  // The archive keeps no new copies: a catalog with an archive path and nothing kept there creates nothing.
  const captured = join(home, "startup-archive")
  catalog = new SessionCatalog([provider], { archivePath: captured })
  await catalog.scan()
  await catalog.stop()
  await assert.rejects(stat(join(captured, "archive.sqlite")), { code: "ENOENT" }, "discovery copies nothing into the archive")

  const emitted = await emitCursorSession(nativeStores, { ref: { ...ref, harness: "cursor", title: "before", cwd: home }, entries: [{ type: "user", text: "hello" }] }, { cwd: home, home })
  db = new DatabaseSync(emitted.path)
  db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_checkpoint(TRUNCATE)")
  const cursor = new CursorProvider(nativeStores, home)
  catalog = new SessionCatalog([cursor])
  await catalog.scan()
  const before = await stat(emitted.path)
  const row = db.prepare("SELECT value FROM meta WHERE key='0'").get()
  const meta = JSON.parse(Buffer.from(String(row.value), "hex").toString())
  meta.name = "after"
  db.prepare("UPDATE meta SET value=? WHERE key='0'").run(Buffer.from(JSON.stringify(meta)).toString("hex"))
  assert.equal((await stat(emitted.path)).mtimeMs, before.mtimeMs)
  await catalog.scan()
  assert.equal(catalog.list()[0].title, "after", "WAL changes invalidate the catalog")
  assert.equal(userTextFrom("<recommended_plugins>list</recommended_plugins>\n\nKeep this request."), "Keep this request.")
  assert.equal(userTextFrom("<turn_aborted>\nThe user interrupted the previous turn on purpose.\n</turn_aborted>"), undefined, "Codex's note to its model about a stop is not a message the person sent")
  console.log("Storage integrity passed: kept copies read and forgotten, complete-record checkpoint, WAL revisions, envelope fidelity")
} finally {
  await archive.stop()
  await catalog?.stop()
  db?.close()
  await new Promise(resolve => setTimeout(resolve, 20))
  await rm(home, { recursive: true, force: true })
}
