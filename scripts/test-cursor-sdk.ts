import assert from "node:assert/strict"
import { CursorSdkProjection } from "../electron/providers/cursor/sdk/projection.ts"
import { CURSOR_SDK_DEFAULT_MODE, CURSOR_SDK_MODES, isCursorSdkModeId } from "../electron/providers/cursor/sdk/modes.ts"
import {
  SdkChildLineSchema,
  SdkRequestSchema,
  sdkMessageForWire,
  type JsonValue,
  type SdkDelta,
  type SdkMessage,
} from "../electron/providers/cursor/sdk/wire.ts"
import type { LiveUpdate } from "../electron/contracts/live-content.ts"

const run = { agent_id: "agent-1", run_id: "run-1" } as const

function assistant(text: string): SdkMessage {
  return { ...run, type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } }
}

function thinking(text: string, durationMs?: number): SdkMessage {
  const message: SdkMessage = { ...run, type: "thinking", text }
  if (durationMs !== undefined) message.thinking_duration_ms = durationMs
  return message
}

function textOf(updates: LiveUpdate[]): Map<string, string> {
  const blocks = new Map<string, string>()
  for (const update of updates) {
    if (update.kind !== "text" && update.kind !== "thinking") continue
    blocks.set(update.id, (blocks.get(update.id) ?? "") + update.text)
  }
  return blocks
}

// The exact order SDK 1.0.31 delivered on 2026-09-13: every chunk arrives
// once as a delta and once more as a message that echoes the same chunk.
{
  const projection = new CursorSdkProjection("t1")
  const updates: LiveUpdate[] = []
  const feed = (item: { delta: SdkDelta } | { message: SdkMessage }) => {
    updates.push(...("delta" in item ? projection.delta(item.delta) : projection.message(item.message)))
  }
  feed({ delta: { type: "thinking-delta", text: "Running `echo`" } })
  feed({ message: thinking("Running `echo`") })
  feed({ delta: { type: "thinking-delta", text: " in the shell." } })
  feed({ message: thinking(" in the shell.") })
  feed({ delta: { type: "thinking-completed" } })
  feed({ message: thinking("", 1236) })
  feed({
    message: {
      ...run,
      type: "tool_call",
      call_id: "tool-shell",
      name: "shell",
      status: "running",
      args: { command: "echo hello-mako", timeout: 30000 },
    },
  })
  feed({
    message: {
      ...run,
      type: "tool_call",
      call_id: "tool-shell",
      name: "shell",
      status: "completed",
      args: { command: "echo hello-mako", timeout: 30000 },
      result: { status: "success", value: { exitCode: 0, stdout: "hello-mako\n", stderr: "" } },
    },
  })
  feed({ delta: { type: "text-delta", text: "Done" } })
  feed({ message: assistant("Done") })
  feed({ delta: { type: "text-delta", text: "." } })
  feed({ message: assistant(".") })
  feed({ delta: { type: "turn-ended" } })

  const blocks = textOf(updates)
  assert.deepEqual(
    [...blocks.entries()],
    [
      ["t1:thinking:0", "Running `echo` in the shell."],
      ["t1:text:1", "Done."],
    ],
    "each chunk is appended exactly once and the reply stays one block"
  )
  assert.ok(updates.every((update) => !("replace" in update && update.replace)), "no block is replaced")
  const tool = updates.find((update) => update.kind === "tool")
  assert.ok(tool && tool.kind === "tool")
  assert.equal(tool.title, "echo hello-mako")
  const finished = updates.find((update) => update.kind === "tool-update")
  assert.ok(finished && finished.kind === "tool-update")
  assert.equal(finished.status, "completed")
  assert.equal(finished.output, "hello-mako\n")
}

// Search results read like `rg` output, not the SDK's nested JSON. Shapes
// from SDK 1.0.31: a `content` result whose hits may lack their line, a
// `files` result, a `count` result, and a glob with a truncation flag.
{
  const projection = new CursorSdkProjection("t-search")
  const search = (name: string, value: JsonValue): LiveUpdate[] =>
    projection.message({
      ...run,
      type: "tool_call",
      call_id: `${name}-1`,
      name,
      status: "completed",
      args: { pattern: "Agent" },
      result: { status: "success", value },
    })
  const output = (updates: LiveUpdate[]) => {
    const finished = updates.find((update) => update.kind === "tool-update")
    return finished?.kind === "tool-update" ? finished.output : undefined
  }
  assert.equal(
    output(
      search("grep", {
        workspaceResults: {
          "/w": {
            type: "content",
            output: {
              matches: [
                { file: "./probe.mjs", lineNumber: 3, line: "import { Agent }" },
                { file: "./fold.mjs" },
              ],
              totalMatches: 5,
            },
          },
          "/other": { type: "files", output: { files: ["src/a.ts"], count: 1 } },
          "/third": { type: "count", output: { counts: [{ file: "src/b.ts", count: 4 }], total: 4 } },
        },
      })
    ),
    "./probe.mjs:3: import { Agent }\n./fold.mjs\n… 5 matches in all\nsrc/a.ts\nsrc/b.ts: 4"
  )
  assert.equal(output(search("grep", { workspaceResults: {} })), "No matches")
  assert.equal(
    output(search("glob", { files: ["./a.mjs", "./b.mjs"], totalFiles: 40, clientTruncated: true })),
    "./a.mjs\n./b.mjs\n… 40 files in all"
  )
}

// A message stream with no deltas (an SDK that stops streaming, or a
// replayed run) still produces the whole reply.
{
  const projection = new CursorSdkProjection("t2")
  const updates = [...projection.message(assistant("Hello")), ...projection.message(assistant(" world"))]
  assert.deepEqual([...textOf(updates).entries()], [["t2:text:0", "Hello world"]])
}

// Deltas alone do too, and a tool between two paragraphs splits them.
{
  const projection = new CursorSdkProjection("t3")
  const updates: LiveUpdate[] = [
    ...projection.delta({ type: "text-delta", text: "First" }),
    ...projection.message({
      ...run,
      type: "tool_call",
      call_id: "tool-read",
      name: "read",
      status: "running",
      args: { path: "/repo/a.ts" },
    }),
    ...projection.delta({ type: "text-delta", text: "Second" }),
  ]
  assert.deepEqual(
    [...textOf(updates).entries()],
    [
      ["t3:text:0", "First"],
      ["t3:text:1", "Second"],
    ]
  )
}

// A plan tool's arguments stream in; each growth repaints the plan and the
// final plan carries the completed arguments.
{
  const projection = new CursorSdkProjection("t4")
  const running = (todos: { content: string; status: string }[]): SdkMessage => ({
    ...run,
    type: "tool_call",
    call_id: "tool-todos",
    name: "updateTodos",
    status: "running",
    args: { todos },
  })
  const first = projection.message(running([{ content: "Run echo", status: "completed" }]))
  const plansAtStart = first.filter((update) => update.kind === "plan")
  assert.equal(plansAtStart.length, 1)
  assert.equal(projection.message(running([{ content: "Run echo", status: "completed" }])).length, 0, "unchanged args repaint nothing")
  const grown = projection.message(
    running([
      { content: "Run echo", status: "completed" },
      { content: "Reply", status: "in_progress" },
    ])
  )
  assert.equal(grown.length, 1)
  assert.ok(grown[0].kind === "plan" && grown[0].entries.length === 2)
  const done = projection.message({
    ...run,
    type: "tool_call",
    call_id: "tool-todos",
    name: "updateTodos",
    status: "completed",
    args: {
      todos: [
        { content: "Run echo", status: "completed" },
        { content: "Reply", status: "completed" },
      ],
    },
    result: { status: "success" },
  })
  const finalPlan = done.find((update) => update.kind === "plan")
  assert.ok(finalPlan && finalPlan.kind === "plan")
  assert.deepEqual(
    finalPlan.entries.map((entry) => entry.status),
    ["completed", "completed"]
  )
}

// A call the SDK refuses before it runs (Auto review, a hook's deny) emits
// one `running` event and no terminal one; the turn's end closes the row so
// it does not spin forever, and a completed call is left alone.
{
  const projection = new CursorSdkProjection("t5")
  const shell = (id: string, status: "running" | "completed"): SdkMessage => {
    const message: SdkMessage = {
      ...run,
      type: "tool_call",
      call_id: id,
      name: "shell",
      status,
      args: { command: "git push --force origin main" },
    }
    if (status === "completed") message.result = { status: "success", value: { exitCode: 0 } }
    return message
  }
  projection.message(shell("refused", "running"))
  projection.message(shell("ran", "running"))
  projection.message(shell("ran", "completed"))
  const settled = projection.finish("finished", "Cursor did not run this call.")
  assert.deepEqual(settled, [
    { kind: "tool-update", id: "refused", status: "failed", output: "Cursor did not run this call." },
  ])
  assert.deepEqual(projection.finish("finished", "again"), [], "a second finish has nothing left to close")

  const stopped = new CursorSdkProjection("t6")
  stopped.message(shell("open", "running"))
  assert.deepEqual(stopped.finish("cancelled", "Stopped before this call finished."), [
    { kind: "tool-update", id: "open", status: "cancelled", output: "Stopped before this call finished." },
  ])
}

// Modes: Cursor is Agent on the full tier and nothing else. Neither the SDK's
// refusing classifier nor Cursor's old ACP ids are modes here.
{
  assert.deepEqual(
    CURSOR_SDK_MODES.map((mode) => [mode.id, mode.name, mode.access, mode.enforcement]),
    [["full-access", "Agent", "full", "provider"]]
  )
  assert.equal(CURSOR_SDK_DEFAULT_MODE, "full-access")
  assert.ok(isCursorSdkModeId("full-access"))
  assert.equal(isCursorSdkModeId("agent"), false, "Cursor ACP's asking mode id is not an SDK mode")
  assert.equal(isCursorSdkModeId("auto-review"), false, "the refusing classifier is not offered")
  assert.equal(isCursorSdkModeId("plan"), false)
  assert.equal(isCursorSdkModeId("read-only"), false)
}

// Wire: the child's lines parse, unknown message types are refused rather
// than passed through, and requests carry their method-specific params.
{
  const parsed = SdkChildLineSchema.safeParse({
    event: "message",
    turn: "t",
    message: assistant("hi"),
  })
  assert.ok(parsed.success)
  const unknown = SdkChildLineSchema.safeParse({ event: "message", turn: "t", message: { ...run, type: "novel" } })
  assert.equal(unknown.success, false)
  const request = SdkRequestSchema.safeParse({
    id: 1,
    method: "send",
    params: { turn: "t", text: "hello", model: { id: "composer-2.5" } },
  })
  assert.ok(request.success)
  const noTurn = SdkRequestSchema.safeParse({
    id: 2,
    method: "send",
    params: { text: "hello", model: { id: "composer-2.5" } },
  })
  assert.equal(noTurn.success, false)

  // The child validates what the wire carries, not the SDK's live object: a
  // grep result's `line: undefined` (SDK 1.0.31) is not JSON, but the line the
  // child writes has no such field. Refusing it dropped the completed message
  // and left the grep row running for good.
  const grepHit = { file: "probe.mjs", line: undefined, text: "import { Agent }" }
  const liveGrep = {
    ...run,
    type: "tool_call",
    call_id: "grep-1",
    name: "grep",
    status: "completed",
    args: { pattern: "Agent" },
    result: { status: "success", value: { workspaceResults: { "/w": { output: { matches: [grepHit] } } } } },
  }
  const completedGrep = sdkMessageForWire(liveGrep)
  assert.ok("message" in completedGrep, "a result with an undefined field is carried once serialized")
  assert.equal(completedGrep.message.type === "tool_call" && completedGrep.message.status, "completed")
  const novel = sdkMessageForWire({ ...run, type: "novel" })
  assert.ok("refused" in novel && novel.refused.length > 0, "an unknown message type is still refused, by name")
}

console.log("cursor sdk projection, modes and wire ok")
