import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ClaudeProvider } from "../dist/index.js"
import { appendPromptAttachments } from "../dist/prompt-attachments.js"

// Claude Code's own records in a saved session read as the markers the live
// session shows: one per fact, with its long text kept to open on demand.
const home = await mkdtemp(join(tmpdir(), "mako-claude-events-"))
const session = "session-events"
let clock = 0
const record = (value) => JSON.stringify({
  sessionId: session, cwd: home, isSidechain: false,
  timestamp: new Date(Date.UTC(2026, 8, 29, 12, 0, clock++)).toISOString(), ...value,
})
const user = (uuid, text, extra = {}) => record({ type: "user", uuid, message: { role: "user", content: [{ type: "text", text }] }, ...extra })
const assistant = (uuid, content, extra = {}) => record({
  type: "assistant", uuid,
  message: { id: `msg-${uuid}`, role: "assistant", model: "claude-opus-4-8", content, ...extra.message },
  ...extra.record,
})
const text = (value) => ({ type: "text", text: value })
const system = (uuid, subtype, fields) => record({ type: "system", subtype, uuid, level: "info", ...fields })
const queued = (uuid, prompt, commandMode) => record({
  type: "attachment", uuid,
  attachment: { type: "queued_command", prompt, commandMode, source_uuid: `source-${uuid}` },
})
const summary = [
  "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.",
  "",
  "Summary:",
  "1. The user asked for a parser.",
].join("\n")
const notification = [
  "<task-notification>",
  "<task-id>b1</task-id>",
  "<status>completed</status>",
  "<summary>Background command \"npm test\" completed (exit code 0)</summary>",
  "</task-notification>",
].join("\n")

const lines = [
  user("u1", "Build the parser"),
  assistant("a1", [text("Working on it.")]),
  queued("q1", "Also handle comments", "prompt"),
  queued("q2", notification, "task-notification"),
  assistant("a2", [text("Done with both.")]),
  system("b1", "compact_boundary", { content: "Conversation compacted", compactMetadata: { trigger: "auto", preTokens: 155_000, postTokens: 12_000, durationMs: 72_400 } }),
  user("s1", summary, { isCompactSummary: true, isVisibleInTranscriptOnly: true }),
  user("u2", "Continue"),
  assistant("e1", [text("You've hit your session limit · resets 5:10am (America/Los_Angeles)")],
    { message: { model: "<synthetic>" }, record: { isApiErrorMessage: true, error: "rate_limit" } }),
  assistant("e2", [text("Login expired · Please run /login")],
    { message: { model: "<synthetic>" }, record: { isApiErrorMessage: true, error: "authentication_failed" } }),
  assistant("n1", [text("No response requested.")], { message: { model: "<synthetic>" } }),
  user("u3", "Try the audit again"),
  assistant("f1", [{ type: "fallback", from: { model: "claude-fable-5-1" }, to: { model: "claude-opus-4-8" } }], { record: { requestId: "req-1" } }),
  assistant("f2", [text("Here is the audit.")], { record: { requestId: "req-1" } }),
  system("r1", "model_refusal_fallback", {
    requestId: "req-1", originalModel: "claude-fable-5-1", fallbackModel: "claude-opus-4-8", scope: "session",
    content: "Fable 5.1's safeguards flagged this message. Switched to Opus 4.8.", apiRefusalExplanation: null,
  }),
  system("c1", "local_command", { content: "<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>" }),
  system("c2", "local_command", { content: "<local-command-stdout>Kept model as `Fable 5.1`</local-command-stdout>" }),
  system("t1", "turn_duration", { durationMs: 1000 }),
  system("h1", "stop_hook_summary", { hookCount: 1 }),
]
const path = join(home, `${session}.jsonl`)
await writeFile(path, `${lines.join("\n")}\n`)

try {
  const thread = await new ClaudeProvider(home).read(path)
  assert.ok(thread)
  const shape = thread.entries.map((entry) => {
    if (entry.kind === "user") return { kind: "user", id: entry.id, text: entry.text, steeringFor: entry.steeringFor }
    if (entry.kind === "assistant") return { kind: "assistant", text: entry.blocks.map((block) => block.text).join("") }
    return { kind: "event", label: entry.label, detail: entry.detail, body: entry.body, tone: entry.tone, opensTurn: entry.opensTurn }
  })
  assert.deepEqual(shape, [
    { kind: "user", id: "u1", text: "Build the parser", steeringFor: undefined },
    { kind: "assistant", text: "Working on it." },
    { kind: "user", id: "q1", text: "Also handle comments", steeringFor: "u1" },
    { kind: "event", label: "Background command \"npm test\" completed (exit code 0)", detail: undefined, body: undefined, tone: undefined, opensTurn: undefined },
    { kind: "assistant", text: "Done with both." },
    { kind: "event", label: "Context compacted", detail: "Automatic · 155k → 12k tokens · took 1m 12s", body: "Summary:\n1. The user asked for a parser.", tone: undefined, opensTurn: undefined },
    { kind: "user", id: "u2", text: "Continue", steeringFor: undefined },
    { kind: "event", label: "Rate limited", detail: "You've hit your session limit · resets 5:10am (America/Los_Angeles)", body: undefined, tone: "warning", opensTurn: undefined },
    { kind: "event", label: "Authentication failed", detail: "Login expired · Please run /login", body: undefined, tone: "error", opensTurn: undefined },
    { kind: "user", id: "u3", text: "Try the audit again", steeringFor: undefined },
    { kind: "event", label: "Model changed", detail: "claude-fable-5-1 → claude-opus-4-8 · after a refusal",
      body: "Fable 5.1's safeguards flagged this message. Switched to Opus 4.8.", tone: undefined, opensTurn: undefined },
    { kind: "assistant", text: "Here is the audit." },
    { kind: "event", label: "Notice", detail: "/model · Kept model as `Fable 5.1`", body: undefined, tone: undefined, opensTurn: undefined },
  ])

  // The summary alone, from a Claude Code that wrote no boundary, is still one marker.
  const lone = join(home, "lone.jsonl")
  await writeFile(lone, `${[user("u1", "Start"), user("s1", summary, { isCompactSummary: true })].join("\n")}\n`)
  const loneThread = await new ClaudeProvider(home).read(lone)
  assert.deepEqual(loneThread?.entries.filter((entry) => entry.kind === "event").map((entry) => [entry.label, entry.detail, entry.body]),
    [["Context compacted", undefined, "Summary:\n1. The user asked for a parser."]])

  // A follower that reads the boundary in one batch and the summary in the next keeps one marker.
  const followed = join(home, "followed.jsonl")
  await writeFile(followed, `${[user("u1", "Start"), lines[5]].join("\n")}\n`)
  const follower = new ClaudeProvider(home).createFollower(followed, 0)
  await follower.next()
  await writeFile(followed, `${[user("u1", "Start"), lines[5], lines[6]].join("\n")}\n`)
  const update = await follower.next()
  assert.equal(update.replace, true, "the summary completes the boundary's marker rather than adding one")
  assert.equal(update.replaceFrom, 1)
  assert.deepEqual(update.entries.map((entry) => [entry.kind, entry.body]), [["event", "Summary:\n1. The user asked for a parser."]])
  console.log("PASS: Claude history reads compaction, queued prompts, task results, API errors, fallbacks and local commands as markers")

  const restoredFiles = join(home, "mixed-files.jsonl")
  const literal = "User attachment literal.pdf (application/pdf): /literal.pdf"
  const file = { name: "notes.md", mimeType: "text/markdown", path: "/fixture/notes.md" }
  await writeFile(restoredFiles, [
    record({ type: "user", uuid: "old-files", message: { role: "user", content: [text(literal), text("User attachment report.pdf (application/pdf): /fixture/report.pdf"), { type: "image", source: { type: "base64", media_type: "image/png", data: "image-bytes" } }] } }),
    record({ type: "user", uuid: "new-files", message: { role: "user", content: [text(appendPromptAttachments("Read notes", [file]))] } }),
    queued("queued-files", [text(appendPromptAttachments("Also read notes", [file]))], "prompt"),
    assistant("tool-owner", [{ type: "tool_use", id: "literal-tool", name: "Read", input: {} }]),
    record({ type: "user", uuid: "tool-output", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "literal-tool", content: [text(appendPromptAttachments("Literal tool output", [file]))] }] } }),
  ].join("\n") + "\n")
  const restored = await new ClaudeProvider(home).read(restoredFiles)
  const prompts = restored.entries.filter(entry => entry.kind === "user")
  assert.equal(prompts[0].text, literal, "first authored native part stays literal")
  assert.deepEqual(prompts[0].attachments.map(item => [item.name, item.source.kind]), [["image", "inline"], ["report.pdf", "file"]])
  assert.deepEqual(prompts.slice(1).map(entry => [entry.text, entry.attachments[0].name]), [["Read notes", "notes.md"], ["Also read notes", "notes.md"]])
  const tool = restored.entries.flatMap(entry => entry.kind === "assistant" ? entry.blocks : []).find(block => block.type === "tool")
  assert.equal(tool.output, appendPromptAttachments("Literal tool output", [file]), "user-role tool outputs are not attachment transport")
  console.log("PASS: Claude native mixed files, queued manifests, literal user examples and tool output boundaries")

  const planned = join(home, "planned.jsonl")
  await writeFile(planned, `${[
    user("u1", "Plan the parser"),
    assistant("a1", [{ type: "tool_use", id: "toolu_plan", name: "ExitPlanMode", input: { plan: "# Parser\n\n1. Move parsing." } }]),
  ].join("\n")}\n`)
  const plannedThread = await new ClaudeProvider(home).read(planned)
  assert.deepEqual(plannedThread.entries.flatMap((entry) => entry.kind === "assistant" ? entry.blocks : []).filter((block) => block.type === "proposed-plan"),
    [{ type: "proposed-plan", id: "toolu_plan", text: "# Parser\n\n1. Move parsing.", status: "proposed" }])
  console.log("PASS: Claude's saved ExitPlanMode reads as the live plan card")
} finally {
  await rm(home, { recursive: true, force: true })
}
