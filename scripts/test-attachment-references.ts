import assert from "node:assert/strict"
import {
  attachmentReference,
  attachmentRanges,
  mergeAttachmentDraft,
  removeAttachmentReference,
  removedAttachments,
  restoreAttachmentReferences,
  reusablePromptAttachments,
} from "../src/lib/attachment-references.ts"
import { formatBytes, type Attachment } from "../src/lib/attachments.ts"
import { sentDraft, writeDraft, recordLabel } from "../src/lib/context/draft.ts"
import { readSent } from "../src/lib/context/sent.ts"
import { chipLabel, draftView, editDraftView } from "../src/lib/draft-view.ts"
import { SavedAttachmentSchema } from "../src/lib/draft-persistence.ts"
import { PromptAttachmentSchema } from "@mako/host/contracts/prompt-attachments"

/**
 * A file stays the file it is from the draft to the agent and back: placed
 * by its anchor, removed whole, sent with its own path even beside another
 * of the same name, drawn and reused as itself.
 */

const image: Attachment = {
  id: "image",
  index: 1,
  name: "Screenshot @2x.png",
  mimeType: "image/png",
  size: 34,
  kind: "image",
  stagedPath: "/retained/nonce-Screenshot @2x.png",
}
const text: Attachment = {
  ...image,
  id: "text",
  index: 2,
  name: "notes.txt",
  mimeType: "text/plain",
  kind: "text",
  stagedPath: "/retained/notes.txt",
}
const labels = (items: readonly Attachment[]) =>
  new Map(items.map((item) => [attachmentReference(item), chipLabel(recordLabel(item))]))

/* An edit that reaches a chip removes the file ------------------------------ */

const draft = `Compare ${attachmentReference(image)} with ${attachmentReference(text)}.`
const view = draftView(draft, labels([image, text]))
assert.equal(view.text, "Compare @Screenshot @2x.png with @notes.txt.", "the textarea shows each file's name")
const [first] = view.spans
assert.ok(first)
for (const [after, caret] of [
  [view.text.slice(0, first.viewEnd - 1) + view.text.slice(first.viewEnd), first.viewEnd - 1],
  [view.text.slice(0, first.viewStart) + view.text.slice(first.viewStart + 1), first.viewStart],
  [view.text.slice(0, first.viewStart + 3) + view.text.slice(first.viewEnd - 3), first.viewStart + 3],
] as const) {
  const edited = editDraftView(draft, view, after, caret)
  assert.deepEqual(removedAttachments(edited.draft, [image, text]), ["image"])
  assert.equal(edited.draft, `Compare  with ${attachmentReference(text)}.`)
  const sent = writeDraft({ draft: edited.draft, records: [text] }).text
  assert.ok(!sent.includes(image.stagedPath!))
  assert.ok(!sent.includes(image.name))
  assert.ok(sent.includes(text.stagedPath!))
}
assert.equal(removeAttachmentReference(draft, [image, text], "image"), `Compare with ${attachmentReference(text)}.`)

/* Same names, different files ----------------------------------------------- */

const duplicate: Attachment = { ...text, id: "duplicate", index: 3, stagedPath: "/retained/other-notes.txt" }
const nested: Attachment = { ...text, id: "nested", index: 4, name: "report [notes.txt]", stagedPath: "/retained/report-notes.txt" }
for (const items of [[text, duplicate], [nested, text]]) {
  const body = items.map(attachmentReference).join(" then ")
  const sent = readSent(writeDraft({ draft: body, records: items }).text)
  assert.deepEqual(
    sent.items.flatMap((item) => (item.kind === "file" ? [item.file.path] : [])),
    items.map((item) => item.stagedPath),
    "send and transcript keep each file's identity rather than the first of its name"
  )
  const reused = sentDraft(sent)
  assert.deepEqual(
    attachmentRanges(reused.text, reused.records).map((range) => range.item.stagedPath),
    items.map((item) => item.stagedPath),
    "and Reuse places each where it stood"
  )
}

/* Reused files know only what was sent -------------------------------------- */

const reused = sentDraft(readSent(writeDraft({ draft: `See ${attachmentReference(image)}`, records: [{ ...image, size: undefined }] }).text)).records[0]
assert.ok(reused)
assert.equal(reused.name, image.name)
assert.equal(reused.mimeType, "image/png")
assert.equal(reused.stagedPath, image.stagedPath)
assert.equal(reused.size, undefined, "A native path is not evidence that a file is empty")
assert.equal(SavedAttachmentSchema.parse(reused).size, undefined)
assert.equal(PromptAttachmentSchema.parse(reused).size, undefined)

/* Drafts from before anchors ---------------------------------------------- */

const legacyImage = { ...image, reference: "[Screenshot @2x.png]" }
const legacyText = { ...text, reference: "[notes.txt]" }
const legacyNested = { ...nested, reference: "[report [notes.txt]]" }
assert.equal(restoreAttachmentReferences("Look [Attachment 1]", [image]), `Look ${attachmentReference(image)}`)
assert.equal(
  restoreAttachmentReferences(`Compare ${legacyImage.reference} with ${legacyText.reference}.`, [legacyImage, legacyText]),
  `Compare ${attachmentReference(image)} with ${attachmentReference(text)}.`
)
assert.equal(
  restoreAttachmentReferences(`${legacyNested.reference} then ${legacyText.reference}`, [legacyText, legacyNested]),
  `${attachmentReference(nested)} then ${attachmentReference(text)}`,
  "a label holding another is placed whole"
)
assert.equal(restoreAttachmentReferences("Paragraph", [image]), `Paragraph ${attachmentReference(image)} `)
assert.equal(attachmentReference(SavedAttachmentSchema.parse(image)), attachmentReference(image))

/* Buckets ----------------------------------------------------------------- */

const incoming = { ...text, id: "reused", stagedPath: "/retained/reused-notes.txt" }
const merged = mergeAttachmentDraft([text], [incoming])
assert.equal(new Set(merged.map((item) => item.index)).size, 2)
assert.equal(new Set(merged.map(attachmentReference)).size, 2)
assert.equal(merged[0], incoming)
assert.deepEqual(mergeAttachmentDraft(merged, [incoming]), merged)

const sparse = reusablePromptAttachments(
  [{ index: 2, name: text.name, path: text.stagedPath! }],
  [{ type: "attachment", name: "extra.txt", mimeType: "text/plain", source: { kind: "file", path: "/retained/extra.txt" } }]
)
assert.deepEqual(sparse.map((item) => item.index), [2, 3])
const withMedia = sentDraft(readSent(writeDraft({ draft: `See ${attachmentReference(text)}`, records: [text] }).text), [
  { type: "attachment", name: "extra.txt", mimeType: "text/plain", source: { kind: "file", path: "/retained/extra.txt" } },
])
assert.deepEqual(withMedia.records.map((item) => item.stagedPath), [text.stagedPath, "/retained/extra.txt"], "media the message carried come back as records")
assert.equal(attachmentRanges(withMedia.text, withMedia.records).length, 2, "each with a chip")

assert.equal(formatBytes(undefined), "Size unknown")
assert.equal(formatBytes(0), "0 B", "A known empty file remains distinguishable")
assert.equal(SavedAttachmentSchema.parse({ ...image, size: 0 }).size, 0)
assert.equal(PromptAttachmentSchema.parse({ ...image, size: 0 }).size, 0)
const onlyFiles = readSent(writeDraft({ draft: "", records: [image] }).text)
assert.equal(onlyFiles.body, "")
assert.equal(onlyFiles.items[0]?.kind === "file" && onlyFiles.items[0].file.name, image.name, "a message of files alone reads back")
console.log(
  "Attachment identity survives colliding filenames, nested labels, removal, send, transcript reading, and reuse"
)
