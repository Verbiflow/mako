import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ThreadEntry } from "@mako/sessions"
import type { JsonObject } from "../electron/codex-app-json.ts"
import { AcpDecoder } from "../electron/acp-decoder.ts"
import { grokAcpSource } from "../electron/providers/grok/acp.ts"
import { GrokProvider } from "../packages/sessions/src/providers/grok.ts"

// Record shapes as xai-org/grok-build 1.0.45 writes them (xai-grok-shell
// `session/storage`, `turn_completion`, `interrupted_turn`).
const home = await mkdtemp(join(tmpdir(), "mako-grok-store-"))
const workspace = join(home, ".grok", "sessions", "%2Fwork")
let clock = 0

const prompt = (text: string, promptIndex: number): JsonObject =>
  ({ sessionUpdate: "user_message_chunk", content: { type: "text", text }, _meta: { promptIndex } })
const reply = (text: string): JsonObject => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } })
const ended = (stop_reason: string, agent_result?: string): JsonObject =>
  ({ sessionUpdate: "turn_completed", stop_reason, ...agent_result && { agent_result } })
/** Updates Grok saves on its own method, as it saves its own kinds. */
const vendorUpdates = new WeakSet<JsonObject>()
const vendor = (update: JsonObject): JsonObject => (vendorUpdates.add(update), update)

async function session(id: string, updates: JsonObject[], summary: JsonObject = {}): Promise<string> {
  const dir = join(workspace, id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, "summary.json"), JSON.stringify({ info: { id, cwd: "/work" }, session_summary: id, ...summary }))
  const lines = updates.map((update) =>
    JSON.stringify({ timestamp: ++clock, method: vendorUpdates.has(update) ? "_x.ai/session/update" : "session/update", params: { sessionId: id, update } }))
  await writeFile(join(dir, "updates.jsonl"), `${lines.join("\n")}\n`)
  return join(dir, "updates.jsonl")
}

async function drawn(path: string): Promise<string[]> {
  const thread = await new GrokProvider(home).read(path)
  return (thread?.entries ?? []).map((entry: ThreadEntry) => {
    if (entry.kind === "user") return `user: ${entry.text}`
    if (entry.kind === "event") return `event: ${[entry.label, entry.detail, entry.body].filter(Boolean).join(" · ")}`
    return `assistant: ${entry.blocks.map((block) => block.type === "text" ? block.text : block.type === "tool" ? `${block.name}${block.error ? " failed" : ""}` : block.type).join(" ")}`
  })
}

try {
  // A rewind keeps the turns before its target, counted as Grok counts them:
  // its own turns and steering messages are not turns of their own.
  const rewound = await session("rewound", [
    prompt("first", 0), reply("one"), ended("end_turn"),
    { sessionUpdate: "user_message_chunk", content: { type: "text", text: "[model text]", _meta: { displayText: "also check the tests" } }, _meta: { modelId: "grok-4", interjection: true } },
    reply("checked"),
    { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Continue from where the task left off." }, _meta: { hostTurn: true, hideFromScrollback: true } },
    reply("the build passed"), ended("end_turn"),
    prompt("second", 1), reply("two"), ended("end_turn"),
    prompt("third", 2), reply("three"), ended("end_turn"),
    vendor({ sessionUpdate: "rewind_marker", target_prompt_index: 1 }),
    prompt("second again", 1), reply("two again"), ended("end_turn"),
    vendor({ sessionUpdate: "rewind_marker", target_prompt_index: 9 }),
  ])
  assert.deepEqual(await drawn(rewound), [
    "user: first",
    "assistant: one",
    "user: also check the tests",
    "assistant: checked",
    "event: A background task finished",
    "assistant: the build passed",
    "user: second again",
    "assistant: two again",
  ], "a rewind cuts at Grok's own count of turns; a target past the last turn keeps everything")
  console.log("PASS: Grok rewinds, steering and its own turns read as Grok replays them")

  const ignored = await session("ignored", [prompt("first", 0), reply("one"), { sessionUpdate: "rewind_marker", target_prompt_index: 0 }])
  assert.deepEqual(await drawn(ignored), ["user: first", "assistant: one"], "only Grok's own update method rewinds")

  const chunked = await session("chunked", [prompt("part one, ", 0), prompt("part two", 0), reply("ok"), prompt("next", 1)])
  assert.deepEqual(await drawn(chunked), ["user: part one, part two", "assistant: ok", "user: next"], "chunks of one prompt are one message")

  const ends = await session("ends", [
    prompt("a", 0), reply("partial"), ended("error", "Request failed: upstream returned 500"),
    prompt("b", 1), vendor({ sessionUpdate: "retry_state", type: "failed", error_type: "api", message: "upstream returned 500" }), ended("error", "upstream returned 500"),
    prompt("c", 2), ended("rate_limit", "Rate limited"),
    prompt("d", 3), reply("stopping"), ended("cancelled"),
    prompt("e", 4), ended("interrupted", "Grok stopped before this turn finished (the agent process exited or was restarted). Committed tool results were kept."),
    prompt("f", 5), reply("done"), ended("end_turn"),
  ])
  assert.deepEqual(await drawn(ends), [
    "user: a", "assistant: partial", "event: Turn failed · Request failed: upstream returned 500",
    "user: b", "event: Turn failed · Server error · upstream returned 500",
    "user: c", "event: Turn failed · Rate limited",
    "user: d", "assistant: stopping", "event: Interrupted",
    "user: e", "event: Turn failed · Grok stopped before this turn finished (the agent process exited or was restarted). Committed tool results were kept.",
    "user: f", "assistant: done",
  ], "a turn's end shows as Grok's viewer draws it, and a failure its retries already showed shows once")
  console.log("PASS: Grok's stop reasons read as failures, interruptions or nothing")

  const shell = (exit_code: number | null, status: string): JsonObject =>
    ({ sessionUpdate: "tool_call_update", toolCallId: `call_${exit_code}`, status, rawOutput: { type: "Bash", output: [], exit_code, command: "false", truncated: false } })
  const commands = await session("commands", [
    prompt("run", 0),
    { sessionUpdate: "tool_call", toolCallId: "call_1", title: "false", kind: "execute", status: "pending", rawInput: { command: "false" }, _meta: { "x.ai/tool": { name: "run_terminal_command" } } },
    shell(1, "in_progress"), shell(1, "completed"),
    { sessionUpdate: "tool_call", toolCallId: "call_0", title: "true", kind: "execute", status: "pending", rawInput: { command: "true" }, _meta: { "x.ai/tool": { name: "run_terminal_command" } } },
    shell(0, "completed"),
  ])
  assert.deepEqual(await drawn(commands), ["user: run", "assistant: run_terminal_command failed run_terminal_command"])
  const decoder = new AcpDecoder(grokAcpSource)
  // SAFETY: a `tool_call_update` in the shape grok 1.0.46 sends, which the SDK's schema admits.
  const status = (exit_code: number | null, state: string) => decoder.update({ sessionId: "s", update: shell(exit_code, state) as never })
    .flatMap((item) => item.kind === "update" && item.update.kind === "tool-update" ? [item.update.status] : [])
  assert.deepEqual([status(1, "completed"), status(1, "in_progress"), status(0, "completed"), status(null, "completed")], [["failed"], ["in_progress"], ["completed"], ["completed"]])
  console.log("PASS: a Grok shell command that exits non-zero is failed, live and saved")

  await session("subagent", [prompt("child", 0)], { session_kind: "subagent" })
  await session("subagent-fork", [prompt("child", 0)], { session_kind: "subagent_fork" })
  await session("hidden", [prompt("hidden", 0)], { hidden: true })
  await session("shown-subagent", [prompt("shown", 0)], { session_kind: "subagent", hidden: false })
  await session("fork", [prompt("fork", 0)], { session_kind: "fork", parent_session_id: "rewound" })
  const provider = new GrokProvider(home)
  const listed = (await Promise.all((await provider.discover()).map((file) => provider.peek(file)))).flatMap((ref) => ref ? [ref.title] : [])
  for (const id of ["subagent", "subagent-fork", "hidden"]) assert.ok(!listed.includes(id), `${id} is left out, as Grok's history leaves it out`)
  for (const id of ["shown-subagent", "fork", "rewound"]) assert.ok(listed.includes(id), `${id} is listed`)
  console.log("PASS: Grok's hidden sessions and subagents stay out of the list; forks stay in")
} finally {
  await rm(home, { recursive: true, force: true })
}
