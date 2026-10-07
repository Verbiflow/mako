import assert from "node:assert/strict"
import { pairTools, foldTools } from "../src/lib/tools.ts"
import { threadToMessages } from "../src/lib/foreign-thread.ts"
import { isInterruptedNote, notesBesideStop, promptLabel, responseSections, toExchanges } from "../src/lib/exchanges.ts"
import { textOf } from "../src/lib/format.ts"
import { acpBlocksToMessages } from "../src/lib/acp-blocks.ts"
import type { AttachmentContent } from "@mako/sessions"
import { CursorSdkProjection } from "../electron/providers/cursor/sdk/projection.ts"
import { reduceLiveUpdates } from "@mako/sessions/live-content"

// SDK wire -> canonical live blocks -> shared row, and retained blocks -> the same row.
// The SDK's MCP envelope differs from Desktop's CallDynamicTool, even in one harness.
{
  const projection = new CursorSdkProjection("mcp-parity")
  const input = { providerIdentifier: "mako", toolName: "app_status", args: {} }
  const updates = projection.message({ type: "tool_call", agent_id: "agent", run_id: "run", call_id: "status", name: "mcp", status: "completed", args: input, result: { status: "success", value: {} } })
  const blocks = reduceLiveUpdates([], updates)
  const liveRows = acpBlocksToMessages(blocks, false, "cursor")
  const liveRow = pairTools(liveRows.messages[0]!.blocks)[0]!
  const savedRows = threadToMessages([{ kind: "assistant", blocks: [{ type: "tool", id: "status", name: "mcp", input: JSON.stringify(input), output: "" }] }], 0, "cursor")
  const savedRow = pairTools(savedRows[0]!.blocks)[0]!
  assert.equal(liveRow.tool.label, "App status")
  assert.equal(savedRow.tool.label, liveRow.tool.label)
  assert.equal(liveRow.tool.server, "mako")
  assert.equal(liveRow.tool.tool, "app_status")
}

const image: AttachmentContent = {
  type: "attachment",
  name: "proof.png",
  mimeType: "image/png",
  source: { kind: "inline", data: "cHJvb2Y=" },
}
const imported = threadToMessages([
  {
    kind: "assistant",
    blocks: [{ type: "tool", id: "read", name: "Read", attachments: [image] }],
  },
])
const nativeCall = pairTools(imported[0]!.blocks)[0]!
assert.equal(
  nativeCall.pending,
  false,
  "An image-only native result completes its call"
)
assert.deepEqual(nativeCall.attachments, [image])
assert.equal(nativeCall.result, "")

// A viewer page carries the head of a long tool output; the call remembers
// how long the whole is and where the rest lives, addressed in the thread
// (page start plus local index), so an opened row can ask for it.
const paged = threadToMessages(
  [
    {
      kind: "assistant",
      blocks: [
        { type: "text", text: "Looking." },
        { type: "tool", name: "exec", input: "ls", output: "short" },
        {
          type: "tool",
          name: "exec",
          input: "cat big",
          output: "head",
          outputLength: 41_394,
        },
      ],
    },
  ],
  37
)
const pagedCalls = pairTools(paged[0]!.blocks)
assert.equal(pagedCalls[0]!.rest, undefined, "a complete output has no rest")
assert.deepEqual(pagedCalls[1]!.rest, {
  length: 41_394,
  at: { entry: 37, block: 2 },
})
assert.equal(pagedCalls[1]!.result, "head")
assert.equal(pagedCalls[1]!.pending, false, "a trimmed result is a result")

const live = acpBlocksToMessages(
  [
    {
      type: "tool",
      id: "read",
      title: "Read",
      status: "completed",
      attachments: [image],
    },
  ],
  false
)
assert.deepEqual(pairTools(live.messages[0]!.blocks)[0]!.attachments, [image])
assert.equal(pairTools(live.messages[0]!.blocks)[0]!.pending, false)
// The provider's kind rides the call so a name the registry does not know
// still finds its body family.
const kinded = pairTools([
  { type: "toolCall", id: "kind", name: "mystery_tool", kind: "execute" },
])[0]!
assert.equal(kinded.kind, "execute")
const empty = pairTools([
  { type: "toolCall", id: "empty", name: "Shell" },
  { type: "toolResult", id: "empty", text: "" },
])[0]!
assert.equal(empty.pending, false, "Empty output is a completed result")
assert.equal(
  pairTools([{ type: "toolCall", id: "pending", name: "Read" }])[0]!.pending,
  true
)
const streaming = pairTools([
  { type: "toolCall", id: "stream", name: "Read" },
  {
    type: "toolResult",
    id: "stream",
    text: "partial",
    streaming: true,
    attachments: [image],
  },
])[0]!
assert.equal(streaming.pending, true)
assert.deepEqual(streaming.attachments, [image])
const folded = foldTools([
  {
    id: "assistant",
    role: "assistant",
    blocks: [{ type: "toolCall", id: "read", name: "Read" }],
  },
  { id: "result", role: "tool", toolCallId: "read", blocks: [image] },
])
assert.deepEqual(pairTools(folded[0]!.blocks)[0]!.attachments, [image])
console.log(
  "Tool results retain media ownership and distinguish empty completion from pending output"
)

const { claudeCommandPrompt, claudeInterrupted } =
  await import("../packages/sessions/src/providers/claude-presentation.ts")
assert.equal(
  claudeCommandPrompt(
    "<command-message>graphify</command-message>\n<command-name>/graphify</command-name>\n<command-args>billing accounting?</command-args>"
  ),
  "/graphify billing accounting?"
)
assert.equal(
  claudeCommandPrompt("Explain <command-name>/foo</command-name>"),
  "Explain <command-name>/foo</command-name>"
)
assert.equal(
  claudeInterrupted("[Request interrupted by user for tool use]"),
  true
)
const { devinReferences, devinPromptImages, devinMcpCall } =
  await import("../packages/sessions/src/providers/devin-presentation.ts")
const reference = '<ref_snippet file="/work/src/app.ts" lines="12-18" />'
assert.equal(devinReferences(reference), "[app.ts:12-18](file:///work/src/app.ts)", "as Devin 3000.10.23 streams it")
assert.equal(devinReferences('See <ref_file file="/work/src/app.ts" />.'), "See [app.ts](file:///work/src/app.ts).")
assert.equal(
  devinReferences("```xml\n" + reference + "\n```"),
  "```xml\n" + reference + "\n```"
)
assert.equal(
  devinPromptImages("Check this [Image 1: /work/proof.png]").attachments[0]
    ?.source.kind,
  "file"
)
assert.equal(
  devinMcpCall(
    JSON.stringify({
      server_name: "files",
      tool_name: "read",
      arguments: { path: "proof.txt" },
    })
  )?.name,
  "files.read"
)
assert.equal(devinMcpCall('{"command":"read"}'), undefined)
const { todoDetails } = await import("../packages/sessions/src/tool-plan.ts")
assert.deepEqual(
  todoDetails('{"todos":[{"content":"Verify image","status":"completed"}]}'),
  [
    {
      type: "plan",
      entries: [{ content: "Verify image", status: "completed" }],
    },
  ]
)
const { inlineFileTarget } = await import("../src/lib/file-citations.ts")
assert.equal(inlineFileTarget("src/app.ts:12-18")?.endLine, 18)
for (const literal of [
  "process.env",
  "npm run build",
  "https://example.com/app.ts",
  "x/y",
  "foo.bar",
])
  assert.equal(inlineFileTarget(literal), null, literal)
const { markdownMedia } = await import("../src/lib/transcript-media.ts")
assert.equal(markdownMedia("/work/proof.mp3").mimeType, "audio/mpeg")
assert.equal(markdownMedia("file:///work/proof.png").source.kind, "file")
console.log(
  "Provider commands, native references, plans, file links, and media types preserve their contracts"
)

const { codexPrompt, codexPromptImages, codexPresentation } =
  await import("../packages/sessions/src/providers/codex-presentation.ts")
const appendix = '<image name=[Image #1] path="/work/proof.png"></image>'
assert.equal(codexPrompt(`Look here\n${appendix}`), "Look here")
assert.equal(
  codexPromptImages(`Look here\n${appendix}`)[0]?.source.kind,
  "file"
)
assert.equal(
  codexPrompt(
    "# AGENTS.md instructions for /work\n\n<INSTRUCTIONS>Context only</INSTRUCTIONS>\n<environment_context>cwd</environment_context>"
  ),
  undefined
)
assert.equal(
  codexPrompt(
    "# AGENTS.md instructions for /work\n<INSTRUCTIONS>Context only</INSTRUCTIONS>\nKeep this request"
  ),
  "Keep this request"
)
assert.equal(
  codexPrompt(
    '<send_user_message_question_reply>\n[{"question":"Which profile?","answer":"Existing"}]\n</send_user_message_question_reply>'
  ),
  "Which profile?\n\nExisting"
)
assert.equal(
  codexPrompt(
    "<send_user_message_question_reply>broken</send_user_message_question_reply>"
  ),
  "<send_user_message_question_reply>broken</send_user_message_question_reply>"
)
assert.equal(
  codexPrompt("Explain <custom>this user XML</custom>"),
  "Explain <custom>this user XML</custom>"
)
const directive =
  '::code-comment{title="[P2] Read failure" body="The read of the file fails." file="/work/app.ts" start=12}'
assert.match(
  codexPresentation(directive),
  /\[\/work\/app.ts:12\]\(<\/work\/app.ts#L12>\)/
)
assert.equal(
  codexPresentation("```text\n" + directive + "\n```"),
  "```text\n" + directive + "\n```"
)
assert.equal(
  codexPresentation(
    "[Review](codex://review?pr=https%3A%2F%2Fgithub.com%2Fa%2Fb%2Fpull%2F1&path=app.ts&line=12)"
  ),
  "[Review](https://github.com/a/b/pull/1)"
)
console.log(
  "Codex normalization retains user text, source examples, and actionable review targets"
)
assert.match(
  codexPresentation(
    '::code-comment{title="Review" body="The `reader` fails." file="src/app.ts" start=7}'
  ),
  /\[src\/app.ts:7\]/
)
const { cursorTaskNotification, cursorPrompt } =
  await import("../packages/sessions/src/providers/cursor-presentation.ts")
const notification =
  "<timestamp>Today</timestamp>\n<system_notification><task>kind: subagent\nstatus: success\ntitle: Inspect module\n<response>**Verified** result</response></task></system_notification>\n<user_query>Follow up</user_query>"
const taskResult = cursorTaskNotification(notification, "native-bubble")
assert.equal(taskResult?.kind, "assistant")
assert.ok(
  taskResult?.kind === "assistant" &&
    taskResult.blocks[0]?.type === "tool" &&
    taskResult.blocks[0].output === "**Verified** result"
)
assert.equal(
  cursorTaskNotification("Explain " + notification, "example"),
  undefined
)
assert.equal(
  cursorPrompt("<user_query>Keep my request</user_query>"),
  "Keep my request"
)

const steered = acpBlocksToMessages(
  [
    { type: "user", requestId: "original", text: "Original task" },
    { type: "text", id: "answer", text: "Answer before confirmation" },
    {
      type: "user",
      requestId: "steer",
      steeringFor: "original",
      text: "Additional instruction",
      attachments: [image],
    },
    { type: "text", id: "continued", text: "Answer continues" },
  ],
  false
)
const exchanges = toExchanges(steered.messages)
assert.equal(
  exchanges.length,
  1,
  "Late steering confirmation must not create an empty exchange"
)
assert.equal(exchanges[0]?.response.length, 3)
assert.deepEqual(exchanges[0]?.response.map((message) => message.role), ["assistant", "user", "assistant"])
assert.equal(exchanges[0]?.response[1]?.blocks[0]?.type, "text")
assert.deepEqual(exchanges[0]?.response[1]?.blocks[1], image)
console.log(
  "Steering stays with its original exchange, whole-answer copy and retained attachments"
)

const portableSteering = toExchanges(
  threadToMessages([
    { kind: "user", id: "original", text: "Original task" },
    { kind: "assistant", blocks: [{ type: "text", text: "Whole answer" }] },
    {
      kind: "user",
      id: "steer",
      steeringFor: "original",
      text: "Additional instruction",
      attachments: [image],
    },
  ])
)
assert.equal(portableSteering.length, 1)
assert.equal(portableSteering[0]?.response.filter((message) => message.role === "user").length, 1)

// Markers keep their place in a long answer: a summary between two stretches
// of work splits the log there rather than joining the notes under the prompt.
const tool = (id: string) => ({ type: "tool" as const, id, name: "Shell", input: id, output: "ok" })
const [compacted] = toExchanges(
  threadToMessages([
    { kind: "user", id: "ask", text: "Long task" },
    { kind: "event", label: "Model changed", detail: "fast" },
    { kind: "assistant", blocks: [tool("one"), tool("two")] },
    { kind: "event", label: "Context compacted" },
    { kind: "assistant", blocks: [tool("three")] },
    { kind: "event", label: "Context compacted" },
    { kind: "assistant", blocks: [{ type: "text", text: "Done" }] },
  ])
)
assert.deepEqual(
  compacted!.system.map((note) => note.after),
  [0, 1, 2],
  "Each note records how much of the answer came before it"
)
const sections = responseSections(compacted!.response, compacted!.system)
assert.deepEqual(
  sections.map((section) => section.kind),
  ["work", "note", "work", "note", "prose"],
  "Notes after the first reply sit between the stretches they separate; the leading note stays above"
)
assert.deepEqual(responseSections(compacted!.response).map((section) => section.kind), ["work", "prose"])
assert.ok(
  isInterruptedNote({ id: "n", role: "system", blocks: [{ type: "text", text: "Interrupted" }] }) &&
    !isInterruptedNote({ id: "n", role: "system", blocks: [{ type: "text", text: "Context compacted" }] })
)
const note = (id: string, text: string, after: number) => ({ message: { id, role: "system" as const, blocks: [{ type: "text" as const, text }] }, after })
assert.deepEqual(
  notesBesideStop([note("lead", "Interrupted", 0), note("steer", "Interrupted", 1), note("summary", "Context compacted", 2), note("end", "Interrupted", 3)], 3)
    .map((kept) => kept.message.id),
  ["steer", "summary"],
  "With a Stopped footer, the provider's marker above or below the answer goes; a marker between parts of it stays"
)
console.log("Compaction and other notes render where they happened in a long answer; a stopped turn says so once")

// A turn the provider started itself opens its own exchange, headed by the
// cause it reported, whether read from its native file or streamed live.
const finished = 'Background command "Sleep 8 seconds" completed (exit code 0)'
const nativeTurns = toExchanges(
  threadToMessages([
    { kind: "user", id: "ask", text: "Start the sleep" },
    { kind: "assistant", id: "started", blocks: [{ type: "text", text: "Started it." }] },
    { kind: "event", id: "cause", at: "2026-09-27T01:00:10.000Z", label: finished, opensTurn: true },
    { kind: "assistant", id: "read", blocks: [{ type: "text", text: "It printed BG-DONE." }] },
  ])
)
assert.deepEqual(nativeTurns.map((exchange) => [Boolean(exchange.prompt), exchange.opener ? textOf(exchange.opener.blocks) : null, exchange.response.length]),
  [[true, null, 1], [false, finished, 1]], "the provider's turn is its own exchange, not more of the previous answer")
assert.equal(nativeTurns[1]!.id, "native-event-cause")
assert.equal(nativeTurns[1]!.timestamp, Date.parse("2026-09-27T01:00:10.000Z"))
assert.equal(promptLabel(nativeTurns[1]!), finished, "the navigator names the turn by its cause")
const liveTurns = toExchanges(acpBlocksToMessages([
  { type: "user", requestId: "r1", text: "Start the sleep" },
  { type: "text", text: "Started it." },
  { type: "provider-turn", reason: finished },
  { type: "tool", id: "read", title: "Read", status: "completed", output: "BG-DONE" },
  { type: "text", text: "It printed BG-DONE." },
], true).messages)
assert.deepEqual(liveTurns.map((exchange) => exchange.id), ["acp-request-r1", "acp-turn-2"])
assert.equal(liveTurns[1]!.response.at(-1)?.streaming, true, "the running provider turn is the one streaming")
const queued = toExchanges(
  threadToMessages([
    { kind: "event", id: "stale", label: "Background shell command didn't finish before the previous session ended", opensTurn: true },
    { kind: "user", id: "next", text: "Reply with resumed" },
    { kind: "assistant", blocks: [{ type: "text", text: "resumed" }] },
  ])
)
assert.deepEqual(queued.map((exchange) => [exchange.prompt?.id ?? null, exchange.system.map((entry) => [entry.message.id, entry.after])]),
  [["native-user-next", [["native-event-stale", 0]]]], "a cause nothing answered was delivered with the next prompt and sits under it")
const pair = toExchanges(
  threadToMessages([
    { kind: "event", id: "first", label: "First task finished", opensTurn: true },
    { kind: "event", id: "second", label: "Second task finished", opensTurn: true },
    { kind: "assistant", blocks: [{ type: "text", text: "Both are done." }] },
  ])
)
assert.deepEqual(pair.map((exchange) => [exchange.opener?.id, exchange.system.map((entry) => entry.message.id)]),
  [["native-event-first", ["native-event-second"]]], "causes reported together open one turn")
console.log("A turn the provider started itself is its own exchange headed by its cause, live and native")

const compactedLive = toExchanges(acpBlocksToMessages([
  { type: "user", requestId: "r2", text: "Keep going" },
  { type: "text", text: "Before." },
  { type: "event", label: "Context compacted", detail: "Automatic" },
  { type: "text", text: "After." },
], false).messages)
assert.equal(compactedLive.length, 1, "a compaction does not open a turn")
assert.deepEqual(compactedLive[0]!.system.map((entry) => [textOf(entry.message.blocks), entry.after]),
  [["Context compacted — Automatic", 1]], "live, the marker sits where it happened, as it does in saved history")
assert.deepEqual(compactedLive[0]!.response.map((message) => textOf(message.blocks)), ["Before.", "After."])
console.log("A live compaction is a marker in place inside its answer")

const controlEnvelope = '<mako-local-control>\nBrowser and computer use: fixture setup\n</mako-local-control>\n\n'
assert.equal(codexPrompt(controlEnvelope + '<send_user_message_question_reply>\n[{"question":"Which profile?","answer":"Existing"}]\n</send_user_message_question_reply>'), 'Which profile?\n\nExisting')
const { userTextFrom } = await import('../packages/sessions/src/format.ts')
assert.equal(userTextFrom(controlEnvelope + 'Keep this request'), 'Keep this request')
assert.equal(userTextFrom('Explain this example: ' + controlEnvelope), ('Explain this example: ' + controlEnvelope).trim())
assert.equal(userTextFrom('<mako-local-control>incomplete'), '<mako-local-control>incomplete')
const { EntrySink } = await import('../packages/sessions/src/format.ts')
const history = new EntrySink()
history.push({ kind: 'user', text: controlEnvelope + 'Use your question tool' })
history.push({ kind: 'user', text: 'Explain <mako-local-control>\nkept\n</mako-local-control>\n\n' })
assert.deepEqual(history.done().map((entry) => entry.kind === 'user' && entry.text), ['Use your question tool', 'Explain <mako-local-control>\nkept\n</mako-local-control>\n\n'],
  "every provider's history drops only Mako's own leading control envelope")

const { identifyTool } = await import("../packages/sessions/src/tool-identity.ts")
const structuredAsk = JSON.stringify({ questions: [{ header: "Colour", question: "Which colour?", options: [{ label: "red" }] }] })
assert.equal(identifyTool({ name: "AskUserQuestion", input: structuredAsk }).target, "Which colour?", "Claude and OpenCode asks summarise by their first question")
assert.equal(identifyTool({ name: "question", input: JSON.stringify({ question: "Flat" }) }).target, "Flat")
assert.equal(identifyTool({ acpKind: "question", title: "Which colour?" }).label, "Question", "OpenCode's native question row reads as a question")
console.log("Structured questions keep a named row")
