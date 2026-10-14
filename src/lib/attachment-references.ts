import { classify } from "./attachment-kind"
import type { Attachment, AttachmentFileReference } from "./attachments"
import { contextAnchor, tokenize } from "./mentions"
import type { AttachmentContent } from "@mako/sessions"
import { mediaTypeForPath } from "./transcript-media"

/**
 * Where each context record sits in a draft.
 *
 * A record (a file, a snapshot, a comment on lines, a picked element…) is
 * placed by its anchor, `@ctx:<id>`, and the textarea shows its label there
 * (`draftView`). Drafts saved before October 12 placed a file by its label
 * in brackets, `[report.pdf]` or `[report.pdf (2)]`, and a sent prompt read
 * back by `[Attachment N]`; `restoreAttachmentReferences` turns both into
 * anchors, so nothing else reads them.
 */

/** A record's anchor: what the draft holds where its chip stands. */
export function attachmentReference(item: Pick<Attachment, "id">): string {
  return contextAnchor(item.id)
}

/** How a draft from before anchors placed this record. */
function legacyReference(item: Pick<Attachment, "index" | "reference" | "name" | "contextLabel">): string {
  if (item.reference?.startsWith("[")) return item.reference
  return `[${item.contextLabel ?? item.name}${item.index > 1 ? ` (${item.index})` : ""}]`
}

export interface AttachmentRange {
  item: Attachment
  start: number
  end: number
}

/** Each anchor in `text` that places one of `items`, in order. */
export function attachmentRanges(
  text: string,
  items: readonly Attachment[]
): AttachmentRange[] {
  const byId = new Map(items.map((item) => [item.id, item]))
  const ranges: AttachmentRange[] = []
  let at = 0
  for (const segment of tokenize(text)) {
    const length = segment.kind === "text" ? segment.text.length : segment.raw.length
    if (segment.kind === "context") {
      const item = byId.get(segment.id)
      if (item) ranges.push({ item, start: at, end: at + length })
    }
    at += length
  }
  return ranges
}

/** `text` without the record's anchor, and the space that followed it. */
export function removeAttachmentReference(
  text: string,
  items: readonly Attachment[],
  id: string
): string {
  return attachmentRanges(text, items)
    .filter((range) => range.item.id === id)
    .reduceRight(
      (body, range) =>
        body.slice(0, range.start) +
        body.slice(body[range.end] === " " ? range.end + 1 : range.end),
      text
    )
}

/** The records `text` no longer places, from those it did. */
export function removedAttachments(
  text: string,
  items: readonly Attachment[]
): string[] {
  const present = new Set(attachmentRanges(text, items).map((range) => range.item.id))
  return items.filter((item) => !present.has(item.id)).map((item) => item.id)
}

/**
 * The draft with every record placed by its anchor: a sent prompt's
 * `[Attachment N]` and an older draft's `[label]` become anchors, and a
 * record the text doesn't place is added at its end, so no file is attached
 * without a chip that says so.
 */
export function restoreAttachmentReferences(
  text: string,
  items: readonly Attachment[]
): string {
  if (items.length === 0) return text
  const byIndex = new Map(items.map((item) => [`[Attachment ${item.index}]`, item]))
  let restored = text.replace(/\[Attachment \d+\]/g, (found) => {
    const item = byIndex.get(found)
    return item ? attachmentReference(item) : found
  })
  // Longest first, so `[report [notes.txt]]` is placed before `[notes.txt]`
  // could be found inside it.
  for (const item of items.toSorted((a, b) => legacyReference(b).length - legacyReference(a).length)) {
    const legacy = legacyReference(item)
    if (restored.includes(legacy)) restored = restored.split(legacy).join(attachmentReference(item))
  }
  const present = new Set(attachmentRanges(restored, items).map((range) => range.item.id))
  const missing = items.filter((item) => !present.has(item.id)).map(attachmentReference)
  return missing.length
    ? `${restored}${restored && !/\s$/.test(restored) ? " " : ""}${missing.join(" ")} `
    : restored
}

/** Two buckets as one, each record once, each with its own index. */
export function mergeAttachmentDraft(
  current: readonly Attachment[],
  incoming: readonly Attachment[]
): Attachment[] {
  const ids = new Set(incoming.map((item) => item.id))
  const combined = [...incoming, ...current.filter((item) => !ids.has(item.id))]
  const indices = new Set<number>()
  let nextIndex = Math.max(0, ...combined.map((item) => item.index)) + 1
  return combined.map((item) => {
    const index = indices.has(item.index) ? nextIndex++ : item.index
    indices.add(index)
    return index === item.index ? item : { ...item, index }
  })
}

/**
 * Records pasted into a draft get ids of their own, and the pasted text's
 * anchors follow them, so pasting the same chips twice makes two chips.
 * Text from an older Mako placed them by label; that is restored first.
 */
export function pasteAttachmentDraft(text: string, incoming: readonly Attachment[], reserved: readonly Attachment[]) {
  let nextIndex = Math.max(0, ...reserved.map((item) => item.index)) + 1
  const replacements = new Map<string, Attachment>()
  const attachments = incoming.map((item) => {
    const pasted: Attachment = { ...item, id: crypto.randomUUID(), index: nextIndex++, preview: undefined }
    delete pasted.reference
    replacements.set(item.id, pasted)
    return pasted
  })
  const placed = restoreAttachmentReferences(text, incoming)
  return {
    text: attachmentRanges(placed, incoming).reduceRight(
      (body, range) =>
        body.slice(0, range.start) + attachmentReference(replacements.get(range.item.id)!) + body.slice(range.end),
      placed
    ),
    attachments,
  }
}

/**
 * Records for a sent prompt's files, to put them in a draft again: the files
 * its context named, and any the message carried as media without a name in
 * its words.
 */
export function reusablePromptAttachments(
  files: readonly AttachmentFileReference[],
  media: readonly AttachmentContent[]
): Array<Attachment & { stagedPath: string }> {
  const references = [...files]
  const paths = new Set(files.map((file) => file.path))
  let nextIndex = Math.max(0, ...files.map((file) => file.index)) + 1
  for (const attachment of media) {
    if (attachment.source.kind === "file" && !paths.has(attachment.source.path)) {
      paths.add(attachment.source.path)
      references.push({ index: nextIndex++, name: attachment.name, path: attachment.source.path })
    }
  }
  return references.map((file) => {
    const original = media.find(
      (attachment) => attachment.source.kind === "file" && attachment.source.path === file.path
    )
    const mimeType =
      original?.mimeType ?? file.mimeType ?? mediaTypeForPath(file.path) ?? "application/octet-stream"
    return {
      id: `reuse:${file.index}:${file.path}`,
      index: file.index,
      name: file.name,
      mimeType,
      kind: classify({ type: mimeType, name: file.name }),
      stagedPath: file.path,
      contextPath: file.contextPath,
    }
  })
}
