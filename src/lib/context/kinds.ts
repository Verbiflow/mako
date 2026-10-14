import { ProposedPlanSchema, type ProposedPlan } from "@mako/sessions/content"
import {
  CommentDetailSchema,
  ElementDetailSchema,
  PullRequestDetailSchema,
  QuoteDetailSchema,
  type CommentDetail,
  type ContextDetail,
  type ElementDetail,
  type PullRequestDetail,
  type QuoteDetail,
} from "../context-detail"
import { readFields, writeFields } from "./fields"
import type { ItemAttributes, WireItem } from "./wire"

/**
 * Every kind of context, written and read in one place.
 *
 * A kind says what its marker calls it (`noun`), what its chip reads
 * (`label`), how it is written into an item (attributes for the reader and
 * for Mako, a body for the agent), and how an item reads back. Adding a kind
 * is one entry here plus where its chips come from; the wire format, the
 * composer's chips, the transcript, Reuse and the clipboard all go through
 * these. Round trips are held by `scripts/test-context-kinds.ts`.
 */

export interface WrittenItem {
  kind: string
  /** The marker's noun, or null for an item with no place in the words (a skill, a plan). */
  noun: string | null
  label: string
  attrs: ItemAttributes
  body: string
}

/* Conversations ------------------------------------------------------------ */

/** What the composer prepared for a referenced conversation. */
export type ConversationContext =
  | { kind: "file"; file: string; title?: string; harness: string }
  | { kind: "inline"; content: string; title?: string; harness: string }

export interface ConversationItem {
  /** The token's body, `thread:<harness>:<id>`, when the reference was typed as one. */
  ref?: string
  harness?: string
  title: string
}

export function writeConversation(item: ConversationItem, context: ConversationContext | null): WrittenItem {
  const attrs: ItemAttributes = {}
  if (item.ref) attrs.ref = item.ref
  const harness = context?.harness ?? item.harness
  if (harness) attrs.harness = harness
  attrs.title = context?.title ?? item.title
  const body = !context
    ? "This conversation is unavailable or no longer exists. Do not infer its contents."
    : context.kind === "inline"
      ? `Its transcript bundle follows. Read its security boundary, chronology, integrity and loss directions before using the history.\n\n${context.content}`
      : `Transcript bundle: ${context.file}\nRead transcript.md at that exact path in full before using it. Read turns newest first while keeping each turn's own order, read its Bundle integrity section, open the tool input and output files beside it, and respect every loss it declares without guessing at what was left out.`
  return { kind: "conversation", noun: "Conversation", label: attrs.title, attrs, body }
}

export function readConversation(item: WireItem): ConversationItem {
  const read: ConversationItem = { title: item.attrs.title || "Untitled conversation" }
  if (item.attrs.ref?.startsWith("thread:")) read.ref = item.attrs.ref
  if (item.attrs.harness) read.harness = item.attrs.harness
  return read
}

/* Files ------------------------------------------------------------------- */

/** A file the person attached, or one Mako made (a terminal selection, a snapshot). */
export interface FileItem {
  name: string
  mimeType: string
  size?: number
  /** Where the bytes were staged. */
  path?: string
  /** Readable window text staged beside an image capture. */
  contextPath?: string
  /** The chip's own words, when they aren't the file name. */
  label?: string
  origin?: "terminal" | "git-conflicts" | "pull-request" | "window"
  /** Inline text, for a text file that could not be staged. */
  text?: string
  /** For a window capture (an Appshot): whose window it was. */
  window?: { app: string; title: string }
  /**
   * For a window capture, its elements as `@mako/host/contracts/window-outline`
   * writes them, carried in the item so the agent reads them with the image
   * without a turn spent opening the file at `contextPath`.
   */
  outline?: string
}

export function fileNoun(item: Pick<FileItem, "origin" | "mimeType">): string {
  if (item.origin === "terminal") return "Terminal output"
  if (item.origin === "git-conflicts") return "Git conflicts"
  if (item.origin === "pull-request") return "Pull request"
  if (item.origin === "window") return "Window"
  if (item.mimeType.startsWith("image/")) return "Image"
  return "File"
}

export function fileLabel(item: FileItem): string {
  return item.label ?? item.name
}

function bytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

export function writeFile(item: FileItem): WrittenItem {
  const attrs: ItemAttributes = { name: item.name, type: item.mimeType }
  if (item.size !== undefined) attrs.size = String(item.size)
  if (item.path) attrs.path = item.path
  if (item.contextPath) attrs["window-text"] = item.contextPath
  if (item.label && item.label !== item.name) attrs.label = item.label
  if (item.origin) attrs.origin = item.origin
  if (item.window) {
    attrs["window-app"] = item.window.app
    if (item.window.title) attrs["window-title"] = item.window.title
  }
  const size = item.size === undefined ? "" : `, ${bytes(item.size)}`
  const body = item.path
    ? `${item.mimeType}${size}. Saved at ${item.path}; read it from there.${windowNote(item)}`
    : item.text !== undefined
      ? writeFields([["text", item.text]])
      : "It could not be staged; ask for it again."
  return { kind: "file", noun: fileNoun(item), label: fileLabel(item), attrs, body }
}

/** What an image capture adds to its body: the window's elements, or where they are. */
function windowNote(item: FileItem): string {
  if (!item.contextPath) return ""
  if (!item.window) return ` The window's text is saved at ${item.contextPath}; read it alongside the image.`
  if (!item.outline) return ` A window capture: its elements are saved at ${item.contextPath}, one per line with each box in this image's pixels; read them alongside the image.`
  return ` A window capture: its elements follow (also saved at ${item.contextPath}).\n${writeFields([["elements", item.outline]])}`
}

export function readFile(item: WireItem): FileItem {
  const read: FileItem = { name: item.attrs.name || "file", mimeType: item.attrs.type || "application/octet-stream" }
  const size = Number(item.attrs.size)
  if (item.attrs.size && Number.isFinite(size)) read.size = size
  if (item.attrs.path) read.path = item.attrs.path
  if (item.attrs["window-text"]) read.contextPath = item.attrs["window-text"]
  if (item.attrs.label) read.label = item.attrs.label
  const origin = item.attrs.origin
  if (origin === "terminal" || origin === "git-conflicts" || origin === "pull-request" || origin === "window") read.origin = origin
  if (item.attrs["window-app"] !== undefined) read.window = { app: item.attrs["window-app"], title: item.attrs["window-title"] ?? "" }
  if (!read.path) {
    const text = readFields(item.body, ["text"]).get("text")
    if (text !== undefined) read.text = text
  } else if (read.window) {
    const outline = readFields(item.body, ["elements"]).get("elements")
    if (outline !== undefined) read.outline = outline
  }
  return read
}

/* Details: comments, elements, quotes, pull requests ---------------------- */

function lines(detail: CommentDetail): string {
  return detail.startLine === detail.endLine ? `${detail.startLine}` : `${detail.startLine}-${detail.endLine}`
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1)
}

export function detailLabel(detail: ContextDetail): string {
  if (detail.kind === "comment")
    return `${baseName(detail.path)}:${detail.startLine === detail.endLine ? detail.startLine : `${detail.startLine}–${detail.endLine}`}`
  if (detail.kind === "element") return detail.component ?? (detail.name ? `${detail.tag} “${detail.name}”` : detail.tag)
  if (detail.kind === "quote") {
    const flat = detail.text.replace(/\s+/g, " ").trim()
    return `“${flat.length > 36 ? `${flat.slice(0, 35).trimEnd()}…` : flat}”`
  }
  return `#${detail.number} ${detail.title}`
}

const DETAIL_NOUN = { comment: "Comment", element: "Element", quote: "Quote", "pull-request": "Pull request" } as const

export function writeDetail(detail: ContextDetail, label: string, screenshot?: string): WrittenItem {
  const noun = DETAIL_NOUN[detail.kind]
  if (detail.kind === "comment") {
    const attrs: ItemAttributes = { path: detail.path, lines: lines(detail), side: detail.side, source: detail.source }
    if (detail.base) attrs.base = detail.base
    return { kind: "comment", noun, label, attrs, body: writeFields([["comment", detail.comment], ["code", detail.code]]) }
  }
  if (detail.kind === "element") {
    const attrs: ItemAttributes = { url: detail.url, title: detail.title, tag: detail.tag }
    if (detail.selector) attrs.selector = detail.selector
    if (detail.role) attrs.role = detail.role
    if (detail.name) attrs.name = detail.name
    if (detail.component) attrs.component = detail.component
    if (detail.source)
      attrs.source = [detail.source.file, detail.source.line, detail.source.column].filter((part) => part !== undefined).join(":")
    attrs.box = [detail.box.x, detail.box.y, detail.box.width, detail.box.height].map((value) => Math.round(value)).join(",")
    if (screenshot) attrs.screenshot = screenshot
    return {
      kind: "element",
      noun,
      label,
      attrs,
      body: writeFields([["comment", detail.comment], ["html", detail.html], ["styles", detail.styles]]),
    }
  }
  if (detail.kind === "quote") {
    const attrs: ItemAttributes = {}
    if (detail.messageId) attrs.message = detail.messageId
    if (detail.conversation) {
      attrs.conversation = `${detail.conversation.harness}:${detail.conversation.id}`
      if (detail.conversation.title) attrs["conversation-title"] = detail.conversation.title
    }
    return { kind: "quote", noun, label, attrs, body: writeFields([["text", detail.text]]) }
  }
  const attrs: ItemAttributes = {
    number: String(detail.number),
    title: detail.title,
    url: detail.url,
    state: detail.state,
    draft: String(detail.draft),
    head: detail.head,
    base: detail.base,
  }
  if (detail.author) attrs.author = detail.author
  if (detail.repository) attrs.repository = detail.repository
  const state = detail.state === "open" && detail.draft ? "draft" : detail.state
  return {
    kind: "pull-request",
    noun,
    label,
    attrs,
    body: `Pull request #${detail.number}, ${state}: ${detail.title}\n${detail.head} into ${detail.base}\n${detail.url}`,
  }
}

function number(value: string | undefined): number | undefined {
  const parsed = Number(value)
  return value && Number.isFinite(parsed) ? parsed : undefined
}

/** A detail item back as the record it was written from, or null when it doesn't hold together. */
export function readDetail(item: WireItem): ContextDetail | null {
  const a = item.attrs
  if (item.kind === "comment") {
    const [start, end] = (a.lines ?? "").split("-").map(Number)
    const fields = readFields(item.body, ["comment", "code"])
    const parsed = CommentDetailSchema.safeParse({
      kind: "comment",
      path: a.path,
      startLine: start,
      endLine: end ?? start,
      side: a.side,
      source: a.source,
      base: a.base,
      code: fields.get("code") ?? "",
      comment: fields.get("comment") ?? "",
    })
    return parsed.success ? parsed.data : null
  }
  if (item.kind === "element") {
    const fields = readFields(item.body, ["comment", "html", "styles"])
    const [x, y, width, height] = (a.box ?? "").split(",").map(Number)
    const source = a.source?.split(":")
    const [file, line, column] = source
      ? source.length > 2
        ? [source.slice(0, -2).join(":"), source.at(-2), source.at(-1)]
        : [source[0], source[1], undefined]
      : []
    const parsed = ElementDetailSchema.safeParse({
      kind: "element",
      url: a.url,
      title: a.title ?? "",
      tag: a.tag,
      selector: a.selector ?? null,
      role: a.role,
      name: a.name,
      html: fields.get("html") ?? "",
      styles: fields.get("styles") ?? "",
      box: { x, y, width, height },
      component: a.component,
      source: file ? { file, line: number(line), column: number(column) } : undefined,
      comment: fields.get("comment"),
    })
    return parsed.success ? parsed.data : null
  }
  if (item.kind === "quote") {
    const [harness, ...id] = (a.conversation ?? "").split(":")
    const parsed = QuoteDetailSchema.safeParse({
      kind: "quote",
      text: readFields(item.body, ["text"]).get("text") ?? "",
      messageId: a.message,
      conversation: harness && id.length ? { harness, id: id.join(":"), title: a["conversation-title"] } : undefined,
    })
    return parsed.success ? parsed.data : null
  }
  if (item.kind === "pull-request") {
    const parsed = PullRequestDetailSchema.safeParse({
      kind: "pull-request",
      number: number(a.number),
      title: a.title,
      url: a.url,
      state: a.state,
      draft: a.draft === "true",
      head: a.head,
      base: a.base,
      author: a.author,
      repository: a.repository,
    })
    return parsed.success ? parsed.data : null
  }
  return null
}

export const DETAIL_KINDS: ReadonlySet<string> = new Set(Object.keys(DETAIL_NOUN))

/* Skills and plans: context for the whole message ------------------------- */

export interface SkillItem {
  name: string
  /** The provider whose copy was handed over; absent when the provider had its own. */
  from?: string
  /** What the agent reads: where the skill is, or its instructions. */
  body: string
}

export function writeSkill(item: SkillItem): WrittenItem {
  const attrs: ItemAttributes = { name: item.name }
  if (item.from) attrs.from = item.from
  return { kind: "skill", noun: null, label: item.name, attrs, body: item.body }
}

export function readSkill(item: WireItem): Omit<SkillItem, "body"> {
  const read: Omit<SkillItem, "body"> = { name: item.attrs.name ?? "" }
  if (item.attrs.from) read.from = item.attrs.from
  return read
}

export function writePlan(plan: ProposedPlan, title: string): WrittenItem {
  const attrs: ItemAttributes = { id: plan.id, title, status: plan.status }
  if (plan.truncated) attrs.truncated = "true"
  return { kind: "plan", noun: null, label: title, attrs, body: plan.text }
}

export function readPlan(item: WireItem): ProposedPlan | null {
  const parsed = ProposedPlanSchema.safeParse({
    type: "proposed-plan",
    id: item.attrs.id,
    text: item.body,
    status: item.attrs.status,
    truncated: item.attrs.truncated === "true" ? true : undefined,
  })
  return parsed.success ? parsed.data : null
}

export type { CommentDetail, ElementDetail, PullRequestDetail, QuoteDetail }
