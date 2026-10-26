import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { DevinCliProvider } from "../dist/providers/devin-cli.js"
import { mkdtemp as mkdtempSync, realpath, symlink } from "node:fs/promises"
import { ClaudeProvider, GrokProvider, KeptOutputs, keptOutputsPath, OpenCodeProvider, backgroundCommandLabel, backgroundCommandTurn, claudeTaskOutputTail, codexGoalTurn, openCodeNoticeLabel, openCodeNoticeTurn, outputTail, subagentTurn, CODEX_GOAL, UNNAMED_TURN } from "../dist/index.js"
import { claudeTaskCause, claudeTaskTurn, parseClaudeTaskNotification } from "../dist/harnesses/index.js"
import { codexGoalPromptStanding } from "../dist/providers/codex-presentation.js"
import { cursorTaskOpener } from "../dist/providers/cursor-presentation.js"
import { cursorTerminalEnd } from "../dist/providers/cursor-terminal.js"
import { TurnCauseSchema } from "../dist/events.js"
import { NativeStores } from "../dist/read-only-sqlite.js"
import { messagesFromEntries } from "../dist/entry-sink.js"

const nativeStores = new NativeStores(false)

// Shapes recorded from Claude Code 2.1.283 and grok 1.0.41 on 2026-09-27: each
// runs a turn on its own when a background command settles.
const root = await mkdtemp(join(tmpdir(), "sessions-provider-turns-"))
/** A thread read as messages, as its replies are drawn whole. */
const grouped = (thread) => thread && { ...thread, entries: messagesFromEntries(thread.entries) }
const lines = (rows) => rows.map((row) => JSON.stringify(row)).join("\n") + "\n"
const outline = (entries) => entries.map((entry) =>
  entry.kind === "event" ? `event${entry.opensTurn ? ":opens" : ""}:${entry.label}` : `${entry.kind}:${entry.kind === "user" ? entry.text : entry.blocks.map((block) => block.type).join(",")}`)

try {
  assert.equal(backgroundCommandLabel({ description: "Sleep then print", exitCode: 0 }), 'Background command "Sleep then print" completed (exit code 0)')
  assert.equal(backgroundCommandLabel({ command: "make test", exitCode: 2 }), 'Background command "make test" failed (exit code 2)')
  assert.equal(backgroundCommandLabel({ description: "Watch", signal: "SIGTERM" }), 'Background command "Watch" was stopped (SIGTERM)')
  assert.equal(backgroundCommandLabel({ stopped: true }), "A background command was stopped")
  // The same outcome as structure, beside the sentence: the transcript words its line from this, never from the sentence.
  assert.deepEqual(backgroundCommandTurn({ description: "Sleep then print", exitCode: 0 }), { reason: 'Background command "Sleep then print" completed (exit code 0)', cause: { kind: "command", outcome: "finished", name: "Sleep then print", exitCode: 0 } })
  assert.deepEqual(backgroundCommandTurn({ command: "make test", exitCode: 2 }).cause, { kind: "command", outcome: "failed", name: "make test", exitCode: 2 })
  assert.deepEqual(backgroundCommandTurn({ description: "Watch", signal: "SIGTERM" }).cause, { kind: "command", outcome: "stopped", name: "Watch", signal: "SIGTERM" })
  assert.deepEqual(backgroundCommandTurn({ failed: true }).cause, { kind: "command", outcome: "failed" })
  assert.deepEqual(subagentTurn({ description: "Index", state: "failed" }), { reason: 'Subagent "Index" failed', cause: { kind: "agent", outcome: "failed", name: "Index" } })
  assert.deepEqual(subagentTurn({ state: "cancelled" }).cause, { kind: "agent", outcome: "stopped" })
  assert.deepEqual(CODEX_GOAL.cause, { kind: "goal" })
  assert.deepEqual(UNNAMED_TURN, { reason: "A background task finished", cause: { kind: "task", outcome: "finished" } })
  // Every summary shape Claude Code 2.1 wrote in this machine's sessions on 2026-10-12, and one it doesn't.
  for (const [summary, status, cause] of [
    ['Background command "Watch the pull request\'s checks until done" completed (exit code 0)', "completed", { kind: "command", outcome: "finished", name: "Watch the pull request's checks until done", exitCode: 0 }],
    ['Background command "Run the test suite" failed with exit code 1', "failed", { kind: "command", outcome: "failed", name: "Run the test suite", exitCode: 1 }],
    ['Background command "npm run dev" was stopped', "killed", { kind: "command", outcome: "stopped", name: "npm run dev" }],
    ["Background shell command didn't finish before the previous session ended", "killed", { kind: "command", outcome: "unfinished" }],
    ['Agent "Audit the transcript events" finished', "completed", { kind: "agent", outcome: "finished", name: "Audit the transcript events" }],
    ['Agent "Index" finished', "failed", { kind: "agent", outcome: "failed", name: "Index" }],
    ['Monitor event: "CI turned green on main"', "completed", { kind: "monitor", outcome: "event", name: "CI turned green on main" }],
    ['Monitor "deploy logs" stream ended', "completed", { kind: "monitor", outcome: "ended", name: "deploy logs" }],
    ["Something Claude Code says next year", "completed", { kind: "task", outcome: "finished", name: "Something Claude Code says next year" }],
    // The limit that refuses the orchestrator ends every agent it runs, and says so in each one's summary.
    ['Agent "Index" failed: Agent terminated early due to an API error: You\'ve hit your session limit · resets 3:20am (America/Los_Angeles) (error type rate_limit, HTTP 429)', "failed", { kind: "agent", outcome: "failed", name: "Index", limit: {} }],
    ['Agent "Index" failed: Agent terminated early due to an API error: Overloaded (error type overloaded_error, HTTP 529)', "failed", { kind: "agent", outcome: "failed", name: "Index" }],
  ]) {
    assert.deepEqual(claudeTaskCause(summary, status), cause, summary)
    assert.ok(TurnCauseSchema.safeParse(cause).success, `${summary} is a valid cause`)
  }
  assert.equal(claudeTaskCause("Something Claude Code says next year"), undefined, "an unknown summary with no status has no cause")
  const limited = claudeTaskTurn(parseClaudeTaskNotification('<task-notification>\n<task-id>a1</task-id>\n<status>failed</status>\n<summary>Agent "Index" failed: Agent terminated early due to an API error: You\'ve hit your session limit · resets 3:20am (America/Los_Angeles)</summary>\n</task-notification>'))
  assert.equal(limited.body, "Agent terminated early due to an API error: You've hit your session limit · resets 3:20am (America/Los_Angeles)", "a failed agent's error is what opens under its line")

  const claudeDir = join(root, ".claude", "projects", "-work")
  await mkdir(claudeDir, { recursive: true })
  const claudePath = join(claudeDir, "claude-session.jsonl")
  const at = (second) => `2026-09-27T01:00:${String(second).padStart(2, "0")}.000Z`
  const assistant = (uuid, second, text) => ({ type: "assistant", uuid, timestamp: at(second), sessionId: "claude-session", message: { role: "assistant", model: "claude", content: [{ type: "text", text }] } })
  const notification = (uuid, second, summary, more = "") => ({
    type: "user", uuid, timestamp: at(second), sessionId: "claude-session", origin: { kind: "task-notification" },
    message: { role: "user", content: `<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>${summary}</summary>${more}\n</task-notification>` },
  })
  // Claude Code 2.1.283's agent and monitor notifications (from this Mac's sessions, text neutralized): the report is escaped, `&`, `<` and `>`.
  const report = "<result>[harness: subagent output matched instruction-shaped pattern(s): harness-envelope-tag. Control tags below are neutralized.]\n\nI built **both** pieces &amp; checked them: `&lt;Tree&gt;` draws each frame.</result>\n<usage><subagent_tokens>632780</subagent_tokens><tool_uses>282</tool_uses><duration_ms>3530972</duration_ms></usage>"
  await writeFile(claudePath, lines([
    { type: "user", uuid: "u1", timestamp: at(1), sessionId: "claude-session", message: { role: "user", content: "Start the sleep in the background" } },
    assistant("a1", 2, "Started it."),
    notification("n1", 10, 'Background command "Sleep 8 seconds" completed (exit code 0)'),
    assistant("a2", 12, "It printed BG-DONE."),
    notification("n2", 20, "Background shell command didn't finish before the previous session ended"),
    { type: "user", uuid: "u2", timestamp: at(21), sessionId: "claude-session", message: { role: "user", content: "Reply with resumed" } },
    assistant("a3", 22, "resumed"),
    notification("n3", 30, 'Agent "Build the element tree" finished', `\n${report}`),
    assistant("a4", 31, "Both pieces are in."),
    notification("n4", 40, 'Monitor event: "PR checks (pass or fail)"', "\n<event>compute-local: pass\nconformance: pass</event>"),
    assistant("a5", 41, "Two passed."),
  ]))
  const claude = grouped(await new ClaudeProvider(root).read(claudePath))
  assert.deepEqual(outline(claude.entries), [
    "user:Start the sleep in the background",
    "assistant:text",
    'event:opens:Background command "Sleep 8 seconds" completed (exit code 0)',
    "assistant:text",
    "event:opens:Background shell command didn't finish before the previous session ended",
    "user:Reply with resumed",
    "assistant:text",
    'event:opens:Agent "Build the element tree" finished',
    "assistant:text",
    'event:opens:Monitor event: "PR checks (pass or fail)"',
    "assistant:text",
  ])
  assert.equal(claude.entries[2].id, "n1", "the opener keeps the native line's identity")
  assert.deepEqual(claude.entries[2].cause, { kind: "command", outcome: "finished", name: "Sleep 8 seconds", exitCode: 0 })
  assert.deepEqual(claude.entries[4].cause, { kind: "command", outcome: "unfinished" })
  assert.equal(claude.entries[2].body, undefined, "a command whose output file is gone has nothing more to show")
  assert.deepEqual(claude.entries[7].cause, { kind: "agent", outcome: "finished", name: "Build the element tree", agentId: "b1", durationMs: 3530972 })
  assert.equal(claude.entries[7].body, "I built **both** pieces & checked them: `<Tree>` draws each frame.", "the agent's report, as it wrote it, without Claude's note to its model")
  assert.deepEqual(claude.entries[9].cause, { kind: "monitor", outcome: "event", name: "PR checks (pass or fail)", output: "compute-local: pass" })
  assert.equal(claude.entries[9].body, "```output\ncompute-local: pass\nconformance: pass\n```")
  console.log("PASS Claude task notifications open the turns Claude started itself, with the report, event or output each left")

  // A command's output is read from Claude Code's own temporary folder, while it is there, and from nowhere else.
  const uid = process.getuid()
  const claudeTemp = join(await realpath("/tmp"), `claude-${uid}`)
  await mkdir(claudeTemp, { recursive: true })
  const outputRoot = await mkdtempSync(join(claudeTemp, "mako-provider-turns-"))
  try {
    const tasks = join(outputRoot, "session", "tasks")
    await mkdir(tasks, { recursive: true })
    const lines = Array.from({ length: 300 }, (_, index) => `line ${index}`).join("\n")
    await writeFile(join(tasks, "bx1.output"), `\u001b[1mbuild\u001b[0m\n${lines}\nprogress 10%\rprogress 100%\nAll checks were successful\n`)
    const tail = claudeTaskOutputTail(join("/tmp", `claude-${uid}`, outputRoot.slice(claudeTemp.length + 1), "session", "tasks", "bx1.output"), "bx1")
    assert.ok(tail.endsWith("line 299\nprogress 100%\nAll checks were successful"), "the end of the output, a progress bar as it last drew")
    assert.equal(tail.split("\n").length, 40, "at most its last 40 lines")
    assert.equal(claudeTaskOutputTail(join(tasks, "bx1.output"), "other"), undefined, "only the file named for the task")
    await symlink(join(root, "secret.txt"), join(tasks, "ax2.output"))
    await writeFile(join(root, "secret.txt"), "not Claude's")
    assert.equal(claudeTaskOutputTail(join(tasks, "ax2.output"), "ax2"), undefined, "an agent's output file is a link, never followed")
    const outside = join(root, "elsewhere", "tasks")
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, "bx3.output"), "outside")
    assert.equal(claudeTaskOutputTail(join(outside, "bx3.output"), "bx3"), undefined, "nothing outside Claude Code's temporary folder")
    const withOutput = claudeTaskTurn(parseClaudeTaskNotification(`<task-notification>\n<task-id>bx1</task-id>\n<output-file>${join(tasks, "bx1.output")}</output-file>\n<status>completed</status>\n<summary>Background command "Watch the checks" completed (exit code 0)</summary>\n</task-notification>`), tail)
    assert.ok(withOutput.body.startsWith("```output\n") && withOutput.body.endsWith("All checks were successful\n```"))
  } finally {
    await rm(outputRoot, { recursive: true, force: true })
  }
  assert.equal(outputTail("\u001b[31mred\u001b[0m"), "red", "terminal codes are left out")
  console.log("PASS a background command's output is read only from the task's own file, and only its end")

  // A command's output is kept when it is first read, and read back from the copy once the file is gone.
  {
    const keptRoot = await mkdtemp(join(tmpdir(), "sessions-kept-outputs-"))
    const keptTemp = await mkdtempSync(join(claudeTemp, "mako-kept-"))
    try {
      const session = "kept-session"
      const tasks = join(keptTemp, session, "tasks")
      await mkdir(tasks, { recursive: true })
      const file = join(tasks, "bk1.output")
      await writeFile(file, "compiling\n12 passed\n")
      const projects = join(keptRoot, ".claude", "projects", "-work")
      await mkdir(projects, { recursive: true })
      const path = join(projects, `${session}.jsonl`)
      const done = `<task-notification>\n<task-id>bk1</task-id>\n<output-file>${file}</output-file>\n<status>completed</status>\n<summary>Background command "Run the tests" completed (exit code 0)</summary>\n</task-notification>`
      await writeFile(path, lines([
        { type: "user", uuid: "k1", timestamp: at(1), sessionId: session, message: { role: "user", content: "Run the tests in the background, then edit" } },
        { type: "assistant", uuid: "k2", timestamp: at(2), sessionId: session, message: { role: "assistant", model: "claude", content: [{ type: "text", text: "Started." }] } },
        // Taken in while the turn ran: a marker in it, citing the attachment's line.
        { type: "attachment", uuid: "k3", timestamp: at(3), sessionId: session, isSidechain: false, attachment: { type: "queued_command", prompt: done, commandMode: "task-notification" } },
        { type: "assistant", uuid: "k4", timestamp: at(4), sessionId: session, message: { role: "assistant", model: "claude", content: [{ type: "text", text: "They passed." }] } },
      ]))
      const marker = (thread) => thread.entries.find((entry) => entry.kind === "event")
      const first = marker(grouped(await new ClaudeProvider(keptRoot).read(path)))
      assert.deepEqual({ id: first.id, source: first.source, body: first.body }, { id: "k3", source: { harness: "claude", record: "k3", body: "output-file" }, body: "```output\ncompiling\n12 passed\n```" })
      await rm(file)
      // A new process, after a reboot cleared /tmp: the same body, from the copy.
      const again = marker(grouped(await new ClaudeProvider(keptRoot).read(path)))
      assert.deepEqual({ source: again.source, body: again.body }, { source: { harness: "claude", record: "k3", body: "kept-copy" }, body: first.body })
      // A strict host reads the copies and writes none.
      const strict = new ClaudeProvider(keptRoot, new NativeStores(true))
      assert.equal(marker(grouped(await strict.read(path))).body, first.body, "a read-only host reads the kept copy")
      const outputs = new KeptOutputs(keptOutputsPath(keptRoot), new NativeStores(true))
      outputs.keep({ harness: "claude", session, task: "other" }, { output: "x" })
      assert.equal(outputs.read({ harness: "claude", session, task: "other" }), undefined, "and keeps nothing itself")
      // The budget: the oldest copies go once it is spent.
      const small = new KeptOutputs(join(keptRoot, "budget.sqlite"), undefined, { copies: 10, bytes: 1024 * 1024 })
      for (let index = 0; index < 25; index++) small.keep({ harness: "claude", session: "s", task: `t${index}` }, { output: `output ${index}` })
      const totals = small.totals()
      assert.ok(totals.copies <= 10 && totals.copies > 0, `the copies stay in the budget (${totals.copies})`)
      assert.equal(small.read({ harness: "claude", session: "s", task: "t0" }), undefined, "the oldest went first")
      assert.deepEqual(small.read({ harness: "claude", session: "s", task: "t24" }), { output: "output 24" })
      const bytes = new KeptOutputs(join(keptRoot, "bytes.sqlite"), undefined, { copies: 1000, bytes: 4096 })
      for (let index = 0; index < 20; index++) bytes.keep({ harness: "claude", session: "s", task: `t${index}` }, { output: "x".repeat(1000) })
      assert.ok(bytes.totals().bytes <= 4096, "and in its bytes")
      for (const store of [small, bytes, outputs]) store.close()
    } finally {
      await rm(keptTemp, { recursive: true, force: true })
      await rm(keptRoot, { recursive: true, force: true })
    }
  }
  console.log("PASS a command's output is kept when first read, read back once its file is gone, within its budget, and never written by a read-only host")

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
    update(10, { sessionUpdate: "task_completed", task_snapshot: { task_id: "01a0-task", exit_code: 0, output: "BG-DONE\n", start_time: { secs_since_epoch: 100, nanos_since_epoch: 0 }, end_time: { secs_since_epoch: 108, nanos_since_epoch: 200000000 } } }, "_x.ai/session/update"),
    update(10, { sessionUpdate: "user_message_chunk", content: { type: "text", text: reminder("completed (exit code: 0)", "Sleep briefly then print BG-DONE") } }),
    update(11, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "It printed BG-DONE." } }),
    update(12, { sessionUpdate: "turn_completed", prompt_id: "task-completed-01a0-task", stop_reason: "end_turn" }, "_x.ai/session/update"),
    update(20, { sessionUpdate: "user_message_chunk", content: { type: "text", text: reminder("failed (exit code: 3)", "Run the checks") } }),
    update(21, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "The checks failed." } }),
    update(22, { sessionUpdate: "turn_completed", prompt_id: "task-completed-01a0-task", stop_reason: "end_turn" }, "_x.ai/session/update"),
    update(30, { sessionUpdate: "user_message_chunk", content: { type: "text", text: "<system-reminder>\nYour todo list changed.\n</system-reminder>" } }),
  ]))
  const grok = grouped(await new GrokProvider(root).read(grokPath))
  assert.deepEqual(outline(grok.entries).slice(0, 6), [
    "user:Start the sleep in the background",
    "assistant:text",
    'event:opens:Background command "Sleep briefly then print BG-DONE" completed (exit code 0)',
    "assistant:text",
    'event:opens:Background command "Run the checks" failed (exit code 3)',
    "assistant:text",
  ])
  assert.ok(!grok.entries.some((entry) => entry.kind === "event" && /todo/i.test(entry.label)), "only a background task reminder opens a turn")
  assert.deepEqual(grok.entries[2].cause, { kind: "command", outcome: "finished", name: "Sleep briefly then print BG-DONE", exitCode: 0, durationMs: 8200 })
  assert.equal(grok.entries[2].body, "```output\nBG-DONE\n```", "the reminder's task's output, from the snapshot the store kept before it")
  assert.deepEqual(grok.entries[4].cause, { kind: "command", outcome: "failed", name: "Run the checks", exitCode: 3, durationMs: 8200 })
  assert.equal(grok.entries[4].body, "```output\nBG-DONE\n```", "a later reminder for the same task reads the same snapshot")
  console.log("PASS Grok background reminders open the turns Grok started itself")

  // Shapes from opencode 2.0.27's ShellResult.notification: the notice it
  // writes when background work ends, and the turn it runs on one while idle.
  const shellNotice = (state, command, output, outcome = {}) => ({
    text: `<shell id="sh_1" state="${state}" command="${command}">\n${output}\n</shell>`,
    description: command,
    source: "shell",
    state,
    ...outcome,
  })
  const subagentNotice = (state, description) => ({
    text: `<subagent sessionID="ses_child" state="${state}" description="${description}">\nSubagent cancelled\n</subagent>`,
    description,
    source: "subagent",
    state,
  })
  assert.equal(openCodeNoticeLabel(shellNotice("completed", "sleep 8 && echo done", "done", { exit: 0 })), 'Background command "sleep 8 && echo done" completed (exit code 0)')
  assert.equal(openCodeNoticeLabel(shellNotice("completed", "make test", "Exited with code 2", { exit: 2 })), 'Background command "make test" failed (exit code 2)')
  assert.equal(openCodeNoticeLabel(shellNotice("completed", "sleep 60", "Killed by SIGKILL", { signal: "SIGKILL" })), 'Background command "sleep 60" was stopped (SIGKILL)')
  assert.equal(openCodeNoticeLabel(shellNotice("cancelled", "sleep 60", "Cancelled")), 'Background command "sleep 60" was stopped')
  assert.equal(openCodeNoticeLabel(shellNotice("error", "sleep 3017", "Command failed")), 'Background command "sleep 3017" failed')
  assert.equal(openCodeNoticeLabel(subagentNotice("cancelled", "Run the checks")), 'Subagent "Run the checks" was stopped')
  assert.equal(openCodeNoticeLabel(subagentNotice("completed", "Run the checks")), 'Subagent "Run the checks" completed')
  assert.equal(openCodeNoticeLabel({ text: "The server restarted while you were working. Continue from where you left off." }), "The server restarted while you were working. Continue from where you left off.")
  assert.deepEqual(openCodeNoticeTurn(shellNotice("completed", "make test", "Exited with code 2", { exit: 2 })).cause, { kind: "command", outcome: "failed", name: "make test", exitCode: 2 })
  assert.equal(openCodeNoticeTurn({ text: "The server restarted while you were working." }).cause, undefined, "OpenCode's own notice names no work, so it keeps only its words")
  // What the work left: the shell's output without OpenCode's closing words, the subagent's reply.
  assert.equal(openCodeNoticeTurn(shellNotice("completed", "sleep 8 && echo done", "done\n\nCommand exited with code 0.", { exit: 0 })).body, "```output\ndone\n```")
  assert.equal(openCodeNoticeTurn(shellNotice("completed", "bun run backfill > log 2>&1", "(no output)\n\nCommand exited with code 1.", { exit: 1 })).body, undefined, "nothing printed, nothing to open")
  assert.equal(openCodeNoticeTurn(shellNotice("error", "sleep 3017", "")).body, undefined)
  assert.equal(openCodeNoticeTurn(subagentNotice("cancelled", "Run the checks")).body, undefined, "its placeholder repeats the line")
  assert.equal(openCodeNoticeTurn({ text: `<subagent sessionID="ses_c" state="completed" description="Review">\nAll **41** checks pass.\n</subagent>`, description: "Review", source: "subagent", state: "completed" }).body, "All **41** checks pass.")

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
  const stored = ({ source, state, exit, signal, ...notice }, metadata) => ({ ...notice, metadata: { source, state, exit, signal, ...metadata } })
  const rows = [
    ["user", { text: "Start them in the background", files: [] }],
    ["assistant", step("tool-calls", "Starting.")],
    ["synthetic", stored(shellNotice("completed", "true", "", { exit: 0 }), { shellID: "sh_0" })],
    ["assistant", step("stop", "Started both.")],
    ["synthetic", stored(shellNotice("completed", "sleep 8 && echo done", "done\n\nCommand exited with code 0.", { exit: 0 }), { shellID: "sh_1" })],
    ["assistant", step("stop", "It printed done.")],
    ["synthetic", stored(subagentNotice("cancelled", "Run the checks"), { childID: "ses_child" })],
    ["assistant", interrupted],
  ]
  rows.forEach(([type, data], seq) => insert.run(`msg_${seq}`, "ses_notice", type, seq, 1000 + seq * 1000, 1000 + seq * 1000, JSON.stringify({ ...data, time: { created: 1000 + seq * 1000 } })))
  store.close()
  const openCode = grouped(await new OpenCodeProvider(nativeStores, root).read(`${openCodePath}#v2:ses_notice`))
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
  assert.deepEqual(openCode.entries[3].cause, { kind: "command", outcome: "finished", name: "sleep 8 && echo done", exitCode: 0 })
  assert.equal(openCode.entries[3].body, "```output\ndone\n```", "saved reads the same output live does")
  assert.deepEqual(openCode.entries[5].cause, { kind: "agent", outcome: "stopped", name: "Run the checks" })
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
  const devinThread = grouped(await new DevinCliProvider(nativeStores, root).read(`${devinPath}#devin-notice`))
  assert.deepEqual(outline(devinThread.entries), [
    "user:Start the checks in a background subagent",
    "assistant:tool,tool,text",
    'event:opens:Subagent "Run the checks" completed',
    "assistant:text",
    "user:Start another",
    "assistant:tool",
    "event:Interrupted",
    'event:opens:Subagent "Break things" failed',
    "assistant:text",
  ])
  assert.equal(devinThread.entries[2].id, "6", "the opener keeps the native row's identity")
  assert.deepEqual(devinThread.entries[2].cause, { kind: "agent", outcome: "finished", name: "Run the checks", agentId: "ag1", durationMs: 3000 })
  assert.equal(devinThread.entries[2].body, "All checks passed", "the completion's report opens under the turn, as live, not as a second tool row")
  assert.deepEqual(devinThread.entries[7].cause, { kind: "agent", outcome: "failed", name: "Break things", agentId: "ag2", durationMs: 2000 })
  assert.equal(devinThread.entries[7].body, "It broke")
  console.log("PASS Devin completion notifications open the turns Devin started itself; one read mid-turn opens none")

  // Devin 3000.11.205 (decode pair subagent-wake, 2026-10-25) holds the turn that started a background
  // subagent open until it reports, and tags the report with the subagent: a marker in that turn, as live.
  const held = new DatabaseSync(devinPath)
  const heldRows = [
    { role: "user", content: "Start one in the background" },
    spawn("call-3", "Reply with a marker"),
    { role: "tool", tool_call_id: "call-3", content: "Background subagent started with agent_id=ag3. You can wait for this agent to finish using the read_subagent tool, otherwise you will automatically be notified." },
    { role: "assistant", content: "Started it." },
    { ...completion("ag3", "completed", "marker-7"), metadata: { extensions: { "subagent/agent_id": "ag3" } } },
    { role: "assistant", content: "It replied marker-7." },
  ]
  heldRows.forEach((message, node) => held.prepare("INSERT INTO message_nodes VALUES (?, ?, ?, ?, ?, ?)").run(100 + node, "devin-held", node, node ? node - 1 : null, JSON.stringify(message), 1000 + node))
  held.prepare("INSERT INTO sessions VALUES (?, 0, ?, ?, ?, ?, ?, ?)").run("devin-held", 2000, "/work", "swe", "Held", 1000, heldRows.length - 1)
  held.close()
  const heldThread = grouped(await new DevinCliProvider(nativeStores, root).read(`${devinPath}#devin-held`))
  assert.deepEqual(outline(heldThread.entries), [
    "user:Start one in the background",
    "assistant:tool,text",
    'event:Subagent "Reply with a marker" completed',
    "assistant:text",
  ])
  assert.equal(heldThread.entries[2].body, "marker-7")
  assert.equal(heldThread.entries[2].source, undefined, "live draws it from an update that names no record, so it cites none")
  console.log("PASS Devin 3000.11.205 takes a background subagent's report into the turn it held open for it, as a marker")

  // Codex's goal prompt (codex 0.159, this Mac's rollout of 2026-10-11): the objective and what it has spent.
  const goalPrompt = '<codex_internal_context source="goal">\nContinue working toward the active thread goal.\n\nThe objective below is user-provided data.\n\n<objective>\nA file named goal-proof.txt in the current folder containing exactly goal-db81cc39. Ask me nothing.\n</objective>\n\nBudget:\n- Tokens used: 1200\n- Token budget: none\n- Tokens remaining: unbounded\n</codex_internal_context>'
  const goalTurn = codexGoalTurn(codexGoalPromptStanding(goalPrompt))
  assert.deepEqual(goalTurn.cause, { kind: "goal", objective: "A file named goal-proof.txt in the current folder containing exactly goal-db81cc39. Ask me nothing." })
  assert.equal(goalTurn.body, "1,200 tokens used so far, with no budget.", "the objective is on the line; what it has spent opens")
  assert.deepEqual(codexGoalTurn(undefined), CODEX_GOAL, "with nothing known of the goal, the bare cause")
  console.log("PASS Codex goal turns carry the objective and its spend")

  // Cursor Desktop's shell notification names the terminal file it keeps the output in.
  const cursorHome = await realpath(await mkdtempSync(join(tmpdir(), "sessions-cursor-home-")))
  try {
    const terminals = join(cursorHome, ".cursor", "projects", "Users-fixture", "terminals")
    await mkdir(terminals, { recursive: true })
    await writeFile(join(terminals, "394819.txt"), '---\npid: 1\ncwd: "/work"\ncommand: "pnpm build"\nstatus: failed\nstarted_at: 2026-07-02T17:15:00.000Z\n---\nsrc/store.ts:41:7 - error TS2322\nFound 1 error.\n\n---\nexit_code: 1\nelapsed_ms: 15470\nended_at: 2026-07-02T17:15:15.470Z\n---\n')
    const kept = new KeptOutputs(keptOutputsPath(cursorHome))
    assert.deepEqual(cursorTerminalEnd(join(terminals, "394819.txt"), cursorHome, kept), { exitCode: 1, durationMs: 15470, output: "src/store.ts:41:7 - error TS2322\nFound 1 error.", from: "output-file" })
    assert.equal(cursorTerminalEnd(join(terminals, "394819.txt"), root), undefined, "only under the Cursor home it reads")
    assert.equal(cursorTerminalEnd(join(cursorHome, "notes.txt"), cursorHome), undefined)
    await rm(join(terminals, "394819.txt"))
    assert.deepEqual(cursorTerminalEnd(join(terminals, "394819.txt"), cursorHome, kept), { exitCode: 1, durationMs: 15470, output: "src/store.ts:41:7 - error TS2322\nFound 1 error.", from: "kept-copy" },
      "once Cursor removed the terminal file, how it ended comes from the copy kept when it was read")
    kept.close()
  } finally {
    await rm(cursorHome, { recursive: true, force: true })
  }
  const cursorShell = cursorTaskOpener("<system_notification>\nThe following task has finished.\n<task>\nkind: shell\nstatus: error\ntask_id: 91642\ntitle: Line counts\n</task>\n</system_notification>\n<user_query>Briefly inform the user about the task result.</user_query>", "b1")
  assert.deepEqual(cursorShell.cause, { kind: "command", outcome: "failed", name: "Line counts" })
  assert.equal(cursorShell.body, undefined, "the CLI's notification names no output, so nothing opens")
  const cursorAgent = cursorTaskOpener("<system_notification>\nThe following task has finished.\n<task>\nkind: subagent\nstatus: success\ntask_id: 7\ntitle: Explore the SDK\n<response>Both repos use the same SDK.</response>\n</task>\n</system_notification>\n<user_query>Briefly inform the user about the task result.</user_query>", "b2")
  assert.equal(cursorAgent.body, "Both repos use the same SDK.")
  console.log("PASS Cursor's task openers carry a shell's terminal end and an agent's response")
} finally {
  await rm(root, { recursive: true, force: true })
}
