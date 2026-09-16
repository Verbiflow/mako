import type { PhrasingContent, Root } from "mdast"
import { visit } from "unist-util-visit"
import { attachmentPromptSegments } from "./attachment-references"
import type { AttachmentFileReference } from "./attachments"
import type { ThreadAppendixEntry } from "./thread-references"

type PromptSegment = ReturnType<typeof attachmentPromptSegments>[number]

/**
 * A conversation a sent prompt referenced without a token to draw the chip
 * from: prompts sent before the appendix carried one keep only the title
 * and harness their heading named, and the placeholder reads as that.
 */
export interface ThreadTitleReference {
  kind: "thread-title"
  number: number
  title: string
  harness?: string
}

export type PromptReference =
  | Exclude<PromptSegment, { kind: "text" }>
  | ThreadTitleReference

function referenceUrl(reference: PromptReference): string {
  const key =
    reference.kind === "attachment"
      ? `attachment:${reference.file.index}`
      : reference.kind === "thread-title"
        ? `conversation:${reference.number}`
        : reference.raw
  return `mako-reference:${encodeURIComponent(key)}`
}

function linkText(reference: PromptReference): string {
  return reference.kind === "attachment"
    ? reference.file.name
    : reference.kind === "thread-title"
      ? reference.title
      : reference.raw
}

/**
 * The segments of one text node: attachments and typed tokens as the
 * attachment splitter finds them, and each `[Referenced conversation N]`
 * that names a title-only entry as its own reference.
 */
function promptSegments(
  text: string,
  files: readonly AttachmentFileReference[],
  threads: readonly ThreadAppendixEntry[]
): Array<PromptSegment | ThreadTitleReference> {
  const segments = attachmentPromptSegments(text, files)
  if (threads.length === 0) return segments
  const byPlaceholder = new Map(
    threads.map((entry) => [`[Referenced conversation ${entry.number}]`, entry])
  )
  const pattern = /\[Referenced conversation (\d+)\]/g
  return segments.flatMap((segment): Array<PromptSegment | ThreadTitleReference> => {
    if (segment.kind !== "text") return [segment]
    const parts: Array<PromptSegment | ThreadTitleReference> = []
    let cursor = 0
    for (const match of segment.text.matchAll(pattern)) {
      const entry = byPlaceholder.get(match[0])
      if (!entry) continue
      const start = match.index ?? 0
      if (start > cursor) parts.push({ kind: "text", text: segment.text.slice(cursor, start) })
      const reference: ThreadTitleReference = { kind: "thread-title", number: entry.number, title: entry.title }
      if (entry.harness) reference.harness = entry.harness
      parts.push(reference)
      cursor = start + match[0].length
    }
    if (parts.length === 0) return [segment]
    if (cursor < segment.text.length) parts.push({ kind: "text", text: segment.text.slice(cursor) })
    return parts
  })
}

export function remarkPromptReferences({
  files,
  references,
  threads = [],
}: {
  files: readonly AttachmentFileReference[]
  references: Map<string, PromptReference>
  /** Referenced conversations with no token to restore; their placeholders read as title chips. */
  threads?: readonly ThreadAppendixEntry[]
}) {
  return (tree: Root) => {
    visit(tree, "link", (node, index, parent) => {
      if (index === undefined || !parent || !node.url.startsWith("mailto:")) return
      const before = parent.children[index - 1]
      const after = parent.children[index + 1]
      const content = node.children[0]
      if (before?.type !== "text" || after?.type !== "text" || content?.type !== "text") return
      const start = before.value.lastIndexOf("[")
      const end = after.value.indexOf("]")
      const label = before.value.slice(start + 1) + content.value + after.value.slice(0, end)
      if (start < 0 || end < 0 || !files.some((file) => label === file.name || label === `${file.name} (${file.index})`)) return
      parent.children.splice(index, 1, { type: "text", value: content.value, position: node.position })
      return index + 1
    })
    visit(tree, (node) => {
      if (!("children" in node)) return
      for (let index = node.children.length - 1; index > 0; index--) {
        const left = node.children[index - 1]
        const right = node.children[index]
        if (left?.type !== "text" || right?.type !== "text") continue
        left.value += right.value
        if (left.position && right.position) left.position.end = right.position.end
        node.children.splice(index, 1)
      }
    })
    visit(tree, "text", (node, index, parent) => {
      if (index === undefined || !parent || parent.type === "link" || parent.type === "linkReference") return
      const segments = promptSegments(node.value, files, threads)
      if (segments.every((segment) => segment.kind === "text")) return
      for (const segment of segments)
        if (segment.kind !== "text") references.set(referenceUrl(segment), segment)
      const children: PhrasingContent[] = segments.map((segment) => segment.kind === "text"
        ? { type: "text", value: segment.text }
        : { type: "link", url: referenceUrl(segment), children: [{ type: "text", value: linkText(segment) }] })
      parent.children.splice(index, 1, ...children)
      return index + children.length
    })
  }
}
