import { z } from "zod"
import type { JsonObject, JsonValue } from "../json.js"

/**
 * What the driver says, made small enough to read every turn.
 *
 * The driver's window state is a JSON array of ~65-token records; the same
 * window as one line per element is ~13 tokens a row, and the token that
 * addresses the next action is still on the line. Measured on a real app
 * (docs/audits/2026-09-14, F12): 12,006 tokens as the driver's JSON, 838
 * as lines with the menu bar dropped, 483 with only interactive roles.
 */

/** The application's menu bar, which the driver includes in a *window* state. */
export const MENU_ROLES: ReadonlySet<string> = new Set([
  "AXMenuBar",
  "AXMenuBarItem",
  "AXMenu",
  "AXMenuItem",
])

/** Roles that show but never take an action. */
export const PASSIVE_ROLES: ReadonlySet<string> = new Set([
  "AXStaticText",
  "AXImage",
  "AXGroup",
  "AXWebArea",
  "AXWindow",
  "AXHeading",
  "AXSplitter",
  "AXSeparator",
  "AXUnknown",
])

const VALUE_LENGTH = 80

export const ElementSchema = z.looseObject({
  element_token: z.string().optional(),
  element_index: z.number().int().optional(),
  role: z.string(),
  label: z.string().nullable().optional(),
  value: z.union([z.string(), z.number(), z.boolean()]).nullable().optional(),
  enabled: z.boolean().optional(),
  selected: z.boolean().optional(),
  frame: z
    .object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })
    .optional(),
})
export type Element = z.infer<typeof ElementSchema>

export interface LineOptions {
  /** Drop roles that only show (StaticText, Image, Group…). */
  interactive?: boolean
  /** Append the element's screen frame. */
  frames?: boolean
  /** Keep only lines whose label or value contains this text (case-insensitive). */
  query?: string
}

/** One element as one line: `<token> Role "label" =value`. */
export function elementLine(
  element: Element,
  options: LineOptions = {}
): string {
  const parts: string[] = []
  if (element.element_token) parts.push(element.element_token)
  parts.push(element.role.replace(/^AX/, ""))
  if (element.label) parts.push(JSON.stringify(element.label))
  if (element.value !== undefined && element.value !== null) {
    const text = String(element.value)
    if (text !== element.label && text !== "")
      parts.push(
        `=${JSON.stringify(text.length > VALUE_LENGTH ? `${text.slice(0, VALUE_LENGTH)}…` : text)}`
      )
  }
  if (element.enabled === false) parts.push("disabled")
  if (element.selected) parts.push("selected")
  if (options.frames && element.frame)
    parts.push(
      `@${element.frame.x},${element.frame.y} ${element.frame.w}x${element.frame.h}`
    )
  return parts.join(" ")
}

/** The window's elements as lines, menu bar removed. */
export function elementLines(
  elements: readonly JsonValue[],
  options: LineOptions = {}
): string[] {
  const query = options.query?.toLowerCase()
  const lines: string[] = []
  for (const raw of elements) {
    const parsed = ElementSchema.safeParse(raw)
    if (!parsed.success) continue
    const element = parsed.data
    if (MENU_ROLES.has(element.role)) continue
    if (options.interactive && PASSIVE_ROLES.has(element.role)) continue
    if (
      query &&
      !(element.label ?? "").toLowerCase().includes(query) &&
      !String(element.value ?? "")
        .toLowerCase()
        .includes(query)
    )
      continue
    lines.push(elementLine(element, options))
  }
  return lines
}

/** The address part of a line, so the same element on two snapshots compares equal. */
export function lineIdentity(line: string): string {
  return line.replace(/^s[0-9a-f]{8}:\d+ /, "")
}

/**
 * A line's role and label, without token or value: what the same control
 * reads as before and after its value changed, so a read-back finds it.
 */
export function lineAddress(line: string): string {
  const match = /^(?:s[0-9a-f]{8}:\d+ )?([A-Za-z]+)( "(?:[^"\\]|\\.)*")?/.exec(
    line
  )
  return match ? `${match[1]}${match[2] ?? ""}` : lineIdentity(line)
}

/** The exact window that minted an opaque snapshot token. */
export interface SnapshotIndex {
  snapshot_id: string
  pid: number
  window_id: number
}

const snapshotElementsSchema = z.looseObject({
  snapshot_id: z.string().min(1),
  pid: z.number().int().positive(),
  window_id: z.number().int().positive(),
  elements: z.array(z.json()).optional(),
})

export function indexSnapshot(value: JsonValue): SnapshotIndex | undefined {
  const parsed = snapshotElementsSchema.safeParse(value)
  if (!parsed.success) return undefined
  return {
    snapshot_id: parsed.data.snapshot_id,
    pid: parsed.data.pid,
    window_id: parsed.data.window_id,
  }
}

/** The `=value` a line shows for this text, truncated as `elementLine` truncates. */
export function shownValue(text: string): string {
  return `=${JSON.stringify(text.length > VALUE_LENGTH ? `${text.slice(0, VALUE_LENGTH)}…` : text)}`
}

export interface ViewDelta {
  added: string[]
  removed: string[]
  unchanged: number
}

/** What appeared and what went between two views, by identity not token. */
export function diffLines(
  before: readonly string[],
  after: readonly string[]
): ViewDelta {
  const previous = new Set(before.map(lineIdentity))
  const next = new Set(after.map(lineIdentity))
  const added = after.filter((line) => !previous.has(lineIdentity(line)))
  return {
    added,
    removed: before
      .filter((line) => !next.has(lineIdentity(line)))
      .map(lineIdentity),
    unchanged: after.length - added.length,
  }
}

const windowStateSchema = z.looseObject({
  elements: z.array(z.json()),
  returned_element_count: z.number().int().optional(),
})

/**
 * A window state without the application's menu bar. On a real app 118 of
 * 180 elements were the Apple menu and its Recent Items; none of them is
 * in the window. Tokens carry the element index, so dropping rows leaves
 * every remaining token valid.
 */
export function withoutMenuBar(structuredContent: JsonObject): JsonObject {
  const state = windowStateSchema.safeParse(structuredContent)
  if (!state.success) return structuredContent
  const kept = state.data.elements.filter((raw) => {
    const element = ElementSchema.safeParse(raw)
    return !element.success || !MENU_ROLES.has(element.data.role)
  })
  const omitted = state.data.elements.length - kept.length
  if (omitted === 0) return structuredContent
  return {
    ...structuredContent,
    elements: kept,
    returned_element_count: kept.length,
    menu_bar_elements_omitted: omitted,
  }
}

export const WindowRecordSchema = z.looseObject({
  window_id: z.number().int(),
  title: z.string().nullable().optional(),
  bounds: z
    .object({
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
    })
    .optional(),
  is_on_screen: z.boolean().nullable().optional(),
})
export type WindowRecord = z.infer<typeof WindowRecordSchema>

export type WindowKind = "document" | "helper" | "unknown"

/** A WindowServer record is a strip with no title, a titled window, or neither. */
const HELPER_EXTENT = 40

/**
 * Which of an application's WindowServer records is a window a person would
 * name. Finder keeps nine untitled 30-pixel strips at layer 0; every model
 * asked to list its windows counted them, at any size of context
 * (docs/audits/2026-09-14, F11). The rule lives here so no model has to
 * know it: an untitled record no taller or wider than a toolbar is a
 * `helper`, a titled one is a `document`, and an untitled one of real size
 * is `unknown` (a WebKit shell before its first activation looks like that).
 */
export function windowKind(window: WindowRecord): WindowKind {
  if (window.title) return "document"
  const bounds = window.bounds
  if (
    bounds &&
    (bounds.height <= HELPER_EXTENT || bounds.width <= HELPER_EXTENT)
  )
    return "helper"
  return "unknown"
}

const windowListSchema = z.looseObject({ windows: z.array(z.json()) })

/** `list_windows` with `kind` on every record. */
export function withWindowKinds(structuredContent: JsonObject): JsonObject {
  const list = windowListSchema.safeParse(structuredContent)
  if (!list.success) return structuredContent
  return {
    ...structuredContent,
    windows: list.data.windows.map((raw) => {
      const window = WindowRecordSchema.safeParse(raw)
      if (!window.success) return raw
      return { ...window.data, kind: windowKind(window.data) }
    }),
  }
}

const toolResultSchema = z.looseObject({
  content: z
    .array(
      z.looseObject({
        type: z.string(),
        text: z.string().optional(),
        data: z.string().optional(),
        mimeType: z.string().optional(),
      })
    )
    .optional(),
  isError: z.boolean().optional(),
  structuredContent: z.record(z.string(), z.json()).optional(),
})
export type ToolResult = z.infer<typeof toolResultSchema>

/** The message a refused driver call should reject with. */
export function toolResultError(result: ToolResult): string | undefined {
  if (!result.isError) return undefined
  const text = result.content
    ?.filter((block) => block.type === "text" && block.text)
    .map((block) => block.text)
    .join("\n")
  return text || "The driver refused the action"
}

/**
 * What `await computer.<action>()` resolves to: the driver's structured
 * data itself. An MCP result carries that data twice, as
 * `structuredContent` and as its JSON in a text block, and every model in
 * the September benchmarks lost a turn to `result.structuredContent.apps`
 * before finding the data. Images and text the driver did not also give
 * structured stay on `content`.
 */
export function toolResultData(result: ToolResult): JsonObject {
  const structured = result.structuredContent
  const echo = structured ? JSON.stringify(structured) : undefined
  const blocks: JsonObject[] = []
  const texts: string[] = []
  for (const block of result.content ?? []) {
    if (block.type === "text") {
      if (block.text && block.text !== echo) texts.push(block.text)
      continue
    }
    const kept: JsonObject = { type: block.type }
    if (block.data !== undefined) kept.data = block.data
    if (block.mimeType !== undefined) kept.mimeType = block.mimeType
    blocks.push(kept)
  }
  if (!structured) {
    const data: JsonObject = {}
    if (texts.length) data.text = texts.join("\n")
    if (blocks.length) data.content = blocks
    return data
  }
  if (texts.length)
    blocks.unshift(...texts.map((text): JsonObject => ({ type: "text", text })))
  return blocks.length ? { ...structured, content: blocks } : structured
}
