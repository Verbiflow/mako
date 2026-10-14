import type { PhrasingContent, Root } from "mdast"
import { visit } from "unist-util-visit"
import type { Attachment } from "./attachments"
import { MARKER } from "./context/wire"
import type { SentItem } from "./context/sent"
import { tokenize, type Segment } from "./mentions"

/**
 * A sent prompt's chips, read out of its words for the transcript: each
 * marker becomes the item it numbers, and each typed reference (`@path`,
 * `@thread:…`, `/skill`) the chip it was in the composer. Both come from
 * `readSent`, so a prompt from any build draws the same way.
 */

/** What a sent prompt's words carried: its items, and the record each would be again in a draft. */
export interface SentProse {
  items: readonly SentItem[]
  /** By item number: the record Reuse makes of it, so copying a chip copies the chip. */
  records: ReadonlyMap<number, Attachment>
}

export type PromptReference =
  | Exclude<Segment, { kind: "text" | "context" }>
  | { kind: "item"; item: SentItem; record?: Attachment }

type PromptSegment = { kind: "text"; text: string } | PromptReference

function referenceUrl(reference: PromptReference): string {
  const key = reference.kind === "item" ? `item:${reference.item.n}` : reference.raw
  return `mako-reference:${encodeURIComponent(key)}`
}

function linkText(reference: PromptReference): string {
  return reference.kind === "item" ? `#${reference.item.n}` : reference.raw
}

/** The segments of one text node: markers as their items, the rest as the tokenizer reads it. */
function promptSegments(text: string, sent: SentProse): PromptSegment[] {
  const byNumber = new Map(sent.items.map((item) => [item.n, item]))
  const segments: PromptSegment[] = []
  let cursor = 0
  const words = (slice: string) => {
    for (const segment of tokenize(slice, cursor === 0)) {
      if (segment.kind === "context") segments.push({ kind: "text", text: segment.raw })
      else segments.push(segment)
    }
  }
  for (const match of text.matchAll(MARKER)) {
    const item = byNumber.get(Number(match[2]))
    if (!item) continue
    const start = match.index ?? 0
    if (start > cursor) words(text.slice(cursor, start))
    const reference: PromptReference = { kind: "item", item }
    const record = sent.records.get(item.n)
    if (record) reference.record = record
    segments.push(reference)
    cursor = start + match[0].length
  }
  if (cursor < text.length) words(text.slice(cursor))
  return segments
}

const OPEN_MARKER = /\[[A-Z][A-Za-z ]* \d+: [^\]\n]*$/

export function remarkPromptReferences({
  sent,
  references,
}: {
  sent: SentProse
  references: Map<string, PromptReference>
}) {
  return (tree: Root) => {
    // An address in a chip's label (`[File 2: notes@team.md]`) is autolinked
    // by Markdown, splitting the marker; it goes back to being words.
    visit(tree, "link", (node, index, parent) => {
      if (index === undefined || !parent || !node.url.startsWith("mailto:")) return
      const before = parent.children[index - 1]
      const after = parent.children[index + 1]
      const content = node.children[0]
      if (before?.type !== "text" || after?.type !== "text" || content?.type !== "text") return
      if (!OPEN_MARKER.test(before.value) || !/^[^[\n]*\]/.test(after.value)) return
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
      const segments = promptSegments(node.value, sent)
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
