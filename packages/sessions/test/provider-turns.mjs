import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ClaudeProvider, GrokProvider, backgroundCommandLabel } from "../dist/index.js"

// Shapes recorded from Claude Code 2.1.283 and grok 1.0.41 on 2026-09-27: each
// runs a turn on its own when a background command settles.
const root = await mkdtemp(join(tmpdir(), "sessions-provider-turns-"))
const lines = (rows) => rows.map((row) => JSON.stringify(row)).join("\n") + "\n"
const shape = (entries) => entries.map((entry) =>
  entry.kind === "event" ? `event${entry.opensTurn ? ":opens" : ""}:${entry.label}` : `${entry.kind}:${entry.kind === "user" ? entry.text : entry.blocks.map((block) => block.type).join(",")}`)

try {
  assert.equal(backgroundCommandLabel({ description: "Sleep then print", exitCode: 0 }), 'Background command "Sleep then print" completed (exit code 0)')
  assert.equal(backgroundCommandLabel({ command: "make test", exitCode: 2 }), 'Background command "make test" failed (exit code 2)')
  assert.equal(backgroundCommandLabel({ description: "Watch", signal: "SIGTERM" }), 'Background command "Watch" was stopped (SIGTERM)')
  assert.equal(backgroundCommandLabel({ stopped: true }), "A background command was stopped")

  const claudeDir = join(root, ".claude", "projects", "-work")
  await mkdir(claudeDir, { recursive: true })
  const claudePath = join(claudeDir, "claude-session.jsonl")
  const at = (second) => `2026-09-27T01:00:${String(second).padStart(2, "0")}.000Z`
  const assistant = (uuid, second, text) => ({ type: "assistant", uuid, timestamp: at(second), sessionId: "claude-session", message: { role: "assistant", model: "claude", content: [{ type: "text", text }] } })
  const notification = (uuid, second, summary) => ({
    type: "user", uuid, timestamp: at(second), sessionId: "claude-session", origin: { kind: "task-notification" },
    message: { role: "user", content: `<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>${summary}</summary>\n</task-notification>` },
  })
  await writeFile(claudePath, lines([
    { type: "user", uuid: "u1", timestamp: at(1), sessionId: "claude-session", message: { role: "user", content: "Start the sleep in the background" } },
    assistant("a1", 2, "Started it."),
    notification("n1", 10, 'Background command "Sleep 8 seconds" completed (exit code 0)'),
    assistant("a2", 12, "It printed BG-DONE."),
    notification("n2", 20, "Background shell command didn't finish before the previous session ended"),
    { type: "user", uuid: "u2", timestamp: at(21), sessionId: "claude-session", message: { role: "user", content: "Reply with resumed" } },
    assistant("a3", 22, "resumed"),
  ]))
  const claude = await new ClaudeProvider(root).read(claudePath)
  assert.deepEqual(shape(claude.entries), [
    "user:Start the sleep in the background",
    "assistant:text",
    'event:opens:Background command "Sleep 8 seconds" completed (exit code 0)',
    "assistant:text",
    "event:opens:Background shell command didn't finish before the previous session ended",
    "user:Reply with resumed",
    "assistant:text",
  ])
  assert.equal(claude.entries[2].id, "n1", "the opener keeps the native line's identity")
  console.log("PASS Claude task notifications open the turns Claude started itself")

  const grokDir = join(root, ".grok", "sessions", "%2Fwork", "grok-session")
  await mkdir(grokDir, { recursive: true })
  await writeFile(join(grokDir, "summary.json"), JSON.stringify({ info: { id: "grok-session", cwd: "/work" }, session_summary: "Background" }))
  const grokPath = join(grokDir, "updates.jsonl")
  const update = (timestamp, value, method = "session/update") => ({ timestamp, method, params: { sessionId: "grok-session", update: value } })
  const reminder = (status, description) =>
    `<system-reminder>\nBackground task "01a0-task" ${status}.\nDescription: ${description} | Duration: 8.2s\nUse get_command_or_subagent_output("01a0-task") to see the full output.\n</system-reminder>`
  await writeFile(grokPath, lines([
    update(1, { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Start the sleep in the background" } }),
    update(2, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Started it." } }),
    update(3, { sessionUpdate: "turn_completed", prompt_id: "p1", stop_reason: "end_turn" }, "_x.ai/session/update"),
    update(10, { sessionUpdate: "task_completed", task_snapshot: { task_id: "01a0-task", exit_code: 0 } }, "_x.ai/session/update"),
    update(10, { sessionUpdate: "user_message_chunk", content: { type: "text", text: reminder("completed (exit code: 0)", "Sleep briefly then print BG-DONE") } }),
    update(11, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "It printed BG-DONE." } }),
    update(12, { sessionUpdate: "turn_completed", prompt_id: "task-completed-01a0-task", stop_reason: "end_turn" }, "_x.ai/session/update"),
    update(20, { sessionUpdate: "user_message_chunk", content: { type: "text", text: reminder("failed (exit code: 3)", "Run the checks") } }),
    update(21, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "The checks failed." } }),
    update(22, { sessionUpdate: "turn_completed", prompt_id: "task-completed-01a0-task", stop_reason: "end_turn" }, "_x.ai/session/update"),
    update(30, { sessionUpdate: "user_message_chunk", content: { type: "text", text: "<system-reminder>\nYour todo list changed.\n</system-reminder>" } }),
  ]))
  const grok = await new GrokProvider(root).read(grokPath)
  assert.deepEqual(shape(grok.entries).slice(0, 6), [
    "user:Start the sleep in the background",
    "assistant:text",
    'event:opens:Background command "Sleep briefly then print BG-DONE" completed (exit code 0)',
    "assistant:text",
    'event:opens:Background command "Run the checks" failed (exit code 3)',
    "assistant:text",
  ])
  assert.ok(!grok.entries.some((entry) => entry.kind === "event" && /todo/i.test(entry.label)), "only a background task reminder opens a turn")
  console.log("PASS Grok background reminders open the turns Grok started itself")
} finally {
  await rm(root, { recursive: true, force: true })
}
