import assert from "node:assert/strict"
import { mkdir, writeFile, unlink } from "node:fs/promises"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { SessionCatalog } from "../dist/catalog.js"
import { CATALOG_CACHE_VERSION } from "../dist/catalog-cache.js"
import { DevinCliProvider } from "../dist/providers/devin-cli.js"

const home = mkdtempSync(join(tmpdir(), "mako-devin-cli-"))
const dir = join(home, ".local", "share", "devin", "cli")
await mkdir(dir, { recursive: true })
const database = new DatabaseSync(join(dir, "sessions.db"))

database.exec(`
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    hidden INTEGER NOT NULL,
    last_activity_at INTEGER NOT NULL,
    working_directory TEXT NOT NULL,
    model TEXT NOT NULL,
    title TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    main_chain_id INTEGER
  );
  CREATE TABLE message_nodes (
    row_id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL,
    node_id INTEGER NOT NULL,
    parent_node_id INTEGER,
    chat_message TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`)

database
  .prepare(
    "INSERT INTO sessions (id, hidden, last_activity_at, working_directory, model, title, created_at, main_chain_id) VALUES (?, 0, ?, ?, ?, ?, ?, ?)"
  )
  .run("session-1", 2, "/work", "gpt-5-6-sol-high-priority", "Live session", 1, 2)
const insert = database.prepare(
  "INSERT INTO message_nodes (row_id, session_id, node_id, parent_node_id, chat_message, created_at) VALUES (?, ?, ?, ?, ?, ?)"
)
insert.run(1, "session-1", 1, null, JSON.stringify({ role: "user", content: "hello" }), 1)
insert.run(
  2,
  "session-1",
  2,
  1,
  JSON.stringify({
    role: "assistant",
    thinking: { text: "checking" },
    content: "",
    tool_calls: [
      {
        id: "tool-1",
        function: { name: "shell", arguments: { command: "pwd" } },
      },
    ],
  }),
  2
)
insert.run(
  6,
  "session-1",
  100,
  null,
  JSON.stringify({ role: "user", content: "internal subagent prompt" }),
  2
)
database.exec("ALTER TABLE message_nodes ADD COLUMN metadata TEXT")
database
  .prepare("UPDATE message_nodes SET metadata = ? WHERE row_id = ?")
  .run(
    JSON.stringify({
      metrics: {
        input_tokens: 120,
        output_tokens: 30,
        cache_read_tokens: 40,
        cache_creation_tokens: 10,
      },
    }),
    2
  )

database.close()

try {
  const locks = join(dir, "session_locks")
  await mkdir(locks)
  await writeFile(join(locks, "session-1.lock"), String(process.pid))
  // Native lock files outlive sessions; unrelated locks must not affect results.
  for (let batch = 0; batch < 20; batch++) await Promise.all(Array.from({ length: 50 }, (_, i) => writeFile(join(locks, `retired-${batch}-${i}.lock`), String(process.pid))))
  const provider = new DevinCliProvider(home)
  const [file] = await provider.discover()
  assert.ok(file)
  assert.equal(file.bytes, 2)
  assert.equal(file.locked, true)

  const opened = await provider.read(file.path)
  assert.ok(opened)
  assert.equal(opened.ref.model, "gpt-5-6-sol-high-priority")
  assert.equal(opened.ref.locked, true)
  assert.equal(opened.entries.length, 2)
  const assistant = opened.entries.find((entry) => entry.kind === "assistant")
  assert.deepEqual(assistant?.usage, {
    input: 120,
    output: 30,
    cacheRead: 40,
    cacheWrite: 10,
  })
  const firstTool = opened.entries
    .filter((entry) => entry.kind === "assistant")
    .flatMap((entry) => entry.blocks)
    .find((block) => block.type === "tool")
  assert.equal(firstTool?.name, "shell")
  assert.equal(firstTool?.output, undefined)

  await writeFile(join(locks, "session-1.lock"), "99999999")
  const [unlocked] = await provider.discover()
  assert.equal(unlocked.locked, false)
  await unlink(join(locks, "session-1.lock"))
  assert.equal((await provider.read(file.path)).ref.locked, false, "single-session read sees lock removal")
  await writeFile(join(locks, "session-1.lock"), String(process.pid))
  assert.equal((await provider.discover())[0].locked, true, "new lock is not hidden by cached discovery")
  await writeFile(join(locks, "session-1.lock"), "99999999")

  const follower = provider.createFollower(file.path, file.bytes)
  const writable = new DatabaseSync(join(dir, "sessions.db"))
  writable
    .prepare("INSERT INTO message_nodes (row_id, session_id, node_id, parent_node_id, chat_message, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(
      3,
      "session-1",
      3,
      2,
      JSON.stringify({ role: "tool", tool_call_id: "tool-1", content: "/work" }),
      3
    )
  writable
    .prepare("UPDATE sessions SET last_activity_at = ?, main_chain_id = ? WHERE id = ?")
    .run(3, 3, "session-1")
  writable.close()

  const completed = await follower.next()
  assert.equal(completed.replace, true)
  assert.equal(completed.replaceFrom, 1)
  const completedTool = completed.entries
    .filter((entry) => entry.kind === "assistant")
    .flatMap((entry) => entry.blocks)
    .find((block) => block.type === "tool")
  assert.equal(completedTool?.output, "/work")

  const continued = new DatabaseSync(join(dir, "sessions.db"))
  continued
    .prepare("INSERT INTO message_nodes (row_id, session_id, node_id, parent_node_id, chat_message, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(4, "session-1", 4, 3, JSON.stringify({ role: "user", content: "continue" }), 4)
  continued
    .prepare("INSERT INTO message_nodes (row_id, session_id, node_id, parent_node_id, chat_message, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(5, "session-1", 5, 4, JSON.stringify({ role: "assistant", content: "done" }), 5)
  continued
    .prepare("UPDATE sessions SET last_activity_at = ?, main_chain_id = ? WHERE id = ?")
    .run(5, 5, "session-1")
  continued.close()

  const appended = await follower.next()
  assert.equal(appended.replace, false)
  assert.deepEqual(
    appended.entries.map((entry) => entry.kind),
    ["user", "assistant"]
  )
  assert.equal(appended.nextByte, 5)

  const notified = new DatabaseSync(join(dir, "sessions.db"))
  notified
    .prepare("INSERT INTO message_nodes (row_id, session_id, node_id, parent_node_id, chat_message, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(
      7,
      "session-1",
      6,
      5,
      JSON.stringify({
        role: "system",
        content:
          "<subagent_completion_notification>\n[Background subagent with agent_id=agent-1 completed]\n\nFound the root cause.\n</subagent_completion_notification>",
      }),
      6
    )
  notified
    .prepare("UPDATE sessions SET last_activity_at = ?, main_chain_id = ? WHERE id = ?")
    .run(6, 6, "session-1")
  notified.close()

  const subagent = await follower.next()
  assert.equal(subagent.replace, false)
  const subagentBlock = subagent.entries
    .filter((entry) => entry.kind === "assistant")
    .flatMap((entry) => entry.blocks)
    .find((block) => block.type === "tool")
  assert.equal(subagentBlock?.name, "subagent")
  assert.equal(subagentBlock?.output, "Found the root cause.")

  const stopped = new DatabaseSync(join(dir, "sessions.db"))
  stopped
    .prepare("INSERT INTO message_nodes (row_id, session_id, node_id, parent_node_id, chat_message, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(8, "session-1", 7, 6, JSON.stringify({ role: "system", content: "[Response interrupted by user]" }), 7)
  stopped
    .prepare("UPDATE sessions SET last_activity_at = ?, main_chain_id = ? WHERE id = ?")
    .run(7, 7, "session-1")
  stopped.close()
  const stop = await follower.next()
  assert.deepEqual(
    stop.entries.map((entry) => [entry.kind, entry.label]),
    [["event", "Interrupted"]],
    "Devin's stop notice reads as the shared Interrupted event"
  )

  const cachePath = join(home, "catalog-cache.json")
  await writeFile(
    cachePath,
    JSON.stringify({
      version: CATALOG_CACHE_VERSION,
      entries: {
        [file.path]: {
          bytes: file.bytes,
          mtimeMs: file.mtimeMs,
          revision: file.revision,
          ref: opened.ref,
        },
      },
    })
  )
  const cached = new SessionCatalog(
    [
      {
        harness: "devin",
        displayName: "Devin",
        roots: () => [dir],
        discover: async () => [file],
        peek: async () => {
          throw new Error("unchanged cached refs must not be re-read")
        },
        read: async () => null,
      },
    ],
    { cachePath }
  )
  const [cachedRef] = await cached.scan()
  assert.equal(cachedRef.locked, true)
  await cached.stop()
  const unknownModel = new DatabaseSync(join(dir, "sessions.db"))
  unknownModel.prepare("UPDATE sessions SET model = '' WHERE id = ?").run("session-1")
  unknownModel.close()
  const unconfigured = await provider.read(file.path)
  assert.ok(unconfigured)
  assert.equal(unconfigured.ref.model, undefined, "an empty native model is unknown")
  assert.equal(unconfigured.ref.settings.model, undefined, "an empty native model is not a selection")
  const archived = new SessionCatalog([provider], { archivePath: join(home, "archive") })
  await archived.scan()
  await archived.stop()
  const restarted = new SessionCatalog([], { archivePath: join(home, "archive") })
  try {
    assert.equal((await restarted.scan()).length, 1)
    assert.deepEqual((await restarted.open(file.path)).entries, unconfigured.entries)
    assert.equal((await restarted.open(file.path)).ref.settings.model, undefined)
  } finally {
    await restarted.stop()
  }
  const watched = new SessionCatalog([provider])
  const writer = new DatabaseSync(join(dir, "sessions.db"))
  try {
    await watched.scan()
    const viewed = await watched.open(file.path)
    const updates = []
    watched.follow(file.path, viewed.ref.bytes, entries => updates.push(...entries))
    watched.startWatching()
    for (const watcher of watched.watchers.values()) watcher.close()
    writer.exec("PRAGMA journal_mode=WAL")
    writer.prepare("INSERT INTO message_nodes (row_id, session_id, node_id, parent_node_id, chat_message, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
      999, "session-1", 999, 6, JSON.stringify({ role: "user", content: "observed through WAL" }), 999
    )
    writer.prepare("UPDATE sessions SET last_activity_at = ?, main_chain_id = ? WHERE id = ?").run(999, 999, "session-1")
    const deadline = Date.now() + 2000
    while (!updates.some(entry => entry.kind === "user" && entry.text === "observed through WAL")) {
      assert.ok(Date.now() < deadline, "Devin WAL update delivered without directory events")
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    console.log("Devin native WAL observation delivered without directory events")
  } finally { await watched.stop(); writer.close() }
  // Devin's rename writes the title alone and leaves last_activity_at be.
  const renaming = new SessionCatalog([provider])
  try {
    const before = (await renaming.scan()).find(ref => ref.nativeId === "session-1")
    const renamer = new DatabaseSync(join(dir, "sessions.db"))
    renamer.prepare("UPDATE sessions SET title = ? WHERE id = ?").run("Renamed in Devin", "session-1")
    renamer.close()
    const after = (await renaming.scan()).find(ref => ref.nativeId === "session-1")
    assert.notEqual(before.title, "Renamed in Devin")
    assert.equal(after.title, "Renamed in Devin", "a rename that moves no timestamp still reaches the row")
    console.log("Devin rename without an activity bump reaches the row")
  } finally { await renaming.stop() }

  // Recorded from devin 3000.10.23: a failed tool result, and the system
  // message an automatic compaction leaves in place of the history it summarized.
  const annotated = new DatabaseSync(join(dir, "sessions.db"))
  annotated
    .prepare("INSERT INTO sessions (id, hidden, last_activity_at, working_directory, model, title, created_at, main_chain_id) VALUES (?, 0, ?, ?, ?, ?, ?, ?)")
    .run("session-2", 20, "/work", "swe-1-6", "Compacted", 10, 15)
  const node = annotated.prepare("INSERT INTO message_nodes (row_id, session_id, node_id, parent_node_id, chat_message, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)")
  const extensions = (value) => ({ metadata: { num_tokens: null, extensions: value, telemetry: { source: "system" } } })
  node.run(1011, "session-2", 11, null, JSON.stringify({ role: "user", content: "Speed up the build" }), 11, null)
  node.run(1012, "session-2", 12, 11, JSON.stringify({ role: "assistant", content: "", tool_calls: [{ id: "call-edit", name: "edit", arguments: { file_path: "/work/a.ts" } }] }), 12, null)
  node.run(1013, "session-2", 13, 12, JSON.stringify({
    role: "tool",
    tool_call_id: "call-edit",
    content: "Tool 'edit' validation failed: String not found in file.",
    ...extensions({ "chisel/tool_result_meta": { success: false, failure_reason: "ValidationError", kind: "edit" }, "chisel/tool_failure": { reason: "ValidationError" } }),
  }), 13, null)
  node.run(1014, "session-2", 14, 13, JSON.stringify({
    role: "system",
    content: "You are continuing work from a previous conversation thread. Below is a summary of the previous conversation thread:\nFull conversation history saved at /Users/me/.local/share/devin/cli/summaries/history_19c6.md.\nSummary:\n## 1. Request and Intent\n\nMake the build faster.",
    ...extensions({ "devin-rs/summary": { source: "async_file_compactor" }, "compact/edited_files": { paths: ["/work/a.ts"] } }),
  }), 14, JSON.stringify({ summarized_from: 335, num_tokens_preceding: null, is_system_prefix: null }))
  node.run(1015, "session-2", 15, 14, JSON.stringify({
    role: "system",
    content: "The session mode has changed: you are now in the 'Ask' mode.",
    ...extensions({ mode_transition: { from: "normal", to: "ask" } }),
  }), 15, null)
  annotated.close()
  const compacted = await provider.read(`${join(dir, "sessions.db")}#session-2`)
  assert.ok(compacted)
  const failedTool = compacted.entries.flatMap((entry) => entry.kind === "assistant" ? entry.blocks : []).find((block) => block.type === "tool")
  assert.equal(failedTool?.error, true, "a failed tool result reads as failed")
  const markers = compacted.entries.filter((entry) => entry.kind === "event")
  assert.deepEqual(markers, [{ kind: "event", id: "1014", at: new Date(14_000).toISOString(), label: "Context compacted", body: "## 1. Request and Intent\n\nMake the build faster." }],
    "the compaction reads as a marker carrying its summary; a mode change is not shown")
  assert.ok(!compacted.entries.some((entry) => entry.kind === "user" && /continuing work/.test(entry.text)))
  console.log("Devin compaction summaries read as markers and failed tool results as failed")
  provider.close()
  console.log("Devin CLI tests clean: streamed rows, tools, thinking, locks, and incremental follow verified.")
} finally {
  rmSync(home, { recursive: true, force: true })
}
