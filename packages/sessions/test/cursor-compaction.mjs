import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { CursorProvider } from "../dist/providers/cursor.js"

// When Cursor summarizes a long conversation, its root restarts with the
// system prompt, workspace context and the summary, and keeps what it
// replaced as archived windows in field 13. History must read the windows,
// or everything before the latest summary disappears.
const id = "55555555-5555-4555-8555-555555555555"
const said = (text) => ({ role: "user", content: [{ type: "text", text: `<user_query>${text}</user_query>` }] })
const answer = (text) => ({ role: "assistant", content: [{ type: "text", text }] })
const scaffold = (n) => [
  { role: "system", content: "You are an AI coding assistant." },
  { role: "user", content: [{ type: "text", text: `<user_info>workspace ${n}</user_info>` }] },
  { role: "user", content: [{ type: "text", text: ` <summary>summary ${n}</summary>` }] },
]
const messages = {}
const hash = (message) => {
  const key = createHash("sha256").update(JSON.stringify(message)).digest("hex")
  messages[key] = message
  return key
}
const list = (hashes) => Buffer.concat(hashes.map((key) => Buffer.concat([Buffer.from([10, 32]), Buffer.from(key, "hex")])))
const windowBlob = (hashes, summary) => Buffer.concat([list(hashes), Buffer.from([18, summary.length]), Buffer.from(summary)])
const root = (live, windows) => Buffer.concat([list(live), ...windows.map((key) => Buffer.concat([Buffer.from([106, 32]), Buffer.from(key, "hex")]))])
const checkpoint = (blobId) => JSON.stringify({ blobId, storeKind: "local-agent-store" })

const first = [said("first"), answer("one")].map(hash)
const second = [said("second"), answer("two")].map(hash)
const third = [said("third"), answer("three")].map(hash)
const opening = [scaffold(0)[0], scaffold(0)[1]].map(hash)
const afterOne = scaffold(1).map(hash)
const afterTwo = scaffold(2).map(hash)

const home = await mkdtemp(join(tmpdir(), "mako-cursor-compaction-"))
try {
  const sdkRoot = join(home, ".mako", "cursor-sdk")
  const directory = join(sdkRoot, "agents", `agent-${createHash("sha256").update(id).digest("hex")}`)
  await mkdir(directory, { recursive: true })
  const path = join(directory, "store.db")
  const store = new DatabaseSync(path)
  store.exec("CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)")
  const put = (key, data) => store.prepare("INSERT OR REPLACE INTO blobs VALUES (?, ?)").run(key, data)
  for (const [key, message] of Object.entries(messages)) put(key, Buffer.from(JSON.stringify(message)))
  const windowOne = createHash("sha256").update("window-1").digest("hex")
  const windowTwo = createHash("sha256").update("window-2").digest("hex")
  put(windowOne, windowBlob(first, "summary 1"))
  put(windowTwo, windowBlob(second, "summary 2"))
  put("root-0", root([...opening, ...first], []))
  put("root-1", root([...afterOne, ...second], [windowOne]))
  put("root-2", root([...afterTwo, ...third], [windowOne, windowTwo]))
  store.prepare("INSERT INTO meta VALUES (?, ?)").run("0", JSON.stringify({ agentId: id, name: "Compaction" }))

  const index = new DatabaseSync(join(sdkRoot, "index.db"))
  index.exec(
    "CREATE TABLE agents (agent_id TEXT PRIMARY KEY, workspace_ref TEXT NOT NULL, status TEXT NOT NULL, latest_checkpoint_ref_json TEXT, name TEXT, metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);" +
      "CREATE TABLE runs (run_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, turn_number INTEGER NOT NULL, status TEXT NOT NULL, model TEXT, model_params_json TEXT, start_checkpoint_ref_json TEXT, latest_checkpoint_ref_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, cancelled_at TEXT);"
  )
  index.prepare("INSERT INTO agents VALUES (?, ?, 'IDLE', ?, 'Compaction', '{}', '2026-09-26T00:00:00.000Z', '2026-09-26T00:00:01.000Z')").run(id, home, checkpoint("root-1"))
  const run = index.prepare("INSERT INTO runs VALUES (?, ?, ?, ?, 'auto', NULL, ?, ?, '2026-09-26T00:00:00.000Z', '2026-09-26T00:00:00.000Z', ?)")
  run.run("run-1", id, 1, "FINISHED", null, checkpoint("root-1"), null)

  const transcript = (entries) => entries.map((entry) =>
    entry.kind === "user" ? `user:${entry.text}` : entry.kind === "event" ? `event:${entry.label}` : `assistant:${entry.blocks.map((block) => block.text).join("")}`)

  const provider = new CursorProvider(home, {})
  const follower = provider.createFollower(path, 0)
  const once = await follower.next()
  assert.deepEqual(transcript(once.entries), ["user:first", "assistant:one", "event:Context compacted", "user:second", "assistant:two"],
    "the summarized window reads ahead of the live one, marked where the summary replaced it")

  // A second summary lands while the conversation is followed.
  run.run("run-2", id, 2, "FINISHED", checkpoint("root-1"), checkpoint("root-2"), null)
  index.prepare("UPDATE agents SET latest_checkpoint_ref_json = ? WHERE agent_id = ?").run(checkpoint("root-2"), id)
  const twice = await follower.next()
  const whole = ["user:first", "assistant:one", "event:Context compacted", "user:second", "assistant:two", "event:Context compacted", "user:third", "assistant:three"]
  assert.deepEqual(transcript([...once.entries.slice(0, twice.replaceFrom), ...twice.entries]), whole,
    "a live update after a new summary keeps everything before it")
  assert.deepEqual(transcript((await new CursorProvider(home, {}).read(path)).entries), whole, "a fresh read agrees with the followed one")

  // A run stopped after the latest summary is still marked where it ended.
  const fourth = [said("fourth"), answer("partial")].map(hash)
  for (const key of fourth) put(key, Buffer.from(JSON.stringify(messages[key])))
  put("root-3", root([...afterTwo, ...third, ...fourth], [windowOne, windowTwo]))
  run.run("run-3", id, 3, "CANCELLED", checkpoint("root-2"), checkpoint("root-3"), "2026-09-26T00:00:05.000Z")
  index.prepare("UPDATE agents SET latest_checkpoint_ref_json = ? WHERE agent_id = ?").run(checkpoint("root-3"), id)
  const stopped = await new CursorProvider(home, {}).read(path)
  assert.deepEqual(transcript(stopped.entries), [...whole, "user:fourth", "assistant:partial", "event:Interrupted"])

  // A store without windows reads exactly as before.
  index.prepare("UPDATE agents SET latest_checkpoint_ref_json = ? WHERE agent_id = ?").run(checkpoint("root-0"), id)
  index.exec("DELETE FROM runs")
  assert.deepEqual(transcript((await new CursorProvider(home, {}).read(path)).entries), ["user:first", "assistant:one"])
  index.close()
  store.close()
  console.log("Cursor compaction: summarized windows read ahead of the live one, live and in history, with a marker at each summary")
} finally {
  await rm(home, { recursive: true, force: true })
}
