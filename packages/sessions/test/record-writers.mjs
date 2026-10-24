import assert from "node:assert/strict"
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { ClaudeProvider } from "../dist/providers/claude.js"
import { CodexProvider } from "../dist/providers/codex.js"
import { NativeStores } from "../dist/read-only-sqlite.js"
import { RecordStore } from "../dist/record-store.js"
import { STREAMS_ROOT, streamPath, streamsRoot, withStreams } from "../dist/record-streams.js"
import { observedInstall } from "../dist/record-observed.js"
import { fieldScan, mergeWriters, newestWriter, restoreGate, STREAM_RUNTIME_SCAN, writersOf } from "../dist/record-writers.js"

/**
 * Which harness version wrote what the record store captures: stated by the
 * records, observed from a launch's stream or the install a write landed
 * under, kept per version and per session, and the one gate every restore
 * takes with it. Also the store's format rule: an older build opens what a
 * newer one wrote as long as the newer one says it may.
 */

const stores = new NativeStores(false)
const root = await mkdtemp(join(tmpdir(), "mako-record-writers-"))
try {
  // A scan finds a version a chunk boundary cuts, once, in the order versions first come.
  {
    const scan = fieldScan('"cli_version":"', /"cli_version":"([^"]{1,64})"/, { before: 0, after: 80 })()
    const text = Buffer.from(`{"a":1}\n{"type":"session_meta","payload":{"cli_version":"0.159.3"}}\n{"x":"\\"cli_version\\":\\"9.9.9\\""}\n{"payload":{"cli_version":"0.163.0"}}\n{"payload":{"cli_version":"0.159.3"}}\n`)
    for (let cut = 1; cut < text.length; cut += 7) {
      const each = fieldScan('"cli_version":"', /"cli_version":"([^"]{1,64})"/, { before: 0, after: 80 })()
      each.push(text.subarray(0, cut))
      each.push(text.subarray(cut))
      assert.deepEqual(each.end(), ["0.159.3", "0.163.0"], `cut at ${cut}`)
    }
    scan.push(text)
    assert.deepEqual(scan.end(), ["0.159.3", "0.163.0"], "an escaped field inside a string is content, not a version")
    const runtime = STREAM_RUNTIME_SCAN()
    runtime.push(Buffer.from('{"capture":1,"harness":"grok"}\n{"at":"2026-10-17T09:00:25.199Z","message":{"runtime":"7.7.7"}}\n{"at":"2026-10-17T09:00:25.200Z","runtime":"1.0.46","via":"ACP initialize.agentInfo"}\n'))
    assert.deepEqual(runtime.end(), ["1.0.46"], "only the driver's own runtime line names the version that ran")
  }

  // The gate: records go only into the version that wrote them or a newer one; an unknown version blocks nothing.
  {
    const writers = { record: ["0.159.3"], observed: ["0.163.0"] }
    assert.deepEqual(newestWriter(writers), { version: "0.163.0", source: "observed" })
    assert.equal(restoreGate(writers, "0.163.0").kind, "same-or-newer")
    assert.equal(restoreGate(writers, "0.164.0-alpha.1").kind, "same-or-newer")
    assert.equal(restoreGate(writers, "0.163.0-alpha.9").kind, "older", "a prerelease sorts before its release")
    assert.deepEqual(restoreGate(writers, "0.159.3"), { kind: "older", wrote: { version: "0.163.0", source: "observed" }, installed: "0.159.3" })
    assert.equal(restoreGate(writers, "0.163.0").why, "writer")
    assert.deepEqual(restoreGate({ record: [], observed: [] }, "0.1.0"), { kind: "unproven", installed: "0.1.0", evidence: "unknown" }, "nothing names the writer: gated unless the install is provably newer")
    assert.equal(restoreGate(writers, null).kind, "unknown")
    assert.equal(restoreGate(writers, "not a version").kind, "unknown")
    assert.deepEqual(writersOf(mergeWriters(writers, { record: ["0.163.0"] })).map((writer) => [writer.version, writer.source]), [["0.159.3", "record"], ["0.163.0", "record"]], "what the records state wins over what was observed")
  }

  // Observed from the host's installed readings: only when every installation agrees and the binary is unchanged.
  {
    const bin = join(root, "bin")
    await mkdir(bin, { recursive: true })
    const grok = join(bin, "grok")
    await writeFile(grok, "#!/bin/sh\n")
    const info = await stat(grok)
    const readings = join(root, "runtime-updates.json")
    const write = (updates, signatures) => writeFile(readings, JSON.stringify({ version: 2, updates, signatures }))
    await write({ grok: { provider: "grok", binary: grok, installed: "1.0.62" } }, { grok: { binary: grok, mtimeMs: info.mtimeMs, size: info.size, installed: "1.0.62" } })
    assert.equal(observedInstall(readings, "grok"), "1.0.62")
    assert.equal(observedInstall(readings, "devin"), null, "a harness the host read nothing of")
    await write({ grok: { provider: "grok", binary: grok, installed: "1.0.62" }, "grok:other": { provider: "grok", binary: grok, installed: "1.0.46" } }, { grok: { binary: grok, mtimeMs: info.mtimeMs, size: info.size, installed: "1.0.62" }, "grok:other": { binary: grok, mtimeMs: info.mtimeMs, size: info.size, installed: "1.0.46" } })
    assert.equal(observedInstall(readings, "grok"), null, "two installations that disagree say nothing")
    await write({ grok: { provider: "grok", binary: grok, installed: "1.0.62" }, "grok:other": { provider: "grok", binary: join(bin, "missing") } }, { grok: { binary: grok, mtimeMs: info.mtimeMs, size: info.size, installed: "1.0.62" } })
    assert.equal(observedInstall(readings, "grok"), null, "an installation whose version wasn't read may be the writer")
    await write({ grok: { provider: "grok", binary: grok, installed: "1.0.62" } }, { grok: { binary: grok, mtimeMs: info.mtimeMs, size: info.size, installed: "1.0.62" } })
    await utimes(grok, new Date(), new Date(info.mtimeMs + 60_000))
    assert.equal(observedInstall(readings, "grok"), null, "a binary replaced since it was read")
    assert.equal(observedInstall(join(root, "absent.json"), "grok"), null)
  }

  // Claude Code: every line states its version; a session updated mid-conversation keeps both.
  {
    const home = join(root, "claude-home")
    const project = join(home, ".claude", "projects", "-work")
    await mkdir(project, { recursive: true })
    const id = "6676d8e9-0576-43d4-9858-31fe4b22cd20"
    const path = join(project, `${id}.jsonl`)
    const line = (version, text) => `${JSON.stringify({ parentUuid: null, isSidechain: false, userType: "external", cwd: "/work", sessionId: id, version, type: "user", message: { role: "user", content: text }, uuid: crypto.randomUUID(), timestamp: new Date().toISOString() })}\n`
    await writeFile(path, `${JSON.stringify({ type: "custom-title", customTitle: "t", sessionId: id })}\n${line("2.1.200", "first")}`)
    const provider = new ClaudeProvider(home, stores)
    const store = new RecordStore(join(root, "claude-records"), stores)
    const records = await provider.records(path)
    await store.capture({ harness: "claude", nativeId: id, home, records })
    await appendFile(path, line("2.1.283", "second") + line("2.1.283", "third"))
    const report = await store.capture({ harness: "claude", nativeId: id, home, records: await provider.records(path) })
    assert.deepEqual(report.writers, { record: ["2.1.283"], observed: [] })
    const [unit] = store.units("claude", id).filter((candidate) => candidate.key.endsWith(".jsonl"))
    assert.deepEqual(store.versions("claude", unit.key).map((version) => version.writer), [{ versions: ["2.1.200"], source: "record" }, { versions: ["2.1.283"], source: "record" }])
    assert.deepEqual(store.writers("claude", id), { record: ["2.1.200", "2.1.283"], observed: [] })

    // A restore into an older Claude Code writes nothing and says why; into the same one it writes.
    const elsewhere = join(root, "claude-elsewhere")
    const refused = await store.restore({ harness: "claude", nativeId: id, home: elsewhere, installed: "2.1.250" })
    assert.deepEqual(refused.outdated, { wrote: { version: "2.1.283", source: "record" }, installed: "2.1.250" })
    assert.equal(refused.written, false)
    assert.equal(await stat(join(elsewhere, ".claude")).catch(() => null), null, "nothing written for an older install")
    const restored = await store.restore({ harness: "claude", nativeId: id, home: elsewhere, installed: "2.1.283" })
    assert.equal(restored.written, true)
    assert.equal(restored.outdated, undefined)
    assert.equal(await readFile(join(elsewhere, ".claude", "projects", "-work", `${id}.jsonl`), "utf8"), await readFile(path, "utf8"))
    const unknown = await store.restore({ harness: "claude", nativeId: id, home: join(root, "claude-unknown"), installed: null })
    assert.equal(unknown.written, true, "an install whose version is unknown is never refused")
    await store.close()
  }

  // Codex: the rollout's session_meta and the thread's row; a launch's stream observed beside them.
  {
    const home = join(root, "codex-home")
    const id = "01a0e74f-b716-77a2-8b46-71174540cd63"
    const dated = join(home, ".codex", "sessions", "2026", "10", "14")
    const live = join(dated, `rollout-2026-10-14T02-19-16-${id}.jsonl`)
    await mkdir(dated, { recursive: true })
    const line = (type, payload) => `${JSON.stringify({ timestamp: new Date().toISOString(), type, payload })}\n`
    await writeFile(live, line("session_meta", { id, cwd: home, cli_version: "0.159.3", originator: "mako" }) + line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }))
    const state = new DatabaseSync(join(home, ".codex", "state_5.sqlite"))
    state.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, cwd TEXT, rollout_path TEXT, cli_version TEXT)")
    state.prepare("INSERT INTO threads VALUES (?, 'hi', ?, ?, '0.163.0')").run(id, home, live)
    state.close()
    const recordsPath = join(root, "codex-records")
    const store = new RecordStore(recordsPath, stores)
    const streams = streamsRoot(recordsPath)
    const stream = streamPath(streams, "codex", "2026-10-14T02-20-00-000Z-c.jsonl", id)
    await mkdir(join(streams, "codex"), { recursive: true })
    await writeFile(stream, `{"capture":1,"harness":"codex","session":{}}\n{"at":"2026-10-14T02:20:00.100Z","runtime":"0.163.0","via":"app-server initialize.userAgent"}\n`)
    const provider = new CodexProvider(stores, home)
    const capture = async () => store.capture({ harness: "codex", nativeId: id, home, records: withStreams(await provider.records(live), streams, [stream]) })
    const first = await capture()
    assert.deepEqual(first.writers, { record: ["0.159.3", "0.163.0"], observed: ["0.163.0"] })
    const units = store.units("codex", id)
    const writerOf = (match) => store.versions("codex", units.find((unit) => match(unit.key)).key).at(-1).writer
    assert.deepEqual(writerOf((key) => key.includes(":rollouts/")), { versions: ["0.159.3"], source: "record" })
    assert.deepEqual(writerOf((key) => key.includes("\trow\tthreads\t")), { versions: ["0.163.0"], source: "record" })
    assert.deepEqual(writerOf((key) => key.startsWith(`${STREAMS_ROOT}:`)), { versions: ["0.163.0"], source: "observed" })
    // The schema unit and the migration rows state nothing, and are stamped with the version the stream saw run.
    assert.deepEqual(writerOf((key) => key.endsWith("\tschema")), { versions: ["0.163.0"], source: "observed" })
    // A turn appended later: the rollout states nothing, the stream's own launch did, and stamps it.
    await appendFile(live, line("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] }))
    await appendFile(stream, `{"at":"2026-10-14T02:20:01.000Z","message":{"method":"turn/completed"}}\n`)
    const second = await capture()
    assert.deepEqual(second.writers, { record: [], observed: ["0.163.0"] })
    assert.deepEqual(writerOf((key) => key.includes(":rollouts/")), { versions: ["0.163.0"], source: "observed" })
    assert.deepEqual(newestWriter(store.writers("codex", id)), { version: "0.163.0", source: "record" })
    await store.close()
  }

  // A write heard as it lands, of records that state nothing, takes the installed version; a backfill takes none.
  {
    const home = join(root, "grok-home")
    const folder = join(home, "sessions", "a")
    await mkdir(folder, { recursive: true })
    const updates = join(folder, "updates.jsonl")
    await writeFile(updates, '{"update":1}\n')
    const records = () => ({ roots: [{ name: "grok", path: home }], files: [updates], databases: [], writer: { installed: true } })
    const store = new RecordStore(join(root, "grok-records"), stores)
    const backfill = await store.capture({ harness: "grok", nativeId: "a", home, records: records() })
    assert.deepEqual(backfill.writers, { record: [], observed: [] })
    await appendFile(updates, '{"update":2}\n')
    const live = await store.capture({ harness: "grok", nativeId: "a", home, records: records(), observed: "1.0.62" })
    assert.deepEqual(live.writers, { record: [], observed: ["1.0.62"] })
    const [unit] = store.units("grok", "a")
    assert.deepEqual(store.versions("grok", unit.key).map((version) => version.writer), [null, { versions: ["1.0.62"], source: "observed" }])
    await store.close()
  }

  // The store's format: additive columns need no new number; a newer format an older build may read opens read-only.
  {
    const folder = join(root, "format")
    const store = new RecordStore(folder, stores)
    assert.equal(store.access, "write")
    await store.close()
    const db = new DatabaseSync(join(folder, "records.sqlite"))
    const meta = (key) => db.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value
    assert.equal(meta("schema"), "3")
    assert.equal(meta("reads"), "2", "a format-2 build still reads it")
    assert.match(meta("additions"), /\bwriters\b/)
    db.prepare("UPDATE meta SET value = '4' WHERE key = 'schema'").run()
    db.close()
    const reader = new RecordStore(folder, stores)
    assert.equal(reader.access, "read", "a newer format that says this build may read it")
    assert.deepEqual(reader.sessions(), [])
    assert.throws(() => reader.capture({ harness: "grok", nativeId: "a", home: root, records: { roots: [], files: [], databases: [] } }), /newer Mako's format/)
    await assert.rejects(reader.forget("grok", "a"), /newer Mako's format/)
    await reader.close()
    const again = new DatabaseSync(join(folder, "records.sqlite"))
    assert.equal(again.prepare("SELECT value FROM meta WHERE key = 'schema'").get().value, "4", "an older build writes nothing to it")
    again.prepare("UPDATE meta SET value = '4' WHERE key = 'reads'").run()
    again.close()
    assert.throws(() => new RecordStore(folder, stores), /kept as it is/)

    // A store a format-2 build wrote, which named some rows by their rowid: raised as it opens, and a format-2 build that
    // had it open is stopped inside SQLite, rather than naming rows beside this build's names for them.
    const second = join(root, "second-format")
    await new RecordStore(second, stores).close()
    const lowered = new DatabaseSync(join(second, "records.sqlite"))
    lowered.prepare("UPDATE meta SET value = '2' WHERE key = 'schema'").run()
    lowered.close()
    await new RecordStore(second, stores).close()
    const raised = new DatabaseSync(join(second, "records.sqlite"))
    assert.deepEqual(["schema", "reads"].map((key) => raised.prepare("SELECT value FROM meta WHERE key = ?").get(key).value), ["3", "2"], "raised to this build's format, still read by format 2")
    raised.function("mako_store_format", { deterministic: true }, () => 2)
    assert.throws(() => raised.prepare("INSERT INTO sessions (harness, native_id) VALUES ('devin', 'x')").run(), /newer Mako/, "a format-2 build's write is refused")
    raised.close()

    // A store from before the writers keeps working, and gains the columns.
    const old = join(root, "old-format")
    await mkdir(old, { recursive: true })
    const before = new DatabaseSync(join(old, "records.sqlite"))
    before.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID; INSERT INTO meta VALUES ('schema', '2');
      CREATE TABLE versions (unit INTEGER NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL, at INTEGER NOT NULL, size INTEGER NOT NULL, digest BLOB, tail BLOB, chunks BLOB NOT NULL, captured_at INTEGER NOT NULL, detail TEXT, PRIMARY KEY (unit, seq)) WITHOUT ROWID;`)
    before.close()
    const upgraded = new RecordStore(old, stores)
    assert.equal(upgraded.access, "write")
    await upgraded.close()
    const columns = new DatabaseSync(join(old, "records.sqlite")).prepare("PRAGMA table_info(versions)").all().map((column) => column.name)
    assert.ok(columns.includes("writer") && columns.includes("writer_source"))
  }
  console.log("record writers: stated, observed, kept per version and session; the restore gate; the store's format")
} finally {
  await rm(root, { recursive: true, force: true })
}
