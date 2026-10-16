import assert from "node:assert/strict"
import {
  appendFile,
  mkdtemp,
  mkdir,
  open,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { readLines } from "../dist/jsonl.js"
import { CodexProvider } from "../dist/providers/codex.js"
import { NativeStores } from "../dist/read-only-sqlite.js"

const nativeStores = new NativeStores(false)

const home = await mkdtemp(join(tmpdir(), "mako-codex-large-"))
const sessions = join(home, ".codex", "sessions")
const path = join(sessions, "rollout.jsonl")
await mkdir(sessions, { recursive: true })
const metadata = new DatabaseSync(join(home, ".codex", "state_5.sqlite"))
metadata.exec(`
  CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    name TEXT,
    title TEXT,
    first_user_message TEXT,
    cwd TEXT,
    updated_at_ms INTEGER,
    thread_source TEXT,
    rollout_path TEXT
  )
`)
metadata
  .prepare(
    "INSERT INTO threads (id, title, first_user_message, cwd, updated_at_ms, thread_source) VALUES (?, ?, ?, ?, ?, 'user')"
  )
  .run(
    "wrapped",
    "Update sequence links",
    "Investigate duplicate email synchronization carefully.",
    home,
    Date.parse("2026-08-20T00:00:00.000Z")
  )
metadata.close()
const handle = await open(path, "w")
const line = (type, payload) => JSON.stringify({ timestamp: "2026-08-19T00:00:00Z", type, payload }) + "\n"
await handle.write(line("session_meta", { id: "large", cwd: home }))
await handle.write(line("turn_context", { model: "gpt-5.6-sol" }))
await handle.write(line("response_item", { type: "message", role: "user", content: [{ text: "First prompt" }] }))
const tail =
  "\n" +
  line("response_item", { type: "message", role: "user", content: [{ text: "Recent prompt" }] }) +
  line("response_item", { type: "message", role: "assistant", content: [{ text: "Recent answer" }] })
await handle.write(tail, 65 * 1024 * 1024)
await handle.close()

const thread = await new CodexProvider(nativeStores, home).read(path)
assert.ok(thread)
assert.ok(!thread.entries.some((entry) => entry.type === "event" && entry.label === "Earlier history not shown"), "a large rollout is read whole")
assert.ok(thread.entries.some((entry) => entry.type === "user" && entry.text === "First prompt"))
assert.ok(thread.entries.some((entry) => entry.type === "user" && entry.text === "Recent prompt"))
const hole = thread.entries.find((entry) => entry.type === "unread")
assert.equal(hole?.kind, "line", "a line that isn't JSON shows as an unread record")
assert.equal(hole?.reason, "unreadable")
assert.ok(hole.record.ranges[0][1] - hole.record.ranges[0][0] > 64 * 1024 * 1024, "it names its bytes")
const beforeFollow = await stat(path)
const follower = new CodexProvider(nativeStores, home).createFollower(path, beforeFollow.size)
await follower.next()
await appendFile(
  path,
  line("response_item", {
    type: "function_call_output",
    call_id: "missing-before-tail",
    output: "bounded recovery",
  })
)
const recovered = await follower.next()
assert.equal(recovered.reset, true)
assert.ok(
  recovered.entries.some(
    (entry) => entry.type === "user" && entry.text === "First prompt"
  ),
  "a reset re-reads the rollout whole"
)

const wrappedPath = join(sessions, "rollout-wrapped.jsonl")
await writeFile(
  wrappedPath,
  line("session_meta", { id: "wrapped", cwd: home }) +
    line("response_item", {
      type: "message",
      role: "user",
      content: [{ text: "<recommended_plugins>\ninternal" }],
    }) +
    line("response_item", {
      type: "message",
      role: "user",
      content: [
        {
          text: "# Files mentioned by the user:\n\n## report.csv: /tmp/report.csv\n\n## My request:\nInvestigate duplicate email synchronization carefully.",
        },
      ],
    }) +
    line("turn_context", { model: "gpt-5.6-sol" })
)
const wrappedInfo = await stat(wrappedPath)
const wrapped = await new CodexProvider(nativeStores, home).peek({
  path: wrappedPath,
  bytes: wrappedInfo.size,
  mtimeMs: wrappedInfo.mtimeMs,
})
assert.equal(wrapped?.title, "Update sequence links")
assert.equal(wrapped?.updatedAt, new Date(wrappedInfo.mtimeMs).toISOString())

const childPath = join(sessions, "rollout-subagent.jsonl")
await writeFile(
  childPath,
  line("session_meta", {
    id: "child-rollout",
    session_id: "parent-session",
    parent_thread_id: "parent-session",
    thread_source: "subagent",
    cwd: home,
  }) +
    line("session_meta", {
      id: "parent-session",
      session_id: "parent-session",
      thread_source: "user",
      cwd: home,
    })
)
const childInfo = await stat(childPath)
const child = await new CodexProvider(nativeStores, home).peek({
  path: childPath,
  bytes: childInfo.size,
  mtimeMs: childInfo.mtimeMs,
})
assert.equal(child, null)

const customToolPath = join(sessions, "custom-tool.jsonl")
await writeFile(
  customToolPath,
  line("session_meta", { id: "custom-tool", cwd: home }) +
    line("response_item", {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Run the command" }],
    }) +
    line("response_item", {
      type: "custom_tool_call",
      call_id: "custom-1",
      name: "wait",
      input: "{\"cell_id\":\"706\"}",
    }) +
    line("response_item", {
      type: "custom_tool_call_output",
      call_id: "custom-1",
      output: JSON.stringify([
        { type: "input_text", text: "Script completed\nOutput:\n" },
        { type: "input_text", text: "390 rows" },
      ]),
    }) +
    line("response_item", {
      type: "local_shell_call",
      call_id: "shell-1",
      action: { command: ["bun", "test"] },
    }) +
    line("response_item", {
      type: "function_call_output",
      call_id: "shell-1",
      output: "tests passed",
    }) +
    line("response_item", {
      type: "tool_search_call",
      call_id: "search-1",
      arguments: { query: "spreadsheet" },
      execution: "server",
      status: "completed",
    }) +
    line("response_item", {
      type: "tool_search_output",
      call_id: "search-1",
      output: "found spreadsheet tool",
    })
)
const customTool = await new CodexProvider(nativeStores, home).read(customToolPath)
// Each call as drawn, without where and when it was read; those are checked where they matter.
const drawnTool = ({ at: _at, record: _record, model: _model, usage: _usage, ...tool }) => tool
const customTools = customTool.entries.filter((entry) => entry.type === "tool").map(drawnTool)
const customBlock = customTools[0]
assert.deepEqual(customBlock, {
  type: "tool",
  id: "custom-1",
  name: "wait",
  input: "{\"cell_id\":\"706\"}",
  output: "Script completed\nOutput:\n\n390 rows",
  status: "completed",
})
assert.deepEqual(customTools?.find((block) => block.name === "exec_command"), {
  type: "tool",
  name: "exec_command",
  id: "shell-1",
  input: "{\"command\":\"bun test\"}",
  output: "tests passed",
  status: "completed",
  // What the call reported doing, for attribution; this rollout records no turn, so no folder.
  effects: [{ kind: "command", command: "bun test" }],
})
assert.deepEqual(customTools?.find((block) => block.name === "ToolSearch"), {
  type: "tool",
  name: "ToolSearch",
  id: "search-1",
  input: "{\"query\":\"spreadsheet\"}",
  output: "found spreadsheet tool",
  status: "completed",
})

const oversizedPath = join(sessions, "oversized-line.jsonl")
const oversized = await open(oversizedPath, "w")
await oversized.write(Buffer.from("{"), 0, 1, 0)
const afterOversized = line("session_meta", {
  id: "after-oversized",
  cwd: home,
})
await oversized.write(
  Buffer.from(`\n${afterOversized}`),
  0,
  Buffer.byteLength(`\n${afterOversized}`),
  20 * 1024 * 1024
)
await oversized.close()
const lines = []
await readLines(oversizedPath, 0, (raw, place) => lines.push({ raw, place }))
assert.equal(lines.length, 2, "a 20 MiB line is read like any other")
assert.equal(lines[0].raw.length, 20 * 1024 * 1024)
assert.deepEqual(lines[0].place, { from: 0, to: 20 * 1024 * 1024 + 1 })
assert.match(lines[1].raw, /after-oversized/)

const resumedId = "01a07995-2e08-7360-8599-291f436c18d8"
const originalPath = join(sessions, `rollout-2026-09-07T09-00-00-${resumedId}.jsonl`)
const resumedPath = join(sessions, `rollout-2026-09-07T10-00-00-${resumedId}_01a07db0-30b5-7773-98d6-5ab7500df5e8.jsonl`)
// A thread's later rollout continues its earlier one up to history_base, as an undo's does.
const original = line("session_meta", { id: resumedId, cwd: home }) + line("response_item", { type: "message", role: "user", content: [{ text: "Old prompt" }] })
await writeFile(resumedPath, line("session_meta", { id: resumedId, cwd: home, history_base: { thread_id: resumedId, end_byte_offset: Buffer.byteLength(original) } }) + line("response_item", { type: "message", role: "user", content: [{ text: "Current resumed prompt" }] }))
// Touch the old rollout last: an mtime guess must not defeat Codex's current path.
await writeFile(originalPath, original + line("response_item", { type: "message", role: "user", content: [{ text: "Undone prompt" }] }))
const currentDb = new DatabaseSync(join(home, ".codex", "state_5.sqlite"))
currentDb.prepare("INSERT INTO threads (id, title, cwd, updated_at_ms, thread_source, rollout_path) VALUES (?, ?, ?, ?, 'user', ?)").run(resumedId, "Resumed thread", home, Date.now(), resumedPath)
currentDb.close()
const resumedProvider = new CodexProvider(nativeStores, home)
const discovered = await resumedProvider.discover()
assert.equal(discovered.filter(file => file.path.includes(resumedId)).length, 1)
assert.ok(discovered.some(file => file.path === resumedPath))
assert.deepEqual((await resumedProvider.read(resumedPath)).entries.flatMap(entry => entry.type === "user" ? [entry.text] : []), ["Old prompt", "Current resumed prompt"], "the current rollout reads through the history it continues")
assert.ok((await resumedProvider.read(originalPath)).entries.some(entry => entry.type === "user" && entry.text === "Old prompt"), "Explicit historical file reads remain available")

await rm(home, { recursive: true, force: true })

console.log("Large Codex checks clean: gigabyte rollouts translate from a bounded recent window.")
