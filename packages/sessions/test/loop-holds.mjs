import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { Worker } from "node:worker_threads"
import { CursorProvider } from "../dist/providers/cursor.js"
import { NativeStores } from "../dist/read-only-sqlite.js"
import { RecordStore } from "../dist/record-store.js"
import { RecordSync } from "../dist/record-sync.js"
import { ViewCache } from "../dist/view-cache.js"
import { largeCursorChat } from "./large-cursor-chat.mjs"

// The sync daemon answers the host on one loop: a read whole, a follow, a
// view written or a write to the record store that held it for the size of a
// Session kept the host's pings and status reads waiting, past their timeouts
// on a large one. Each is timed here on a Cursor chat of 25MB, as a headless
// agent writes one: one exchange holding the whole conversation.
/**
 * The longest a step may hold the loop, in CPU time: half again what parsing a JSON document the chat's size takes on
 * this runner, now, which is about 55 ms on an M-series Mac. A runner with a slower CPU is slower at both, so this
 * scales with it where a fixed time wouldn't; a step that holds the loop for the whole chat (unsliced) takes several times
 * the parse. The parse is the middle of five.
 */
const HOLD_MS = (() => {
  const text = JSON.stringify(Array.from({ length: 120_000 }, (_, index) => ({ id: `m${index}`, role: index % 2 ? "assistant" : "user", text: "word ".repeat(30), at: index })))
  const parses = Array.from({ length: 5 }, () => {
    const { user, system } = process.threadCpuUsage()
    JSON.parse(text)
    const after = process.threadCpuUsage()
    return (after.user - user + after.system - system) / 1000
  }).sort((a, b) => a - b)
  return Math.round(parses[2] * 1.5)
})()
/** How many turns the loop takes through a store lock's wait before the lock goes. */
const TURNS_THROUGH_WAIT = 20
/** What releases the store's lock if the loop never turns through its wait. */
const LOCK_HANG_MS = 30_000

/**
 * The longest the loop went without a turn while `work` ran, in this thread's own CPU time: a runner that takes the
 * CPU away mid-slice stretches the slice's wall time (117 ms once on CI, unchanged code), not the work it held.
 */
async function longestHold(work, onTurn = () => {}) {
  const cpu = () => {
    const { user, system } = process.threadCpuUsage()
    return (user + system) / 1000
  }
  let longest = 0
  let longestWall = 0
  let turns = 0
  let last = cpu()
  const began = performance.now()
  let lastWall = began
  const turn = () => {
    const now = cpu()
    const wall = performance.now()
    longest = Math.max(longest, now - last)
    longestWall = Math.max(longestWall, wall - lastWall)
    last = now
    lastWall = wall
    turns++
    onTurn(turns)
  }
  const timer = setInterval(turn, 1)
  try {
    const result = await work()
    turn()
    return { result, ms: longest, wallMs: longestWall, turns, tookMs: performance.now() - began }
  } finally {
    clearInterval(timer)
  }
}

const measured = []
function held(what, { ms, wallMs }) {
  measured.push(`${what}: ${Math.round(ms)} ms (${Math.round(wallMs)} ms on the clock)`)
  assert.ok(ms <= HOLD_MS, `${what} held the loop ${Math.round(ms)} ms of its CPU (at most ${HOLD_MS}; ${Math.round(wallMs)} ms on the clock)`)
}

/** A `cursor-agent` chat of `count` short messages under one root: a version each in the record store. */
function manyMessages(home, count) {
  const agentId = "88888888-8888-4888-8888-888888888888"
  const folder = join(home, ".cursor", "chats", "d".repeat(32), agentId)
  mkdirSync(folder, { recursive: true })
  const path = join(folder, "store.db")
  const db = new DatabaseSync(path)
  db.exec("CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)")
  const insert = db.prepare("INSERT INTO blobs VALUES (?, ?)")
  const hashes = []
  db.exec("BEGIN")
  for (let index = 0; index < count; index++) {
    const data = Buffer.from(JSON.stringify(index % 2 ? { role: "assistant", content: [{ type: "text", text: `Answer ${index}.` }] } : { role: "user", content: [{ type: "text", text: `<user_query>Question ${index}?</user_query>` }] }))
    const hash = createHash("sha256").update(data).digest("hex")
    insert.run(hash, data)
    hashes.push(hash)
  }
  const rootData = Buffer.concat(hashes.map((hash) => Buffer.concat([Buffer.from([0x0a, 0x20]), Buffer.from(hash, "hex")])))
  const rootId = createHash("sha256").update(rootData).digest("hex")
  insert.run(rootId, rootData)
  db.prepare("INSERT INTO meta VALUES ('0', ?)").run(Buffer.from(JSON.stringify({ agentId, latestRootBlobId: rootId, name: "Many messages", mode: "default" })).toString("hex"))
  db.exec("COMMIT")
  db.close()
  writeFileSync(join(folder, "meta.json"), JSON.stringify({ schemaVersion: 1, createdAtMs: Date.now(), hasConversation: true, updatedAtMs: Date.now(), cwd: home }))
  return { path, agentId }
}

/**
 * A Cursor SDK agent as a Fin's runs: its store's messages and a root at each step, and in the SDK's index its row,
 * its one running run, and what the run streamed (thinking chunks, a reply, a shell call started and ended a step).
 * `step` adds a step as the SDK checkpoints one.
 */
function sdkAgent(home, steps) {
  const id = "77777777-7777-4777-8777-777777777777"
  const runId = "run-loop-holds"
  const root = join(home, ".mako", "cursor-sdk")
  const folder = join(root, "agents", `agent-${createHash("sha256").update(id).digest("hex")}`)
  mkdirSync(folder, { recursive: true })
  const path = join(folder, "store.db")
  const store = new DatabaseSync(path)
  store.exec("PRAGMA journal_mode = WAL; CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)")
  store.prepare("INSERT INTO meta VALUES ('0', ?)").run(JSON.stringify({ agentId: id, name: "A Fin" }))
  const index = new DatabaseSync(join(root, "index.db"))
  index.exec(
    "PRAGMA journal_mode = WAL;" +
      "CREATE TABLE agents (agent_id TEXT PRIMARY KEY, workspace_ref TEXT NOT NULL, status TEXT NOT NULL, latest_checkpoint_ref_json TEXT, name TEXT, metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);" +
      "CREATE TABLE runs (run_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, turn_number INTEGER NOT NULL, status TEXT NOT NULL, model TEXT, model_params_json TEXT, start_checkpoint_ref_json TEXT, latest_checkpoint_ref_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, started_at TEXT, finished_at TEXT);" +
      "CREATE TABLE run_events (run_id TEXT NOT NULL, seq INTEGER NOT NULL, event_type TEXT NOT NULL, payload_json TEXT, created_at TEXT NOT NULL, PRIMARY KEY (run_id, seq));"
  )
  const at = "2026-11-03T16:00:00.000Z"
  index.prepare("INSERT INTO agents VALUES (?, ?, 'RUNNING', NULL, 'A Fin', '{}', ?, ?)").run(id, home, at, at)
  index.prepare("INSERT INTO runs VALUES (?, ?, 1, 'RUNNING', 'composer-2.5', NULL, NULL, NULL, ?, ?, ?, NULL)").run(runId, id, at, at, at)
  const put = store.prepare("INSERT OR IGNORE INTO blobs VALUES (?, ?)")
  const log = index.prepare("INSERT INTO run_events VALUES (?, ?, 'run_stream_event', ?, ?)")
  const pointRun = index.prepare("UPDATE runs SET latest_checkpoint_ref_json = ?, updated_at = ?")
  const pointAgent = index.prepare("UPDATE agents SET latest_checkpoint_ref_json = ?, updated_at = ?")
  const hashes = []
  const message = (body) => {
    const data = Buffer.from(JSON.stringify(body))
    const hash = createHash("sha256").update(data).digest("hex")
    put.run(hash, data)
    hashes.push(hash)
  }
  let seq = 0
  const event = (body) => log.run(runId, ++seq, JSON.stringify({ schemaVersion: 1, type: "sdk_message", agentId: id, runId, message: { agent_id: id, run_id: runId, ...body } }), at)
  const checkpoint = () => {
    const rootId = createHash("sha256").update(`root-${hashes.length}`).digest("hex")
    put.run(rootId, Buffer.concat(hashes.map((hash) => Buffer.concat([Buffer.from([10, 32]), Buffer.from(hash, "hex")]))))
    const ref = JSON.stringify({ blobId: rootId, storeKind: "local-agent-store" })
    pointRun.run(ref, at)
    pointAgent.run(ref, at)
  }
  let taken = 0
  const step = () => {
    const call = `call-${++taken}`
    const output = `line of output ${taken}\n`.repeat(40)
    store.exec("BEGIN")
    index.exec("BEGIN")
    for (let chunk = 0; chunk < 36; chunk++) event({ type: "thinking", text: `thought ${taken}.${chunk} ` })
    event({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `Step ${taken}: checking.` }] } })
    event({ type: "tool_call", call_id: call, name: "shell", status: "running", args: { command: `echo ${taken}` } })
    event({ type: "tool_call", call_id: call, name: "shell", status: "completed", args: { command: `echo ${taken}` }, result: { status: "success", value: { exitCode: 0, signal: "", stdout: output, stderr: "" } } })
    message({ role: "assistant", content: [{ type: "text", text: `Step ${taken}: checking.` }, { type: "tool-call", toolName: "Shell", toolCallId: call, args: { command: `echo ${taken}` } }] })
    message({ role: "tool", content: [{ type: "tool-result", toolCallId: call, result: output }] })
    checkpoint()
    index.exec("COMMIT")
    store.exec("COMMIT")
  }
  message({ role: "user", content: [{ type: "text", text: "<user_query>Do the work.</user_query>" }] })
  while (taken < steps) step()
  return { path, step, get steps() { return taken }, get events() { return seq }, close: () => { store.close(); index.close() } }
}

const home = await mkdtemp(join(tmpdir(), "mako-loop-holds-"))
try {
  const { rows, agentId } = largeCursorChat()
  const folder = join(home, ".cursor", "chats", "c".repeat(32), agentId)
  mkdirSync(folder, { recursive: true })
  const path = join(folder, "store.db")
  const db = new DatabaseSync(path)
  db.exec("PRAGMA journal_mode = WAL; CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)")
  const insert = db.prepare("INSERT OR IGNORE INTO blobs VALUES (?, ?)")
  const pointAt = db.prepare("INSERT INTO meta VALUES ('0', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
  const roots = rows.flatMap((row, index) => (row.root ? [index] : []))
  /** The chat's rows through its `step`th root, as the agent wrote them. */
  const writeThrough = (step) => {
    db.exec("BEGIN")
    for (const row of rows.slice(0, roots[step] + 1)) insert.run(row.id, row.data)
    pointAt.run(Buffer.from(JSON.stringify({ agentId, latestRootBlobId: rows[roots[step]].id, name: "A long chat", mode: "default" })).toString("hex"))
    db.exec("COMMIT")
  }
  writeThrough(roots.length - 2)
  writeFileSync(join(folder, "meta.json"), JSON.stringify({ schemaVersion: 1, createdAtMs: Date.now(), hasConversation: true, updatedAtMs: Date.now(), cwd: home }))

  const stores = new NativeStores(false)
  const provider = new CursorProvider(stores, home)
  const read = await longestHold(() => provider.read(path))
  assert.ok(read.result && read.result.entries.length > 100, "the chat reads whole")
  held("a read whole", read)

  const follower = provider.createFollower(path, 0)
  await follower.next()
  writeThrough(roots.length - 1)
  const moved = await longestHold(() => follower.next())
  assert.equal(moved.result.replace, true)
  assert.ok(moved.result.entries.length < 10, `a step replaces what moved (${moved.result.entries.length} entries), not its exchange`)
  held("a follow through one more step", moved)

  const views = new ViewCache(join(home, "views"), () => "loop-holds")
  const wrote = await longestHold(() => views.write(path, { bytes: 1, mtimeMs: 1 }, read.result, 100))
  held("its view written", wrote)
  views.close()

  // A backfill pass's process holds the record store's write lock until its next commit.
  const records = join(home, "records")
  const store = new RecordStore(records, stores)
  const ref = { harness: "cursor", nativeId: agentId }
  const captured = await longestHold(async () => store.capture({ ...ref, home, path, records: await provider.records(path) }))
  assert.ok(captured.result.taken > rows.length / 2, `the chat's rows are captured (${captured.result.taken})`)
  held("a capture of the whole chat", captured)
  // The lock goes only once the loop has turned through the write's wait, so a write that sleeps in the lock's wait,
  // holding the loop without using the CPU, keeps it until the hang guard. No clock judges this: a runner that takes
  // the CPU away mid-wait, as the stall here does, delays those turns and fails nothing.
  const turnedThrough = new Int32Array(new SharedArrayBuffer(4))
  const holder = new Worker(
    `const { DatabaseSync } = require("node:sqlite")
    const { parentPort, workerData } = require("node:worker_threads")
    const db = new DatabaseSync(workerData.path)
    db.exec("BEGIN IMMEDIATE")
    parentPort.postMessage("locked")
    const waited = Atomics.wait(workerData.turnedThrough, 0, 0, ${LOCK_HANG_MS})
    db.exec("COMMIT")
    db.close()
    parentPort.postMessage(waited)`,
    { eval: true, workerData: { path: join(records, "records.sqlite"), turnedThrough } }
  )
  const released = new Promise((resolve) => holder.once("message", (first) => {
    assert.equal(first, "locked")
    holder.once("message", resolve)
  }))
  await new Promise((resolve) => holder.once("message", resolve))
  let written = false
  const pushed = await longestHold(() => store.notePushed("account", ref.harness, ref.nativeId, 1, Date.now()).then(() => { written = true }), (turn) => {
    if (turn === 1) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300)
    if (turn === TURNS_THROUGH_WAIT) {
      assert.equal(written, false, "the write can't have gone in while the lock is held")
      Atomics.store(turnedThrough, 0, 1)
      Atomics.notify(turnedThrough, 0)
    }
  })
  assert.notEqual(await released, "timed-out", `the loop turned ${pushed.turns} times in the write's wait, and the lock never went`)
  assert.equal(store.pushed("account").get(`${ref.harness}\n${ref.nativeId}`)?.capture, 1, "the write waited for the lock, then went in")
  held("a write the store's lock kept waiting", pushed)

  // A push of a chat of 30,000 messages: its batches of 10,000 versions read from the store, to a remote that takes them all.
  const many = manyMessages(home, 30_000)
  const manyRef = { harness: "cursor", nativeId: many.agentId }
  await store.capture({ ...manyRef, home, path: many.path, records: await provider.records(many.path) })
  const taken = new Set()
  const versionsIn = (bundle) => bundle.units.reduce((sum, unit) => sum + unit.versions.length, 0)
  const remote = {
    id: "account",
    missing: async (hashes) => hashes.filter((hash) => !taken.has(hash)),
    putChunks: async (pack) => {
      for (const chunk of pack) taken.add(chunk.hash)
      return { taken: pack.length }
    },
    pushWith: async (bundle, chunks) => {
      for (const chunk of chunks) taken.add(chunk.hash)
      return { ok: true, versions: versionsIn(bundle), held: 0 }
    },
    push: async (bundle) => ({ ok: true, versions: versionsIn(bundle), held: 0 }),
  }
  const sent = await longestHold(() => new RecordSync(store, remote).push(manyRef.harness, manyRef.nativeId))
  assert.ok(sent.result.versions > 20_000, `the chat's versions went (${sent.result.versions})`)
  held(`a push of ${sent.result.versions} versions`, sent)
  await store.close()
  db.close()

  // A Fin's Cursor SDK agent: one run of thousands of streamed events, which the fold replays at each checkpoint.
  const sdk = sdkAgent(home, 600)
  const sdkFollower = new CursorProvider(stores, home).createFollower(sdk.path, 0)
  const whole = await longestHold(() => sdkFollower.next())
  assert.ok(whole.result.entries.length > sdk.steps, `the agent's run is drawn (${whole.result.entries.length} entries)`)
  held(`an SDK agent's run of ${sdk.events} events folded`, whole)
  sdk.step()
  const checkpointed = await longestHold(() => sdkFollower.next())
  assert.equal(checkpointed.result.replace, true)
  held("its follow through one more checkpoint", checkpointed)
  sdk.close()
  console.log(`loop holds ok, each at most ${HOLD_MS} ms: ${measured.join("; ")}`)
} finally {
  await rm(home, { recursive: true, force: true })
}
