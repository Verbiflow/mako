import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { setTimeout as delay } from "node:timers/promises"
import { SessionCatalog } from "../dist/catalog.js"
import { CodexProvider } from "../dist/providers/codex.js"
import { NativeStores } from "../dist/read-only-sqlite.js"
import { RecordCapture } from "../dist/record-capture.js"
import { RecordStore } from "../dist/record-store.js"

const nativeStores = new NativeStores(false)
const measured = []
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex")

async function until(check, what, ms = 10_000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await check()) return
    await delay(20)
  }
  assert.fail(`timed out waiting for ${what}`)
}

async function stored(store, key) {
  const parts = []
  for await (const part of store.content("codex", key)) parts.push(part)
  return Buffer.concat(parts)
}

const home = await mkdtemp(join(tmpdir(), "mako-record-capture-"))
try {
  const id = "01a0e74f-b716-77a2-8b46-71174540cd63"
  const dated = join(home, ".codex", "sessions", "2026", "10", "14")
  const live = join(dated, `rollout-2026-10-14T02-19-16-${id}.jsonl`)
  await mkdir(dated, { recursive: true })
  const line = (type, payload) => `${JSON.stringify({ timestamp: new Date().toISOString(), type, payload })}\n`
  const message = (role, text) => line("response_item", { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] })
  await writeFile(live, line("session_meta", { id, cwd: home }) + message("user", "Fix the login redirect"))
  const state = new DatabaseSync(join(home, ".codex", "state_5.sqlite"))
  state.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, title TEXT, cwd TEXT, updated_at_ms INTEGER, thread_source TEXT, rollout_path TEXT)")
  state.prepare("INSERT INTO threads VALUES (?, NULL, 'Fix the login redirect', ?, ?, 'user', ?)").run(id, home, Date.now(), live)
  state.close()
  const recordsPath = join(home, "mako-records")

  // Discovery takes nothing: what was there before Mako started is the backfill's.
  const catalog = new SessionCatalog([new CodexProvider(nativeStores, home)], { recordsPath, recordsHome: home })
  await catalog.scan()
  await delay(400)
  const look = new RecordStore(recordsPath, nativeStores)
  assert.deepEqual(look.sessions(), [], "a session nobody wrote since start isn't captured")

  // A write is captured, and the copy is the file.
  await appendFile(live, message("assistant", "Looking at the redirect handler."))
  await catalog.scan({ emitChanges: true })
  await until(() => look.sessions().length === 1, "the first capture")
  const [unit] = look.units("codex", id).filter((candidate) => candidate.role === "file" && candidate.key.endsWith(".jsonl"))
  assert.ok(unit, "the rollout is a unit of the session")
  assert.equal(sha(await stored(look, unit.key)), sha(await readFile(live)))

  // A reply streaming: twenty writes fold into a few captures, each an append.
  for (let index = 0; index < 20; index++) {
    await appendFile(live, message("assistant", `Step ${index}: still working on the redirect.`))
    await catalog.scan({ emitChanges: true })
    await delay(25)
  }
  const final = await readFile(live)
  await until(async () => look.units("codex", id).find((candidate) => candidate.key === unit.key)?.size === final.length, "the streamed reply")
  const versions = look.versions("codex", unit.key)
  assert.ok(versions.length >= 2 && versions.length <= 8, `twenty writes took ${versions.length} versions`)
  assert.ok(versions.slice(1).every((version) => version.kind === "append"), "each later capture appends")
  measured.push(`20 streamed writes took ${versions.length - 1} captures (${versions.map((version) => version.kind).join(" ")})`)
  assert.equal(sha(await stored(look, unit.key)), sha(final))

  // Stopping takes the last write first.
  await appendFile(live, message("assistant", "Done: the redirect keeps the query string."))
  await catalog.scan({ emitChanges: true })
  await catalog.stop()
  assert.equal(sha(await stored(look, unit.key)), sha(await readFile(live)), "stop flushes the write it was told of")
  await look.close()

  // Read-only catalogs write nothing of Mako's.
  const readOnlyRecords = join(home, "read-only-records")
  const readOnly = new SessionCatalog([new CodexProvider(new NativeStores(true), home)], { recordsPath: readOnlyRecords, recordsHome: home, readOnly: true })
  await readOnly.scan()
  await appendFile(live, message("user", "Thanks"))
  await readOnly.scan({ emitChanges: true })
  await readOnly.stop()
  await assert.rejects(readFile(join(readOnlyRecords, "records.sqlite")), { code: "ENOENT" })
} finally {
  await rm(home, { recursive: true, force: true })
}

function fakeStore(captures, failures = 0) {
  return {
    async capture() {
      captures.push(Date.now())
      await delay(100)
      if (failures-- > 0) throw new Error("database is locked")
      return { versions: [], unchanged: 0, newChunks: 0, newBytes: 0, storedBytes: 0, ms: 100 }
    },
    async close() {},
  }
}
const noRecords = async () => ({ files: [], databases: [] })
const ref = { harness: "codex", nativeId: "pace", path: "/home/pace.jsonl" }

// A store that takes 100 ms is captured at most every half second while writes keep coming.
{
  const captures = []
  const capture = new RecordCapture(fakeStore(captures), noRecords, { home: "/home" })
  const started = Date.now()
  while (Date.now() - started < 2_000) {
    capture.wrote(ref)
    await delay(10)
  }
  await capture.stop()
  const gaps = captures.slice(1).map((at, index) => at - captures[index])
  assert.ok(captures.length >= 3 && captures.length <= 6, `${captures.length} captures in two seconds of writes`)
  assert.ok(gaps.every((gap) => gap >= 450), `gaps ${gaps.join(", ")} keep capture to a fifth of the time`)
  measured.push(`a 100 ms store under constant writes: ${captures.length} captures, ${gaps.join("/")} ms apart`)
}

// A refused capture is tried again without another write, and not reported.
{
  const captures = []
  const errors = []
  const capture = new RecordCapture(fakeStore(captures, 1), noRecords, { home: "/home", onError: (_ref, error) => errors.push(error) })
  capture.wrote(ref)
  await until(() => captures.length === 2, "the retry", 5_000)
  await capture.stop()
  assert.equal(errors.length, 0)
}

console.log(`record-capture: ok\n  ${measured.join("\n  ")}`)
