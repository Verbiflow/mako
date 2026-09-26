import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { CursorProvider } from "../dist/providers/cursor.js"

// A stopped Cursor SDK run leaves only its CANCELLED row in index.db; the
// conversation blobs look like any other turn. History marks the stop where
// the run's own checkpoint ended, like every other harness's native marker.
const id = "44444444-4444-4444-8444-444444444444"
const messages = [
  { role: "user", content: [{ type: "text", text: "<user_query>first</user_query>" }] },
  { role: "assistant", content: [{ type: "tool-call", toolCallId: "a", toolName: "Shell", args: { command: "ls" } }] },
  { role: "tool", content: [{ type: "tool-result", toolCallId: "a", result: "listing" }] },
  { role: "assistant", content: [{ type: "text", text: "done" }] },
  { role: "user", content: [{ type: "text", text: "<user_query>second</user_query>" }] },
  { role: "assistant", content: [
    { type: "tool-call", toolCallId: "b", toolName: "Shell", args: { command: "true" } },
    { type: "tool-call", toolCallId: "c", toolName: "Shell", args: { command: "sleep 120" } },
  ] },
  { role: "tool", content: [{ type: "tool-result", toolCallId: "b", result: "ok" }] },
  { role: "user", content: [{ type: "text", text: "<user_query>third</user_query>" }] },
  { role: "assistant", content: [{ type: "text", text: "after the stop" }] },
]
const hashes = messages.map((_, index) => createHash("sha256").update(`message-${index}`).digest("hex"))
const root = (count) => Buffer.concat(hashes.slice(0, count).map((hash) => Buffer.concat([Buffer.from([10, 32]), Buffer.from(hash, "hex")])))
const checkpoint = (blobId) => JSON.stringify({ blobId, storeKind: "local-agent-store" })

const home = await mkdtemp(join(tmpdir(), "mako-cursor-stop-"))
try {
  const sdkRoot = join(home, ".mako", "cursor-sdk")
  const directory = join(sdkRoot, "agents", `agent-${createHash("sha256").update(id).digest("hex")}`)
  await mkdir(directory, { recursive: true })
  const path = join(directory, "store.db")
  const store = new DatabaseSync(path)
  store.exec("CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)")
  messages.forEach((message, index) => store.prepare("INSERT INTO blobs VALUES (?, ?)").run(hashes[index], Buffer.from(JSON.stringify(message))))
  for (const [blob, count] of [["root-1", 4], ["root-2", 7], ["root-3", 9]]) store.prepare("INSERT INTO blobs VALUES (?, ?)").run(blob, root(count))
  // A checkpoint that is not a prefix of the current conversation: a rewritten history.
  store.prepare("INSERT INTO blobs VALUES (?, ?)").run("rewritten", Buffer.concat([Buffer.from([10, 32]), Buffer.alloc(32, 9)]))
  store.prepare("INSERT INTO meta VALUES (?, ?)").run("0", JSON.stringify({ agentId: id, name: "Stops" }))
  store.close()

  const index = new DatabaseSync(join(sdkRoot, "index.db"))
  index.exec(
    "CREATE TABLE agents (agent_id TEXT PRIMARY KEY, workspace_ref TEXT NOT NULL, status TEXT NOT NULL, latest_checkpoint_ref_json TEXT, name TEXT, metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);" +
      "CREATE TABLE runs (run_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, turn_number INTEGER NOT NULL, status TEXT NOT NULL, model TEXT, model_params_json TEXT, start_checkpoint_ref_json TEXT, latest_checkpoint_ref_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, cancelled_at TEXT);"
  )
  index.prepare("INSERT INTO agents VALUES (?, ?, 'IDLE', ?, 'Stops', '{}', '2026-09-25T00:00:00.000Z', '2026-09-25T00:00:09.000Z')").run(id, home, checkpoint("root-2"))
  const run = index.prepare("INSERT INTO runs VALUES (?, ?, ?, ?, 'auto', NULL, ?, ?, '2026-09-25T00:00:00.000Z', '2026-09-25T00:00:00.000Z', ?)")
  run.run("run-1", id, 1, "FINISHED", null, checkpoint("root-1"), null)
  run.run("run-2", id, 2, "RUNNING", checkpoint("root-1"), checkpoint("root-2"), null)

  const provider = new CursorProvider(home, {})
  const follower = provider.createFollower(path, 0)
  const running = await follower.next()
  assert.equal(running.entries.some((entry) => entry.kind === "event"), false, "a running turn has no stop marker")

  // The cancel is recorded after its messages were written.
  index.prepare("UPDATE runs SET status = 'CANCELLED', cancelled_at = '2026-09-25T00:00:05.000Z' WHERE run_id = 'run-2'").run()
  const stopped = await follower.next()
  assert.equal(stopped.replaceFrom, 0, "a stop landing inside kept entries refolds the whole conversation")
  const marker = { kind: "event", at: "2026-09-25T00:00:05.000Z", label: "Interrupted" }
  assert.deepEqual(stopped.entries.at(-1), marker)

  run.run("run-3", id, 3, "FINISHED", checkpoint("root-2"), checkpoint("root-3"), null)
  run.run("run-4", id, 4, "CANCELLED", checkpoint("root-3"), checkpoint("root-3"), "2026-09-25T00:00:08.000Z")
  run.run("run-5", id, 5, "CANCELLED", checkpoint("root-3"), checkpoint("rewritten"), "2026-09-25T00:00:09.000Z")
  index.prepare("UPDATE agents SET latest_checkpoint_ref_json = ? WHERE agent_id = ?").run(checkpoint("root-3"), id)
  const thread = await new CursorProvider(home, {}).read(path)
  const shape = thread.entries.map((entry) => entry.kind === "assistant"
    ? entry.blocks.map((block) => block.type === "tool" ? `${block.id}${block.canceled ? ":canceled" : ""}` : block.type).join(",")
    : entry.kind === "user" ? `user:${entry.text}` : `${entry.kind}:${entry.label}`)
  assert.deepEqual(shape, ["user:first", "a,text", "user:second", "b,c:canceled", "event:Interrupted", "user:third", "text"],
    "only the stopped run is marked; its answered call stands and its unanswered one reads canceled")
  assert.deepEqual(thread.entries[4], marker)

  // An index from before runs recorded checkpoints still reads, without stops.
  index.exec("DROP TABLE runs; CREATE TABLE runs (run_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, turn_number INTEGER NOT NULL, status TEXT NOT NULL, model TEXT, model_params_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);")
  index.close()
  const legacy = await new CursorProvider(home, {}).read(path)
  assert.equal(legacy.entries.length, 6)
  assert.equal(legacy.entries.some((entry) => entry.kind === "event"), false)
  console.log("Cursor stops: a CANCELLED run is marked where its checkpoint ended, live and in history, and nowhere else")
} finally {
  await rm(home, { recursive: true, force: true })
}
