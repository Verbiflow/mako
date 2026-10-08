import { cp, mkdtemp, readdir, readFile, rm, truncate, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  captureRecords,
  decodeSegment,
  encodeSegment,
  restoreRecords,
  segmentId,
  type RecordSegment,
  type RecordValue,
  type SessionRecords,
} from "../packages/sessions/src/harness-records.ts"
import { drawing, PAIRS_FOLDER, PairSchema, storeMessages, storeReader } from "./decode-compare.ts"
import { FIXTURE_ROOT } from "./native-decoding.ts"

/**
 * Every pair's stores, as each harness wrote them, kept whole by
 * `SessionProvider.records`: captured, encoded, restored under a fresh home,
 * and captured again, the segments must be the same line for line, and the
 * restored store must draw what the original does. A capture from its own
 * cursor takes nothing, and a transcript captured halfway continues with
 * appends alone. A synthetic store holds row changes, deletions and a
 * rewritten transcript to what a capture must take.
 */

const failures: string[] = []
let stores = 0
let segments = 0
let bytes = 0

let cited = 0

/** What a citation adds to the record it names: the fact about it (`<turn>:failed`) or where in it (`<journal>:messages/3`). */
const CITED_FACT = /:[a-z]+(?:\/\d+)?$/

/** Everything the captured records say, as text: names, file contents, row values. */
function sourceText(taken: readonly RecordSegment[]): string {
  const text = (value: RecordValue): string => value instanceof Uint8Array ? Buffer.from(value).toString("utf8") : String(value)
  return taken.map((segment) => {
    switch (segment.kind) {
      case "file":
      case "append":
        return `${segment.file}\n${text(segment.bytes)}`
      case "row":
        return `${segment.database}\n${Object.values(segment.values).map(text).join("\n")}`
      default:
        return ""
    }
  }).join("\n")
}

const encoded = (taken: readonly RecordSegment[]) => taken.map(encodeSegment)
const kinds = (taken: readonly RecordSegment[]) => taken.map((segment) => segment.kind).join(" ")

async function scratch<T>(work: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "mako-retention-"))
  try {
    return await work(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function recordsAt(reader: string, home: string, path: string): Promise<SessionRecords> {
  const records = await storeReader(reader, home).records(join(home, path))
  if (!records) throw new Error(`${reader} keeps no records for ${path}`)
  return records
}

async function roundTrip(where: string, reader: string, harness: string, home: string, path: string): Promise<string[]> {
  const found: string[] = []
  const records = await recordsAt(reader, home, path)
  const first = await captureRecords(records, home)
  if (!first.segments.length) return [`${reader} captured nothing for ${path}`]
  const lines = encoded(first.segments)
  segments += lines.length
  bytes += lines.reduce((total, line) => total + line.length, 0)
  const ids = new Set(lines.map(segmentId))
  if (ids.size !== new Set(lines).size) found.push(`${reader}: two different segments share an address`)
  const again = await captureRecords(records, home, first.cursor)
  if (again.segments.length) found.push(`${reader}: a capture from its own cursor took ${kinds(again.segments)}`)
  await scratch(async (fresh) => {
    await restoreRecords(lines.map(decodeSegment), fresh)
    const restored = await captureRecords(await recordsAt(reader, fresh, path), fresh)
    const back = encoded(restored.segments)
    if (back.length !== lines.length || back.some((line, index) => line !== lines[index]))
      found.push(`${reader}: the restored store captures ${back.length} segments unlike the ${lines.length} it was restored from (${kinds(restored.segments)})`)
    const original = await storeMessages(reader, harness, home, join(home, path))
    const source = sourceText(first.segments)
    for (const { note } of original.messages) {
      const record = note?.source?.record
      if (record === undefined) continue
      cited++
      if (!source.includes(record.replace(CITED_FACT, ""))) found.push(`${reader}: ${note!.label} cites ${record}, which no captured record holds`)
    }
    const copy = await storeMessages(reader, harness, fresh, join(fresh, path))
    const left = drawing(original.messages)
    const right = drawing(copy.messages)
    if (left.join("\n") !== right.join("\n")) found.push(`${reader}: the restored store draws ${right.length} lines unlike the original's ${left.length}`)
    if (JSON.stringify(original.unread) !== JSON.stringify(copy.unread)) found.push(`${reader}: the restored store reports other unread records`)
  })
  found.push(...await continued(reader, home, path, records))
  return found.map((problem) => `${where} ${problem}`)
}

/** Each transcript captured at half its lines, then continued from that cursor: appends alone, and the result restores the whole. */
async function continued(reader: string, home: string, path: string, records: SessionRecords): Promise<string[]> {
  const transcripts = records.files.filter((file) => /\.(?:jsonl|ndjson)$/.test(file))
  if (!transcripts.length) return []
  return scratch(async (root) => {
    const growing = join(root, "growing")
    const restored = join(root, "restored")
    await cp(home, growing, { recursive: true })
    const moved = (file: string) => join(growing, file.slice(home.length))
    const growingRecords = await recordsAt(reader, growing, path)
    const halves = await Promise.all(transcripts.map(async (file) => {
      const text = await readFile(file)
      let cut = 0
      for (let at = text.indexOf(10); at !== -1 && at < text.length / 2; at = text.indexOf(10, at + 1)) cut = at + 1
      return { file: moved(file), whole: text, cut }
    }))
    for (const half of halves) await truncate(half.file, half.cut)
    const early = await captureRecords(growingRecords, growing)
    await restoreRecords(early.segments, restored)
    for (const half of halves) await writeFile(half.file, half.whole)
    const late = await captureRecords(growingRecords, growing, early.cursor)
    const rewritten = late.segments.filter((segment) => segment.kind === "file" && /\.(?:jsonl|ndjson)$/.test(segment.file))
    const found = rewritten.map((segment) => `${reader}: a transcript that only grew was taken whole again (${segment.kind === "file" ? segment.file : ""})`)
    await restoreRecords(late.segments, restored)
    const whole = encoded((await captureRecords(await recordsAt(reader, restored, path), restored)).segments)
    const original = encoded((await captureRecords(records, home)).segments)
    if (whole.join("\n") !== original.join("\n")) found.push(`${reader}: a capture continued from halfway restores another store than the original`)
    return found
  })
}

/** Row updates, inserts and deletions, an unchanged blob table, and a transcript rewritten before its cursor. */
async function synthetic(): Promise<string[]> {
  const { DatabaseSync } = await import("node:sqlite")
  return scratch(async (home) => {
    const found: string[] = []
    const database = join(home, "store.db")
    const transcript = join(home, "session.jsonl")
    const db = new DatabaseSync(database)
    db.exec(`CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT, body TEXT, weight REAL, size INTEGER, raw BLOB);
      CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB);
      CREATE TABLE log (session_id TEXT, line TEXT);
      CREATE INDEX messages_session ON messages (session_id);
      PRAGMA user_version = 7;`)
    const insert = db.prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?)")
    insert.run("m1", "s", "first", 1, 9007199254740993n, new Uint8Array([0, 1, 2]))
    insert.run("m2", "s", "second", 2.5, 2n, null)
    insert.run("m3", "other", "not ours", 0, 0n, null)
    db.prepare("INSERT INTO blobs VALUES (?, ?)").run("b1", new Uint8Array(4096).fill(7))
    db.prepare("INSERT INTO log VALUES (?, ?)").run("s", "one")
    await writeFile(transcript, `{"n":1}\n{"n":2}\n`)
    const records: SessionRecords = {
      files: [transcript],
      databases: [{ path: database, tables: [
        { table: "messages", where: "session_id = ?", params: ["s"] },
        { table: "blobs", immutable: true },
        { table: "log", where: "session_id = ?", params: ["s"] },
      ] }],
    }
    const first = await captureRecords(records, home)
    if (kinds(first.segments) !== "file schema row row row row")
      found.push(`synthetic: the first capture took ${kinds(first.segments)}`)
    db.prepare("UPDATE messages SET body = 'second, edited' WHERE id = 'm2'").run()
    db.prepare("DELETE FROM messages WHERE id = 'm1'").run()
    insert.run("m4", "s", "fourth", 4, 4n, null)
    db.prepare("UPDATE messages SET body = 'still not ours' WHERE id = 'm3'").run()
    db.prepare("INSERT INTO blobs VALUES (?, ?)").run("b2", new Uint8Array([1]))
    db.close()
    await writeFile(transcript, `{"n":1}\n{"n":2}\n{"n":3}\n`)
    const second = await captureRecords(records, home, first.cursor)
    const described = second.segments.map((segment) =>
      segment.kind === "row" ? `row ${segment.table} ${String(segment.values["id"])}` :
      segment.kind === "deleted" ? `deleted ${segment.table} ${String(segment.key["id"])}` :
      segment.kind === "append" ? `append ${segment.at}` : segment.kind)
    const expected = ["append 16", "row messages m2", "row messages m4", "deleted messages m1", "row blobs b2"]
    if (described.join(", ") !== expected.join(", ")) found.push(`synthetic: the second capture took ${described.join(", ")}, not ${expected.join(", ")}`)
    await writeFile(transcript, `{"n":0}\n{"n":2}\n{"n":3}\n{"n":4}\n`)
    const third = await captureRecords(records, home, second.cursor)
    if (kinds(third.segments) !== "file") found.push(`synthetic: a transcript rewritten before its cursor was taken as ${kinds(third.segments) || "nothing"}`)
    await scratch(async (fresh) => {
      await restoreRecords([...first.segments, ...second.segments, ...third.segments].map(encodeSegment).map(decodeSegment), fresh)
      const restored = encoded((await captureRecords({
        files: [join(fresh, "session.jsonl")],
        databases: [{ path: join(fresh, "store.db"), tables: records.databases[0]!.tables }],
      }, fresh)).segments)
      const original = encoded((await captureRecords(records, home)).segments)
      if (restored.join("\n") !== original.join("\n")) found.push("synthetic: three captures restored don't capture as the store does")
      const copy = new DatabaseSync(join(fresh, "store.db"), { readOnly: true })
      const types = copy.prepare("SELECT typeof(weight) w, typeof(size) s, typeof(raw) r FROM messages ORDER BY id").all().map((row) => `${String(row["w"])}/${String(row["s"])}/${String(row["r"])}`)
      const version = Number(copy.prepare("PRAGMA user_version").get()?.["user_version"])
      copy.close()
      if (types.join(" ") !== "real/integer/null real/integer/null") found.push(`synthetic: restored rows hold ${types.join(" ")}`)
      if (version !== 7) found.push(`synthetic: the restored store's user_version is ${version}`)
    })
    try {
      await restoreRecords([{ kind: "file", file: "../outside", bytes: new Uint8Array() }], home)
      found.push("synthetic: a segment naming a path outside the home was restored")
    } catch {
      // Refused, as it must be.
    }
    try {
      await scratch((fresh) => restoreRecords([{ kind: "append", file: "session.jsonl", at: 16, bytes: new Uint8Array([10]) }], fresh))
      found.push("synthetic: an append to bytes the home doesn't hold was restored")
    } catch {
      // Refused, as it must be.
    }
    return found
  })
}

failures.push(...await synthetic())

for (const harness of await readdir(FIXTURE_ROOT)) {
  const root = join(FIXTURE_ROOT, harness, PAIRS_FOLDER)
  for (const name of await readdir(root).catch(() => [])) {
    const where = `${harness}/${PAIRS_FOLDER}/${name}`
    const pair = PairSchema.parse(JSON.parse(await readFile(join(root, name, "pair.json"), "utf8")))
    for (const store of pair.stores) {
      stores++
      try {
        failures.push(...await roundTrip(where, store.reader, pair.harness, join(root, name, "home"), store.path))
      } catch (error) {
        failures.push(`${where} ${store.reader}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
}

if (failures.length) {
  console.error(`\n${failures.join("\n")}\n`)
  process.exit(1)
}
console.log(`PASS: ${stores} stores restore under a fresh home as ${segments} segments (${(bytes / 1024 / 1024).toFixed(1)} MiB encoded) that capture the same and draw the same, and each of the ${cited} records their markers cite is in what was captured; captures continue from their cursors, and a synthetic store's row changes, deletions and rewrite are taken as they happened`)
