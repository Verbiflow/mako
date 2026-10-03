import assert from "node:assert/strict"
import {
  attachmentReference,
  attachmentRanges,
  editAttachmentReferences,
  removeAttachmentReference,
  restoreAttachmentReferences,
  namedAttachmentReference,
  attachmentPromptSegments,
  reusablePromptAttachments,
  mergeAttachmentDraft,
} from "../src/lib/attachment-references.ts"
import {
  buildForeignPrompt,
  buildPrompt,
  parseAttachmentAppendix,
  formatBytes,
  type Attachment,
} from "../src/lib/attachments.ts"
import { SavedAttachmentSchema } from "../src/lib/draft-persistence.ts"
import { PromptAttachmentSchema } from "../electron/contracts/prompt-attachments.ts"

const image: Attachment = {
  id: "image",
  index: 1,
  name: "Screenshot @2x.png",
  reference: "[Screenshot @2x.png]",
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
  reference: "[notes.txt]",
  mimeType: "text/plain",
  kind: "text",
  stagedPath: "/retained/notes.txt",
}
const draft = `Compare ${image.reference} with ${text.reference}.`
const [first, second] = attachmentRanges(draft, [image, text])
assert.ok(first && second)
for (const after of [
  draft.slice(0, first.end - 1) + draft.slice(first.end),
  draft.slice(0, first.start) + draft.slice(first.start + 1),
  draft.slice(0, first.start + 3) + draft.slice(first.end - 3),
]) {
  const edited = editAttachmentReferences(draft, after, [image, text])
  assert.deepEqual(edited.removed, ["image"])
  assert.equal(edited.text, `Compare  with ${text.reference}.`)
  const sent = buildForeignPrompt(edited.text, [text])
  assert.ok(!sent.includes(image.stagedPath!))
  assert.ok(!sent.includes(image.name))
  assert.ok(sent.includes(text.stagedPath!))
}
const replaced = editAttachmentReferences(
  draft,
  draft.slice(0, first.start + 2) + "replacement" + draft.slice(second.end - 2),
  [image, text]
)
assert.equal(replaced.text, "Compare replacement.")
assert.deepEqual(replaced.removed, ["image", "text"])
assert.equal(
  editAttachmentReferences(draft, draft + " More text.", [image, text]).text,
  draft + " More text."
)
assert.equal(
  attachmentReference(SavedAttachmentSchema.parse(image)),
  image.reference
)
assert.equal(
  restoreAttachmentReferences("Look [Attachment 1]", [image]),
  `Look ${image.reference}`
)
assert.equal(
  namedAttachmentReference(image.name, 2, [image.reference!]),
  "[Screenshot @2x.png (2)]"
)

for (const body of [draft, "Compare [Attachment 1] with [Attachment 2]."]) {
  const parsed = parseAttachmentAppendix(
    buildForeignPrompt(body, [image, text])
  )
  const segments = attachmentPromptSegments(parsed.body, parsed.files)
  assert.deepEqual(
    segments
      .filter((part) => part.kind === "attachment")
      .map((part) => part.file.name),
    [image.name, text.name]
  )
  assert.ok(
    !segments.some(
      (part) => part.kind === "text" && part.text.includes("[Attachment")
    )
  )
  const reusable = reusablePromptAttachments(parsed.files, [])
  assert.equal(reusable[0]?.name, image.name)
  assert.equal(reusable[0]?.mimeType, "image/png")
  assert.equal(reusable[0]?.stagedPath, image.stagedPath)
  assert.equal(reusable[0]?.size, undefined, "A native path is not evidence that a file is empty")
  assert.equal(SavedAttachmentSchema.parse(reusable[0]).size, undefined)
  assert.equal(PromptAttachmentSchema.parse(reusable[0]).size, undefined)
  assert.ok(
    buildForeignPrompt(
      restoreAttachmentReferences(parsed.body, reusable),
      reusable
    ).includes(image.stagedPath!)
  )
}
const collisionNames = [
  "notes.txt",
  "notes.txt (3)",
  "notes.txt",
  "notes.txt (4)",
  "notes.txt",
]
const collisionReferences: string[] = []
for (const [index, name] of collisionNames.entries()) {
  const reference = namedAttachmentReference(
    name,
    index + 1,
    collisionReferences
  )
  assert.ok(
    !collisionReferences.includes(reference),
    `${reference} must identify exactly one file`
  )
  collisionReferences.push(reference)
}

const nested: Attachment = {
  ...text,
  id: "nested",
  index: 3,
  name: "report [notes.txt]",
  reference: "[report [notes.txt]]",
  stagedPath: "/retained/report-notes.txt",
}
const nestedDraft = `${nested.reference} then ${text.reference}`
assert.deepEqual(
  attachmentRanges(nestedDraft, [text, nested]).map((range) => range.item.id),
  [nested.id, text.id]
)
const nestedEdit = editAttachmentReferences(nestedDraft, nestedDraft.slice(1), [
  text,
  nested,
])
assert.equal(nestedEdit.text, ` then ${text.reference}`)
assert.deepEqual(nestedEdit.removed, [nested.id])
assert.equal(
  removeAttachmentReference(nestedDraft, [text, nested], text.id),
  `${nested.reference} then `
)
assert.equal(
  removeAttachmentReference(nestedDraft, [text, nested], nested.id),
  ` then ${text.reference}`
)
assert.equal(
  restoreAttachmentReferences(nested.reference!, [text, nested]),
  `${nested.reference}\n${text.reference}`
)
const repeated = `${text.reference} ${text.reference}`
assert.deepEqual(editAttachmentReferences(repeated, "", [text]).removed, [
  text.id,
])
assert.deepEqual(
  editAttachmentReferences(repeated, text.reference!, [text]).removed,
  []
)

const duplicate: Attachment = {
  ...text,
  id: "duplicate",
  index: 3,
  stagedPath: "/retained/other-notes.txt",
}
const olderDuplicate = { ...text, reference: "[notes.txt (2)]" }
for (const items of [
  [olderDuplicate, duplicate],
  [text, nested],
]) {
  const body = items.map(attachmentReference).join(" then ")
  for (const sent of [
    buildForeignPrompt(body, items),
    buildPrompt(body, items).text,
  ]) {
    const parsed = parseAttachmentAppendix(sent)
    const segments = attachmentPromptSegments(parsed.body, parsed.files)
    assert.deepEqual(
      segments
        .filter((segment) => segment.kind === "attachment")
        .map((segment) => segment.file.path),
      items.map((item) => item.stagedPath),
      "Send and transcript must preserve file identity rather than matching the first filename"
    )
    const restored = reusablePromptAttachments(parsed.files, [])
    const restoredText = restoreAttachmentReferences(parsed.body, restored)
    assert.deepEqual(
      attachmentRanges(restoredText, restored).map(
        (range) => range.item.stagedPath
      ),
      items.map((item) => item.stagedPath)
    )
  }
}

const incoming = {
  ...text,
  id: "reused",
  stagedPath: "/retained/reused-notes.txt",
}
const merged = mergeAttachmentDraft([text], [incoming])
assert.equal(new Set(merged.map((item) => item.index)).size, 2)
assert.equal(new Set(merged.map(attachmentReference)).size, 2)
assert.equal(merged[0], incoming)
assert.deepEqual(mergeAttachmentDraft(merged, [incoming]), merged)
const mergedText = restoreAttachmentReferences(incoming.reference!, merged)
const mergedPrompt = parseAttachmentAppendix(
  buildForeignPrompt(mergedText, merged)
)
assert.deepEqual(
  attachmentPromptSegments(mergedPrompt.body, mergedPrompt.files)
    .filter((part) => part.kind === "attachment")
    .map((part) => part.file.path),
  merged.map((item) => item.stagedPath)
)

const sparse = reusablePromptAttachments(
  [{ index: 2, name: text.name, path: text.stagedPath! }],
  [
    {
      type: "attachment",
      name: "extra.txt",
      mimeType: "text/plain",
      source: { kind: "file", path: "/retained/extra.txt" },
    },
  ]
)
assert.deepEqual(
  sparse.map((item) => item.index),
  [2, 3]
)

const onlyFiles = parseAttachmentAppendix(buildForeignPrompt("", [image]))
assert.equal(formatBytes(undefined), "Size unknown")
assert.equal(formatBytes(0), "0 B", "A known empty file remains distinguishable")
assert.equal(SavedAttachmentSchema.parse({ ...image, size: 0 }).size, 0)
assert.equal(PromptAttachmentSchema.parse({ ...image, size: 0 }).size, 0)
assert.equal(onlyFiles.body, "")
assert.equal(onlyFiles.files[0]?.name, image.name)
assert.equal(
  restoreAttachmentReferences("Paragraph", [image]),
  `Paragraph\n${image.reference}`
)
console.log(
  "Attachment identity survives colliding filenames, nested references, removal, send, transcript rendering, and reuse"
)
