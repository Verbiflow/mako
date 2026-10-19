import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, stat, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { zstdCompressSync } from "node:zlib"
import { SessionCatalog } from "../dist/index.js"
import { keepCopies } from "./fixtures/archive-copies.mjs"
import { EntryOriginalSchema, readOriginal } from "../dist/record-original.js"

// An entry's original is the bytes its record names, read whole and as the
// harness wrote them: file ranges by plain byte offset, whatever the file's
// encoding now, and database rows by key, every column worded for reading.

const root = await mkdtemp(join(tmpdir(), "mako-record-original-"))
try {
  const lines = [
    JSON.stringify({ type: "user", text: "first" }),
    JSON.stringify({ type: "assistant", text: "naïve café 🎉" }),
    JSON.stringify({ type: "tool_result", output: "ok" }),
  ].map((line) => `${line}\n`)
  const offsets = lines.reduce((at, line) => [...at, at.at(-1) + Buffer.byteLength(line)], [0])
  const session = join(root, "rollout.jsonl")
  await writeFile(session, lines.join(""))

  // A range counts bytes, not characters: the line after multi-byte text starts where its bytes do.
  const second = await readOriginal(session, { ranges: [[offsets[1], offsets[2]]] })
  assert.deepEqual(second, { kept: false, parts: [{ kind: "range", file: session, from: offsets[1], to: offsets[2], text: lines[1] }] })
  assert.deepEqual(EntryOriginalSchema.parse(second), second, "an original crosses the wire as it is")

  // A call and its result are two ranges of one record, oldest first.
  const both = await readOriginal(session, { ranges: [[offsets[0], offsets[1]], [offsets[2], offsets[3]]] }, true)
  assert.equal(both.kept, true, "a read from Mako's copy says so")
  assert.deepEqual(both.parts.map((part) => part.text), [lines[0], lines[2]])

  // A range past the end reads what there is, and says where it stopped.
  const past = await readOriginal(session, { ranges: [[offsets[2], offsets[3] + 100]] })
  assert.equal(past.parts[0].to, offsets[3])
  assert.equal(past.parts[0].text, lines[2])

  // The harness compresses the record in place: the same offsets read the same bytes.
  await writeFile(`${session}.zst`, zstdCompressSync(Buffer.from(lines.join(""))))
  await unlink(session)
  const compressed = await readOriginal(session, { ranges: [[offsets[1], offsets[2]]] })
  assert.equal(compressed.parts[0].kind, "range")
  assert.equal(compressed.parts[0].text, lines[1], "a compressed record reads by plain offsets")
  assert.equal(compressed.parts[0].file, `${session}.zst`, "and names the file it was read from")

  // A record beside the session's own file is named relative to it.
  await mkdir(join(root, "sub"))
  await writeFile(join(root, "sub", "child.jsonl"), lines.join(""))
  const beside = await readOriginal(`${session}#child`, { file: "sub/child.jsonl", ranges: [[0, offsets[1]]] })
  assert.equal(beside.parts[0].file, join(root, "sub", "child.jsonl"))
  assert.equal(beside.parts[0].text, lines[0])

  // A file that is gone says so instead of failing the read.
  const gone = await readOriginal(join(root, "gone.jsonl"), { ranges: [[0, 10]] })
  assert.deepEqual(gone.parts, [{ kind: "missing", file: join(root, "gone.jsonl"), reason: "The file is gone." }])

  // Rows by key, each column worded: integers exactly, text as is, blobs as UTF-8 when they are, else base64.
  const database = join(root, "store.db")
  const db = new DatabaseSync(database)
  db.exec("CREATE TABLE events (run TEXT, seq INTEGER, payload TEXT, size REAL, data BLOB, raw BLOB, note TEXT, PRIMARY KEY (run, seq))")
  const big = 2n ** 60n + 1n
  db.prepare("INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?)").run("run-1", big, '{"type":"text","text":"hi"}', 1.5, Buffer.from("plain bytes ✓"), Buffer.from([0xff, 0x00, 0xfe]), null)
  db.close()
  const rows = await readOriginal(`${database}#run-1`, { rows: [{ table: "events", key: { run: "run-1", seq: big.toString() } }, { table: "events", key: { run: "run-1", seq: 7 } }] })
  assert.equal(rows.parts.length, 2)
  const [found, absent] = rows.parts
  assert.equal(found.kind, "row")
  assert.deepEqual(found.columns, {
    run: { type: "text", text: "run-1" },
    seq: { type: "integer", text: big.toString() },
    payload: { type: "text", text: '{"type":"text","text":"hi"}' },
    size: { type: "real", text: "1.5" },
    data: { type: "blob", bytes: Buffer.byteLength("plain bytes ✓"), encoding: "utf8", text: "plain bytes ✓" },
    raw: { type: "blob", bytes: 3, encoding: "base64", text: Buffer.from([0xff, 0x00, 0xfe]).toString("base64") },
    note: { type: "null" },
  }, "every column, a 64-bit integer exactly")
  assert.deepEqual(absent, { kind: "row", file: database, table: "events", key: { run: "run-1", seq: 7 }, columns: null }, "a row the database no longer has says so")
  assert.deepEqual(EntryOriginalSchema.parse(rows), rows)

  const unopenable = await readOriginal(join(root, "missing.db"), { rows: [{ table: "events", key: { run: "x" } }] })
  assert.equal(unopenable.parts[0].kind, "missing", "a database that can't be opened is a missing part")

  // Through the catalog: an entry's original by its id, and nothing invented for one that names no record.
  const native = join(root, "native")
  await mkdir(native)
  const path = join(native, "session.jsonl")
  await writeFile(path, lines.join(""))
  const stamp = async () => { const s = await stat(path); return { path, bytes: s.size, mtimeMs: s.mtimeMs } }
  const ref = { harness: "fixture", nativeId: "s", path, title: "Originals" }
  const catalog = new SessionCatalog([{
    harness: "fixture", displayName: "Fixture", roots: () => [native],
    discover: async () => [await stamp()], stat: stamp,
    peek: async (file) => ({ ...ref, ...file }),
    read: async () => ({ ref, entries: [
      { type: "user", id: "u1", text: "first", record: { ranges: [[offsets[0], offsets[1]]] } },
      { type: "text", id: "a1", text: "naïve café 🎉", record: { ranges: [[offsets[1], offsets[2]]] } },
      { type: "text", id: "plain", text: "no record" },
    ] }),
  }], { archivePath: join(root, "archive"), cachePath: join(root, "cache.json") })
  await catalog.prepare()
  await catalog.scan()
  assert.equal((await catalog.original(path, "a1")).parts[0].text, lines[1])
  assert.deepEqual(await catalog.original(path, "plain"), { kept: false, parts: [] })
  assert.equal(await catalog.original(path, "nope"), null, "an id the session doesn't have is null")
  await catalog.close?.()

  // A session only Mako's older archive holds has its translation, not its records.
  const archivePath = join(root, "archive-only")
  const pruned = { ref: { harness: "archived", nativeId: "p", path: join(root, "pruned.jsonl") }, entries: [{ type: "user", id: "u1", text: "kept translation" }] }
  await keepCopies(archivePath, [pruned])
  const archived = new SessionCatalog([], { archivePath, cachePath: join(root, "cache-2.json") })
  await archived.prepare()
  const thread = await archived.open(pruned.ref.path)
  assert.equal(thread?.entries[0]?.id, "u1")
  assert.equal(thread.entries[0].record, undefined)
  assert.deepEqual(await archived.original(pruned.ref.path, thread.entries[0].id), { kept: false, parts: [] })
  await archived.close?.()
  console.log("record originals: ranges by plain bytes (compressed or not), rows with every column, missing parts, the catalog by id")
} finally {
  await rm(root, { recursive: true, force: true })
}
