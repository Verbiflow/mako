import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, truncate, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
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
const actions = (report: RestoreReport) => [...new Set([
  ...report.actions.map((action) => action.action),
  ...report.rows.flatMap((rows) => (["insert", "replace", "delete", "skip"] as const).filter((kind) => rows[kind] > 0)),
])].sort().join(" ")
/** Each table's rows a restore writes, as `messages 1 insert 1 replace 1 delete`. */
const tallied = (report: RestoreReport) => report.rows.filter((rows) => rows.insert + rows.replace + rows.delete > 0)
  .map((rows) => [rows.table, ...(["insert", "replace", "delete"] as const).filter((kind) => rows[kind] > 0).map((kind) => `${rows[kind]} ${kind}`)].join(" ")).sort()

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
      if (twice.written || twice.diverged.length)
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
      roots: [{ name: "synthetic", path: home }],
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
      return version.unit === "synthetic:session.jsonl" ? `${version.kind} ${version.bytes}` : `${version.kind} ${table} ${key ? JSON.parse(key).id : ""}`
    })
    const expected = ["append 8", "replace messages m2", "replace messages m4", "delete messages m1", "replace blobs b2"]
    if (described.join(", ") !== expected.join(", ")) found.push(`synthetic: the second capture took ${described.join(", ")}, not ${expected.join(", ")}`)

    const onto = await store.restore({ ...session, home: earlier })
    const did = [...onto.actions.filter((action) => action.action !== "skip").map((action) => `${action.action} ${action.path}`), ...tallied(onto)]
    if (did.join(", ") !== "append synthetic:session.jsonl, blobs 1 insert, messages 1 insert 1 replace 1 delete")
      found.push(`synthetic: restoring onto the earlier copy did ${did.join(", ")}`)
    await withStore(async (copy) => {
      await copy.capture({ ...session, home: earlier, records: { ...records, roots: [{ name: "synthetic", path: earlier }], files: [join(earlier, "session.jsonl")], databases: [{ ...records.databases[0]!, path: join(earlier, "store.db") }] } })
      const lost = differences(await snapshot(store, "synthetic", "s"), await snapshot(copy, "synthetic", "s"))
      if (lost.length) found.push(`synthetic: the earlier copy, restored onto, holds other units: ${lost.slice(0, 3).join(", ")}`)
    })

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
      const action = restored.actions.find((entry) => entry.path === "synthetic:session.jsonl")?.action
      if (action !== "write-plain" || existsSync(join(fresh, "session.jsonl.zst")))
        found.push(`synthetic: a compressed earlier copy was met with ${action}, ${existsSync(join(fresh, "session.jsonl.zst")) ? "and still exists" : "and removed"}`)
    })

    // A destination that went on without Mako is never overwritten.
    await scratch(async (fresh) => {
      await store.restore({ ...session, home: fresh })
      await writeFile(join(fresh, "session.jsonl"), `{"n":0}\n{"n":2}\n{"n":3}\n{"n":4}\n{"n":"elsewhere"}\n`)
      const before = await readFile(join(fresh, "session.jsonl"), "utf8")
      const longer = await store.restore({ ...session, home: fresh })
      if (longer.written || !longer.diverged.some((entry) => entry.unit === "synthetic:session.jsonl")) found.push("synthetic: a transcript that went on at the destination wasn't held back")
      await writeFile(join(fresh, "session.jsonl"), `{"n":9}\n`)
      const other = await store.restore({ ...session, home: fresh })
      if (other.written || !other.diverged.some((entry) => entry.unit === "synthetic:session.jsonl")) found.push("synthetic: a transcript that differs at the destination wasn't held back")
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
      const extra = await store.restore({ ...session, home: fresh, destination: { roots: [{ name: "synthetic", path: fresh }], files: [join(fresh, "session.jsonl"), join(fresh, "notes.jsonl")], databases: [] } })
      if (!extra.diverged.some((entry) => entry.unit === "synthetic:notes.jsonl")) found.push("synthetic: a file of the session Mako never saw didn't count as going on")
    })

    await scratch(async (fresh) => {
      const held = await store.restore({ ...session, home: fresh, held: () => true })
      if (held.written || existsSync(join(fresh, "session.jsonl"))) found.push("synthetic: a restore wrote while the session was held")
    })

    const m4 = await store.decoded("synthetic", `synthetic:store.db\trow\tmessages\t${JSON.stringify({ id: "m4" })}`)
    if ("statements" in m4 || m4["size"] !== 4n || m4["body"] !== "fourth") found.push(`synthetic: m4 decodes as ${JSON.stringify("statements" in m4 ? m4 : taggedRow(m4))}`)

    try {
      await store.capture({ ...session, records: { ...records, files: [join(home, "..", "outside.jsonl")], databases: [] } })
      found.push("synthetic: a file outside every root was captured")
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
    const roots = [{ name: "codex", path: join(home, ".codex") }]
    const at = (path: string, nativeId = "t") => ({ harness: "codex", nativeId, home, records: { roots, files: [path], databases: [], place: codexRecordPlace } })
    await store.capture(at(join(dated, name)))
    await writeFile(join(dated, `${name}.zst`), zstdCompressSync(body))
    await rm(join(dated, name))
    const compressed = await store.capture(at(join(dated, `${name}.zst`)))
    const archived = join(home, ".codex", "archived_sessions")
    await mkdir(archived, { recursive: true })
    await rename(join(dated, `${name}.zst`), join(archived, `${name}.zst`))
    const moved = await store.capture(at(join(archived, `${name}.zst`)))
    const unlisted = await store.capture({ ...at(join(archived, `${name}.zst`)), records: { roots, files: [], databases: [] } })
    if (compressed.versions.length || moved.versions.length || unlisted.versions.length)
      found.push(`codex: compressing, archiving or not listing a rollout took ${[compressed, moved, unlisted].map(kinds).join(" | ")}`)
    if (store.units("codex", "t").length !== 1) found.push(`codex: one rollout became ${store.units("codex", "t").length} units`)
    const codex = { place: codexRecordPlace, roots }
    if (fileUnitKey(codex, join(archived, `${name}.zst`)) !== fileUnitKey(codex, join(dated, name)))
      found.push("codex: an archived rollout has another key than its dated original")
    await rm(join(archived, `${name}.zst`))
    const gone = await store.capture({ ...at(join(archived, `${name}.zst`)), records: { roots, files: [], databases: [] } })
    if (kinds(gone) !== "delete") found.push(`codex: a rollout gone from every folder was taken as ${kinds(gone) || "nothing"}`)
    // Dropped while the session lived, so a restore follows the session as it now is.
    await scratch(async (fresh) => {
      const back = await store.restore({ harness: "codex", nativeId: "t", home: fresh })
      if (back.written || existsSync(join(fresh, ".codex"))) found.push(`codex: a rollout the session dropped was restored (${actions(back)})`)
    })
    // A session that expired whole is never captured again: its last capture restores whole.
    const other = name.replace("01a00000", "01a00001")
    await writeFile(join(dated, other), body)
    await store.capture(at(join(dated, other), "expired"))
    await rm(join(dated, other))
    const expired = await store.restore({ harness: "codex", nativeId: "expired", home })
    if (!expired.written || !(await readFile(join(dated, other))).equals(body)) found.push(`codex: an expired session's rollout didn't restore whole (${actions(expired)})`)
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
    const records = (folder: string): SessionRecords => ({ roots: [{ name: "synthetic", path: folder }], files: [], databases: [{ path: join(folder, "store.db"), tables: [{ table: "__drizzle_migrations" }] }] })
    const session = { harness: "synthetic", nativeId: "migrations", home, records: records(home) }
    await store.capture(session)
    const rows = store.units("synthetic", "migrations").filter((unit) => unit.role === "row")
    if (rows.length !== 3) found.push(`null keys: three rows with NULL ids became ${rows.length} units`)
    const onto = await store.restore({ harness: "synthetic", nativeId: "migrations", home })
    const count = (db: Database) => Number(db.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get()?.["n"])
    if (onto.written || onto.diverged.length || count(source) !== 3) found.push(`null keys: restoring onto the same rows did ${actions(onto)}, leaving ${count(source)} rows`)
    source.prepare("DELETE FROM __drizzle_migrations WHERE name = 'second'").run()
    const deleted = await store.capture(session)
    if (kinds(deleted) !== "delete") found.push(`null keys: a deleted row was taken as ${kinds(deleted) || "nothing"}`)
    await scratch(async (fresh) => {
      const before = make(fresh)
      for (const [at, name] of [[1, "first"], [2, "second"], [3, "third"]] as const)
        before.prepare("INSERT INTO __drizzle_migrations VALUES (NULL, '', ?, ?)").run(at, name)
      const restored = await store.restore({ harness: "synthetic", nativeId: "migrations", home: fresh })
      const names = before.prepare("SELECT name FROM __drizzle_migrations ORDER BY created_at").all().map((row) => row["name"]).join(", ")
      if (names !== "first, third" || restored.diverged.length) found.push(`null keys: restoring onto the earlier rows left ${names} (${actions(restored)})`)
      before.close()
    })
    source.close()

    // A table with only `key UNIQUE` (Cursor's `cursorDiskKV`): restored by key, never onto the destination's own rows that share a rowid.
    const kv = new DatabaseSync(join(home, "kv.db"))
    kv.exec("CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)")
    kv.prepare("INSERT INTO cursorDiskKV VALUES ('composerData:s', 'mine'), ('bubbleId:s:1', 'hello')").run()
    const kvRecords = (folder: string): SessionRecords => ({ roots: [{ name: "synthetic", path: folder }], files: [], databases: [{ path: join(folder, "kv.db"), tables: [{ table: "cursorDiskKV" }] }] })
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
        found.push(`unique keys: restoring beside another session's rows left ${left} (${actions(restored)})`)
      other.close()
    })
    return found
  }))
}

/**
 * A Codex-like home: the thread's row names its rollout by absolute path,
 * and a shared name log holds a line per naming. Restored under another
 * home, or with the store kept outside any home, the row names the rollout
 * where it now is, the working directory stays, and the log gains only the
 * thread's own lines.
 */
async function layouts(): Promise<string[]> {
  const { DatabaseSync } = await import("node:sqlite")
  return scratch(async (root) => withStore(async (store) => {
    const found: string[] = []
    const name = "rollout-2026-10-01T10-00-00-01a00000-0000-7000-8000-000000000000.jsonl"
    const make = async (codexHome: string) => {
      const dated = join(codexHome, "sessions", "2026", "10", "01")
      await mkdir(dated, { recursive: true })
      await writeFile(join(dated, name), `{"type":"session_meta"}\n`)
      const db = new DatabaseSync(join(codexHome, "state.sqlite"))
      db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT)")
      db.prepare("INSERT INTO threads VALUES ('t', ?, '/work/project'), ('u', ?, '/work/other')").run(join(dated, name), join(dated, "other.jsonl"))
      db.close()
      await writeFile(join(codexHome, "session_index.jsonl"), `{"id":"u","thread_name":"Other"}\n{"id":"t","thread_name":"First"}\n`)
      const records: SessionRecords = {
        roots: [{ name: "codex", path: codexHome }],
        files: [join(dated, name)],
        databases: [{ path: join(codexHome, "state.sqlite"), tables: [{ table: "threads", where: "id = ?", params: ["t"], paths: ["rollout_path"] }] }],
        lines: [{ path: join(codexHome, "session_index.jsonl"), field: "id", value: "t" }],
        place: codexRecordPlace,
      }
      return records
    }
    const row = (codexHome: string) => {
      const db = new DatabaseSync(join(codexHome, "state.sqlite"), { readOnly: true })
      try {
        return db.prepare("SELECT rollout_path AS path, cwd FROM threads WHERE id = 't'").get()
      } finally {
        db.close()
      }
    }
    const home = join(root, "home")
    const session = { harness: "codex", nativeId: "t", home, records: await make(join(home, ".codex")) }
    await store.capture(session)

    const moved = join(root, "moved")
    const restored = await store.restore({ harness: "codex", nativeId: "t", home: moved })
    const at = row(join(moved, ".codex"))
    if (at?.["path"] !== join(moved, ".codex", "sessions", "2026", "10", "01", name) || at["cwd"] !== "/work/project")
      found.push(`layouts: a row restored under another home names ${String(at?.["path"])} in ${String(at?.["cwd"])}`)
    if (restored.movedPaths !== 1) found.push(`layouts: a restore under another home moved ${restored.movedPaths} paths, not 1`)
    if ((await readFile(join(moved, ".codex", "session_index.jsonl"), "utf8")) !== `{"id":"t","thread_name":"First"}\n`)
      found.push("layouts: the restored name log holds other lines than the thread's")
    const again = await store.restore({ harness: "codex", nativeId: "t", home: moved })
    if (again.written || again.diverged.length) found.push(`layouts: restoring onto its own moved restore did ${actions(again)}${again.diverged.length ? `, diverging at ${again.diverged[0]!.unit}` : ""}`)

    // A rename appends a line; restored onto the earlier copy, only that line is added, after the destination's own.
    await writeFile(join(moved, ".codex", "session_index.jsonl"), `{"id":"t","thread_name":"First"}\n{"id":"x","thread_name":"Here"}\n`)
    await writeFile(join(home, ".codex", "session_index.jsonl"), `{"id":"t","thread_name":"Renamed"}\n`, { flag: "a" })
    const renamed = await store.capture(session)
    if (kinds(renamed) !== "replace") found.push(`layouts: a rename was taken as ${kinds(renamed) || "nothing"}`)
    const unchanged = await store.capture(session)
    if (unchanged.versions.length) found.push(`layouts: an unchanged name log took ${kinds(unchanged)}`)
    const onto = await store.restore({ harness: "codex", nativeId: "t", home: moved })
    if ((await readFile(join(moved, ".codex", "session_index.jsonl"), "utf8")) !== `{"id":"t","thread_name":"First"}\n{"id":"x","thread_name":"Here"}\n{"id":"t","thread_name":"Renamed"}\n`)
      found.push(`layouts: restoring a rename onto the earlier copy did ${actions(onto)}`)
    await writeFile(join(moved, ".codex", "session_index.jsonl"), `{"id":"t","thread_name":"Named here"}\n`)
    const elsewhere = await store.restore({ harness: "codex", nativeId: "t", home: moved })
    if (elsewhere.written || !elsewhere.diverged.some((entry) => entry.unit.includes("\tlines\t"))) found.push("layouts: a name given at the destination wasn't held back")

    // Kept outside any home: a restore must be told where, and the row follows.
    const outside = join(root, "elsewhere", "codex")
    const kept = { harness: "codex", nativeId: "t", home, records: await make(outside) }
    await withStore(async (apart) => {
      await apart.capture(kept)
      const unnamed = await apart.restore({ harness: "codex", nativeId: "t", home: moved })
      if (unnamed.written || !unnamed.diverged.some((entry) => entry.unit === "codex:")) found.push("layouts: a store kept outside the home restored without being told where")
      const there = join(root, "there")
      const named = await apart.restore({ harness: "codex", nativeId: "t", home: moved, roots: [{ name: "codex", path: there }] })
      if (!named.written || row(there)?.["path"] !== join(there, "sessions", "2026", "10", "01", name)) found.push(`layouts: a store restored where named holds ${String(row(there)?.["path"])}`)
      const units = apart.units("codex", "t").map((unit) => unit.key).sort()
      if (units.some((key) => !key.startsWith("codex:"))) found.push(`layouts: units of a store outside the home are keyed ${units.join(", ")}`)
    })
    return found
  }))
}

/** A session folder the harness moves while the session lives: its old place is dropped, never restored beside the new one. */
async function movedFolder(): Promise<string[]> {
  return scratch(async (home) => withStore(async (store) => {
    const found: string[] = []
    const roots = [{ name: "synthetic", path: join(home, "sessions") }]
    const before = join(home, "sessions", "here", "s", "transcript.jsonl")
    const after = join(home, "sessions", "there", "s", "transcript.jsonl")
    await mkdir(dirname(before), { recursive: true })
    await writeFile(before, `{"n":1}\n`)
    const at = (path: string) => ({ harness: "synthetic", nativeId: "s", home, records: { roots, files: [path], databases: [] } })
    await store.capture(at(before))
    await scratch(async (fresh) => {
      await store.restore({ harness: "synthetic", nativeId: "s", home: fresh })
      await mkdir(dirname(after), { recursive: true })
      await rename(before, after)
      const moved = await store.capture(at(after))
      if (kinds(moved).split(" ").sort().join(" ") !== "delete replace") found.push(`moved folder: a moved transcript was taken as ${kinds(moved)}`)
      const onto = await store.restore({ harness: "synthetic", nativeId: "s", home: fresh })
      const placed = (path: string) => join(fresh, path.slice(home.length))
      if (existsSync(placed(before)) || !existsSync(placed(after))) found.push(`moved folder: restoring onto the copy at its old place did ${actions(onto)}`)
    })
    await scratch(async (fresh) => {
      await store.restore({ harness: "synthetic", nativeId: "s", home: fresh })
      if (existsSync(join(fresh, before.slice(home.length)))) found.push("moved folder: a fresh restore wrote the transcript's old place")
    })
    return found
  }))
}

/** A table larger than one read is read in several, each short; a row that leaves the session leaves its units and stays in the database. */
async function pagedReads(): Promise<string[]> {
  const { DatabaseSync } = await import("node:sqlite")
  return scratch(async (home) => withStore(async (store) => {
    const found: string[] = []
    const path = join(home, "big.db")
    const db = new DatabaseSync(path)
    db.exec("PRAGMA journal_mode = WAL; CREATE TABLE parts (id TEXT PRIMARY KEY, session_id TEXT, body BLOB); CREATE TABLE pairs (a TEXT, b TEXT, PRIMARY KEY (a, b)) WITHOUT ROWID")
    const insert = db.prepare("INSERT INTO parts VALUES (?, 's', ?)")
    for (let n = 0; n < 24; n++) insert.run(`p${n}`, new Uint8Array(1024 * 1024).fill(n))
    db.prepare("INSERT INTO pairs VALUES ('s', 'one'), ('s', 'two'), ('other', 'three')").run()
    // A rowid alias (Devin's `message_nodes.row_id`): SQLite names a selected rowid after it.
    db.exec("CREATE TABLE nodes (row_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, body TEXT)")
    db.prepare("INSERT INTO nodes (session_id, body) VALUES ('s', 'a'), ('s', 'b'), ('other', 'c')").run()
    const records: SessionRecords = { roots: [{ name: "synthetic", path: home }], files: [], databases: [{ path, tables: [
      { table: "parts", where: "session_id = ?", params: ["s"] },
      { table: "pairs", where: "a = ?", params: ["s"] },
      { table: "nodes", where: "session_id = ?", params: ["s"] },
      { table: "sqlite_sequence" },
    ] }] }
    const session = { harness: "synthetic", nativeId: "s", home, records }
    // Another session's capture, asked for once this one is under way, goes between its slices.
    await writeFile(join(home, "small.jsonl"), `{"n":1}\n`)
    const finished: string[] = []
    const long = store.capture(session).then((report) => (finished.push("long"), report))
    await new Promise((resolve) => setImmediate(resolve))
    const short = store.capture({ harness: "synthetic", nativeId: "small", home, records: { roots: records.roots, files: [join(home, "small.jsonl")], databases: [] } }).then(() => finished.push("short"))
    const [first] = await Promise.all([long, short])
    if (finished.join(" ") !== "short long") found.push(`paged reads: a short capture asked for during a long one finished ${finished.join(" then ")}`)
    if (first.waitedMs <= 0) found.push("paged reads: a long capture that let a short one go first reports no time waiting")
    if (first.reads < 3) found.push(`paged reads: 24 MiB of rows were read in ${first.reads} reads`)
    const rows = store.units("synthetic", "s").filter((unit) => unit.role === "row").map((unit) => unit.key.split("\t")[2])
    const counted = ["parts", "pairs", "nodes", "sqlite_sequence"].map((table) => `${table} ${rows.filter((name) => name === table).length}`).join(", ")
    if (counted !== "parts 24, pairs 2, nodes 2, sqlite_sequence 1") found.push(`paged reads: the session holds ${counted}`)
    db.prepare("UPDATE parts SET session_id = 'other' WHERE id = 'p3'").run()
    db.prepare("DELETE FROM pairs WHERE b = 'two'").run()
    const second = await store.capture(session)
    const keys = store.units("synthetic", "s").map((unit) => unit.key)
    if (keys.some((key) => key.includes('"p3"'))) found.push("paged reads: a row given to another session is still this one's")
    if (kinds(second) !== "delete") found.push(`paged reads: a deleted row and one given away were taken as ${kinds(second) || "nothing"}`)
    db.close()
    await scratch(async (fresh) => {
      const restored = await store.restore({ ...session, home: fresh })
      const copy = new DatabaseSync(join(fresh, "big.db"), { readOnly: true })
      const parts = Number(copy.prepare("SELECT count(*) AS n FROM parts").get()?.["n"])
      const pairs = copy.prepare("SELECT b FROM pairs ORDER BY b").all().map((entry) => entry["b"]).join(" ")
      copy.close()
      if (parts !== 23 || pairs !== "one" || restored.diverged.length) found.push(`paged reads: the restore holds ${parts} parts and pairs ${pairs}`)
    })
    return found
  }))
}

failures.push(...await synthetic())
failures.push(...await codexPlacement())
failures.push(...await nullKeys())
failures.push(...await layouts())
failures.push(...await movedFolder())
failures.push(...await pagedReads())

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
