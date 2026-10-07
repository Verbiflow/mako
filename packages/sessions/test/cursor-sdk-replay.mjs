import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { CursorProvider } from "../dist/providers/cursor.js"

// A Cursor SDK run reopens as the live window drew it: its `run_events`
// messages go through the live projection. A run is found in the
// conversation by its checkpoints, and after a compaction an older
// checkpoint's last message sits a few places off its length: the window
// keeps the conversation, not the opening scaffold ahead of it. A call the
// stream never ended takes the result the checkpoint kept, and a message
// steered into the run is drawn once, where the run read it.
const id = "66666666-6666-4666-8666-666666666666"
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
const opening = [scaffold(0)[0], scaffold(0)[1]].map(hash)
const afterOne = scaffold(1).map(hash)
const second = [
  said("second"),
  { role: "assistant", content: [{ type: "tool-call", toolName: "Read", toolCallId: "read-1", args: { path: "missing.md" } }] },
  { role: "tool", content: [{ type: "tool-result", toolCallId: "read-1", result: "Error: File not found" }], providerOptions: { cursor: { highLevelToolCallResult: { isError: true } } } },
  said("also check notes.md"),
  answer("two"),
].map(hash)

const home = await mkdtemp(join(tmpdir(), "mako-cursor-replay-"))
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
  put(windowOne, windowBlob(first, "summary 1"))
  put("root-0", root([...opening, ...first], []))
  put("root-1", root([...afterOne, ...second], [windowOne]))
  store.prepare("INSERT INTO meta VALUES (?, ?)").run("0", JSON.stringify({ agentId: id, name: "Replay" }))
  store.close()

  const index = new DatabaseSync(join(sdkRoot, "index.db"))
  index.exec(
    "CREATE TABLE agents (agent_id TEXT PRIMARY KEY, workspace_ref TEXT NOT NULL, status TEXT NOT NULL, latest_checkpoint_ref_json TEXT, name TEXT, metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);" +
      "CREATE TABLE runs (run_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, turn_number INTEGER NOT NULL, status TEXT NOT NULL, model TEXT, model_params_json TEXT, start_checkpoint_ref_json TEXT, latest_checkpoint_ref_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, started_at TEXT, finished_at TEXT);" +
      "CREATE TABLE run_events (run_id TEXT NOT NULL, seq INTEGER NOT NULL, event_type TEXT NOT NULL, payload_json TEXT, created_at TEXT NOT NULL);"
  )
  index.prepare("INSERT INTO agents VALUES (?, ?, 'IDLE', ?, 'Replay', '{}', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:09.000Z')").run(id, home, checkpoint("root-1"))
  const run = index.prepare("INSERT INTO runs VALUES (?, ?, ?, 'FINISHED', 'composer-2.5', NULL, ?, ?, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', ?, ?)")
  run.run("run-1", id, 1, null, checkpoint("root-0"), "2026-10-01T00:00:01.000Z", "2026-10-01T00:00:02.000Z")
  run.run("run-2", id, 2, checkpoint("root-0"), checkpoint("root-1"), "2026-10-01T00:00:05.000Z", "2026-10-01T00:00:08.000Z")
  const log = index.prepare("INSERT INTO run_events VALUES (?, ?, 'run_stream_event', ?, ?)")
  const events = (runId, at, stream) => stream.forEach((message, seq) =>
    log.run(runId, seq + 1, JSON.stringify({ schemaVersion: 1, type: "sdk_message", agentId: id, runId, message: { agent_id: id, run_id: runId, ...message } }), at))
  events("run-1", "2026-10-01T00:00:01.500Z", [
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "one" }] } },
  ])
  events("run-2", "2026-10-01T00:00:06.000Z", [
    { type: "thinking", text: "Reading missing.md." },
    { type: "tool_call", call_id: "read-1", name: "read", status: "running", args: { path: "missing.md" } },
    { type: "user", message: { role: "user", content: [{ type: "text", text: "also check notes.md" }] } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "two" }] } },
  ])
  index.close()

  const transcript = (entries) => entries.map((entry) => {
    if (entry.kind === "user") return `user:${entry.text}${entry.steeringFor ? " (steered)" : ""}`
    if (entry.kind === "event") return `event:${entry.label}`
    return `assistant(${entry.model}):${entry.blocks.map((block) => block.type === "tool" ? `${block.name}:${block.error ? "failed" : "ok"}:${block.output}` : `${block.type}:${block.text}`).join("|")}`
  })
  const whole = [
    "user:first",
    "assistant(composer-2.5):text:one",
    "event:Context compacted",
    "user:second",
    "assistant(composer-2.5):thinking:Reading missing.md.|read:failed:Error: File not found",
    "user:also check notes.md (steered)",
    "assistant(composer-2.5):text:two",
  ]
  const thread = await new CursorProvider(home, {}).read(path)
  assert.deepEqual(transcript(thread.entries), whole,
    "both runs replay, the one before the compaction placed by its last message; the failed read shows the checkpoint's error; the steer is drawn once")
  assert.equal(thread.entries.find((entry) => entry.text === "second")?.at, "2026-10-01T00:00:05.000Z", "a replayed turn's prompt is stamped when its run started")

  const recent = await new CursorProvider(home, {}).recent(path, 1)
  assert.deepEqual(transcript(recent), whole.slice(3), "a recent window that would start at the steer starts at its run's prompt")
  console.log("Cursor SDK replay: runs reopen through the live projection, placed across a compaction, with checkpointed results and steers drawn once")
} finally {
  await rm(home, { recursive: true, force: true })
}
