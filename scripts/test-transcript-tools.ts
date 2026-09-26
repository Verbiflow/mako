import assert from "node:assert/strict"
import { pairTools, foldTools } from "../src/lib/tools.ts"
import { threadToMessages } from "../src/lib/foreign-thread.ts"
import { isInterruptedNote, notesBesideStop, responseSections, toExchanges } from "../src/lib/exchanges.ts"
import { acpBlocksToMessages } from "../src/lib/acp-blocks.ts"
import type { AttachmentContent } from "@mako/sessions"

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
assert.ok(devinReferences(reference).includes("/work/src/app.ts#L12-L18"))
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

const { firstQuestion, liveToolName, toolLabel } = await import("../src/lib/tools.ts")
const structuredAsk = JSON.stringify({ questions: [{ header: "Colour", question: "Which colour?", options: [{ label: "red" }] }] })
assert.equal(firstQuestion(structuredAsk), "Which colour?", "Claude and OpenCode asks summarise by their first question")
assert.equal(firstQuestion(JSON.stringify({ question: "Flat" })), undefined)
assert.equal(toolLabel(liveToolName("question", "Which colour?")), "Question", "OpenCode's native question row reads as a question")
console.log("Structured questions keep a named row")
