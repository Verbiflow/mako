import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, truncate, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { DatabaseSync as Database } from "node:sqlite"
import { zstdCompressSync } from "node:zlib"
import type { SessionRecords } from "../packages/sessions/src/harness-records.ts"
import { RecordStore, decodeRow, fileUnitKey, taggedRow, type CaptureReport, type RestoreReport } from "../packages/sessions/src/record-store.ts"
import { codexRecordPlace } from "../packages/sessions/src/providers/codex.ts"
import { drawing, PAIRS_FOLDER, PairSchema, storeMessages, storeReader } from "./decode-compare.ts"
import { FIXTURE_ROOT } from "./native-decoding.ts"
import { NativeStores } from "@mako/sessions/read-only-sqlite"

const nativeStores = new NativeStores(false)

/**
 * Every pair's stores, as each harness wrote them, kept whole by
 * `SessionProvider.records` in a record store: captured, restored under a
 * fresh home and captured again, every unit must hold the same bytes, and
 * the restored store must draw what the original does. A capture with
 * nothing new takes nothing, a restore onto what it restored writes
 * nothing, and a transcript captured halfway continues with appends alone.
 * A synthetic store holds row changes, deletions, a rewritten transcript and
 * the destinations a restore meets: an earlier copy, a compressed one, and
 * one that went on without Mako, which it must leave untouched.
 */

const failures: string[] = []
let stores = 0
let units = 0
let bytes = 0
let cited = 0

/** What a citation adds to the record it names: the fact about it (`<turn>:failed`) or where in it (`<journal>:messages/3`). */
const CITED_FACT = /:[a-z]+(?:\/\d+)?$/

async function scratch<T>(work: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "mako-retention-"))
  try {
    return await work(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function withStore<T>(work: (store: RecordStore) => Promise<T>): Promise<T> {
  return scratch(async (folder) => {
    const store = new RecordStore(folder, nativeStores)
    try {
      return await work(store)
    } finally {
      await store.close()
    }
  })
}

async function recordsAt(reader: string, home: string, path: string): Promise<SessionRecords> {
  const records = await storeReader(reader, home).records(join(home, path))
  if (!records) throw new Error(`${reader} keeps no records for ${path}`)
  return records
}

/** Each unit of a session by key, as the hash of its newest bytes. */
async function snapshot(store: RecordStore, harness: string, session: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (const unit of store.units(harness, session)) {
    if (unit.kind === "delete") continue
    const hash = createHash("sha256")
    for await (const chunk of store.content(harness, unit.key)) hash.update(chunk)
    out.set(unit.key, hash.digest("hex"))
  }
  return out
}

function differences(left: Map<string, string>, right: Map<string, string>): string[] {
  const keys = new Set([...left.keys(), ...right.keys()])
  return [...keys].filter((key) => left.get(key) !== right.get(key)).map((key) => `${key.replaceAll("\t", " ")} (${left.has(key) ? "" : "missing "}${right.has(key) ? "" : "lost"})`)
}

/** Everything the session's units hold, as text: names, file contents, row values. */
async function sourceText(store: RecordStore, harness: string, session: string): Promise<string> {
  const parts: string[] = []
  for (const unit of store.units(harness, session)) {
    if (unit.kind === "delete") continue
    if (unit.role === "file") {
      const chunks: Buffer[] = []
      for await (const chunk of store.content(harness, unit.key)) chunks.push(chunk)
      parts.push(unit.key, Buffer.concat(chunks).toString("utf8"))
    } else if (unit.role === "row") {
      const row = await store.decoded(harness, unit.key)
      parts.push(unit.key, ...Object.values(row).map((value) => (value instanceof Uint8Array ? Buffer.from(value).toString("utf8") : String(value))))
    }
  }
  return parts.join("\n")
}

const kinds = (report: CaptureReport) => report.versions.map((version) => version.kind).join(" ")
const actions = (report: RestoreReport) => [...new Set(report.actions.map((action) => action.action))].sort().join(" ")

async function roundTrip(where: string, reader: string, harness: string, home: string, path: string): Promise<string[]> {
  const found: string[] = []
  const records = await recordsAt(reader, home, path)
  await withStore(async (store) => {
    const first = await store.capture({ harness: reader, nativeId: path, home, records })
    if (!first.versions.length) {
      found.push(`${reader} captured nothing for ${path}`)
      return
    }
    units += first.versions.length
    bytes += first.newBytes
    const again = await store.capture({ harness: reader, nativeId: path, home, records })
    if (again.versions.length) found.push(`${reader}: a capture with nothing new took ${kinds(again)}`)
    const original = await snapshot(store, reader, path)
    await scratch(async (fresh) => {
      const restored = await store.restore({ harness: reader, nativeId: path, home: fresh })
      if (!restored.written || restored.diverged.length) found.push(`${reader}: a restore under a fresh home didn't write (${restored.diverged.map((d) => d.reason).join("; ")})`)
      const twice = await store.restore({ harness: reader, nativeId: path, home: fresh })
      if (twice.actions.some((action) => action.action !== "skip") || twice.diverged.length)
        found.push(`${reader}: restoring onto its own restore did ${actions(twice)}${twice.diverged.length ? `, diverging at ${twice.diverged[0]!.unit}` : ""}`)
      await withStore(async (copy) => {
        await copy.capture({ harness: reader, nativeId: path, home: fresh, records: await recordsAt(reader, fresh, path) })
        const lost = differences(original, await snapshot(copy, reader, path))
        if (lost.length) found.push(`${reader}: the restored store holds other units: ${lost.slice(0, 3).join(", ")}`)
      })
      const drawn = await storeMessages(reader, harness, home, join(home, path))
      const source = await sourceText(store, reader, path)
      for (const { note } of drawn.messages) {
        const record = note?.source?.record
        if (record === undefined) continue
        cited++
        if (!source.includes(record.replace(CITED_FACT, ""))) found.push(`${reader}: ${note!.label} cites ${record}, which no captured record holds`)
      }
      const copy = await storeMessages(reader, harness, fresh, join(fresh, path))
      const left = drawing(drawn.messages)
      const right = drawing(copy.messages)
      if (left.join("\n") !== right.join("\n")) found.push(`${reader}: the restored store draws ${right.length} lines unlike the original's ${left.length}`)
      if (JSON.stringify(drawn.unread) !== JSON.stringify(copy.unread)) found.push(`${reader}: the restored store reports other unread records`)
    })
    found.push(...await continued(reader, home, path, records, original))
  })
  return found.map((problem) => `${where} ${problem}`)
}

/** Each transcript captured at half its lines, restored, then continued: appends alone, and an append onto the earlier copy restores the whole. */
async function continued(reader: string, home: string, path: string, records: SessionRecords, original: Map<string, string>): Promise<string[]> {
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
    return withStore(async (store) => {
      const found: string[] = []
      await store.capture({ harness: reader, nativeId: path, home: growing, records: growingRecords })
      await store.restore({ harness: reader, nativeId: path, home: restored })
      for (const half of halves) await writeFile(half.file, half.whole)
      const late = await store.capture({ harness: reader, nativeId: path, home: growing, records: growingRecords })
      for (const version of late.versions)
        if (version.kind === "replace" && /\.(?:jsonl|ndjson)$/.test(version.unit)) found.push(`${reader}: a transcript that only grew was taken whole again (${version.unit})`)
      const onto = await store.restore({ harness: reader, nativeId: path, home: restored })
      if (onto.diverged.length) found.push(`${reader}: restoring onto the earlier copy diverged at ${onto.diverged[0]!.unit}: ${onto.diverged[0]!.reason}`)
      if (halves.some((half) => half.cut < half.whole.length) && !onto.actions.some((action) => action.action === "append"))
        found.push(`${reader}: restoring onto the earlier copy did ${actions(onto)}, not an append`)
      await withStore(async (copy) => {
        await copy.capture({ harness: reader, nativeId: path, home: restored, records: await recordsAt(reader, restored, path) })
        const lost = differences(original, await snapshot(copy, reader, path))
        if (lost.length) found.push(`${reader}: a restore continued from halfway holds other units than the original: ${lost.slice(0, 3).join(", ")}`)
      })
      return found
    })
  })
}

/** Row updates, inserts and deletions, an unchanged blob table, a transcript rewritten before its cursor, and the destinations a restore meets. */
async function synthetic(): Promise<string[]> {
  const { DatabaseSync } = await import("node:sqlite")
  return scratch(async (home) => withStore(async (store) => {
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
    const session = { harness: "synthetic", nativeId: "s", home, records }
    const first = await store.capture(session)
    if (kinds(first) !== "replace replace replace replace replace replace")
      found.push(`synthetic: the first capture took ${kinds(first)}`)
    // The first capture, restored, is the earlier copy a destination holds.
    const earlier = join(home, "earlier")
    await store.restore({ ...session, home: earlier })
    db.prepare("UPDATE messages SET body = 'second, edited' WHERE id = 'm2'").run()
    db.prepare("DELETE FROM messages WHERE id = 'm1'").run()
    insert.run("m4", "s", "fourth", 4, 4n, null)
    db.prepare("UPDATE messages SET body = 'still not ours' WHERE id = 'm3'").run()
    db.prepare("INSERT INTO blobs VALUES (?, ?)").run("b2", new Uint8Array([1]))
    db.close()
    await writeFile(transcript, `{"n":1}\n{"n":2}\n{"n":3}\n`)
    const second = await store.capture(session)
    const described = second.versions.map((version) => {
      const [, , table, key] = version.unit.split("\t")
      return version.unit === "session.jsonl" ? `${version.kind} ${version.bytes}` : `${version.kind} ${table} ${key ? JSON.parse(key).id : ""}`
    })
    const expected = ["append 8", "replace messages m2", "replace messages m4", "delete messages m1", "replace blobs b2"]
    if (described.join(", ") !== expected.join(", ")) found.push(`synthetic: the second capture took ${described.join(", ")}, not ${expected.join(", ")}`)

    const onto = await store.restore({ ...session, home: earlier })
    const did = onto.actions.filter((action) => action.action !== "skip").map((action) => `${action.action} ${action.unit.split("\t")[3] ? JSON.parse(action.unit.split("\t")[3]!).id : action.path}`)
    if (did.join(", ") !== "append session.jsonl, insert b2, delete m1, replace m2, insert m4")
      found.push(`synthetic: restoring onto the earlier copy did ${did.join(", ")}`)

    await writeFile(transcript, `{"n":0}\n{"n":2}\n{"n":3}\n{"n":4}\n`)
    const third = await store.capture(session)
    if (kinds(third) !== "replace") found.push(`synthetic: a transcript rewritten before its cursor was taken as ${kinds(third) || "nothing"}`)

    await scratch(async (fresh) => {
      await store.restore({ ...session, home: fresh })
      const copy = new DatabaseSync(join(fresh, "store.db"), { readOnly: true })
      const types = copy.prepare("SELECT typeof(weight) w, typeof(size) s, typeof(raw) r FROM messages ORDER BY id").all().map((row) => `${String(row["w"])}/${String(row["s"])}/${String(row["r"])}`)
      const version = Number(copy.prepare("PRAGMA user_version").get()?.["user_version"])
      const big = copy.prepare("SELECT size FROM messages WHERE id = 'm4'").get()
      copy.close()
      if (types.join(" ") !== "real/integer/null real/integer/null") found.push(`synthetic: restored rows hold ${types.join(" ")}`)
      if (version !== 7) found.push(`synthetic: the restored store's user_version is ${version}`)
      if (!big) found.push("synthetic: the restored store lacks m4")
      if ((await readFile(join(fresh, "session.jsonl"), "utf8")) !== `{"n":0}\n{"n":2}\n{"n":3}\n{"n":4}\n`) found.push("synthetic: the restored transcript isn't the newest version")
    })

    // A destination that holds a compressed earlier copy gets the record back plain, as the harness does itself on resume.
    await scratch(async (fresh) => {
      await mkdir(fresh, { recursive: true })
      await writeFile(join(fresh, "session.jsonl.zst"), zstdCompressSync(Buffer.from(`{"n":0}\n{"n":2}\n`)))
      const restored = await store.restore({ ...session, home: fresh })
      const action = restored.actions.find((entry) => entry.path === "session.jsonl")?.action
      if (action !== "write-plain" || existsSync(join(fresh, "session.jsonl.zst")))
        found.push(`synthetic: a compressed earlier copy was met with ${action}, ${existsSync(join(fresh, "session.jsonl.zst")) ? "and still exists" : "and removed"}`)
    })

    // A destination that went on without Mako is never overwritten.
    await scratch(async (fresh) => {
      await store.restore({ ...session, home: fresh })
      await writeFile(join(fresh, "session.jsonl"), `{"n":0}\n{"n":2}\n{"n":3}\n{"n":4}\n{"n":"elsewhere"}\n`)
      const before = await readFile(join(fresh, "session.jsonl"), "utf8")
      const longer = await store.restore({ ...session, home: fresh })
      if (longer.written || !longer.diverged.some((entry) => entry.unit === "session.jsonl")) found.push("synthetic: a transcript that went on at the destination wasn't held back")
      await writeFile(join(fresh, "session.jsonl"), `{"n":9}\n`)
      const other = await store.restore({ ...session, home: fresh })
      if (other.written || !other.diverged.some((entry) => entry.unit === "session.jsonl")) found.push("synthetic: a transcript that differs at the destination wasn't held back")
      await writeFile(join(fresh, "session.jsonl"), before)
      const local = new DatabaseSync(join(fresh, "store.db"))
      local.prepare("UPDATE messages SET body = 'edited here' WHERE id = 'm2'").run()
      local.close()
      const row = await store.restore({ ...session, home: fresh })
      if (row.written || !row.diverged.some((entry) => entry.unit.includes('"m2"'))) found.push("synthetic: a row edited at the destination wasn't held back")
      const check = new DatabaseSync(join(fresh, "store.db"), { readOnly: true })
      const body = check.prepare("SELECT body FROM messages WHERE id = 'm2'").get()?.["body"]
      check.close()
      if (body !== "edited here" || (await readFile(join(fresh, "session.jsonl"), "utf8")) !== before) found.push("synthetic: a held-back restore wrote anyway")
      const extra = await store.restore({ ...session, home: fresh, destination: { files: [join(fresh, "session.jsonl"), join(fresh, "notes.jsonl")], databases: [] } })
      if (!extra.diverged.some((entry) => entry.unit === "notes.jsonl")) found.push("synthetic: a file of the session Mako never saw didn't count as going on")
    })

    await scratch(async (fresh) => {
      const held = await store.restore({ ...session, home: fresh, held: () => true })
      if (held.written || existsSync(join(fresh, "session.jsonl"))) found.push("synthetic: a restore wrote while the session was held")
    })

    const m4 = await store.decoded("synthetic", `store.db\trow\tmessages\t${JSON.stringify({ id: "m4" })}`)
    if ("statements" in m4 || m4["size"] !== 4n || m4["body"] !== "fourth") found.push(`synthetic: m4 decodes as ${JSON.stringify("statements" in m4 ? m4 : taggedRow(m4))}`)

    try {
      await store.capture({ ...session, records: { files: [join(home, "..", "outside.jsonl")], databases: [] } })
      found.push("synthetic: a file outside the home was captured")
    } catch {
      // Refused, as it must be.
    }
    const broken = await store.verify()
    if (broken.length) found.push(`synthetic: ${broken.length} chunks fail their hash: ${broken[0]}`)
    void decodeRow
    return found
  }))
}

/** A rollout Codex compresses, then archives, stays one unit with one version; it's deleted only once it's gone from every folder. */
async function codexPlacement(): Promise<string[]> {
  return scratch(async (home) => withStore(async (store) => {
    const found: string[] = []
    const name = "rollout-2026-10-01T10-00-00-01a00000-0000-7000-8000-000000000000.jsonl"
    const dated = join(home, ".codex", "sessions", "2026", "10", "01")
    await mkdir(dated, { recursive: true })
    const body = Buffer.from(`{"type":"session_meta"}\n{"type":"event_msg"}\n`)
    await writeFile(join(dated, name), body)
    const at = (path: string) => ({ harness: "codex", nativeId: "t", home, records: { files: [path], databases: [], place: codexRecordPlace } })
    await store.capture(at(join(dated, name)))
    await writeFile(join(dated, `${name}.zst`), zstdCompressSync(body))
    await rm(join(dated, name))
    const compressed = await store.capture(at(join(dated, `${name}.zst`)))
    const archived = join(home, ".codex", "archived_sessions")
    await mkdir(archived, { recursive: true })
    await rename(join(dated, `${name}.zst`), join(archived, `${name}.zst`))
    const moved = await store.capture(at(join(archived, `${name}.zst`)))
    const unlisted = await store.capture({ ...at(join(archived, `${name}.zst`)), records: { files: [], databases: [] } })
    if (compressed.versions.length || moved.versions.length || unlisted.versions.length)
      found.push(`codex: compressing, archiving or not listing a rollout took ${[compressed, moved, unlisted].map(kinds).join(" | ")}`)
    if (store.units("codex", "t").length !== 1) found.push(`codex: one rollout became ${store.units("codex", "t").length} units`)
    const codex = { place: codexRecordPlace }
    if (fileUnitKey(codex, `.codex/archived_sessions/${name}.zst`) !== fileUnitKey(codex, `.codex/sessions/2026/10/01/${name}`))
      found.push("codex: an archived rollout has another key than its dated original")
    await rm(join(archived, `${name}.zst`))
    const gone = await store.capture({ ...at(join(archived, `${name}.zst`)), records: { files: [], databases: [] } })
    if (kinds(gone) !== "delete") found.push(`codex: a rollout gone from every folder was taken as ${kinds(gone) || "nothing"}`)
    const back = await store.restore({ harness: "codex", nativeId: "t", home })
    if (!(await readFile(join(archived, name))).equals(body)) found.push("codex: a deleted rollout didn't restore whole")
    void back
    return found
  }))
}

/** Rows whose declared key is NULL (OpenCode's `__drizzle_migrations`) stay apart, and restoring them never adds a copy. */
async function nullKeys(): Promise<string[]> {
  const { DatabaseSync } = await import("node:sqlite")
  return scratch(async (home) => withStore(async (store) => {
    const found: string[] = []
    const make = (folder: string) => {
      const db = new DatabaseSync(join(folder, "store.db"))
      db.exec(`CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric, name text)`)
      return db
    }
    const source = make(home)
    for (const [at, name] of [[1, "first"], [2, "second"], [3, "third"]] as const)
      source.prepare("INSERT INTO __drizzle_migrations VALUES (NULL, '', ?, ?)").run(at, name)
    const records = (folder: string): SessionRecords => ({ files: [], databases: [{ path: join(folder, "store.db"), tables: [{ table: "__drizzle_migrations" }] }] })
    const session = { harness: "synthetic", nativeId: "migrations", home, records: records(home) }
    await store.capture(session)
    const rows = store.units("synthetic", "migrations").filter((unit) => unit.role === "row")
    if (rows.length !== 3) found.push(`null keys: three rows with NULL ids became ${rows.length} units`)
    const onto = await store.restore({ harness: "synthetic", nativeId: "migrations", home })
    const count = (db: Database) => Number(db.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get()?.["n"])
    if (onto.written || onto.diverged.length || count(source) !== 3) found.push(`null keys: restoring onto the same rows did ${onto.actions.map((action) => action.action).join(", ")}, leaving ${count(source)} rows`)
    source.prepare("DELETE FROM __drizzle_migrations WHERE name = 'second'").run()
    const deleted = await store.capture(session)
    if (kinds(deleted) !== "delete") found.push(`null keys: a deleted row was taken as ${kinds(deleted) || "nothing"}`)
    await scratch(async (fresh) => {
      const before = make(fresh)
      for (const [at, name] of [[1, "first"], [2, "second"], [3, "third"]] as const)
        before.prepare("INSERT INTO __drizzle_migrations VALUES (NULL, '', ?, ?)").run(at, name)
      const restored = await store.restore({ harness: "synthetic", nativeId: "migrations", home: fresh })
      const names = before.prepare("SELECT name FROM __drizzle_migrations ORDER BY created_at").all().map((row) => row["name"]).join(", ")
      if (names !== "first, third" || restored.diverged.length) found.push(`null keys: restoring onto the earlier rows left ${names} (${restored.actions.map((action) => action.action).join(", ")})`)
      before.close()
    })
    source.close()

    // A table with only `key UNIQUE` (Cursor's `cursorDiskKV`): restored by key, never onto the destination's own rows that share a rowid.
    const kv = new DatabaseSync(join(home, "kv.db"))
    kv.exec("CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)")
    kv.prepare("INSERT INTO cursorDiskKV VALUES ('composerData:s', 'mine'), ('bubbleId:s:1', 'hello')").run()
    const kvRecords = (folder: string): SessionRecords => ({ files: [], databases: [{ path: join(folder, "kv.db"), tables: [{ table: "cursorDiskKV" }] }] })
    await store.capture({ harness: "synthetic", nativeId: "kv", home, records: kvRecords(home) })
    const kvKeys = store.units("synthetic", "kv").filter((unit) => unit.role === "row").map((unit) => unit.key.split("\t")[3]).sort()
    if (kvKeys.join(" ") !== `{"key":"bubbleId:s:1"} {"key":"composerData:s"}`) found.push(`unique keys: rows were keyed ${kvKeys.join(" ")}`)
    kv.close()
    await scratch(async (fresh) => {
      const other = new DatabaseSync(join(fresh, "kv.db"))
      other.exec("CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)")
      other.prepare("INSERT INTO cursorDiskKV VALUES ('composerData:other', 'theirs'), ('bubbleId:other:1', 'theirs too')").run()
      const restored = await store.restore({ harness: "synthetic", nativeId: "kv", home: fresh })
      const left = other.prepare("SELECT key, CAST(value AS TEXT) AS value FROM cursorDiskKV ORDER BY key").all().map((row) => `${row["key"]}=${row["value"]}`).join(", ")
      if (left !== "bubbleId:other:1=theirs too, bubbleId:s:1=hello, composerData:other=theirs, composerData:s=mine")
        found.push(`unique keys: restoring beside another session's rows left ${left} (${restored.actions.map((action) => action.action).join(", ")})`)
      other.close()
    })
    return found
  }))
}

failures.push(...await synthetic())
failures.push(...await codexPlacement())
failures.push(...await nullKeys())

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
        failures.push(`${where} ${store.reader}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
      }
    }
  }
}

if (failures.length) {
  console.error(`\n${failures.join("\n")}\n`)
  process.exit(1)
}
console.log(`PASS: ${stores} stores kept as ${units} unit versions (${(bytes / 1024 / 1024).toFixed(1)} MiB of chunks) restore under a fresh home holding the same bytes and drawing the same, onto themselves writing nothing, and onto an earlier copy by appending; each of the ${cited} records their markers cite is kept; a synthetic store's changes are taken as they happened, and a destination that went on without Mako is left untouched`)
