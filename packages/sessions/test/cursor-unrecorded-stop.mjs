import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { CursorProvider } from "../dist/providers/cursor.js"
import { NativeStores } from "../dist/read-only-sqlite.js"

const nativeStores = new NativeStores(false)

// A Cursor SDK run stopped before its first checkpoint never enters the
// conversation: the agent's root stays where the run started. The SDK still
// wrote the prompt record and logged the stream, and history shows that turn
// where the run started, followed by the stop. The SDK rewrites the leading
// system prompt and context when Auto picks another model, which must not
// unplace stops recorded before the switch.
const id = "55555555-5555-4555-8555-555555555555"
const blob = (name) => createHash("sha256").update(name).digest("hex")
const message = (name, value) => [blob(name), Buffer.from(JSON.stringify(value))]
const user = (text) => ({ role: "user", content: [{ type: "text", text: `<timestamp>now</timestamp>\n<user_query>\n${text}\n</user_query>` }] })
const said = (text) => ({ role: "assistant", content: [{ type: "text", text }] })
const preamble = (model) => [
  message(`system-${model}`, { role: "system", content: `You are powered by ${model}.` }),
  message(`context-${model}`, { role: "user", content: `<user_info>\nWorkspace ${model}\n</user_info>` }),
]
const conversation = [
  message("first", user("first")),
  message("one", said("one")),
  message("third", user("third")),
  message("three", said("three")),
  message("fourth", user("fourth")),
  message("partial", said("partial")),
  message("fifth", user("fifth")),
  message("five", said("five")),
]
const root = (entries) => Buffer.concat(entries.map(([hash]) => Buffer.concat([Buffer.from([10, 32]), Buffer.from(hash, "hex")])))
const varint = (value) => {
  const bytes = []
  while (value >= 128) {
    bytes.push((value % 128) | 128)
    value = Math.floor(value / 128)
  }
  bytes.push(value)
  return Buffer.from(bytes)
}
const promptRecord = (text, at) => {
  const body = Buffer.from(text)
  return Buffer.concat([Buffer.from([0x0a]), varint(body.length), body, Buffer.from([0x52, 32]), Buffer.alloc(32, 7), Buffer.from([0xc8, 0x01]), varint(Date.parse(at))])
}
const checkpoint = (blobId) => JSON.stringify({ blobId, storeKind: "local-agent-store" })
const event = (runId, message) => JSON.stringify({ schemaVersion: 1, type: "sdk_message", runId, message })

const home = await mkdtemp(join(tmpdir(), "mako-cursor-unrecorded-"))
try {
  const sdkRoot = join(home, ".mako", "cursor-sdk")
  const directory = join(sdkRoot, "agents", `agent-${createHash("sha256").update(id).digest("hex")}`)
  await mkdir(directory, { recursive: true })
  const path = join(directory, "store.db")
  const store = new DatabaseSync(path)
  store.exec("CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)")
  const put = (hash, data) => store.prepare("INSERT OR IGNORE INTO blobs VALUES (?, ?)").run(hash, data)
  store.prepare("INSERT INTO meta VALUES (?, ?)").run("0", JSON.stringify({ agentId: id, name: "Early stops" }))
  const [first, one, third, three, fourth, partial, fifth, five] = conversation
  const auto = preamble("auto")
  const grok = preamble("grok")
  const sonnet = preamble("sonnet")
  const roots = {
    a: [...auto, first, one],
    b: [...grok, first, one, third, three],
    c: [...grok, first, one, third, three, fourth, partial],
    d: [...sonnet, first, one, third, three, fourth, partial, fifth, five],
  }
  const writeTurn = (name, entries, prompt) => {
    if (prompt) put(blob(`prompt-${name}`), promptRecord(prompt.text, prompt.at))
    for (const [hash, data] of entries) put(hash, data)
    put(blob(`root-${name}`), root(entries))
  }
  writeTurn("a", roots.a, { text: "first", at: "2026-09-25T00:00:01.000Z" })
  // The early-stopped run: a prompt record against its refreshed state, no checkpoint.
  put(blob("prompt-early"), promptRecord("<mako-local-control>\nnote\n</mako-local-control>\n\nsecond, stopped early", "2026-09-25T00:00:03.000Z"))
  store.close()

  const index = new DatabaseSync(join(sdkRoot, "index.db"))
  index.exec(
    "CREATE TABLE agents (agent_id TEXT PRIMARY KEY, workspace_ref TEXT NOT NULL, status TEXT NOT NULL, active_run_id TEXT, latest_checkpoint_ref_json TEXT, name TEXT, metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);" +
      "CREATE TABLE runs (run_id TEXT PRIMARY KEY, request_id TEXT, agent_id TEXT NOT NULL, turn_number INTEGER NOT NULL, status TEXT NOT NULL, model TEXT, model_params_json TEXT, start_checkpoint_ref_json TEXT, latest_checkpoint_ref_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, cancelled_at TEXT);" +
      "CREATE TABLE run_events (run_id TEXT NOT NULL, seq INTEGER NOT NULL, event_type TEXT NOT NULL, payload_json TEXT, created_at TEXT NOT NULL);"
  )
  index.prepare("INSERT INTO agents VALUES (?, ?, 'RUNNING', NULL, ?, 'Early stops', '{}', '2026-09-25T00:00:00.000Z', '2026-09-25T00:00:02.000Z')").run(id, home, checkpoint(blob("root-a")))
  const run = index.prepare("INSERT INTO runs VALUES (?, NULL, ?, ?, ?, 'auto', NULL, ?, ?, '2026-09-25T00:00:00.000Z', '2026-09-25T00:00:00.000Z', ?, NULL, ?)")
  run.run("run-1", id, 1, "FINISHED", null, checkpoint(blob("root-a")), "2026-09-25T00:00:00.500Z", null)
  run.run("run-2", id, 2, "RUNNING", checkpoint(blob("root-a")), checkpoint(blob("root-a")), "2026-09-25T00:00:02.000Z", null)
  const log = index.prepare("INSERT INTO run_events VALUES ('run-2', ?, 'run_stream_event', ?, '2026-09-25T00:00:03.000Z')")
  const stream = [
    { type: "request", request_id: "request-2" },
    { type: "status", status: "RUNNING" },
    { type: "thinking", text: "plan" },
    { type: "thinking", text: "ning" },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "One" }] } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: ", two" }] } },
    { type: "tool_call", call_id: "x", name: "grep", status: "running", args: { pattern: "needle" } },
    { type: "status", status: "CANCELLED" },
  ]
  stream.forEach((message, seq) => log.run(seq + 1, event("run-2", { agent_id: id, run_id: "run-2", ...message })))

  const provider = new CursorProvider(nativeStores, home, {})
  const follower = provider.createFollower(path, 0)
  const running = await follower.next()
  assert.equal(running.entries.length, 2, "a running run adds nothing to history before it stops")

  index.prepare("UPDATE runs SET status = 'CANCELLED', cancelled_at = '2026-09-25T00:00:04.000Z' WHERE run_id = 'run-2'").run()
  index.prepare("UPDATE agents SET status = 'IDLE' WHERE agent_id = ?").run(id)
  const stopped = await follower.next()
  assert.equal(stopped.replaceFrom, 0)
  const early = stopped.entries.slice(2)
  assert.equal(early[0].type, "user")
  assert.equal(early[0].text, "second, stopped early", "the prompt reads like any other, without Mako's control note")
  assert.deepEqual(early.slice(1, 4).map((entry) => entry.type === "tool" ? `tool:${entry.name}:${entry.status === "canceled" ? "canceled" : "open"}` : `${entry.type}:${entry.text}`),
    ["thinking:planning", "text:One, two", "tool:grep:canceled"], "the stream folds in order and the unanswered call reads canceled")
  const { record, ...stop } = early[4]
  assert.deepEqual(stop, { type: "event", id: "run-2:cancelled", at: Date.parse("2026-09-25T00:00:04.000Z"), label: "Interrupted", source: { harness: "cursor", record: "run-2:cancelled" } })
  assert.deepEqual(record?.rows, [{ table: "runs", key: { run_id: "run-2" } }], "the stop names the run row it was read from")

  // Auto moves to another model for the next turns, rewriting the preamble; a
  // recorded stop between them must keep its place.
  const reopen = new DatabaseSync(path)
  const putLater = (hash, data) => reopen.prepare("INSERT OR IGNORE INTO blobs VALUES (?, ?)").run(hash, data)
  for (const [name, entries, text, at] of [["b", roots.b, "third", "2026-09-25T00:00:05.000Z"], ["c", roots.c, "fourth", "2026-09-25T00:00:07.000Z"], ["d", roots.d, "fifth", "2026-09-25T00:00:09.000Z"]]) {
    putLater(blob(`prompt-${name}`), promptRecord(text, at))
    for (const [hash, data] of entries) putLater(hash, data)
    putLater(blob(`root-${name}`), root(entries))
  }
  reopen.close()
  run.run("run-3", id, 3, "FINISHED", checkpoint(blob("root-a")), checkpoint(blob("root-b")), "2026-09-25T00:00:04.500Z", null)
  run.run("run-4", id, 4, "CANCELLED", checkpoint(blob("root-b")), checkpoint(blob("root-c")), "2026-09-25T00:00:06.500Z", "2026-09-25T00:00:08.000Z")
  run.run("run-5", id, 5, "FINISHED", checkpoint(blob("root-c")), checkpoint(blob("root-d")), "2026-09-25T00:00:08.500Z", null)
  index.prepare("UPDATE agents SET latest_checkpoint_ref_json = ? WHERE agent_id = ?").run(checkpoint(blob("root-d")), id)

  const thread = await new CursorProvider(nativeStores, home, {}).read(path)
  const shape = thread.entries.map((entry) => entry.type === "user" ? `user:${entry.text}`
    : entry.type === "event" ? `event:${entry.label}@${new Date(entry.at).toISOString()}` : entry.type)
  assert.deepEqual(shape, [
    "user:first", "text",
    "user:second, stopped early", "thinking", "text", "tool", "event:Interrupted@2026-09-25T00:00:04.000Z",
    "user:third", "text",
    "user:fourth", "text", "event:Interrupted@2026-09-25T00:00:08.000Z",
    "user:fifth", "text",
  ], "the early stop sits where its run started, and the recorded stop survives two model switches")

  // A run stopped before it wrote anything at all leaves no trace.
  run.run("run-6", id, 6, "CANCELLED", checkpoint(blob("root-d")), checkpoint(blob("root-d")), "2026-09-25T00:00:10.000Z", "2026-09-25T00:00:10.500Z")
  const quiet = await new CursorProvider(nativeStores, home, {}).read(path)
  assert.equal(quiet.entries.length, thread.entries.length, "a stop that recorded no prompt and no stream adds nothing")
  index.close()
  console.log("Cursor early stops: a run stopped before its first checkpoint keeps its prompt and output in history, and stops survive a model switch")
} finally {
  await rm(home, { recursive: true, force: true })
}

// An agent's first run, stopped or killed before its first checkpoint (SDK
// 1.0.31 checkpoints a run's prompt about 180 ms after its first call starts;
// the flows stopped and killed theirs 72 ms and 55 ms in), and a run stopped
// after it, whose cut step the next run writes into the conversation with
// the result the model was told. The SDK keeps each run in its own record
// (index.db's runs and run_events, store.db's prompt record), so history
// shows each once, as the live window did.
const later = await mkdtemp(join(tmpdir(), "mako-cursor-unrecorded-"))
try {
  const sdkRoot = join(later, ".mako", "cursor-sdk")
  await mkdir(join(sdkRoot, "agents"), { recursive: true })
  const index = new DatabaseSync(join(sdkRoot, "index.db"))
  index.exec(
    "CREATE TABLE agents (agent_id TEXT PRIMARY KEY, workspace_ref TEXT NOT NULL, status TEXT NOT NULL, active_run_id TEXT, latest_checkpoint_ref_json TEXT, name TEXT, metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);" +
      "CREATE TABLE runs (run_id TEXT PRIMARY KEY, request_id TEXT, agent_id TEXT NOT NULL, turn_number INTEGER NOT NULL, status TEXT NOT NULL, model TEXT, model_params_json TEXT, start_checkpoint_ref_json TEXT, latest_checkpoint_ref_json TEXT, error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, cancelled_at TEXT);" +
      "CREATE TABLE run_events (run_id TEXT NOT NULL, seq INTEGER NOT NULL, event_type TEXT NOT NULL, payload_json TEXT, created_at TEXT NOT NULL);"
  )
  const addRun = index.prepare("INSERT INTO runs VALUES (?, NULL, ?, ?, ?, 'auto', NULL, ?, ?, ?, '2026-10-17T00:00:00.000Z', '2026-10-17T00:00:00.000Z', ?, ?, ?)")
  const streamed = (agentId, runId, messages) => {
    const log = index.prepare("INSERT INTO run_events VALUES (?, ?, 'run_stream_event', ?, '2026-10-17T00:00:01.000Z')")
    ;[{ type: "request" }, ...messages].forEach((item, seq) => log.run(runId, seq + 1, event(runId, { agent_id: agentId, run_id: runId, ...item })))
  }
  const sleep = (callId) => ({ type: "tool_call", call_id: callId, name: "shell", status: "running", args: { command: "sleep 90" } })
  const agent = async (agentId, build) => {
    const directory = join(sdkRoot, "agents", `agent-${createHash("sha256").update(agentId).digest("hex")}`)
    await mkdir(directory, { recursive: true })
    const path = join(directory, "store.db")
    const store = new DatabaseSync(path)
    store.exec("CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)")
    store.prepare("INSERT INTO meta VALUES (?, ?)").run("0", JSON.stringify({ agentId }))
    const put = (hash, data) => store.prepare("INSERT OR IGNORE INTO blobs VALUES (?, ?)").run(hash, data)
    const latest = build(put)
    store.close()
    index.prepare("INSERT INTO agents VALUES (?, ?, 'IDLE', NULL, ?, NULL, '{}', '2026-10-17T00:00:00.000Z', '2026-10-17T00:00:09.000Z')").run(agentId, later, checkpoint(latest))
    return async () => (await new CursorProvider(nativeStores, later, {}).read(path)).entries
  }
  const shape = (entries) => entries.map((entry) => entry.type === "user" ? `user:${entry.text}`
    : entry.type === "event" ? `event:${entry.label}${entry.detail ? ` — ${entry.detail}` : ""}`
    : entry.type === "tool" ? `tool:${entry.status}${entry.unfinished ? ":cut-off" : ""}` : entry.type)
  const answered = (put, name, entries, prompt, at) => {
    put(blob(`prompt-${name}`), promptRecord(prompt, at))
    for (const [hash, data] of entries) put(hash, data)
    put(blob(`root-${name}`), root(entries))
    return blob(`root-${name}`)
  }

  // Stopped as its call started: no checkpoint, so the next run starts from none and its own checkpoint lacks the stop.
  for (const [agentId, status, marker, call] of [
    ["66666666-6666-4666-8666-666666666666", "CANCELLED", "event:Interrupted", "tool:canceled:cut-off"],
    ["77777777-7777-4777-8777-777777777777", "EXPIRED", "event:Turn failed — Cursor's SDK process ended before the turn did", "tool:failed:cut-off"],
  ]) {
    const read = await agent(agentId, (put) => {
      put(blob(`prompt-sleep-${agentId}`), promptRecord("Run sleep 90.", "2026-10-17T00:00:01.000Z"))
      return answered(put, `ok-${agentId}`, [...preamble("auto"), message("ok", user("Reply OK.")), message("said-ok", said("OK"))], "Reply OK.", "2026-10-17T00:00:05.000Z")
    })
    addRun.run(`run-a-${agentId}`, agentId, 1, status, null, null, status === "EXPIRED" ? "force_send" : null, "2026-10-17T00:00:00.500Z", null, status === "CANCELLED" ? "2026-10-17T00:00:04.000Z" : null)
    streamed(agentId, `run-a-${agentId}`, [{ type: "status", status: "RUNNING" }, { type: "thinking", text: "Running it." }, { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "I'll run it." }] } }, sleep(`call-${agentId}`), ...status === "CANCELLED" ? [{ type: "status", status: "CANCELLED" }] : []])
    addRun.run(`run-b-${agentId}`, agentId, 2, "FINISHED", null, checkpoint(blob(`root-ok-${agentId}`)), null, "2026-10-17T00:00:04.500Z", "2026-10-17T00:00:06.000Z", null)
    assert.deepEqual(shape(await read()), ["user:Run sleep 90.", "thinking", "text", call, marker, "user:Reply OK.", "text"],
      `an agent's first run ${status === "EXPIRED" ? "killed" : "stopped"} before its first checkpoint reads from its run's record, before the next turn`)
  }

  // Stopped after its first checkpoint (the prompt alone): the next run writes the cut step, which settles the replayed call.
  const agentId = "88888888-8888-4888-8888-888888888888"
  const interrupted = "Error: Shell command was interrupted before it completed. It may still be running."
  const read = await agent(agentId, (put) => {
    const asked = [...preamble("auto"), message("sleep", user("Run sleep 90."))]
    put(blob("prompt-sleep"), promptRecord("Run sleep 90.", "2026-10-17T00:00:01.000Z"))
    for (const [hash, data] of asked) put(hash, data)
    put(blob("root-asked"), root(asked))
    const step = [
      message("step", { role: "assistant", content: [{ type: "tool-call", toolCallId: "call-y", toolName: "Shell", args: { command: "sleep 90" } }] }),
      message("result", { role: "tool", content: [{ type: "tool-result", toolCallId: "call-y", toolName: "Shell", result: interrupted }], providerOptions: { cursor: { highLevelToolCallResult: { isError: true } } } }),
    ]
    return answered(put, "next", [...asked, ...step, message("next", user("Reply OK.")), message("said-next", said("OK"))], "Reply OK.", "2026-10-17T00:00:05.000Z")
  })
  addRun.run("run-c", agentId, 1, "CANCELLED", null, checkpoint(blob("root-asked")), null, "2026-10-17T00:00:00.500Z", null, "2026-10-17T00:00:04.000Z")
  streamed(agentId, "run-c", [{ type: "status", status: "RUNNING" }, { type: "thinking", text: "Running it." }, sleep("call-y"), { type: "status", status: "CANCELLED" }])
  addRun.run("run-d", agentId, 2, "FINISHED", checkpoint(blob("root-asked")), checkpoint(blob("root-next")), null, "2026-10-17T00:00:04.500Z", "2026-10-17T00:00:06.000Z", null)
  const cut = await read()
  assert.deepEqual(shape(cut), ["user:Run sleep 90.", "thinking", "tool:canceled", "event:Interrupted", "user:Reply OK.", "text"],
    "the cut step the next run wrote is the stopped call's, once, settled by the result its record keeps")
  assert.equal(cut[2].output, interrupted, "with what the model was told")
  index.close()
  console.log("Cursor early stops: an agent's first run stopped or killed before any checkpoint reads from its run's record, and a cut step a later run wrote settles the stopped call")
} finally {
  await rm(later, { recursive: true, force: true })
}
