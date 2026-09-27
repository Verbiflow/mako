import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { DevinCliProvider } from "../dist/providers/devin-cli.js"
import { ClaudeProvider, GrokProvider, OpenCodeProvider, backgroundCommandLabel, openCodeNoticeLabel } from "../dist/index.js"

// Shapes recorded from Claude Code 2.1.283 and grok 1.0.41 on 2026-09-27: each
// runs a turn on its own when a background command settles.
const root = await mkdtemp(join(tmpdir(), "sessions-provider-turns-"))
const lines = (rows) => rows.map((row) => JSON.stringify(row)).join("\n") + "\n"
const outline = (entries) => entries.map((entry) =>
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
  assert.deepEqual(outline(claude.entries), [
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
  assert.deepEqual(outline(grok.entries).slice(0, 6), [
    "user:Start the sleep in the background",
    "assistant:text",
    'event:opens:Background command "Sleep briefly then print BG-DONE" completed (exit code 0)',
    "assistant:text",
    'event:opens:Background command "Run the checks" failed (exit code 3)',
    "assistant:text",
  ])
  assert.ok(!grok.entries.some((entry) => entry.kind === "event" && /todo/i.test(entry.label)), "only a background task reminder opens a turn")
  console.log("PASS Grok background reminders open the turns Grok started itself")

  // Shapes recorded from opencode 2.0.1 on 2026-09-27: the notice it writes
  // when background work ends, and the turn it runs on one while idle.
  const shellNotice = (state, command, output) => ({
    text: `<shell id="sh_1" state="${state}" command="${command}">\n${output}</shell>`,
    description: command,
    source: "shell",
    state,
  })
  const subagentNotice = (state, description) => ({
    text: `<subagent sessionID="ses_child" state="${state}" description="${description}">\nSubagent cancelled\n</subagent>`,
    description,
    source: "subagent",
    state,
  })
  assert.equal(openCodeNoticeLabel(shellNotice("completed", "sleep 8 && echo done", "done\n\n\nCommand exited with code 0.\n")), 'Background command "sleep 8 && echo done" completed (exit code 0)')
  assert.equal(openCodeNoticeLabel(shellNotice("completed", "make test", "\nCommand exited with code 2.\n")), 'Background command "make test" failed (exit code 2)')
  assert.equal(openCodeNoticeLabel(shellNotice("error", "sleep 3017", "\n")), 'Background command "sleep 3017" failed')
  assert.equal(openCodeNoticeLabel(subagentNotice("cancelled", "Run the checks")), 'Subagent "Run the checks" was stopped')
  assert.equal(openCodeNoticeLabel(subagentNotice("completed", "Run the checks")), 'Subagent "Run the checks" completed')
  assert.equal(openCodeNoticeLabel({ text: "The server restarted while you were working. Continue from where you left off." }), "The server restarted while you were working. Continue from where you left off.")

  const openCodeRoot = join(root, ".local", "share", "opencode")
  await mkdir(openCodeRoot, { recursive: true })
  const openCodePath = join(openCodeRoot, "opencode.db")
  const store = new DatabaseSync(openCodePath)
  store.exec(`
    CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL, name TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL);
    CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, directory TEXT NOT NULL, title TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_archived INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, directory TEXT NOT NULL, title TEXT NOT NULL, model TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_archived INTEGER);
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
  `)
  store.prepare("INSERT INTO project VALUES (?, ?, ?, ?, ?)").run("p", "/work", "work", 1, 1)
  store.prepare("INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run("ses_notice", "p", null, "/work", "Background", JSON.stringify({ id: "m", providerID: "opencode" }), 1000, 9000, null)
  const insert = store.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)")
  const step = (finish, text) => ({ agent: "build", model: { id: "m", providerID: "opencode" }, content: text ? [{ type: "text", text }] : [], finish })
  const interrupted = { ...step("error"), error: { type: "aborted", message: "Step interrupted" } }
  const stored = ({ source, state, ...notice }, metadata) => ({ ...notice, metadata: { source, state, ...metadata } })
  const rows = [
    ["user", { text: "Start them in the background", files: [] }],
    ["assistant", step("tool-calls", "Starting.")],
    ["synthetic", stored(shellNotice("completed", "true", "\nCommand exited with code 0.\n"), { shellID: "sh_0" })],
    ["assistant", step("stop", "Started both.")],
    ["synthetic", stored(shellNotice("completed", "sleep 8 && echo done", "done\n\n\nCommand exited with code 0.\n"), { shellID: "sh_1" })],
    ["assistant", step("stop", "It printed done.")],
    ["synthetic", stored(subagentNotice("cancelled", "Run the checks"), { childID: "ses_child" })],
    ["assistant", interrupted],
  ]
  rows.forEach(([type, data], seq) => insert.run(`msg_${seq}`, "ses_notice", type, seq, 1000 + seq * 1000, 1000 + seq * 1000, JSON.stringify({ ...data, time: { created: 1000 + seq * 1000 } })))
  store.close()
  const openCode = await new OpenCodeProvider(root).read(`${openCodePath}#v2:ses_notice`)
  assert.deepEqual(outline(openCode.entries), [
    "user:Start them in the background",
    "assistant:text",
    "assistant:text",
    'event:opens:Background command "sleep 8 && echo done" completed (exit code 0)',
    "assistant:text",
    'event:opens:Subagent "Run the checks" was stopped',
    "event:Interrupted",
  ])
  assert.equal(openCode.entries[3].id, "msg_4", "the opener keeps the native message's identity")
  console.log("PASS OpenCode notices open the turns OpenCode started itself; one read mid-turn opens none")

  // Shapes recorded from devin 3000.6.14 on 2026-09-27: it runs a turn on a
  // background subagent's completion notification that arrives while idle.
  const devinDir = join(root, ".local", "share", "devin", "cli")
  await mkdir(devinDir, { recursive: true })
  const devinPath = join(devinDir, "sessions.db")
  const devin = new DatabaseSync(devinPath)
  devin.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, hidden INTEGER NOT NULL, last_activity_at INTEGER NOT NULL, working_directory TEXT NOT NULL, model TEXT NOT NULL, title TEXT NOT NULL, created_at INTEGER NOT NULL, main_chain_id INTEGER);
    CREATE TABLE message_nodes (row_id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, node_id INTEGER NOT NULL, parent_node_id INTEGER, chat_message TEXT NOT NULL, created_at INTEGER NOT NULL);
  `)
  const completion = (agent, status, output) => ({ role: "system", content: `<subagent_completion_notification>\n[Background subagent with agent_id=${agent} ${status}]\n${output}\n</subagent_completion_notification>` })
  const spawn = (call, title) => ({ role: "assistant", content: "", tool_calls: [{ id: call, function: { name: "run_subagent", arguments: JSON.stringify({ title, task: "…", is_background: true }) } }] })
  const devinRows = [
    { role: "user", content: "Start the checks in a background subagent" },
    spawn("call-1", "Run the checks"),
    { role: "tool", tool_call_id: "call-1", content: "Background subagent started with agent_id=ag1. You can wait for this agent to finish using the read_subagent tool, otherwise you will automatically be notified." },
    completion("ag0", "completed", "An earlier one, read mid-turn"),
    { role: "assistant", content: "started" },
    completion("ag1", "completed", "All checks passed"),
    { role: "assistant", content: "The checks passed." },
    { role: "user", content: "Start another" },
    spawn("call-2", "Break things"),
    { role: "tool", tool_call_id: "call-2", content: "Background subagent started with agent_id=ag2. You can wait for this agent to finish using the read_subagent tool, otherwise you will automatically be notified." },
    { role: "system", content: "[Response interrupted by user]" },
    completion("ag2", "failed", "It broke"),
    { role: "assistant", content: "It failed." },
  ]
  const insertNode = devin.prepare("INSERT INTO message_nodes VALUES (?, ?, ?, ?, ?, ?)")
  devinRows.forEach((message, node) => insertNode.run(node + 1, "devin-notice", node, node ? node - 1 : null, JSON.stringify(message), 1000 + node))
  devin.prepare("INSERT INTO sessions VALUES (?, 0, ?, ?, ?, ?, ?, ?)").run("devin-notice", 2000, "/work", "swe", "Background", 1000, devinRows.length - 1)
  devin.close()
  const devinThread = await new DevinCliProvider(root).read(`${devinPath}#devin-notice`)
  assert.deepEqual(outline(devinThread.entries), [
    "user:Start the checks in a background subagent",
    "assistant:tool",
    "assistant:tool",
    "assistant:text",
    'event:opens:Subagent "Run the checks" completed',
    "assistant:tool",
    "assistant:text",
    "user:Start another",
    "assistant:tool",
    "event:Interrupted",
    'event:opens:Subagent "Break things" failed',
    "assistant:tool",
    "assistant:text",
  ])
  assert.equal(devinThread.entries[4].id, "6", "the opener keeps the native row's identity")
  console.log("PASS Devin completion notifications open the turns Devin started itself; one read mid-turn opens none")
} finally {
  await rm(root, { recursive: true, force: true })
}
