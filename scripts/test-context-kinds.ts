import assert from "node:assert/strict"
import {
  attachmentRanges,
  attachmentReference,
  pasteAttachmentDraft,
  removeAttachmentReference,
  restoreAttachmentReferences,
} from "../src/lib/attachment-references"
import type { Attachment } from "../src/lib/attachments"
import type { ContextDetail } from "../src/lib/context-detail"
import { sentDraft, writeDraft } from "../src/lib/context/draft"
import { readSent } from "../src/lib/context/sent"
import { MARKER, readMessage } from "../src/lib/context/wire"
import { contextAnchor, threadToken, tokenize } from "../src/lib/mentions"

/**
 * Every kind of context through the one format: a draft written as the
 * message an agent receives, read back, and turned into the same draft.
 * Prompts from before the format read the same way.
 */

const comment: ContextDetail = {
  kind: "comment",
  path: "src/components/inspector/review.tsx",
  startLine: 200,
  endLine: 208,
  side: "new",
  source: "diff",
  base: "HEAD",
  code: "  const notes = review.notes\n\n  return notes.length > 0 ? notes : null",
  comment: "This drops the note the person was typing.",
}
const element: ContextDetail = {
  kind: "element",
  url: "http://localhost:5173/checkout",
  title: "Checkout",
  tag: "button",
  selector: "#pay > button.primary",
  role: "button",
  name: "Pay now",
  html: '<button class="primary">Pay now</button>',
  styles: "font-size: 14px\npadding: 8px 12px",
  box: { x: 12, y: 340, width: 120, height: 36 },
  component: "PayButton",
  source: { file: "src/checkout/pay-button.tsx", line: 18, column: 5 },
  comment: "Make it the full width of the card.",
}
const quote: ContextDetail = {
  kind: "quote",
  text: "Restoring a draft on that promise overwrites the paragraph\nthe user has since typed.",
  messageId: "msg-41",
  conversation: { harness: "cursor", id: "chats:ws:e50f", title: "Drafts" },
}
const pull: ContextDetail = {
  kind: "pull-request",
  number: 12,
  title: "Context chips in one format",
  url: "https://github.com/Verbiflow/mako/pull/12",
  state: "open",
  draft: true,
  head: "context-chips",
  base: "main",
  author: "kashyab",
  repository: "Verbiflow/mako",
}

function record(id: string, detail: ContextDetail, label: string, stagedPath?: string): Attachment {
  return { id, index: 1, name: label, contextLabel: label, mimeType: stagedPath ? "image/png" : "text/plain", kind: stagedPath ? "image" : "text", detail, stagedPath }
}

const file: Attachment = { id: "f1", index: 1, name: "report.pdf", mimeType: "application/pdf", size: 2048, kind: "binary", stagedPath: "/staged/report.pdf" }
const shot: Attachment = { id: "f2", index: 2, name: "Appshot Safari.png", mimeType: "image/png", size: 99, kind: "image", stagedPath: "/staged/shot.png", contextPath: "/staged/shot.png.context.txt" }
const terminal: Attachment = { id: "f3", index: 3, name: "zsh selection.txt", contextLabel: "zsh selection", origin: "terminal", mimeType: "text/plain", size: 10, kind: "text", stagedPath: "/staged/zsh.txt" }
const records = [
  file,
  shot,
  terminal,
  record("c1", comment, "review.tsx:200–208"),
  record("e1", element, "PayButton", "/staged/pay.png"),
  record("q1", quote, "“Restoring a draft on that…”"),
  record("p1", pull, "#12 Context chips in one format"),
]
const token = threadToken("cursor", "e50f2b71")
const draft = [
  `/review-skill Compare ${token} with ${attachmentReference(file)}, see ${attachmentReference(shot)}`,
  `and ${attachmentReference(terminal)}. ${attachmentReference(records[3]!)} ${attachmentReference(records[4]!)}`,
  `${attachmentReference(records[5]!)} ${attachmentReference(records[6]!)} @src/lib/a.ts twice ${token}`,
].join("\n")

const written = writeDraft({
  draft,
  records,
  conversations: new Map([[token, { ref: token.slice(1), context: { kind: "file", file: "/bundles/abc/transcript.md", title: "Take a look at the chips", harness: "cursor" } }]]),
  plans: [{ type: "proposed-plan", id: "plan-1", text: "# Plan: Fix chips\n\n1. Do it", status: "proposed" }],
  skills: [{ name: "review-skill", from: "claude", body: "Handed over from Claude Code's skills.\n\nDo the review." }],
})

/* What the agent reads ---------------------------------------------------- */

const wire = readMessage(written.text)
assert.equal(
  wire.body,
  [
    "/review-skill Compare [Conversation 1: Take a look at the chips] with [File 2: report.pdf], see [Image 3: Appshot Safari.png]",
    "and [Terminal output 4: zsh selection]. [Comment 5: review.tsx:200–208] [Element 6: PayButton]",
    "[Quote 7: “Restoring a draft on that…”] [Pull request 8: #12 Context chips in one format] @src/lib/a.ts twice [Conversation 1: Take a look at the chips]",
  ].join("\n"),
  "each chip is its marker, numbered as it stands; a conversation named twice is one item; typed references stay as typed"
)
assert.deepEqual(wire.items.map((item) => item.kind), ["conversation", "file", "file", "file", "comment", "element", "quote", "pull-request", "plan", "skill"])
assert.match(written.text, /Transcript bundle: \/bundles\/abc\/transcript\.md/)
assert.match(written.text, /<item n="5" kind="comment" path="src\/components\/inspector\/review.tsx" lines="200-208" side="new" source="diff" base="HEAD">\ncomment: This drops/)
assert.match(written.text, /code:\n {4}const notes = review.notes\n  \n {4}return notes/, "code keeps its indentation and blank lines inside its field")
assert.match(written.text, /<item n="6" kind="element" url="http:\/\/localhost:5173\/checkout" title="Checkout" tag="button" selector="#pay > button.primary" role="button" name="Pay now" component="PayButton" source="src\/checkout\/pay-button.tsx:18:5" box="12,340,120,36" screenshot="\/staged\/pay.png">/)
assert.match(written.text, /&lt;button class="primary">Pay now&lt;\/button>|<button class="primary">Pay now<\/button>/)
assert.deepEqual(written.files.map((item) => item.id), ["f1", "f2", "f3", "e1"], "files and an element's crop go to the agent as files too")

/* Read back --------------------------------------------------------------- */

const sent = readSent(written.text)
assert.equal(sent.body, wire.body)
const details = sent.items.flatMap((item) => (item.kind === "detail" ? [item.detail] : []))
assert.deepEqual(details, [comment, element, quote, pull], "every detail reads back exactly")
const element6 = sent.items.find((item) => item.n === 6)
assert.equal(element6?.kind === "detail" && element6.screenshot, "/staged/pay.png")
assert.equal(element6?.kind === "detail" && element6.label, "PayButton")
const files = sent.items.flatMap((item) => (item.kind === "file" ? [item.file] : []))
assert.deepEqual(files, [
  { name: "report.pdf", mimeType: "application/pdf", size: 2048, path: "/staged/report.pdf" },
  { name: "Appshot Safari.png", mimeType: "image/png", size: 99, path: "/staged/shot.png", contextPath: "/staged/shot.png.context.txt" },
  { name: "zsh selection.txt", mimeType: "text/plain", size: 10, path: "/staged/zsh.txt", label: "zsh selection", origin: "terminal" },
])
const conversation = sent.items.find((item) => item.kind === "conversation")
assert.deepEqual(conversation?.kind === "conversation" && conversation.conversation, { ref: token.slice(1), harness: "cursor", title: "Take a look at the chips" })
assert.deepEqual(sent.items.find((item) => item.kind === "skill"), { n: 10, kind: "skill", skill: { name: "review-skill", from: "claude" } })
assert.equal(sent.items.find((item) => item.kind === "plan")?.kind, "plan")

/* And back into a draft --------------------------------------------------- */

const again = sentDraft(sent)
assert.equal(again.records.length, 7)
assert.equal(again.plans.length, 1)
const anchors = tokenize(again.text).filter((segment) => segment.kind === "context").length
assert.equal(anchors, 7, "every record is placed by its anchor")
assert.ok(again.text.includes(token), "a conversation comes back as its token")
assert.ok(again.text.startsWith("/review-skill Compare "), "the words are the words")
assert.deepEqual(again.records.flatMap((item) => (item.detail ? [item.detail] : [])), [comment, element, quote, pull])
assert.equal(again.byItem.get(6)?.stagedPath, "/staged/pay.png")
const rewritten = writeDraft({
  draft: again.text,
  records: again.records,
  conversations: new Map([[token, { ref: token.slice(1), context: { kind: "file", file: "/bundles/abc/transcript.md", title: "Take a look at the chips", harness: "cursor" } }]]),
  plans: again.plans,
  skills: [{ name: "review-skill", from: "claude", body: "Handed over from Claude Code's skills.\n\nDo the review." }],
})
assert.equal(readMessage(rewritten.text).body, wire.body, "Reuse sends the same words and markers again")

/* Plain copies and anchors ---------------------------------------------------- */

assert.equal(
  writeDraft({ draft: `see ${attachmentReference(file)} and ${token}`, records, tokens: true }).text.split("\n")[0],
  `see [File 1: report.pdf] and ${token}`,
  "a copy keeps a conversation's token for pasting back"
)
assert.ok(contextAnchor("a.b!(c)").endsWith("a%2Eb%21%28c%29"), "an anchor's id can't end in sentence punctuation")
assert.deepEqual(
  tokenize(`${attachmentReference(file)}, then`).map((segment) => segment.kind),
  ["context", "text"],
  "a comma after a chip stays prose"
)
assert.deepEqual(attachmentRanges(`a ${attachmentReference(file)} b`, records).map((range) => [range.start, range.item.id]), [[2, "f1"]])
assert.equal(removeAttachmentReference(`a ${attachmentReference(file)} b`, records, "f1"), "a b")

/* Drafts and prompts from before the format --------------------------------- */

const legacyFile: Attachment = { id: "old", index: 2, name: "notes.md", reference: "[notes.md (2)]", mimeType: "text/markdown", kind: "text", stagedPath: "/staged/notes.md" }
assert.equal(
  restoreAttachmentReferences("Read [notes.md (2)] and [Attachment 2] now", [legacyFile]),
  `Read ${attachmentReference(legacyFile)} and ${attachmentReference(legacyFile)} now`,
  "a saved draft's labels and a sent prompt's placeholders become anchors"
)
assert.equal(restoreAttachmentReferences("no chip", [legacyFile]), `no chip ${attachmentReference(legacyFile)} `, "a record the words don't place gets a chip at the end")

const pasted = pasteAttachmentDraft(`x ${attachmentReference(file)}`, [file], [file])
assert.notEqual(pasted.attachments[0]!.id, "f1", "pasted records get ids of their own")
assert.equal(pasted.text, `x ${attachmentReference(pasted.attachments[0]!)}`)

const legacy = [
  "Compare [Referenced conversation 1] with [Attachment 1] and [Attachment 2]",
  "",
  "<mako-plan-context>",
  JSON.stringify([{ type: "proposed-plan", id: "p", text: "# Plan", status: "proposed" }]),
  "</mako-plan-context>",
].join("\n")
const oldPrompt = [
  "Compare [Referenced conversation 1] with [Attachment 1] and [Attachment 2]",
  "",
  "---",
  "[Attachment 1] report.pdf — application/pdf, 2 KB. Saved at /staged/report.pdf; read it from there.",
  "",
  "[Attachment 2] shot.png — image/png, 99 B. Saved at /staged/shot.png; read it from there.",
  "---",
  `[Referenced conversation 1] Take a look (cursor) — ${token}`,
  "",
  "Local transcript bundle: /bundles/abc/transcript.md",
  "",
  "---",
  "[Skill review-skill from claude] Handed over.",
].join("\n")
const old = readSent(oldPrompt)
assert.equal(old.body, "Compare [Conversation 1: Take a look] with [File 2: report.pdf] and [Image 3: shot.png]", "an old prompt reads with markers, numbered as its placeholders stand")
assert.deepEqual(old.items.map((item) => item.kind), ["conversation", "file", "file", "skill"])
const oldConversation = old.items[0]
assert.equal(oldConversation?.kind === "conversation" && oldConversation.conversation.ref, token.slice(1))
assert.equal(readSent(legacy).items.filter((item) => item.kind === "plan").length, 1, "an old plan block reads as a plan item")
assert.deepEqual([...old.body.matchAll(MARKER)].map((match) => Number(match[2])), [1, 2, 3])
assert.deepEqual(readSent("I typed [Attachment 9] and [Referenced conversation 4] myself"), { body: "I typed [Attachment 9] and [Referenced conversation 4] myself", items: [] }, "placeholders with nothing behind them are words")

console.log("context kinds ok")
