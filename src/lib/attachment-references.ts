import type { Attachment, AttachmentFileReference } from "./attachments"
import { tokenize, type Segment } from "./mentions"
import type { AttachmentContent } from "@mako/sessions"
import { mediaTypeForPath } from "./transcript-media"

export function attachmentReference(
  item: Pick<Attachment, "index" | "reference" | "name" | "contextLabel">
): string {
  return (
    item.reference ??
    `[${item.contextLabel ?? item.name}${item.index > 1 ? ` (${item.index})` : ""}]`
  )
}

export function namedAttachmentReference(
  name: string,
  index: number,
  used: readonly string[]
): string {
  const label = name.replace(/[\r\n]/g, " ")
  let reference = `[${label}]`
  let suffix = index
  while (used.includes(reference)) reference = `[${label} (${suffix++})]`
  return reference
}

export interface AttachmentRange {
  item: Attachment
  start: number
  end: number
}

export function attachmentRanges(
  text: string,
  items: readonly Attachment[]
): AttachmentRange[] {
  const ranges = items
    .flatMap((item) => {
      const reference = attachmentReference(item)
      const ranges: AttachmentRange[] = []
      let start = text.indexOf(reference)
      while (start !== -1) {
        ranges.push({ item, start, end: start + reference.length })
        start = text.indexOf(reference, start + reference.length)
      }
      return ranges
    })
    .sort((left, right) => left.start - right.start || right.end - left.end)
  let end = 0
  return ranges.filter((range) => {
    if (range.start < end) return false
    end = range.end
    return true
  })
}

export function attachmentPromptText(
  text: string,
  items: readonly Attachment[]
): string {
  return attachmentRanges(text, items).reduceRight(
    (body, range) =>
      body.slice(0, range.start) +
      `[Attachment ${range.item.index}]` +
      body.slice(range.end),
    text
  )
}

export function removeAttachmentReference(
  text: string,
  items: readonly Attachment[],
  id: string
): string {
  return attachmentRanges(text, items)
    .filter((range) => range.item.id === id)
    .reduceRight(
      (body, range) => body.slice(0, range.start) + body.slice(range.end),
      text
    )
}

/** A partial edit of a file reference edits the whole attachment. */
export function editAttachmentReferences(
  before: string,
  after: string,
  items: readonly Attachment[]
) {
  let start = 0
  while (
    start < before.length &&
    start < after.length &&
    before[start] === after[start]
  )
    start++
  let end = before.length
  let nextEnd = after.length
  while (
    end > start &&
    nextEnd > start &&
    before[end - 1] === after[nextEnd - 1]
  ) {
    end--
    nextEnd--
  }
  const touched = attachmentRanges(before, items).filter((range) =>
    start === end
      ? range.start < start && range.end > start
      : range.start < end && range.end > start
  )
  if (!touched.length) return { text: after, removed: [], caret: nextEnd }
  const from = Math.min(start, ...touched.map((range) => range.start))
  const to = Math.max(end, ...touched.map((range) => range.end))
  const insertion = after.slice(start, nextEnd)
  const text = before.slice(0, from) + insertion + before.slice(to)
  const remaining = new Set(
    attachmentRanges(text, items).map((range) => range.item.id)
  )
  return {
    text,
    removed: [...new Set(touched.map((range) => range.item.id))].filter(
      (id) => !remaining.has(id)
    ),
    caret: from + insertion.length,
  }
}

export function restoreAttachmentReferences(
  text: string,
  items: readonly Attachment[]
): string {
  const references = new Map(
    items.map((item) => [
      `[Attachment ${item.index}]`,
      attachmentReference(item),
    ])
  )
  const restored = text.replace(
    /\[Attachment \d+\]/g,
    (reference) => references.get(reference) ?? reference
  )
  const present = new Set(
    attachmentRanges(restored, items).map((range) => range.item.id)
  )
  const missing = items
    .filter((item) => !present.has(item.id))
    .map(attachmentReference)
  return missing.length
    ? `${restored}${restored && !restored.endsWith("\n") ? "\n" : ""}${missing.join(" ")}`
    : restored
}

export function attachmentPromptSegments(
  text: string,
  files: readonly AttachmentFileReference[]
): (Segment | { kind: "attachment"; file: AttachmentFileReference })[] {
  const matches = files
    .flatMap((file) => {
      const references = [
        `[Attachment ${file.index}]`,
        `[${file.name}]`,
        `[${file.name} (${file.index})]`,
      ]
      return references.flatMap((reference) => {
        const found = []
        let start = text.indexOf(reference)
        while (start !== -1) {
          found.push({ start, end: start + reference.length, file })
          start = text.indexOf(reference, start + reference.length)
        }
        return found
      })
    })
    .sort((left, right) => left.start - right.start)
  const segments: (
    Segment | { kind: "attachment"; file: AttachmentFileReference }
  )[] = []
  let cursor = 0
  for (const match of matches) {
    if (match.start < cursor) continue
    segments.push(...tokenize(text.slice(cursor, match.start), cursor === 0), {
      kind: "attachment",
      file: match.file,
    })
    cursor = match.end
  }
  return [...segments, ...tokenize(text.slice(cursor), cursor === 0)]
}

export function mergeAttachmentDraft(
  current: readonly Attachment[],
  incoming: readonly Attachment[]
): Attachment[] {
  const ids = new Set(incoming.map((item) => item.id))
  const combined = [...incoming, ...current.filter((item) => !ids.has(item.id))]
  const indices = new Set<number>()
  const references: string[] = []
  let nextIndex = Math.max(0, ...combined.map((item) => item.index)) + 1
  return combined.map((item) => {
    const index = indices.has(item.index) ? nextIndex++ : item.index
    const original = attachmentReference(item)
    const reference = references.includes(original)
      ? namedAttachmentReference(item.contextLabel ?? item.name, index, references)
      : original
    indices.add(index)
    references.push(reference)
    return index === item.index && reference === original
      ? item
      : { ...item, index, reference }
  })
}

export function pasteAttachmentDraft(text: string, incoming: readonly Attachment[], reserved: readonly Attachment[]) {
  const used = reserved.map(attachmentReference)
  let nextIndex = Math.max(0, ...reserved.map(item => item.index)) + 1
  const replacements = new Map<string, Attachment>()
  const attachments = incoming.map(item => {
    const index = nextIndex++
    const reference = namedAttachmentReference(item.contextLabel ?? item.name, index, used)
    used.push(reference)
    const pasted = { ...item, id: crypto.randomUUID(), index, reference, preview: undefined }
    replacements.set(item.id, pasted)
    return pasted
  })
  return {
    text: attachmentRanges(text, incoming).reduceRight((body, range) =>
      body.slice(0, range.start) + attachmentReference(replacements.get(range.item.id)!) + body.slice(range.end), text),
    attachments,
  }
}

export function reusablePromptAttachments(
  files: readonly AttachmentFileReference[],
  media: readonly AttachmentContent[]
): Array<Attachment & { stagedPath: string }> {
  const references = [...files]
  const paths = new Set(files.map((file) => file.path))
  let nextIndex = Math.max(0, ...files.map((file) => file.index)) + 1
  for (const attachment of media) {
    if (
      attachment.source.kind === "file" &&
      !paths.has(attachment.source.path)
    ) {
      paths.add(attachment.source.path)
      references.push({
        index: nextIndex++,
        name: attachment.name,
        path: attachment.source.path,
      })
    }
  }
  const result: Array<Attachment & { stagedPath: string }> = []
  for (const file of references) {
    const original = media.find(
      (attachment) =>
        attachment.source.kind === "file" &&
        attachment.source.path === file.path
    )
    const mimeType =
      original?.mimeType ?? file.mimeType ?? mediaTypeForPath(file.path) ?? "application/octet-stream"
    result.push({
      id: `reuse:${file.index}:${file.path}`,
      index: file.index,
      reference: namedAttachmentReference(
        file.name,
        file.index,
        result.map(attachmentReference)
      ),
      name: file.name,
      mimeType,
      size: 0,
      kind: mimeType.startsWith("image/") ? "image" : "binary",
      stagedPath: file.path,
      contextPath: file.contextPath,
    })
  }
  return result
}
