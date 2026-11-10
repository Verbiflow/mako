// What a tool row says without being opened: Mako's own tools in their own
// words, on the desk and the phone alike; a failed command's exit code on each
// harness's recorded shape; a read's range and an edit's size from their
// arguments; and a turn's failed count that leaves out what a retry fixed.
import assert from "node:assert/strict"
import { commandExitCode, identifyTool, MAKO_TOOL_NAMES, makoToolWords, toolArguments, toolFacts, toolPhrase, type ToolArguments } from "@mako/sessions/tool-identity"
import { codexCommandOutput } from "@mako/sessions/codex-presentation"
import { CursorSdkProjection } from "@mako/sessions/cursor-sdk-content"
import { reduceLiveUpdates } from "@mako/sessions/live-content"
import type { Entry } from "@mako/sessions/entries"
import { entriesToMessages } from "../src/lib/entry-messages.ts"
import { changedLinesNote, failedExitCode, makoCallWords, pairTools, summarizeToolWork, unfixedFailures } from "../src/lib/tools.ts"
import type { ToolCall } from "../src/extend/slots.ts"
import { stepWords } from "../src/web-client/steps-words.ts"
import { MAKO_CALLS } from "../src/dev/tool-words-fixture.ts"

/** Each tool of the `mako` server: its name in words, while it runs, and once it answered. */
const WORDS: readonly { tool: string; args: ToolArguments; answer?: string; label: string; running: string; done: string; link?: string }[] = [
  { tool: "agents_start", args: { name: "own-words", harness: "codex" }, answer: '{"name":"own-words","state":"starting"}', label: "Start fin:own-words on Codex", running: "Starting fin:own-words on Codex", done: "Started fin:own-words on Codex" },
  { tool: "agents_start", args: { title: "Map the rail's search" }, answer: '{"name":"rail-search","state":"starting"}', label: "Start fin:rail-search", running: "Starting Map the rail's search", done: "Started fin:rail-search" },
  { tool: "agents_start", args: { brief: { objective: "Map the rail's search path and say where helpers fall out." } }, label: "Start Map the rail's search path and…", running: "Starting Map the rail's search path and…", done: "Started Map the rail's search path and…" },
  { tool: "agents_start", args: { name: "fin:later", harness: "grok" }, answer: '{"name":"later","state":"queued","why":"this Mac is busy"}', label: "Start fin:later on Grok", running: "Starting fin:later on Grok", done: "Queued fin:later on Grok" },
  { tool: "agents_link", args: { session: "6b1e", harness: "claude", name: "review" }, label: "Link fin:review", running: "Linking fin:review", done: "Linked fin:review" },
  { tool: "agents_link", args: { session: "6b1e", harness: "claude" }, label: "Link a Claude run", running: "Linking a Claude run", done: "Linked a Claude run" },
  { tool: "agents_list", args: {}, answer: '{"children":[{"name":"a"},{"name":"b"},{"name":"c"}]}', label: "Read Fins", running: "Reading Fins", done: "Read 3 Fins" },
  { tool: "agents_list", args: { scope: "tree" }, answer: '{"children":[{"name":"a"}]}', label: "Read Fins", running: "Reading Fins", done: "Read 1 Fin" },
  { tool: "agents_list", args: { scope: "crew" }, label: "Read the crew", running: "Reading the crew", done: "Read the crew" },
  { tool: "agents_list", args: { scope: "apexes" }, label: "Read other Apexes", running: "Reading other Apexes", done: "Read other Apexes" },
  { tool: "agents_read", args: { child: "fin:own-words" }, label: "Read fin:own-words's report", running: "Reading fin:own-words's report", done: "Read fin:own-words's report" },
  { tool: "agents_read", args: { child: "own-words", view: "transcript" }, label: "Read fin:own-words's transcript", running: "Reading fin:own-words's transcript", done: "Read fin:own-words's transcript" },
  { tool: "agents_read", args: { child: "0a1b2c3d-1111-4222-8333-444455556666" }, answer: '{"name":"by-id","text":"…"}', label: "Read fin:by-id's report", running: "Reading a Fin's report", done: "Read fin:by-id's report" },
  { tool: "agents_report", args: { status: "done", artifacts: [{ kind: "pull-request", ref: "https://github.com/acme/app/pull/374" }] }, label: "Report done · PR #374", running: "Reporting done · PR #374", done: "Reported done · PR #374", link: "https://github.com/acme/app/pull/374" },
  { tool: "agents_report", args: { status: "needs-input", question: "Which base?" }, label: "Report a question", running: "Reporting a question", done: "Reported a question" },
  { tool: "agents_answer", args: { to: "fin:own-words", answer: "Squash it" }, label: "Answer fin:own-words", running: "Answering fin:own-words", done: "Answered fin:own-words: Squash it" },
  { tool: "agents_answer", args: { to: "fin:own-words", person: true }, label: "Leave fin:own-words's question to you", running: "Leaving fin:own-words's question to you", done: "Left fin:own-words's question to you" },
  { tool: "agents_answer", args: { to: "fin:own-words", allow: true }, label: "Allow fin:own-words's request", running: "Allowing fin:own-words's request", done: "Allowed fin:own-words's request" },
  { tool: "agents_answer", args: { to: "fin:own-words", allow: false, answer: "Not on main" }, label: "Refuse fin:own-words's request", running: "Refusing fin:own-words's request", done: "Refused fin:own-words's request" },
  { tool: "agents_send", args: { to: "fin:own-words", forward: true }, label: "Message fin:own-words", running: "Messaging fin:own-words", done: "Messaged fin:own-words" },
  { tool: "agents_send", args: { to: "apex:Release notes", text: "Which branch?" }, label: "Message apex:Release notes", running: "Messaging apex:Release notes", done: "Messaged apex:Release notes" },
  { tool: "agents_move", args: { child: "own-words", harness: "claude" }, label: "Move fin:own-words to Claude", running: "Moving fin:own-words to Claude", done: "Moved fin:own-words to Claude" },
  { tool: "agents_move", args: { all: true, harness: "codex" }, answer: '{"moved":[{"name":"a"},{"name":"b"}]}', label: "Move all Fins to Codex", running: "Moving all Fins to Codex", done: "Moved 2 Fins to Codex" },
  { tool: "agents_stop", args: { child: "rail-search" }, label: "Stop fin:rail-search", running: "Stopping fin:rail-search", done: "Stopped fin:rail-search" },
  { tool: "agents_stop", args: { child: "all" }, answer: '{"stopped":["a","b"]}', label: "Stop all Fins", running: "Stopping all Fins", done: "Stopped 2 Fins" },
  { tool: "agents_stop", args: { child: "rail-search" }, answer: '{"stopped":[],"pending":[{"name":"rail-search","why":"Studio can\'t be reached now."}]}', label: "Stop fin:rail-search", running: "Stopping fin:rail-search", done: "Stop kept for fin:rail-search" },
  { tool: "agents_wait", args: { children: ["a", "b"] }, label: "Wait on 2 Fins", running: "Waiting on 2 Fins", done: "Waited on 2 Fins" },
  { tool: "agents_wait", args: { children: ["a"] }, label: "Wait on fin:a", running: "Waiting on fin:a", done: "Waited on fin:a" },
  { tool: "agents_wait", args: {}, label: "Wait on all Fins", running: "Waiting on all Fins", done: "Waited on all Fins" },
  { tool: "pull_request_open", args: { title: "Words" }, answer: "Opened #374 into main: https://github.com/acme/app/pull/374", label: "Open the PR", running: "Opening the PR", done: "Opened PR #374", link: "https://github.com/acme/app/pull/374" },
  { tool: "pull_request_open", args: { repository: "api" }, answer: "api: #12 was already open; pushed 2 commits: https://github.com/acme/api/pull/12", label: "Open the PR in api", running: "Opening the PR in api", done: "Updated PR #12 in api", link: "https://github.com/acme/api/pull/12" },
  { tool: "pull_request_status", args: {}, answer: "pullRequest:\n  number: 374\n  url: https://github.com/acme/app/pull/374", label: "Read the PR", running: "Reading the PR", done: "Read PR #374", link: "https://github.com/acme/app/pull/374" },
  { tool: "pull_request_status", args: {}, answer: "branch: mako/x\nopening:\n  base: main", label: "Read the PR", running: "Reading the PR", done: "Read the PR's status" },
  { tool: "pull_request_merge", args: {}, answer: "Merged #374 into main (squash). The branch is kept.", label: "Merge the PR", running: "Merging the PR", done: "Merged PR #374" },
  { tool: "pull_request_merge", args: {}, answer: "Asked GitHub to merge #374 into main (squash). The branch is kept.", label: "Merge the PR", running: "Merging the PR", done: "Queued the merge of PR #374" },
  { tool: "pull_request_rerun", args: {}, answer: "Re-running the failed jobs of 1 GitHub Actions run on the pushed commit.", label: "Rerun checks", running: "Rerunning checks", done: "Reran checks" },
  { tool: "pull_request_rerun", args: {}, answer: "No GitHub Actions run on the pushed commit has failed, so nothing was re-run.", label: "Rerun checks", running: "Rerunning checks", done: "Found no failed checks" },
  { tool: "thread_history", args: { action: "turns" }, label: "Read earlier turns", running: "Reading earlier turns", done: "Read earlier turns" },
  { tool: "thread_history", args: { action: "read", turns: "40-60" }, label: "Read turns 40-60", running: "Reading turns 40-60", done: "Read turns 40-60" },
  { tool: "thread_history", args: { action: "search", query: "exit code" }, label: "Search earlier turns for exit code", running: "Searching earlier turns for exit code", done: "Searched earlier turns for exit code" },
  { tool: "thread_history", args: { action: "search", thread: "tree", query: "exit code" }, label: "Search the whole tree for exit code", running: "Searching the whole tree for exit code", done: "Searched the whole tree for exit code" },
  { tool: "thread_history", args: { action: "export", thread: "thread:codex:1" }, label: "Export a referenced thread", running: "Exporting a referenced thread", done: "Exported a referenced thread" },
  { tool: "thread_history", args: { action: "read", thread: "thread:codex:1" }, label: "Read a referenced thread", running: "Reading a referenced thread", done: "Read a referenced thread" },
  { tool: "show", args: { files: [{ path: "/work/shots/rows-after.png" }] }, label: "Show rows-after.png", running: "Showing rows-after.png", done: "Showed rows-after.png" },
  { tool: "show", args: { files: [{ path: "a.png" }, { path: "b.png" }, { path: "c.png" }, { path: "d.png" }] }, label: "Show a.png, b.png and 2 more", running: "Showing a.png, b.png and 2 more", done: "Showed a.png, b.png and 2 more" },
  { tool: "worktree_status", args: {}, label: "Read the worktree", running: "Reading the worktree", done: "Read the worktree" },
  { tool: "worktree_move", args: {}, label: "Move to the worktree", running: "Moving to the worktree", done: "Moved to the worktree" },
  { tool: "worktree_bring", args: { entries: [{ path: "node_modules" }] }, label: "Bring node_modules", running: "Bringing node_modules", done: "Brought node_modules" },
  { tool: "worktree_bring", args: {}, label: "Bring ignored files", running: "Bringing ignored files", done: "Brought ignored files" },
  { tool: "worktree_update", args: {}, label: "Update from main", running: "Updating from main", done: "Updated from main" },
  { tool: "worktree_merge", args: {}, label: "Merge the worktree", running: "Merging the worktree", done: "Merged the worktree" },
  { tool: "worktree_remove", args: {}, label: "Remove the worktree", running: "Removing the worktree", done: "Removed the worktree" },
  { tool: "recipe_guide", args: {}, label: "Read the recipe guide", running: "Reading the recipe guide", done: "Read the recipe guide" },
  { tool: "recipe_save", args: { reason: "Run the API on its own port" }, label: "Save a recipe draft", running: "Saving a recipe draft", done: "Saved a recipe draft" },
  { tool: "recipe_save", args: { version: 3, reason: "Back to 3" }, label: "Save version 3 as a draft", running: "Saving version 3 as a draft", done: "Saved version 3 as a draft" },
  { tool: "recipe_publish", args: {}, label: "Publish the recipe", running: "Publishing the recipe", done: "Published the recipe" },
  { tool: "app_status", args: {}, label: "Read the app's status", running: "Reading the app's status", done: "Read the app's status" },
  { tool: "app_start", args: { processes: ["web", "api"] }, label: "Start the app (web, api)", running: "Starting the app (web, api)", done: "Started the app (web, api)" },
  { tool: "app_start", args: { tier: "web" }, label: "Start the app (web)", running: "Starting the app (web)", done: "Started the app (web)" },
  { tool: "app_stop", args: {}, label: "Stop the app", running: "Stopping the app", done: "Stopped the app" },
  { tool: "app_restart", args: { target: "desktop" }, label: "Restart the app (desktop)", running: "Restarting the app (desktop)", done: "Restarted the app (desktop)" },
  { tool: "app_logs", args: { check: "quick", step: "lint" }, label: "Read app logs (quick · lint)", running: "Reading app logs (quick · lint)", done: "Read app logs (quick · lint)" },
  { tool: "app_check", args: { tier: "full" }, label: "Check the app (full)", running: "Checking the app (full)", done: "Checked the app (full)" },
  { tool: "app_probe", args: {}, label: "Probe the app", running: "Probing the app", done: "Probed the app" },
  { tool: "app_own_packages", args: {}, label: "Unlink packages", running: "Unlinking packages", done: "Unlinked packages" },
  { tool: "port_holder", args: { port: 5173 }, label: "Check port 5173", running: "Checking port 5173", done: "Checked port 5173" },
  { tool: "thread_move", args: { to: "cloud" }, label: "Move this Thread to the cloud", running: "Moving this Thread to the cloud", done: "Moved this Thread to the cloud" },
  { tool: "thread", args: { action: "rename", title: "Ship the importer" }, label: "Rename this Thread to Ship the importer", running: "Renaming this Thread to Ship the importer", done: "Renamed this Thread to Ship the importer" },
  { tool: "automation", args: { action: "list" }, label: "List the automations", running: "Listing the automations", done: "Listed the automations" },
  { tool: "automation", args: { action: "run", id: "nightly" }, label: "Run the automation nightly", running: "Running the automation nightly", done: "Ran the automation nightly" },
  { tool: "harness", args: { action: "install", harness: "codex" }, label: "Install codex", running: "Installing codex", done: "Installed codex" },
  { tool: "harness", args: { action: "read" }, label: "Read the harnesses' versions", running: "Reading the harnesses' versions", done: "Read the harnesses' versions" },
  { tool: "settings", args: { action: "read" }, label: "Read Settings", running: "Reading Settings", done: "Read Settings" },
  { tool: "settings", args: { action: "set", setting: "harness-order" }, label: "Change the setting harness-order", running: "Changing the setting harness-order", done: "Changed the setting harness-order" },
  { tool: "thread", args: { action: "archive" }, label: "Archive this Thread", running: "Archiving this Thread", done: "Archived this Thread" },
  { tool: "thread", args: { action: "restore" }, label: "Restore this Thread", running: "Restoring this Thread", done: "Restored this Thread" },
  { tool: "workspace_status", args: {}, label: "Read the worktree", running: "Reading the worktree", done: "Read the worktree" },
  { tool: "agents_frobnicate", args: {}, label: "Agents frobnicate", running: "Agents frobnicate", done: "Agents frobnicate" },
]

for (const expected of WORDS) {
  const said = makoToolWords(expected.tool, expected.args, expected.answer)
  const name = `${expected.tool} ${JSON.stringify(expected.args)}`
  assert.equal(said.label, expected.label, `${name}: its name`)
  assert.equal(makoToolWords(expected.tool, expected.args).running, expected.running, `${name}: while it runs, before any answer`)
  assert.equal(said.done, expected.done, `${name}: once it answered`)
  assert.equal(said.link, expected.link, `${name}: its link`)
}
for (const tool of MAKO_TOOL_NAMES) assert.ok(WORDS.some((words) => words.tool === tool), `${tool} has no words checked here`)
for (const tool of MAKO_TOOL_NAMES) assert.ok(MAKO_CALLS.some((call) => call.tool === tool), `${tool} has no row on the fixture page (tool-words-fixture.ts)`)
// A refusal's line comes before its JSON; the name it carries still names the Fin.
assert.equal(makoToolWords("agents_read", { child: "0a1b2c3d-1111-4222-8333-444455556666" }, 'refused: not yours\n{"refused":"not yours","name":"x"}').done, "Read fin:x's report")
// A surface's name for a harness, where it has one; its id raised where it has none.
assert.equal(makoToolWords("agents_start", { name: "x", harness: "claude" }, undefined, (id) => (id === "claude" ? "Claude Code" : id)).running, "Starting fin:x on Claude Code")
assert.equal(makoToolWords("agents_start", { name: "x", harness: "devin" }, undefined, (id) => id).running, "Starting fin:x on Devin")
console.log(`tool words: ${WORDS.length} calls of the ${MAKO_TOOL_NAMES.length} Mako tools`)

// Every harness's way of calling a Mako tool resolves to the same words, without the server's tag.
for (const source of [
  { harness: "claude", name: "mcp__mako__agents_send", input: JSON.stringify({ to: "fin:x" }) },
  { harness: "codex", name: "mako.agents_send", input: JSON.stringify({ to: "fin:x" }) },
  { harness: "cursor", name: "CallDynamicTool", input: JSON.stringify({ namespace: "mako", toolName: "agents_send", arguments: { to: "fin:x" } }) },
  { harness: "cursor", name: "mcp", input: JSON.stringify({ providerIdentifier: "mako", toolName: "agents_send", args: { to: "fin:x" } }) },
  { harness: "grok", name: "use_tool", input: JSON.stringify({ tool_name: "mako__agents_send", tool_input: { to: "fin:x" } }) },
  { harness: "devin", name: "mako.agents_send", input: JSON.stringify({ to: "fin:x" }) },
  { harness: "opencode", name: "mako_agents_send", input: JSON.stringify({ to: "fin:x" }) },
]) {
  const identity = identifyTool(source)
  if (identity.server !== "mako") continue
  assert.equal(identity.label, "Message fin:x", `${source.harness} ${source.name}`)
  assert.equal(identity.running, "Messaging fin:x", `${source.harness} ${source.name}`)
  assert.equal(identity.done, "Messaged fin:x", `${source.harness} ${source.name}`)
  assert.equal(identity.target, undefined, `${source.harness} ${source.name}: the words hold the target`)
  assert.equal(toolPhrase(identity, true), "Messaging fin:x")
}

// The desk's row and the phone's step read the same words, the answer's included.
const rows = (entries: Entry[], running: boolean, provider = "claude") => pairTools(entriesToMessages(entries, { kind: "live", running, provider }).messages[0]!.blocks)
{
  const start: Entry = { type: "tool", id: "s", name: "mcp__mako__agents_start", input: JSON.stringify({ title: "Map the rail's search", harness: "codex" }), output: '{"name":"rail-search","state":"starting"}', status: "completed" }
  const settled = rows([start], false)[0]!
  assert.equal(makoCallWords(settled)?.done, "Started fin:rail-search on Codex")
  assert.equal(stepWords(settled, false), "started fin:rail-search on Codex")
  const running = rows([{ ...start, status: "pending", output: undefined }], true)[0]!
  assert.equal(stepWords(running, true), "starting Map the rail's search on Codex")
  const failed = rows([{ ...start, status: "failed", output: "refused: over its budget" }], false)[0]!
  assert.equal(stepWords(failed, false), "start Map the rail's search on Codex")
}
console.log("tool words: the desk and the phone say the same")

// A failed command's exit code, as each harness records it.
{
  // Claude Code's answer opens with it (a recorded Bash result).
  assert.equal(commandExitCode("claude", "Bash", "Exit code 127\n(eval):1: command not found: nmp"), 127)
  // Codex: an exit beside an empty output reads `Exited with code 1` (its typed item), or its model's header in a bare rollout.
  assert.equal(commandExitCode("codex", "exec_command", codexCommandOutput("", 1)), 1)
  assert.equal(commandExitCode("codex", "exec_command", "Chunk ID: 7a\nWall time: 0.0 seconds\nProcess exited with code 2\nOriginal token count: 3\nOutput:\nno"), 2)
  assert.equal(commandExitCode("codex", "exec_command", "cat: missing.md: No such file or directory"), undefined)
  // Cursor's SDK: its recorded shell call (native-decoding/cursor/pairs/failing-shell-output), through its projection.
  const projection = new CursorSdkProjection("exit")
  const updates = projection.message({ type: "tool_call", agent_id: "agent", run_id: "run", call_id: "cat", name: "shell", status: "completed", args: { command: "cat notes.md missing.md", timeout: 30000 }, result: { status: "success", value: { exitCode: 1, signal: "", stdout: "The release ships on Friday.\nQA signs off on Thursday.\n", stderr: "cat: missing.md: No such file or directory\n", executionTime: 415 } } })
  const cursor = pairTools(entriesToMessages(reduceLiveUpdates([], updates), { kind: "live", running: false, provider: "cursor" }).messages[0]!.blocks)[0]!
  assert.equal(commandExitCode("cursor", cursor.name, cursor.result), 1)
  // Cursor keeps it completed; its row still says how it exited, quietly.
  assert.equal(cursor.isError, undefined)
  assert.equal(failedExitCode(cursor, "cursor"), 1)
  assert.equal(failedExitCode({ ...cursor, exitCode: undefined }, "cursor"), 1, "from its answer's text alone")
  // OpenCode closes with it (native-decoding/opencode/pairs/failing-shell), Grok's words for the result end with it.
  assert.equal(commandExitCode("opencode", "bash", "Exited with code 1"), 1)
  assert.equal(commandExitCode("grok", "run_terminal_command", "exit: 1\n"), 1)
  // Devin states it only beside the answer (ACP's `terminal_exit`): the call's command effect carries it.
  assert.equal(commandExitCode("devin", "exec", "grep: notes.md: No such file"), undefined)
  const devin = rows([{ type: "tool", id: "d", name: "exec", input: JSON.stringify({ command: "grep -q Monday notes.md" }), output: "", status: "failed", effects: [{ kind: "command", command: "grep -q Monday notes.md", exitCode: 1 }] }], false, "devin")[0]!
  assert.equal(failedExitCode(devin, "devin"), 1)
  // Only a failed command says it.
  const passed = rows([{ type: "tool", id: "p", name: "Bash", input: JSON.stringify({ command: "true" }), output: "Exit code 0", status: "completed" }], false)[0]!
  assert.equal(failedExitCode(passed, "claude"), undefined)
}
console.log("tool words: every harness's exit code")

// A read's range, from each harness's arguments.
{
  const range = (harness: string, name: string, args: ToolArguments) => toolFacts(identifyTool({ harness, name, input: JSON.stringify(args) }), args, JSON.stringify(args)).range
  assert.equal(range("claude", "Read", { file_path: "/a.ts", offset: 120, limit: 61 }), ":120–180")
  assert.equal(range("claude", "Read", { file_path: "/a.ts", offset: 120 }), ":120+")
  assert.equal(range("claude", "Read", { file_path: "/a.ts" }), undefined)
  assert.equal(range("cursor", "Read", { path: "a.ts", offset: 40, limit: 20 }), ":40–59")
  assert.equal(range("cursor", "Read", { path: "a.ts", offset: -20 }), undefined)
  assert.equal(range("grok", "read_file", { target_file: "src/a.ts", limit: 20 }), ":1–20")
  assert.equal(range("opencode", "read", { filePath: "a.ts", offset: 0, limit: 50 }), ":1–50")
  assert.equal(range("devin", "read", { file_path: "a.ts", start_line: 10, end_line: 30 }), ":10–30")
  assert.equal(range("codex", "read_file", { file_path: "a.ts", offset: 5, limit: 1 }), ":5–5")
  assert.equal(range("claude", "Read", { file_path: "/a.ts", view_range: [3, -1] }), ":3+")
}
console.log("tool words: every harness's read range")

// An edit's and a write's lines, from what their arguments hold.
{
  const lines = (harness: string, name: string, input: string) => {
    const identity = identifyTool({ harness, name, input })
    const read = toolFacts(identity, toolArguments(input), input)
    return [changedLinesNote(read), read.files, read.files ? `${read.files} files` : identity.target]
  }
  const json = JSON.stringify
  assert.deepEqual(lines("claude", "Edit", json({ file_path: "/a.ts", old_string: "a\nb\nc", new_string: "a\nB\nC\nD" })), ["+3 −2", undefined, "/a.ts"])
  assert.deepEqual(lines("claude", "MultiEdit", json({ file_path: "/a.ts", edits: [{ old_string: "x", new_string: "y" }, { old_string: "p\nq", new_string: "p" }] })), ["+1 −2", undefined, "/a.ts"])
  assert.deepEqual(lines("claude", "Write", json({ file_path: "/a.ts", content: "one\ntwo\n" })), ["+2", undefined, "/a.ts"])
  assert.deepEqual(lines("cursor", "StrReplace", json({ path: "a.ts", old_string: "a", new_string: "b" })), ["+1 −1", undefined, "a.ts"])
  assert.deepEqual(lines("cursor", "Write", json({ path: "a.ts", contents: "x" })), ["+1", undefined, "a.ts"])
  assert.deepEqual(lines("opencode", "edit", json({ filePath: "a.ts", oldString: "a\nb", newString: "a\nb\nc" })), ["+1", undefined, "a.ts"])
  assert.deepEqual(lines("grok", "search_replace", json({ file_path: "a.ts", old_string: "gone", new_string: "" })), ["−1", undefined, "a.ts"])
  const patch = "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** Add File: src/b.ts\n+one\n+two\n*** Delete File: src/c.ts\n*** End Patch"
  assert.deepEqual(lines("codex", "apply_patch", patch), ["+3 −1", 3, "3 files"])
  assert.deepEqual(lines("cursor", "ApplyPatch", "*** Begin Patch\n*** Update File: src/b.ts\n@@\n-a\n+b\n*** End Patch"), ["+1 −1", undefined, "src/b.ts"])
  assert.deepEqual(lines("opencode", "patch", json({ patchText: "*** Begin Patch\n*** Add File: notes.md\n+hi\n*** End Patch" })), ["+1", undefined, "notes.md"])
  assert.deepEqual(lines("devin", "edit", json({ file_path: "a.ts", old_string: "a", new_string: "a" })), [undefined, undefined, "a.ts"])
  const unified = "--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n--- a/y.ts\n+++ b/y.ts\n@@ -1 +1,2 @@\n a\n+c"
  assert.deepEqual(lines("claude", "apply_patch", json({ patch: unified })), ["+2 −1", 2, "2 files"])
  assert.equal(stepWords(rows([{ type: "tool", id: "w", name: "Write", input: json({ file_path: "/a.ts", content: "x\ny" }), output: "ok", status: "completed" }], false)[0]!, false), "wrote /a.ts +2")
  assert.equal(stepWords(rows([{ type: "tool", id: "p", name: "apply_patch", input: patch, output: "ok", status: "completed" }], false)[0]!, false), "edited 3 files +3 −1")
}
console.log("tool words: every harness's edit size")

// A failure a later identical call fixed isn't still wrong; one no call fixed is.
{
  const call = (id: string, command: string, isError: boolean, extra: Partial<ToolCall> = {}): ToolCall => ({
    id, name: "Bash", pending: false, isError, arguments: JSON.stringify({ command }), tool: identifyTool({ harness: "claude", name: "Bash", input: JSON.stringify({ command }) }), ...extra,
  })
  assert.equal(unfixedFailures([call("1", "npm run lint", true), call("2", "npm run lint", false)]), 0, "a retry that passed fixes it")
  assert.equal(unfixedFailures([call("1", "npm run lint", false), call("2", "npm run lint", true)]), 1, "a pass before the failure fixes nothing")
  assert.equal(unfixedFailures([call("1", "npm run lint", true), call("2", "npm run lint --fix", false)]), 1, "another command fixes nothing")
  assert.equal(unfixedFailures([call("1", "npm test", true), call("2", "npm test", true), call("3", "npm test", false)]), 0, "both failures are fixed")
  assert.equal(unfixedFailures([call("1", "npm test", true), call("2", "npm test", false, { pending: true })]), 1, "a retry still running fixes nothing yet")
  assert.equal(unfixedFailures([call("1", "npm test", true), call("2", "npm test", false, { isCutOff: true })]), 1, "a retry cut off fixes nothing")
  const codex = (id: string, isError: boolean): ToolCall => {
    const input = JSON.stringify({ cmd: "/bin/zsh -lc 'npm test'" })
    return { id, name: "exec_command", pending: false, isError, arguments: input, tool: identifyTool({ harness: "codex", name: "exec_command", input }) }
  }
  assert.equal(unfixedFailures([call("1", "npm test", true), codex("2", false)]), 0, "the same command bare of its shell is the same call")
  const read = (id: string, args: ToolArguments, isError: boolean): ToolCall => {
    const input = JSON.stringify(args)
    return { id, name: "Read", pending: false, isError, arguments: input, tool: identifyTool({ harness: "claude", name: "Read", input }) }
  }
  assert.equal(unfixedFailures([read("1", { file_path: "/a.ts", limit: 5 }, true), read("2", { limit: 5, file_path: "/a.ts" }, false)]), 0, "the same arguments in another order")
  assert.equal(unfixedFailures([read("1", { file_path: "/a.ts" }, true), call("2", "cat /a.ts", false)]), 1, "another kind fixes nothing")
  const mako = (id: string, tool: string, isError: boolean): ToolCall => {
    const name = `mcp__mako__${tool}`
    return { id, name, pending: false, isError, arguments: "{}", tool: identifyTool({ harness: "claude", name, input: "{}" }) }
  }
  assert.equal(unfixedFailures([mako("1", "app_start", true), mako("2", "app_status", false)]), 1, "another tool of the same server fixes nothing")
  assert.equal(unfixedFailures([mako("1", "app_start", true), mako("2", "app_start", false)]), 0)
  // A pass of the same command in another folder fixes nothing: by the folder its arguments name, or the one its harness reported.
  const shell = (id: string, args: ToolArguments, isError: boolean, extra: Partial<ToolCall> = {}): ToolCall => {
    const input = JSON.stringify(args)
    return { id, name: "shell", pending: false, isError, arguments: input, tool: identifyTool({ harness: "cursor", name: "shell", input }), ...extra }
  }
  assert.equal(unfixedFailures([shell("1", { command: "npm test", workingDirectory: "/work/api" }, true), shell("2", { command: "npm test", workingDirectory: "/work/web" }, false)], "cursor"), 1, "another repository's pass fixes nothing")
  assert.equal(unfixedFailures([shell("1", { command: "npm test", workingDirectory: "/work/api" }, true), shell("2", { command: "npm test", workingDirectory: "/work/api" }, false)], "cursor"), 0, "the same folder's pass fixes it")
  assert.equal(unfixedFailures([shell("1", { command: "npm test", workingDirectory: "/work/api" }, true), shell("2", { command: "npm test" }, false)], "cursor"), 1, "a pass with no folder known fixes no failure with one")
  assert.equal(unfixedFailures([shell("1", { command: "npm test" }, true, { cwd: "/work/api" }), shell("2", { command: "npm test" }, false, { cwd: "/work/web" })], "cursor"), 1, "the folders the harness reported differ")
  assert.equal(unfixedFailures([call("1", "npm test", true, { cwd: "/work/api" }), call("2", "npm test", false, { cwd: "/work/api" })]), 0)
  assert.equal(unfixedFailures([shell("1", { command: "npm test", cwd: "/work/api" }, true), shell("2", { command: "npm test", cwd: "/work/web" }, false)]), 1, "a common folder key, with no harness named")
  // A retry its harness kept as completed but that exited other than 0 didn't succeed: by its command effect, or its answer's text.
  assert.equal(unfixedFailures([shell("1", { command: "npm test" }, true), shell("2", { command: "npm test" }, false, { exitCode: 1, result: "FAIL\nexit 1" })], "cursor"), 1, "a completed call that exited 1 fixes nothing")
  assert.equal(unfixedFailures([shell("1", { command: "npm test" }, true), shell("2", { command: "npm test" }, false, { result: "FAIL\nexit 1" })], "cursor"), 1, "nor by its text alone")
  assert.equal(unfixedFailures([shell("1", { command: "npm test" }, true), shell("2", { command: "npm test" }, false, { exitCode: 0, result: "ok" })], "cursor"), 0, "one that exited 0 fixes it")
  assert.equal(summarizeToolWork([shell("1", { command: "npm test" }, true), shell("2", { command: "npm test" }, false, { exitCode: 1 })], "cursor").failed, 1)
  const summary = summarizeToolWork([call("1", "npm run lint", true), call("2", "npm run lint", false), call("3", "npm test", true)])
  assert.equal(summary.failed, 1, "the folded summary counts what's still wrong")
  assert.equal(summary.commands, 3)
}
console.log("tool words: the failed count leaves out what a retry fixed")
