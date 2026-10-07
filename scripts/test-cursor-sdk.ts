import assert from "node:assert/strict"
import {
  clip,
  compactionSummary,
  CursorSdkProjection,
  type CursorSdkDelta,
  type CursorSdkMessage,
} from "@mako/sessions/cursor-sdk-content"
import { CURSOR_SDK_DEFAULT_MODE, CURSOR_SDK_MODES, isCursorSdkModeId } from "../electron/providers/cursor/sdk/modes.ts"
import {
  SdkChildLineSchema,
  SdkRequestSchema,
  type JsonValue,
  type SdkEvent,
  type SdkMethod,
  type SdkResult,
  type SdkRunResult,
} from "../electron/providers/cursor/sdk/wire.ts"
import { MAX_STREAMED_TOOL_OUTPUT, reduceLiveUpdates, type LiveUpdate } from "@mako/sessions/live-content"
import { RETRIES_EXHAUSTED_STOP } from "../electron/contracts/providers-acp.ts"

const run = { agent_id: "agent-1", run_id: "run-1" } as const

function assistant(text: string): CursorSdkMessage {
  return { ...run, type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } }
}

function thinking(text: string, durationMs?: number): CursorSdkMessage {
  const message: CursorSdkMessage = { ...run, type: "thinking", text }
  if (durationMs !== undefined) message.thinking_duration_ms = durationMs
  return message
}

function textOf(updates: LiveUpdate[]): Map<string, string> {
  const blocks = new Map<string, string>()
  for (const update of updates) {
    if (update.kind !== "text" && update.kind !== "thinking") continue
    assert.ok(update.id, "the SDK projection names every text and thinking block")
    blocks.set(update.id, (blocks.get(update.id) ?? "") + update.text)
  }
  return blocks
}

// The exact order SDK 1.0.31 delivered on 2026-09-13: every chunk arrives
// once as a delta and once more as a message that echoes the same chunk.
{
  const projection = new CursorSdkProjection("t1")
  const updates: LiveUpdate[] = []
  const feed = (item: { delta: CursorSdkDelta } | { message: CursorSdkMessage }) => {
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

// A context summary mid-answer: the text after it is a block of its own, so
// the compaction marker stays between the two.
{
  const projection = new CursorSdkProjection("t-summary")
  const updates: LiveUpdate[] = [
    ...projection.delta({ type: "text-delta", text: "Before" }),
    ...projection.delta({ type: "summary-started" }),
    ...projection.delta({ type: "summary-completed" }),
    ...projection.delta({ type: "text-delta", text: "After" }),
  ]
  assert.deepEqual([...textOf(updates).entries()], [["t-summary:text:0", "Before"], ["t-summary:text:1", "After"]])
  for (const delta of [{ type: "summary-started" }, { type: "summary-completed" }, { type: "unhandled", kind: "future-update" }, { type: "shell-output", text: "tail" }])
    assert.ok(SdkChildLineSchema.safeParse({ event: "delta", turn: "t", delta }).success, `${delta.type} crosses the wire`)

  // SDK 1.0.31 withholds the summary deltas from `onDelta` and streams the
  // summary as a `task` message: that message splits the text the same way.
  const streamed = new CursorSdkProjection("t-task")
  const split: LiveUpdate[] = [
    ...streamed.message(assistant("Before")),
    ...streamed.message({ ...run, type: "task", text: "Summary of the conversation so far." }),
    ...streamed.message(assistant("After")),
  ]
  assert.deepEqual([...textOf(split).entries()], [["t-task:text:0", "Before"], ["t-task:text:1", "After"]])
  assert.equal(compactionSummary({ ...run, type: "task", text: "  The summary.  " }), "The summary.")
  assert.equal(compactionSummary({ ...run, type: "task", status: "running", text: "Something else" }), undefined, "a task with a status is not a summary")
  assert.equal(compactionSummary({ ...run, type: "task", text: "  " }), undefined)
}

// An MCP tool can answer and still report failure with `isError`; the row
// fails like any other call. Shape from SDK 1.0.31 run events.
{
  const projection = new CursorSdkProjection("t-mcp")
  const mcp = (id: string, isError: boolean): LiveUpdate | undefined => projection.message({
    ...run,
    type: "tool_call",
    call_id: id,
    name: "mcp",
    status: "completed",
    args: { providerIdentifier: "linear", toolName: "get_issue" },
    result: { status: "success", value: { content: [{ text: { text: isError ? "Issue not found" : "ENG-1" } }], isError } },
  }).find((update) => update.kind === "tool-update")
  const failed = mcp("mcp-failed", true)
  assert.ok(failed?.kind === "tool-update" && failed.status === "failed" && failed.output === "Issue not found")
  const answered = mcp("mcp-ok", false)
  assert.ok(answered?.kind === "tool-update" && answered.status === "completed")
}

// A running command's output streams into its row as a tail. The SDK's
// chunks name no call, so output goes to the one shell call running and is
// dropped while two are; the completed call's whole output replaces it.
{
  const projection = new CursorSdkProjection("t-shell")
  const shell = (id: string, status: "running" | "completed"): CursorSdkMessage => {
    const message: CursorSdkMessage = { ...run, type: "tool_call", call_id: id, name: "shell", status, args: { command: "make test" } }
    if (status === "completed") message.result = { status: "success", value: { exitCode: 0, stdout: "all passed\n", stderr: "" } }
    return message
  }
  let blocks = reduceLiveUpdates([], projection.message(shell("one", "running")))
  const output = () => blocks.find((block) => block.type === "tool" && block.id === "one")
  assert.deepEqual(projection.delta({ type: "shell-output", text: "building\n" }), [{ kind: "tool-update", id: "one", outputAppend: "building\n" }])
  assert.deepEqual(projection.delta({ type: "shell-output", text: "testing\n" }), [{ kind: "tool-update", id: "one", outputAppend: "testing\n" }])
  blocks = reduceLiveUpdates(blocks, [{ kind: "tool-update", id: "one", outputAppend: "building\ntesting\n" }, ...projection.delta({ type: "shell-output", text: "x".repeat(40_000) })])
  const long = output()
  assert.ok(long?.type === "tool" && long.output?.length === MAX_STREAMED_TOOL_OUTPUT && long.output.endsWith("x"), "the row keeps the tail")
  projection.message(shell("two", "running"))
  assert.deepEqual(projection.delta({ type: "shell-output", text: "whose?" }), [], "with two commands running the output names neither")
  const done = projection.message(shell("one", "completed")).find((update) => update.kind === "tool-update")
  assert.ok(done?.kind === "tool-update" && done.output === "all passed\n", "the result replaces the streamed tail")
  assert.deepEqual(projection.delta({ type: "shell-output", text: "two's\n" }), [{ kind: "tool-update", id: "two", outputAppend: "two's\n" }])
  projection.message(shell("two", "completed"))
  assert.deepEqual(projection.delta({ type: "shell-output", text: "late" }), [], "output after the call completed reopens nothing")
}

// A plan tool's arguments stream in; each growth repaints the plan and the
// final plan carries the completed arguments.
{
  const projection = new CursorSdkProjection("t4")
  const running = (todos: { content: string; status: string }[]): CursorSdkMessage => ({
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
  assert.equal(grown.length, 2)
  const repaint = grown[0]
  assert.ok(repaint.kind === "tool-update" && repaint.input?.includes("Reply"), "streamed arguments replace the row's input")
  assert.ok(grown[1].kind === "plan" && grown[1].entries.length === 2)
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

// Cursor's plan tool starts `{"plan":""}` and streams the real arguments
// behind it. Every growth repaints the row's input — the placeholder must
// not survive — and the plan text becomes the shared proposed-plan
// artifact: drafting while it fills, proposed when the call completes.
{
  const projection = new CursorSdkProjection("t-plan")
  const call = (status: "running" | "completed", args: JsonValue, result?: JsonValue): CursorSdkMessage => {
    const message: CursorSdkMessage = {
      ...run,
      type: "tool_call",
      call_id: "tool-plan",
      name: "createPlan",
      status,
      args,
    }
    if (result !== undefined) message.result = result
    return message
  }
  const started = projection.message(call("running", { plan: "" }))
  assert.ok(
    !started.some((update) => update.kind === "proposed-plan"),
    "an empty plan drafts no artifact"
  )
  const grown = projection.message(call("running", { plan: "1. Read the files\n2. Write the fix" }))
  const painting = grown.find((update) => update.kind === "tool-update")
  assert.ok(
    painting?.kind === "tool-update" && painting.input?.includes("Write the fix"),
    "streamed arguments replace the placeholder"
  )
  const drafting = grown.find((update) => update.kind === "proposed-plan")
  assert.ok(
    drafting?.kind === "proposed-plan" &&
      drafting.status === "drafting" &&
      drafting.text.includes("Write the fix"),
    "the plan drafts as its arguments fill in"
  )
  const done = projection.message(
    call("completed", { plan: "1. Read the files\n2. Write the fix" }, { status: "success" })
  )
  const proposed = done.find((update) => update.kind === "proposed-plan")
  assert.ok(proposed?.kind === "proposed-plan" && proposed.status === "proposed")

  // Arguments that arrive only at completion still replace the start's
  // placeholder — no stale `{"plan":""}` survives.
  const late = new CursorSdkProjection("t-late")
  late.message({
    ...run,
    type: "tool_call",
    call_id: "tool-plan",
    name: "createPlan",
    status: "running",
    args: { plan: "" },
  })
  const settled = late.message(
    call("completed", { plan: "the whole plan" }, { status: "success" })
  )
  const completion = settled.find((update) => update.kind === "tool-update")
  assert.ok(
    completion?.kind === "tool-update" && completion.input?.includes("the whole plan"),
    "a completion-only payload still updates the row"
  )
  assert.ok(
    settled.some((update) => update.kind === "proposed-plan" && update.status === "proposed"),
    "a completion-only payload still proposes the plan"
  )
}

// A call the SDK refuses before it runs (Auto review, a hook's deny) emits
// one `running` event and no terminal one; the turn's end closes the row so
// it does not spin forever, and a completed call is left alone.
{
  const projection = new CursorSdkProjection("t5")
  const shell = (id: string, status: "running" | "completed"): CursorSdkMessage => {
    const message: CursorSdkMessage = {
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

  const crashed = new CursorSdkProjection("t6b")
  crashed.message(shell("open", "running"))
  assert.deepEqual(crashed.finish("error", "The process exited."), [
    { kind: "tool-update", id: "open", status: "failed", output: "The process exited.", unfinished: true },
  ], "only a run that died leaves its calls without a result; a refused or stopped call is not that")

  // A read that fails streams no end either (SDK 1.0.31); its checkpoint kept
  // "Error: File not found", which the row shows instead of guessing why.
  const missing = new CursorSdkProjection("t6c")
  missing.message({ ...run, type: "tool_call", call_id: "read", name: "read", status: "running", args: { path: "missing.md" } })
  missing.message(shell("refused", "running"))
  const kept = new Map([["read", { output: "Error: File not found", failed: true }]])
  const closed = missing.finish("finished", "Cursor did not run this call.", () => kept)
  assert.deepEqual(closed.filter((update) => update.kind === "tool-update").map((update) => [update.id, update.status, update.output]), [
    ["read", "failed", "Error: File not found"],
    ["refused", "failed", "Cursor did not run this call."],
  ], "a call its checkpoint answered shows that answer; one it didn't keeps the note")
}

// A subagent's row is its reply to the parent, not its run. The run carries
// every call's full result and passed 32 KB in each research call on record,
// so a head-kept clip showed its opening and lost the conclusion.
{
  const projection = new CursorSdkProjection("t7")
  const bulk = "x".repeat(40_000)
  projection.message({ ...run, type: "tool_call", call_id: "sub", name: "task", status: "running", args: { description: "Research Tembo environments", prompt: "…" } })
  const [done] = projection.message({
    ...run,
    type: "tool_call",
    call_id: "sub",
    name: "task",
    status: "completed",
    args: { description: "Research Tembo environments", prompt: "…" },
    result: {
      status: "success",
      value: {
        isBackground: false,
        backgroundReason: "unspecified",
        resultSuffix: "agentId: a-1",
        conversationSteps: [
          { thinkingMessage: { text: "Plan the search." } },
          { assistantMessage: { text: "I'll fetch the docs first." } },
          { toolCall: { webFetchToolCall: { result: { success: { content: bulk } } } } },
          { assistantMessage: { text: "## Tembo" } },
          { assistantMessage: { text: "Setup lives in the app, not in Git." } },
        ],
      },
    },
  })
  assert.equal(done?.kind === "tool-update" && done.output, "## Tembo\n\nSetup lives in the app, not in Git.\n\nagentId: a-1")

  const silent = projection.message({
    ...run,
    type: "tool_call",
    call_id: "quiet",
    name: "task",
    status: "completed",
    args: { description: "Quiet" },
    result: { status: "success", value: { isBackground: false, backgroundReason: "unspecified", conversationSteps: [
      { assistantMessage: { text: "Looking." } },
      { toolCall: { shellToolCall: {} } },
    ] } },
  }).find((update) => update.kind === "tool-update")
  assert.equal(silent?.kind === "tool-update" && silent.output, "Looking.", "a run that ends on a call still gives its last words")
}

// Long text keeps both ends, and says how much was left out.
{
  const long = `START${"a".repeat(50_000)}END`
  const clipped = clip(long)
  assert.ok(clipped.startsWith("START") && clipped.endsWith("END"))
  assert.match(clipped, /… 17240 characters left out …/)
  assert.equal(clip("short"), "short")
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

  // The host validates what the wire carries, not the SDK's live object: a
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
  const written = (message: typeof run & { type: string }) => SdkChildLineSchema.safeParse(JSON.parse(JSON.stringify({ event: "message", turn: "t", seq: 0, message })))
  const completedGrep = written(liveGrep)
  assert.ok(completedGrep.success && "event" in completedGrep.data && completedGrep.data.event === "message",
    "a result with an undefined field is carried once serialized")
  assert.equal(completedGrep.data.message.type === "tool_call" && completedGrep.data.message.status, "completed")
  assert.equal(written({ ...run, type: "novel" }).success, false, "an unknown message type is still refused")
}

console.log("cursor sdk projection, modes and wire ok")

// A steer's ack is turn-paced: held past the request deadline it stays
// pending, while an ordinary request still fails at that deadline.
{
  const { CursorSdkClient } = await import("../electron/providers/cursor/sdk/client.ts")
  const { writeFileSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const stub = join(tmpdir(), `cursor-sdk-silent-${process.pid}.mjs`)
  writeFileSync(stub, "process.stdin.resume()\n")
  const client = new CursorSdkClient({
    owner: "test",
    cwd: tmpdir(),
    env: {},
    onEvent() {},
    execPath: process.execPath,
    entry: stub,
    requestTimeoutMs: 50,
  })
  const steer = client
    .request("steer", { text: "hold" })
    .then(() => "answered", () => "failed")
  const send = client
    .request("send", { turn: "slow-start", text: "hold", images: [] })
    .then(() => "answered", () => "failed")
  const cancel = client.request("cancel", undefined).then(
    () => "answered",
    (error: Error) => error.message
  )
  await new Promise((resolve) => setTimeout(resolve, 250))
  assert.equal(
    await Promise.race([steer, Promise.resolve("pending")]),
    "pending",
    "a steer held by the turn is not a disconnect"
  )
  assert.equal(
    await Promise.race([send, Promise.resolve("pending")]),
    "pending",
    "a send the SDK is slow to answer may already be running its turn"
  )
  assert.match(
    await cancel,
    /did not answer cancel/,
    "an ordinary request still dies at the deadline"
  )
  client.kill()

  const defaultDeadline = new CursorSdkClient({
    owner: "test-cancel-default", cwd: tmpdir(), env: {}, onEvent() {},
    execPath: process.execPath, entry: stub,
  })
  try {
    const began = Date.now()
    await assert.rejects(defaultDeadline.request("cancel", undefined), /did not answer cancel within 5s/)
    assert.ok(Date.now() - began < 10_000, "Stop cannot wait the ordinary 60-second deadline")
  } finally {
    defaultDeadline.kill()
    await defaultDeadline.exited
  }
}
console.log("cursor sdk: steer and send outlive the request deadline, cancel does not")

// The driver marks each compaction once, with its summary, whichever of the
// summary message and `summary-completed` arrives first; SDK 1.0.31 sends
// the message alone. A failed turn leaves its reason in the transcript,
// unless the connection dropped and Mako continues it itself.
{
  const { randomUUID } = await import("node:crypto")
  const { mkdtempSync, rmSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const { CursorSdkAuth } = await import("../electron/providers/cursor/sdk/auth.ts")
  const { CursorCredentialStore } = await import("../electron/providers/cursor/sdk/credentials.ts")
  const { createCursorSdkDriver } = await import("../electron/providers/cursor/sdk/driver.ts")
  type Client = import("../electron/providers/cursor/sdk/driver.ts").CursorSdkLiveClient
  type Answers = { [M in SdkMethod]?: () => SdkResult<M> }

  const root = mkdtempSync(join(tmpdir(), "mako-cursor-events-"))
  let childEvent: (event: SdkEvent) => void = () => {}
  const client: Client = {
    alive: true,
    exited: new Promise(() => {}),
    hello: async () => ({ wire: 1, sdkVersion: "fixture", node: process.version }),
    request: async <Method extends SdkMethod>(method: Method): Promise<SdkResult<Method>> => {
      const answers: Answers = {
        me: () => ({ email: "fixture@example.test", apiKeyName: "fixture", createdAt: "2026-09-22" }),
        open: () => ({ agentId: "fixture-agent", model: { id: "fixture-model" } }),
        active: () => ({}),
        send: () => ({ runId: "fixture-run" }),
      }
      const respond = answers[method]
      if (!respond) throw new Error(`Unexpected fixture method: ${method}`)
      return respond()
    },
    close: async () => {},
    kill() {},
  }
  const auth = new CursorSdkAuth({
    env: async () => ({ CURSOR_API_KEY: "key_fixture_0123456789abcdef" }),
    openUrl: async () => {
      throw new Error("Fixture must not sign in")
    },
    credentials: new CursorCredentialStore(join(root, "credential.bin"), {
      available: async () => false,
      encrypt: async () => Buffer.alloc(0),
      decrypt: async () => "",
    }),
    cliKey: async () => null,
    client: () => client,
  })
  const driver = createCursorSdkDriver({
    auth,
    stateRoot: () => root,
    home: root,
    client: (options) => {
      childEvent = options.onEvent
      return client
    },
    models: async () => [{ id: "fixture-model", displayName: "Fixture" }],
  })
  const id = randomUUID()
  const markers: string[] = []
  const activity: string[] = []
  let lastStop: string | undefined
  try {
    await driver.start(root, {
      conversationId: id,
      emit(event) {
        if (event.type === "live-update" && event.update.kind === "event") {
          const { label, detail, body, tone } = event.update
          markers.push([label, detail, body, tone].filter(Boolean).join(" | "))
        }
        if (event.type === "live-activity") activity.push(event.activity?.kind ?? "idle")
        if (event.type === "live-session") lastStop = event.session.lastStop
      },
    })
    const summary = (text: string) => (turn: string): SdkEvent => ({ event: "message", turn, message: { ...run, type: "task", text } })
    const delta = (type: "summary-started" | "summary-completed") => (turn: string): SdkEvent => ({ event: "delta", turn, delta: { type } })
    const turn = async (lines: ((turn: string) => SdkEvent)[], result: Partial<SdkRunResult> = {}) => {
      markers.length = 0
      activity.length = 0
      const attemptId = randomUUID()
      await driver.prompt(id, "go", [], undefined, { operationId: randomUUID(), attemptId, report() {} })
      for (const line of lines) childEvent(line(attemptId))
      childEvent({ event: "result", turn: attemptId, result: { runId: "fixture-run", status: "finished", ...result } })
      return [...markers]
    }

    assert.deepEqual(await turn([summary("First summary."), summary("Second summary.")]),
      ["Context compacted | First summary.", "Context compacted | Second summary."], "SDK 1.0.31: the summary message alone marks each compaction")
    assert.deepEqual(await turn([delta("summary-started"), summary("Text first."), delta("summary-completed")]), ["Context compacted | Text first."])
    assert.deepEqual(activity, ["compacting", "idle"], "compacting shows until the summary lands")
    assert.deepEqual(await turn([delta("summary-started"), delta("summary-completed"), summary("Text last.")]), ["Context compacted | Text last."])
    assert.deepEqual(activity, ["compacting", "idle", "idle"])
    assert.deepEqual(await turn([delta("summary-started"), delta("summary-completed")]), ["Context compacted"],
      "a compaction whose summary never came is still marked, at the turn's end")
    const numbered = (text: string, seq: number) => (turn: string): SdkEvent => ({ event: "message", turn, seq, message: { ...run, type: "task", text } })
    assert.deepEqual(await turn([numbered("Kept the plan.", 4), numbered("Kept the plan.", 4), numbered("Kept the tests.", 5)]),
      ["Context compacted | Kept the plan.", "Context compacted | Kept the tests."], "the child's replay of a message it already sent is drawn once")

    assert.deepEqual(await turn([], { status: "error", error: { message: "Model overloaded", code: "resource_exhausted" } }),
      ["Turn failed | Model overloaded | error"])
    const long = `Provider returned error: ${"x".repeat(300)}\nsecond line`
    const [failure] = await turn([], { status: "error", error: { message: long } })
    assert.ok(failure?.startsWith("Turn failed | Provider returned error: x") && failure.includes(`| ${long} |`), "a long reason is clipped beside the label and whole in the body")
    assert.deepEqual(await turn([], { status: "error", error: { message: "RST_STREAM", code: "unavailable" } }), [],
      "a dropped connection is Mako's to continue, not the conversation's failure")
    const gaveUp = "Agent turn stopped after repeated resume attempts made no progress"
    assert.deepEqual(await turn([], { status: "error", error: { message: gaveUp } }), [`Turn failed | ${gaveUp} | error`],
      "the SDK giving up its own no-progress resumes is a failed turn, never one Mako continues by itself")
    assert.equal(lastStop, RETRIES_EXHAUSTED_STOP, "so the host offers Send again instead of continuing it")
    assert.deepEqual(await turn([], { status: "error", error: { message: "Connection failed repeatedly" } }), ["Turn failed | Connection failed repeatedly | error"],
      "the SDK giving up its transport retries is failed too, though its words read as a network drop")
    assert.equal(lastStop, RETRIES_EXHAUSTED_STOP)
  } finally {
    await driver.close(id)
    rmSync(root, { recursive: true, force: true })
  }
}
console.log("cursor sdk: compaction markers carry their summary in either order; failed turns say why")
