import assert from "node:assert/strict"
import { ORCHESTRATION_INSTRUCTIONS } from "@mako/host/contracts/agent-tools"
import { REPORT_FOLLOW_UP_INSTRUCTIONS } from "@mako/host/contracts/report-actions"
import { MAKO_INSTRUCTIONS } from "@mako/host/tools/conversation-mcp"

/*
 * The `mako` server's instructions reach every harness whole only while they fit the shortest cut a harness makes:
 * Claude Code shows server instructions up to 4,096 characters and drops the rest (code.claude.com/docs/en/mcp, "Tool
 * search for MCP server authors"). Past it, Claude agents never saw the second half, the Fins' rules among it. What
 * doesn't fit goes in the description of the tool it governs, which loads whole when the tool is used.
 */
const CLAUDE_INSTRUCTIONS_CUT = 4_096

assert.ok(MAKO_INSTRUCTIONS.length <= CLAUDE_INSTRUCTIONS_CUT, `MAKO_INSTRUCTIONS is ${MAKO_INSTRUCTIONS.length} characters; Claude cuts at ${CLAUDE_INSTRUCTIONS_CUT}. Move detail into the tool descriptions.`)
assert.ok(ORCHESTRATION_INSTRUCTIONS.length <= CLAUDE_INSTRUCTIONS_CUT, "mako mcp's instructions fit too")
// What must survive the cut, wherever it sits in the text.
for (const rule of [
  "worktree_move, never `git worktree add`",
  "never `gh pr merge`",
  "MAKO_NATIVE=1",
  "thread_history",
  "show:",
  "After starting, end your turn: reports wake you.",
  "`forward: true`",
  "`agents_move`",
  "call `agents_report`",
  REPORT_FOLLOW_UP_INSTRUCTIONS,
  "`waitingOn`",
  "never gh --watch",
  "`scope: apexes`",
  "thread_move: ",
  "That's this Thread going on elsewhere, not new work for a Fin",
  "port_holder",
  "never a server started by hand",
  "end your turn: Mako wakes you",
  "`decides`",
  // #827's reporting rules: what's ready for review or waits on someone is a result, and a turn ending on progress is one.
  "Ready for review, or waiting on your Apex or the person, is done with an `action`, never progress",
  "progress is for a turn that goes on",
  "a turn ending on progress nothing Mako watches will wake asks your Apex how to go on",
  "`mode: \"wait\"`",
  "If you poll gh yourself: at most once a minute per repository; after a 403/429 stop all GitHub calls until Retry-After.",
  "Never run an agent CLI with nohup",
  "wait: to wait on your Fins",
]) assert.ok(MAKO_INSTRUCTIONS.includes(rule), `the instructions say ${JSON.stringify(rule.slice(0, 60))}`)
// Each tool family on a line of its own that says what it's for: what a harness's tool search reads to find it.
const startsALine = (text: string) => MAKO_INSTRUCTIONS.split("\n").some((line) => line.startsWith(text))
assert.ok(MAKO_INSTRUCTIONS.startsWith("Mako's tools for the Thread this Session belongs to."), "it opens with what the server is for")
for (const family of ["worktree_*", "pull_request_*", "app_*", "thread_move", "thread_history", "port_holder", "wait"])
  assert.ok(startsALine(`${family}: `), `a line says what ${family} is for`)
// The words every tool uses, each defined on a line of its own.
for (const word of ["main checkout", "worktree", "checkout", "project folder", "app", "recipe"])
  assert.ok(startsALine(`- ${word}: `), `the instructions define "${word}"`)
process.stdout.write(`mako instructions: ${MAKO_INSTRUCTIONS.length} of ${CLAUDE_INSTRUCTIONS_CUT} characters, every rule inside the cut\n`)
