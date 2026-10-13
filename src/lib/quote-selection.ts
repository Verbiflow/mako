import type { ContextInput, QuoteDetail } from "@/lib/context-detail"

/**
 * A quote of an earlier reply, read from what the person selected in the
 * transcript. The text is the selection as it reads on screen, written back
 * as plain Markdown: paragraphs stay paragraphs, list items keep their
 * markers and numbers, a code block keeps its lines inside a fence, and the
 * chrome around the prose (a code block's header and Copy button, a table's
 * Expand button) is left out.
 *
 * The walk takes the original nodes and the selection's two boundary points
 * rather than a cloned fragment, so a selection that starts in the middle of
 * a numbered list keeps the numbers the reader saw and one that lies inside a
 * code block still knows the block's language.
 */

/** The longest quote a chip carries, in characters. */
export const QUOTE_LIMIT = 8_000
/** The longest chip label, quote marks and ellipsis included. */
export const QUOTE_LABEL_LIMIT = 36

/** The parts of a DOM node the walk reads; a DOM `Node` is one. */
export interface QuoteNode {
  readonly nodeType: number
  readonly nodeName: string
  readonly nodeValue: string | null
  readonly childNodes: ArrayLike<QuoteNode>
  getAttribute?(name: string): string | null
}

/** A selection boundary as the DOM states one: a text node and a character, or an element and a child index. */
export interface QuoteBoundary {
  node: QuoteNode
  offset: number
}

const TEXT_NODE = 3
const ELEMENT_NODE = 1

/** Chrome inside an answer's prose that is never part of what was said. */
const SKIPPED = new Set(["button", "svg", "script", "style", "template", "dialog"])
const SKIPPED_CLASSES = ["mako-code-head"]
/** Previews an answer draws beside its words: a file's contents, a document, a gallery. */
const SKIPPED_ATTRIBUTES = ["data-inline-file-preview", "data-inline-document", "data-asset-collection"]
const BLOCKS = new Set(["p", "div", "section", "article", "figure", "figcaption", "details", "summary", "dl", "dt", "dd", "hr"])

/** A position in document order: the node's pre-order index and an offset within it. */
type Position = readonly [index: number, offset: number]

interface Walk {
  order: Map<QuoteNode, number>
  last: Map<QuoteNode, number>
  start: Position
  end: Position
}

function compare(left: Position, right: Position): number {
  return left[0] - right[0] || left[1] - right[1]
}

function tag(node: QuoteNode): string {
  return node.nodeName.toLowerCase()
}

function attribute(node: QuoteNode, name: string): string | null {
  return node.getAttribute?.(name) ?? null
}

function skipped(node: QuoteNode): boolean {
  if (SKIPPED.has(tag(node))) return true
  if (attribute(node, "aria-hidden") === "true") return true
  if (SKIPPED_ATTRIBUTES.some((name) => attribute(node, name) !== null)) return true
  const classes = attribute(node, "class")
  return Boolean(classes && SKIPPED_CLASSES.some((name) => classes.split(/\s+/).includes(name)))
}

function number(walk: Walk, node: QuoteNode): void {
  walk.order.set(node, walk.order.size)
  for (const child of Array.from(node.childNodes)) number(walk, child)
  walk.last.set(node, walk.order.size - 1)
}

/** Where a boundary sits in document order; an element boundary falls just before its child or after its last one. */
function position(walk: Walk, boundary: QuoteBoundary | undefined, edge: "start" | "end"): Position {
  if (!boundary) return edge === "start" ? [-1, 0] : [Number.MAX_SAFE_INTEGER, 0]
  const index = walk.order.get(boundary.node)
  if (index === undefined) return edge === "start" ? [-1, 0] : [Number.MAX_SAFE_INTEGER, 0]
  if (boundary.node.nodeType === TEXT_NODE) return [index, boundary.offset]
  const child = boundary.node.childNodes[boundary.offset]
  if (child) return [walk.order.get(child) ?? index, -1]
  return [walk.last.get(boundary.node) ?? index, Number.MAX_SAFE_INTEGER]
}

/** The selected characters of a text node, or null when the selection misses it. */
function selectedText(walk: Walk, node: QuoteNode): string | null {
  const index = walk.order.get(node) ?? -1
  if (walk.start[0] > index || walk.end[0] < index) return null
  const value = node.nodeValue ?? ""
  const clamp = (offset: number) => Math.min(value.length, Math.max(0, offset))
  const from = walk.start[0] === index ? clamp(walk.start[1]) : 0
  const to = walk.end[0] === index ? clamp(walk.end[1]) : value.length
  return to > from ? value.slice(from, to) : null
}

/** Whether any of a node's subtree may lie inside the selection. */
function touched(walk: Walk, node: QuoteNode): boolean {
  const first = walk.order.get(node) ?? -1
  const last = walk.last.get(node) ?? first
  return walk.start[0] <= last && compare(walk.end, [first, 0]) > 0
}

/** Accumulates inline text into blocks, the way a reader sees the prose. */
class Writer {
  readonly blocks: string[] = []
  private inline = ""

  text(value: string): void {
    this.inline += value
  }

  flush(): void {
    const lines = this.inline
      .split("\n")
      .map((line) => line.replace(/[ \t\f\v\r]+/g, " ").trim())
    while (lines.length > 0 && !lines[0]) lines.shift()
    while (lines.length > 0 && !lines.at(-1)) lines.pop()
    if (lines.length > 0) this.blocks.push(lines.join("\n"))
    this.inline = ""
  }

  block(value: string): void {
    this.flush()
    if (value) this.blocks.push(value)
  }
}

function collapse(value: string): string {
  return value.replace(/\s+/g, " ")
}

/** The selected text of a subtree exactly as it stands, newlines and all (a code block). */
function verbatim(walk: Walk, node: QuoteNode): string {
  if (node.nodeType === TEXT_NODE) return selectedText(walk, node) ?? ""
  if (node.nodeType !== ELEMENT_NODE && node.nodeType !== 11) return ""
  if (node.nodeType === ELEMENT_NODE && skipped(node)) return ""
  if (!touched(walk, node)) return ""
  if (tag(node) === "br") return "\n"
  return Array.from(node.childNodes).map((child) => verbatim(walk, child)).join("")
}

/** One line of inline content: a heading, a table cell. */
function inlineText(walk: Walk, node: QuoteNode, language: string | undefined): string {
  const writer = new Writer()
  children(walk, node, writer, language, 0)
  writer.flush()
  return writer.blocks.join(" ")
}

function indent(value: string, by: string): string {
  return value.split("\n").map((line, index) => (index === 0 || !line ? line : by + line)).join("\n")
}

function list(walk: Walk, node: QuoteNode, writer: Writer, language: string | undefined, depth: number): void {
  const ordered = tag(node) === "ol"
  let counter = Number(attribute(node, "start") ?? "1")
  if (!Number.isFinite(counter)) counter = 1
  const items: string[] = []
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType !== ELEMENT_NODE || tag(child) !== "li") continue
    const explicit = Number(attribute(child, "value") ?? Number.NaN)
    const marker = ordered ? `${Number.isFinite(explicit) ? explicit : counter}.` : "-"
    counter = (Number.isFinite(explicit) ? explicit : counter) + 1
    if (!touched(walk, child)) continue
    const body = new Writer()
    children(walk, child, body, language, depth + 1)
    body.flush()
    const text = body.blocks.join("\n")
    if (text) items.push(`${marker} ${indent(text, " ".repeat(marker.length + 1))}`)
  }
  if (items.length > 0) writer.block(items.join("\n"))
}

function table(walk: Walk, node: QuoteNode, writer: Writer, language: string | undefined): void {
  const rows: string[] = []
  const visit = (current: QuoteNode) => {
    for (const child of Array.from(current.childNodes)) {
      if (child.nodeType !== ELEMENT_NODE || !touched(walk, child)) continue
      if (tag(child) === "tr") {
        const cells = Array.from(child.childNodes)
          .filter((cell) => cell.nodeType === ELEMENT_NODE && ["td", "th"].includes(tag(cell)) && touched(walk, cell))
          .map((cell) => inlineText(walk, cell, language))
        if (cells.some(Boolean)) rows.push(cells.join(" | "))
      } else visit(child)
    }
  }
  visit(node)
  if (rows.length > 0) writer.block(rows.join("\n"))
}

function children(walk: Walk, node: QuoteNode, writer: Writer, language: string | undefined, depth: number): void {
  for (const child of Array.from(node.childNodes)) visit(walk, child, writer, language, depth)
}

function visit(walk: Walk, node: QuoteNode, writer: Writer, language: string | undefined, depth: number): void {
  if (node.nodeType === TEXT_NODE) {
    const text = selectedText(walk, node)
    if (text) writer.text(collapse(text))
    return
  }
  if (node.nodeType !== ELEMENT_NODE && node.nodeType !== 11) return
  if (node.nodeType === ELEMENT_NODE && skipped(node)) return
  if (!touched(walk, node)) return
  const name = tag(node)
  const codeLanguage = attribute(node, "data-inline-code") ?? language
  if (name === "pre") {
    // A selection starting at a line's end brings that newline along; the indentation after it stays.
    const code = verbatim(walk, node).replace(/^\n+/, "").replace(/\n+$/, "")
    if (code.trim()) {
      const fence = code.includes("```") ? "````" : "```"
      const label = codeLanguage && codeLanguage !== "text" ? codeLanguage : ""
      writer.block(`${fence}${label}\n${code}\n${fence}`)
    }
    return
  }
  if (name === "br") {
    writer.text("\n")
    return
  }
  if (name === "img") {
    const alt = attribute(node, "alt")
    if (alt) writer.text(alt)
    return
  }
  if (name === "code") {
    const code = collapse(verbatim(walk, node))
    if (code) writer.text(`\`${code}\``)
    return
  }
  const heading = /^h([1-6])$/.exec(name)
  if (heading) {
    const text = inlineText(walk, node, codeLanguage)
    if (text) writer.block(`${"#".repeat(Number(heading[1]))} ${text}`)
    return
  }
  if (name === "ul" || name === "ol") {
    list(walk, node, writer, codeLanguage, depth)
    return
  }
  if (name === "li") {
    // An item met outside its list: the selection's own fragment, never the walk from a prose root.
    const text = inlineText(walk, node, codeLanguage)
    if (text) writer.block(`- ${text}`)
    return
  }
  if (name === "table") {
    table(walk, node, writer, codeLanguage)
    return
  }
  if (name === "blockquote") {
    const inner = new Writer()
    children(walk, node, inner, codeLanguage, depth)
    inner.flush()
    const text = inner.blocks.join("\n\n")
    if (text) writer.block(text.split("\n").map((line) => (line ? `> ${line}` : ">")).join("\n"))
    return
  }
  if (BLOCKS.has(name)) {
    writer.flush()
    children(walk, node, writer, codeLanguage, depth)
    writer.flush()
    return
  }
  children(walk, node, writer, codeLanguage, depth)
}

/**
 * The selected part of one answer's prose as Markdown-ish text. A boundary
 * outside `root` (or none) means the selection runs past that edge of it.
 */
export function quoteText(root: QuoteNode, start?: QuoteBoundary, end?: QuoteBoundary): string {
  const walk: Walk = { order: new Map(), last: new Map(), start: [-1, 0], end: [Number.MAX_SAFE_INTEGER, 0] }
  number(walk, root)
  walk.start = position(walk, start, "start")
  walk.end = position(walk, end, "end")
  if (compare(walk.start, walk.end) >= 0) return ""
  const writer = new Writer()
  visit(walk, root, writer, undefined, 0)
  writer.flush()
  return writer.blocks.join("\n\n")
}

export interface CappedQuote {
  text: string
  /** The quote was longer than `QUOTE_LIMIT` and was cut. */
  truncated: boolean
}

/** Cut to `QUOTE_LIMIT` characters without splitting a surrogate pair. */
export function capQuote(text: string): CappedQuote {
  if (text.length <= QUOTE_LIMIT) return { text, truncated: false }
  const code = text.charCodeAt(QUOTE_LIMIT - 1)
  const cut = code >= 0xd800 && code <= 0xdbff ? QUOTE_LIMIT - 1 : QUOTE_LIMIT
  return { text: text.slice(0, cut), truncated: true }
}

/** The words a quote opens with, without its Markdown: fences, markers, backticks. */
function opening(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^\s*(?:`{3,}|~{3,})/.test(line))
    .map((line) => line.replace(/^\s*(?:>\s*)*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)?/, ""))
    .join(" ")
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * The chip's label: the quote's first words in typographic quotes, at most
 * `QUOTE_LABEL_LIMIT` characters, “Restoring a draft on that…”. A quote cut
 * to the limit says so after the closing mark.
 */
export function quoteLabel(text: string, truncated = false): string {
  const words = opening(text)
  const room = QUOTE_LABEL_LIMIT - 2
  let shown = words
  if (words.length > room) {
    // Room for the words and the ellipsis; a word ending exactly there stays whole.
    const head = words.slice(0, room - 1)
    const space = words[room - 1] === " " ? head.length : head.lastIndexOf(" ")
    shown = `${(space >= room / 3 ? head.slice(0, space) : head).replace(/[\s,;:.–—-]+$/, "")}…`
  }
  const quoted = `“${shown}”`
  return truncated ? `${quoted} · first ${QUOTE_LIMIT.toLocaleString("en-US")} characters` : quoted
}

/** What the composer is asked to add for a quote, or null when nothing readable was selected. */
export function quoteContext(
  text: string,
  messageId: string | undefined,
  conversation: QuoteDetail["conversation"]
): ContextInput | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  const capped = capQuote(trimmed)
  const detail: QuoteDetail = { kind: "quote", text: capped.text }
  if (messageId) detail.messageId = messageId
  if (conversation) detail.conversation = conversation
  return { detail, label: quoteLabel(capped.text, capped.truncated) }
}
