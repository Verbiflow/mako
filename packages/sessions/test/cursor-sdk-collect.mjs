import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { copyFile, mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { CursorProvider } from "../dist/providers/cursor.js"
import { CURSOR_QUIET_MS, collectCursorCheckpoints } from "../dist/providers/cursor-sdk-collect.js"
import { NativeStores } from "../dist/read-only-sqlite.js"

const stores = new NativeStores(false)

// Cursor's SDK saves a root listing the whole conversation after every step
// and never deletes the one before. The collector deletes the roots nothing
// reads and keeps what Mako's own reader needs: every checkpoint the index
// names, what those name (windows, subagents), the roots the fold's
// compaction search settles on, and every message and prompt record. The
// conversation reads the same before and after.
const sha = (text) => createHash("sha256").update(text).digest("hex")
const varint = (value) => {
  const bytes = []
  while (value > 0x7f) {
    bytes.push((value & 0x7f) | 0x80)
    value = Math.floor(value / 128)
  }
  bytes.push(value)
  return Buffer.from(bytes)
}
const field = (number, data) => Buffer.concat([varint((number << 3) | 2), varint(data.length), data])
const number = (n, value) => Buffer.concat([varint(n << 3), varint(value)])
const said = (text) => ({ role: "user", content: [{ type: "text", text: `<user_query>${text}</user_query>` }] })
const answer = (text) => ({ role: "assistant", content: [{ type: "text", text }] })
const system = { role: "system", content: "You are an AI coding assistant." }
const context = { role: "user", content: [{ type: "text", text: "<user_info>workspace</user_info>" }] }
const summarized = { role: "user", content: [{ type: "text", text: " <summary>summary 1</summary>" }] }
const checkpoint = (blobId) => JSON.stringify({ blobId, storeKind: "local-agent-store" })

/** A main root: its messages, archived windows, the workspace (field 9) and, when given, its context reading (field 5). */
const root = (hashes, { windows = [], used, subagents = [] } = {}) => Buffer.concat([
  ...hashes.map((key) => field(1, Buffer.from(key, "hex"))),
  ...used === undefined ? [] : [field(5, Buffer.concat([number(1, used), number(2, 200_000)]))],
  field(9, Buffer.from("workspace")),
  ...windows.map((key) => field(13, Buffer.from(key, "hex"))),
  ...subagents.map(([name, key]) => field(31, Buffer.concat([field(1, Buffer.from(name)), field(2, Buffer.from(key, "hex"))]))),
])

/** One agent's store and index rows: two runs, the second summarizing mid-run, each step leaving a root behind. */
async function agentFixture(sdkRoot, index, id, { status = "IDLE", runStatus = "FINISHED", updatedAt = "2026-09-26T00:00:09.000Z", steps = 300 } = {}) {
  const directory = join(sdkRoot, "agents", `agent-${sha(id)}`)
  await mkdir(directory, { recursive: true })
  const path = join(directory, "store.db")
  const store = new DatabaseSync(path)
  store.exec("PRAGMA journal_mode = WAL; CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)")
  const put = (data, key = sha(data)) => {
    store.prepare("INSERT OR REPLACE INTO blobs VALUES (?, ?)").run(key, data)
    return key
  }
  const message = (value) => put(Buffer.from(JSON.stringify(value)))
  const named = {}
  const opening = [message(system), message(context)]
  // A prompt record: its text exactly 32 bytes, a 32-byte state (field 10) and a time (field 25). Nothing names it.
  named.prompt = put(Buffer.concat([field(1, Buffer.from("x".repeat(32))), field(10, Buffer.from(sha("state"), "hex")), number(25, 1_790_000_000)]))
  const first = [message(said("first")), message(answer("one"))]
  const firstSteps = []
  for (let step = 0; step < steps; step++) firstSteps.push(put(root([...opening, ...first.slice(0, 1), message(answer(`thinking ${step}`))], { used: 1000 + step })))
  named.root1 = put(root([...opening, ...first], { used: 2000 }))
  const window = put(Buffer.concat([...opening, ...first].map((key) => field(1, Buffer.from(key, "hex"))).concat([field(2, Buffer.from("summary 1"))])))
  const subagent = put(root([message(system), message(said("look around"))]))
  const second = [message(said("second")), message(answer("two"))]
  const secondSteps = []
  for (let step = 0; step < steps; step++) secondSteps.push(put(root([...opening, ...first, second[0], message(answer(`reading ${step}`))], { used: 3000 + step })))
  // The summary: the first root holding the window still carries the reading from before it; the next measures what it left.
  named.boundary = put(root([message(system), message(summarized), second[0]], { windows: [window], used: 3000 + steps - 1 }))
  named.measured = put(root([message(system), message(summarized), second[0], message(answer("after"))], { windows: [window], used: 900 }))
  for (let step = 0; step < steps; step++) secondSteps.push(put(root([message(system), message(summarized), second[0], message(answer(`later ${step}`))], { windows: [window], used: 950 + step })))
  named.root2 = put(root([message(system), message(summarized), ...second], { windows: [window], used: 1500, subagents: [["explore", subagent]] }))
  named.window = window
  named.subagent = subagent
  store.prepare("INSERT INTO meta VALUES (?, ?)").run("0", JSON.stringify({ agentId: id, name: "Collect" }))
  store.close()
  index.prepare("INSERT INTO agents VALUES (?, ?, ?, ?, 'Collect', '{}', '2026-09-26T00:00:00.000Z', ?)").run(id, sdkRoot, status, checkpoint(named.root2), updatedAt)
  const run = index.prepare("INSERT INTO runs VALUES (?, ?, ?, ?, 'composer-2.5', NULL, ?, ?, '2026-09-26T00:00:00.000Z', ?, '2026-09-26T00:00:00.000Z', NULL)")
  run.run(`${id}-run-1`, id, 1, "FINISHED", null, checkpoint(named.root1), updatedAt)
  run.run(`${id}-run-2`, id, 2, runStatus, checkpoint(named.root1), checkpoint(named.root2), updatedAt)
  return { path, directory, named, unnamed: [...firstSteps, ...secondSteps] }
}

const ids = (path) => {
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    return new Set(database.prepare("SELECT id FROM blobs").all().map((row) => row.id))
  } finally {
    database.close()
  }
}

const home = await mkdtemp(join(tmpdir(), "mako-cursor-collect-"))
try {
  const userRoot = join(home, ".mako")
  const sdkRoot = join(userRoot, "cursor-sdk")
  await mkdir(join(sdkRoot, "agents"), { recursive: true })
  const index = new DatabaseSync(join(sdkRoot, "index.db"))
  index.exec(
    "CREATE TABLE agents (agent_id TEXT PRIMARY KEY, workspace_ref TEXT NOT NULL, status TEXT NOT NULL, latest_checkpoint_ref_json TEXT, name TEXT, metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);" +
      "CREATE TABLE runs (run_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, turn_number INTEGER NOT NULL, status TEXT NOT NULL, model TEXT, model_params_json TEXT, start_checkpoint_ref_json TEXT, latest_checkpoint_ref_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, started_at TEXT, finished_at TEXT);"
  )
  const now = Date.now() + 2 * CURSOR_QUIET_MS
  const idle = await agentFixture(sdkRoot, index, "11111111-1111-4111-8111-111111111111")
  const running = await agentFixture(sdkRoot, index, "22222222-2222-4222-8222-222222222222", { status: "RUNNING", runStatus: "RUNNING", steps: 4 })
  const recent = await agentFixture(sdkRoot, index, "33333333-3333-4333-8333-333333333333", { updatedAt: new Date(now - 60_000).toISOString(), steps: 4 })
  const reader = () => new CursorProvider(stores, home, userRoot, join(home, `outputs-${Math.random()}.sqlite`))
  const read = async (path) => JSON.stringify((await reader().read(path)).entries)
  const before = await read(idle.path)
  assert.match(before, /Context compacted/, "the fixture's summary is drawn")
  const pristine = join(home, "pristine.db")
  await copyFile(idle.path, pristine)

  // A crash between batches: what went is only roots nothing reads, and the agent reads the same.
  const crashed = collectCursorCheckpoints({ stateRoot: sdkRoot, stores, now, directories: [idle.directory.split("/").at(-1)], beforeBatch: (batch) => { if (batch === 1) throw new Error("crash") } })
  assert.equal(crashed[0].outcome, "skipped")
  const afterCrash = ids(idle.path)
  assert.equal(idle.unnamed.filter((key) => !afterCrash.has(key)).length, 256, "the first batch committed and nothing after it")
  assert.equal(await read(idle.path), before, "a store cut short between batches reads as it did")

  // A write between batches (the SDK saving a step) ends the sweep.
  const moved = collectCursorCheckpoints({
    stateRoot: sdkRoot, stores, now, directories: [idle.directory.split("/").at(-1)],
    beforeBatch: (batch) => {
      if (batch !== 1) return
      const writer = new DatabaseSync(idle.path)
      writer.prepare("INSERT INTO blobs VALUES (?, ?)").run(sha("late"), Buffer.from("late"))
      writer.close()
    },
  })
  assert.equal(moved[0].reason, "moved", "a blob written mid-sweep stops it")
  assert.equal(moved[0].stamp, undefined, "a sweep cut short leaves the store to look at again")

  const sweeps = collectCursorCheckpoints({ stateRoot: sdkRoot, stores, now, vacuumMinBytes: 1 })
  const of = (agent) => sweeps.find((sweep) => sweep.directory === agent.directory.split("/").at(-1))
  assert.equal(of(running).reason, "running", "a running agent is left alone")
  assert.equal(of(recent).reason, "recent", "an agent written in the last half hour is left alone")
  const runningLeft = ids(running.path)
  assert.ok(running.unnamed.every((key) => runningLeft.has(key)), "a running agent keeps every root")
  const sweep = of(idle)
  assert.equal(sweep.outcome, "collected")
  assert.equal(sweep.reason, undefined)
  assert.ok(sweep.vacuumed, "what went is given back to the disk")
  assert.ok(sweep.fileAfter < sweep.fileBefore / 2, `the store shrank: ${sweep.fileBefore} → ${sweep.fileAfter}`)
  assert.equal(await read(idle.path), before, "the agent reads after the collection as it did before, its summary placed and measured the same")
  assert.ok(sweep.placed > 0, "the roots the compaction search settles on are kept")
  const left = ids(idle.path)
  for (const [name, key] of Object.entries(idle.named)) assert.ok(left.has(key), `${name} is kept`)
  assert.ok(left.has(sha("late")), "a blob that isn't a root stays")
  const gone = idle.unnamed.filter((key) => !left.has(key)).length
  assert.ok(gone >= idle.unnamed.length - 20, `the unnamed roots go: ${gone} of ${idle.unnamed.length}`)

  const again = collectCursorCheckpoints({ stateRoot: sdkRoot, stores, now, stamps: new Map([[sweep.directory, sweep.stamp]]) })
  assert.equal(again.find((each) => each.directory === sweep.directory).reason, "unchanged", "a store as the last pass left it is skipped")

  // A dry run counts the same roots and deletes nothing.
  await copyFile(pristine, idle.path)
  await rm(`${idle.path}-wal`, { force: true })
  await rm(`${idle.path}-shm`, { force: true })
  const dry = collectCursorCheckpoints({ stateRoot: sdkRoot, stores, now, dryRun: true, directories: [sweep.directory] })
  assert.equal(dry[0].reason, "dry run")
  assert.equal(dry[0].deleted, gone, "a dry run counts what a collection deletes")
  assert.equal(ids(idle.path).size, ids(pristine).size, "a dry run deletes nothing")
  index.close()
  console.log(`Cursor checkpoints: ${gone} of ${idle.unnamed.length} unnamed roots collected, ${sweep.placed} kept for the compaction search; the store shrank ${sweep.fileBefore} → ${sweep.fileAfter} bytes and reads the same; running and recent agents left alone; a crash or a write mid-sweep loses nothing`)
} finally {
  await rm(home, { recursive: true, force: true })
}
