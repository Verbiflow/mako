import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { compactionEvent } from "../dist/events.js"
import { CursorProvider } from "../dist/providers/cursor.js"
import { cursorCompactionReadings } from "../dist/providers/cursor-compactions.js"
import { NativeStores } from "../dist/read-only-sqlite.js"

const nativeStores = new NativeStores(false)

// Cursor summarizes on its server mid-turn and SDK 1.0.31 streams nothing
// about it: a checkpoint root archives the window the summary replaced
// (field 13), still carrying the reading from before it, and the SDK writes
// that root only after the step the summary preceded has run, one row before
// that step's own checkpoint (a real composer-2.5 turn of 2026-10-17). The
// saved reader draws the marker the live child draws, citing the window,
// with what the context held before (the last main root's reading, never a
// subagent's in between) and after (the run's next reading that differs,
// the stale root's own skipped), before the step the summary preceded.
const id = "77777777-7777-4777-8777-777777777777"
const varint = (value) => {
  const bytes = []
  let rest = value
  while (rest >= 0x80) {
    bytes.push((rest % 0x80) | 0x80)
    rest = Math.floor(rest / 0x80)
  }
  bytes.push(rest)
  return Buffer.from(bytes)
}
const field = (number, data) => Buffer.concat([varint(number * 8 + 2), varint(data.length), data])
const reading = (used) => field(5, Buffer.concat([varint(8), varint(used), varint(16), varint(200_000)]))
const hashes = (list) => Buffer.concat(list.map((key) => field(1, Buffer.from(key, "hex"))))
const windows = (list) => Buffer.concat(list.map((key) => field(13, Buffer.from(key, "hex"))))
const root = (live, archived, used) => Buffer.concat([hashes(live), windows(archived), field(9, Buffer.from("file:///work")), reading(used)])
const checkpoint = (blobId) => JSON.stringify({ blobId, storeKind: "local-agent-store" })
const key = (data) => createHash("sha256").update(data).digest("hex")

const message = (value) => Buffer.from(JSON.stringify(value))
const call = (callId) => ({ role: "assistant", content: [{ type: "tool-call", toolName: "Read", toolCallId: callId, args: { path: `${callId}.txt` } }] })
const result = (callId) => ({ role: "tool", content: [{ type: "tool-result", toolCallId: callId, result: `${callId} read` }] })
const system = { role: "system", content: "You are an AI coding assistant." }
const workspace = { role: "user", content: [{ type: "text", text: "<user_info>workspace</user_info>" }] }
const prompt = { role: "user", content: [{ type: "text", text: "<user_query>Read the three files.</user_query>" }] }
const summary = { role: "user", content: "[Previous conversation summary]: Read one.txt so far.", providerOptions: { cursor: { isSummary: true } } }

const home = await mkdtemp(join(tmpdir(), "mako-cursor-summary-"))
try {
  const sdkRoot = join(home, ".mako", "cursor-sdk")
  const directory = join(sdkRoot, "agents", `agent-${createHash("sha256").update(id).digest("hex")}`)
  await mkdir(directory, { recursive: true })
  const path = join(directory, "store.db")
  const store = new DatabaseSync(path)
  store.exec("CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)")
  // Written in the order the SDK writes them: `rowid` is that order.
  const put = (data) => {
    const blobId = key(data)
    store.prepare("INSERT OR IGNORE INTO blobs VALUES (?, ?)").run(blobId, data)
    return blobId
  }
  const [s, w, p] = [system, workspace, prompt].map((value) => put(message(value)))
  const [a1, r1] = [call("one"), result("one")].map((value) => put(message(value)))
  put(root([s, w, p, a1, r1], [], 12_000))
  // A subagent's checkpoint between the main ones: its own system prompt, its own reading.
  put(root([put(message({ role: "system", content: "You are a subagent." }))], [], 5_000))
  const [a2, r2] = [call("two"), result("two")].map((value) => put(message(value)))
  put(root([s, w, p, a1, r1, a2, r2], [], 188_331))
  // The step the summary preceded runs, then the root archiving the window lands, still stale, then the step's own.
  const [a3, r3] = [call("three"), result("three")].map((value) => put(message(value)))
  const window = put(Buffer.concat([hashes([s, w, p, a1, r1]), field(2, Buffer.from("Read one.txt so far."))]))
  const sum = put(message(summary))
  const stale = put(root([s, w, sum, a2, r2], [window], 188_331))
  put(root([s, w, sum, a2, r2, a3, r3], [window], 100_947))
  const answered = put(root([s, w, sum, a2, r2, a3, r3, put(message({ role: "assistant", content: [{ type: "text", text: "Done." }] }))], [window], 101_200))
  store.prepare("INSERT INTO meta VALUES (?, ?)").run("0", JSON.stringify({ agentId: id, name: "Summary" }))

  const index = new DatabaseSync(join(sdkRoot, "index.db"))
  index.exec(
    "CREATE TABLE agents (agent_id TEXT PRIMARY KEY, workspace_ref TEXT NOT NULL, status TEXT NOT NULL, latest_checkpoint_ref_json TEXT, name TEXT, metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);" +
      "CREATE TABLE runs (run_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, turn_number INTEGER NOT NULL, status TEXT NOT NULL, model TEXT, model_params_json TEXT, start_checkpoint_ref_json TEXT, latest_checkpoint_ref_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, started_at TEXT, finished_at TEXT);" +
      "CREATE TABLE run_events (run_id TEXT NOT NULL, seq INTEGER NOT NULL, event_type TEXT NOT NULL, payload_json TEXT, created_at TEXT NOT NULL);"
  )
  index.prepare("INSERT INTO agents VALUES (?, ?, 'IDLE', ?, 'Summary', '{}', '2026-10-17T00:00:00.000Z', '2026-10-17T00:00:09.000Z')").run(id, home, checkpoint(answered))
  index.prepare("INSERT INTO runs VALUES ('run-1', ?, 1, 'FINISHED', 'composer-2.5', NULL, NULL, ?, '2026-10-17T00:00:00.000Z', '2026-10-17T00:00:00.000Z', '2026-10-17T00:00:01.000Z', '2026-10-17T00:00:08.000Z')").run(id, checkpoint(answered))
  const log = index.prepare("INSERT INTO run_events VALUES ('run-1', ?, 'run_stream_event', ?, '2026-10-17T00:00:02.000Z')")
  const stream = [
    { type: "request" },
    ...["one", "two", "three"].flatMap((callId) => [
      { type: "tool_call", call_id: callId, name: "read", status: "running", args: { path: `${callId}.txt` } },
      { type: "tool_call", call_id: callId, name: "read", status: "completed", args: { path: `${callId}.txt` }, result: { status: "success", value: { content: `${callId} read` } } },
    ]),
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Done." }] } },
  ]
  stream.forEach((value, seq) => log.run(seq + 1, JSON.stringify({ schemaVersion: 1, type: "sdk_message", agentId: id, runId: "run-1", message: { agent_id: id, run_id: "run-1", ...value } })))
  index.close()
  store.close()

  // The window's place: the main root before it, never the subagent's reading; after the step its first root records.
  const read = new DatabaseSync(path, { readOnly: true })
  const places = cursorCompactionReadings(read, [{ rootId: answered }], new Set([window]))
  assert.deepEqual(places.get(window), { tokensBefore: 188_331, tokensAfter: 100_947, after: ["two"] }, "the reading before the summary, the run's next one after it, and the step its first root ends on")
  assert.deepEqual(cursorCompactionReadings(read, [{ startRootId: stale, rootId: answered }], new Set([window])).size, 0, "a run that started with the window didn't archive it")
  assert.deepEqual(cursorCompactionReadings(read, [{ rootId: stale }], new Set([window])).get(window), { tokensBefore: 188_331, after: ["two"] }, "a run that ended on the stale root never measured what the summary left")
  read.close()

  const thread = await new CursorProvider(nativeStores, home).read(path)
  assert.ok(thread, "the store reads")
  const drawn = thread.entries.flatMap((entry) => entry.type === "tool" ? [`call ${entry.id ?? entry.name}`] : entry.type === "event" ? [entry] : [])
  const marker = drawn.find((entry) => typeof entry !== "string")
  const expected = compactionEvent({ summary: "Read one.txt so far.", tokensBefore: 188_331, tokensAfter: 100_947 })
  assert.equal(marker.label, expected.label)
  assert.equal(marker.detail, "188k → 101k tokens", "it says what the context held before and after, as the live marker ends up saying")
  assert.equal(marker.detail, expected.detail)
  assert.equal(marker.body, "Read one.txt so far.")
  assert.deepEqual(marker.source, { harness: "cursor", record: window }, "it cites the window, as the live marker does")
  const order = drawn.map((entry) => typeof entry === "string" ? entry.replace(/^call .*?(one|two|three).*$/, "$1") : "summary")
  assert.deepEqual(order, ["one", "two", "summary", "three"], `drawn before the step the summary preceded: ${order.join(", ")}`)
  console.log("cursor server summary: the saved marker cites the window, reads 188k before and 101k after it, skips a subagent's checkpoint and sits before the step it preceded")
} finally {
  await rm(home, { recursive: true, force: true })
}

// A summary after a run's final step has no reading after it in that run:
// the agent's next run measures it with its first main root that reads
// otherwise, unless a newer summary comes first, which leaves it unmeasured.
// Never a reading from before it.
{
  const across = (newerFirst) => {
    const database = new DatabaseSync(":memory:")
    database.exec("CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)")
    const put = (data) => {
      const blobId = key(data)
      database.prepare("INSERT OR IGNORE INTO blobs VALUES (?, ?)").run(blobId, data)
      return blobId
    }
    const [s, w, p] = [system, workspace, prompt].map((value) => put(message(value)))
    const [a1, r1] = [call("one"), result("one")].map((value) => put(message(value)))
    put(root([s, w, p, a1, r1], [], 150_000))
    const done = put(message({ role: "assistant", content: [{ type: "text", text: "Read." }] }))
    put(root([s, w, p, a1, r1, done], [], 188_000))
    const window = put(Buffer.concat([hashes([s, w, p, a1, r1, done]), field(2, Buffer.from("Read one.txt."))]))
    const sum = put(message(summary))
    const last = put(root([s, w, sum], [window], 188_000))
    const next = put(message({ role: "user", content: [{ type: "text", text: "<user_query>And two.txt.</user_query>" }] }))
    const newer = newerFirst ? put(Buffer.concat([hashes([s, w, sum, next]), field(2, Buffer.from("Asked for two.txt."))])) : undefined
    const [a2, r2] = [call("two"), result("two")].map((value) => put(message(value)))
    put(root([s, w, sum, next, a2], newer ? [window, newer] : [window], newer ? 188_000 : 40_100))
    const end = put(root([s, w, sum, next, a2, r2], newer ? [window, newer] : [window], 41_000))
    const places = cursorCompactionReadings(database, [{ rootId: last }, { startRootId: last, rootId: end }], new Set([window]))
    database.close()
    return places.get(window)
  }
  assert.deepEqual(across(false), { tokensBefore: 188_000, tokensAfter: 40_100, after: ["one"] }, "the next run's first reading that isn't the one from before measures it")
  assert.deepEqual(across(true), { tokensBefore: 188_000, after: ["one"] }, "a newer summary before any reading leaves it unmeasured")
  console.log("cursor server summary: a summary after a run's last step is measured by the next run's first reading, and left unmeasured when a newer summary comes first")
}
