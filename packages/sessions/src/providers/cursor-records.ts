import type { SQLOutputValue, StatementSync } from "node:sqlite"
import { attachmentFromUrl, type AttachmentContent } from "../content.js"
import type { UnreadRecord } from "../format.js"
import { cursorMessagePart } from "../harnesses/cursor.js"
import { readPromptAttachments } from "../prompt-attachments.js"
import { normalizeToolOutput } from "../tool-output.js"

/**
 * The records a Cursor agent store keeps, shared by the CLI's chats and the
 * SDK's agents: `blobs` holds each message as JSON under its hash, and a
 * root protobuf lists the conversation's hashes in order.
 */

export type JsonScalar = boolean | number | string | null
export type JsonValue = JsonScalar | JsonObject | JsonValue[]

export interface JsonObject {
  [key: string]: JsonValue | undefined
}

export interface CursorRoot {
  hashes: string[]
  cwd?: string
}

export interface ParsedRoot extends CursorRoot {
  /** Blob ids of the archived windows, oldest first. */
  windows: string[]
}

export interface CursorTextPart {
  type: "text"
  text: string
}

export interface CursorReasoningPart {
  type: "reasoning"
  text: string
}

export interface CursorToolCallPart {
  type: "tool-call"
  toolName: string
  args?: JsonValue
  toolCallId?: string
}

export interface CursorToolResultPart {
  type: "tool-result"
  toolCallId: string
  result?: JsonValue
  attachments: AttachmentContent[]
}

/** A record history can't draw, kept for the thread to name. */
export interface CursorUnread {
  kind: string
  reason: UnreadRecord["reason"]
  record: JsonValue
}

export interface CursorOtherPart {
  type: "other"
  unread?: CursorUnread
}

export type CursorAssistantPart =
  | CursorTextPart
  | CursorReasoningPart
  | CursorToolCallPart
  | CursorOtherPart
  | { type: "attachment"; value: AttachmentContent }
export type CursorToolPart = CursorToolResultPart | CursorOtherPart
export type CursorTextContent = string | CursorTextPart[]

export interface CursorUserMessage {
  role: "user"
  attachments: AttachmentContent[]
  content: CursorTextContent
  /** Parts of a kind no Cursor message holds. */
  unread: CursorUnread[]
  /** The summary a compaction left the model in place of what came before. */
  summary: boolean
}

export interface CursorAssistantMessage {
  role: "assistant"
  content: CursorAssistantPart[]
  model?: string
}

export interface CursorToolMessage {
  role: "tool"
  content: CursorToolPart[]
  isError: boolean
}

export interface CursorOtherMessage {
  role: "other"
  unread?: CursorUnread
}

export type CursorMessage =
  | CursorUserMessage
  | CursorAssistantMessage
  | CursorToolMessage
  | CursorOtherMessage

export type SqliteStatementResult = ReturnType<StatementSync["get"]>

export interface BlobDataRow {
  data: NodeJS.NonSharedUint8Array
}

export function isStringValue(
  value: JsonValue | SQLOutputValue | undefined
): value is string {
  return Object.prototype.toString.call(value) === "[object String]"
}

export function isNumberValue(value: JsonValue | SQLOutputValue | undefined): value is number {
  return Object.prototype.toString.call(value) === "[object Number]"
}

export function isBytesValue(
  value: SQLOutputValue | undefined
): value is NodeJS.NonSharedUint8Array {
  return Object.prototype.toString.call(value) === "[object Uint8Array]"
}

export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return Object.prototype.toString.call(value) === "[object Object]"
}

export function stringValue(value: JsonValue | undefined): string | undefined {
  return isStringValue(value) ? value : undefined
}

export function parseJson(raw: string): JsonValue | undefined {
  try {
    const value: JsonValue = JSON.parse(raw)
    return value
  } catch {
    return undefined
  }
}

/**
 * The protobuf reads the root blob needs: hash list, workspace URI and
 * archived windows. When Cursor summarizes a long conversation, the root's
 * hash list restarts with the system prompt, workspace context and the
 * summary, and field 13 keeps one blob per summarized window, oldest first.
 * A window's field 1 is the hash list it replaced, so windows plus the live
 * list are the whole conversation. Verified 2026-09-26 against 223 local
 * stores: 61 had windows (123 in all), none overlapping, with every message
 * blob present.
 */
/** Visit a protobuf message's top-level varint and length-delimited fields. */
export function eachField(
  data: Uint8Array,
  visit: (field: number, value: number | Uint8Array) => void
): void {
  let index = 0
  const varint = (): number | undefined => {
    let value = 0
    let shift = 0
    while (index < data.length && shift <= 49) {
      const byte = data[index]
      if (byte === undefined) return undefined
      index += 1
      value += (byte & 0x7f) * 2 ** shift
      if ((byte & 0x80) === 0) return value
      shift += 7
    }
    return undefined
  }
  while (index < data.length) {
    const tag = varint()
    if (tag === undefined) break
    const field = Math.floor(tag / 8)
    const wire = tag % 8
    if (wire === 0) {
      const value = varint()
      if (value === undefined) break
      visit(field, value)
    } else if (wire === 2) {
      const length = varint()
      if (length === undefined || length > data.length - index) break
      const bytes = data.subarray(index, index + length)
      index += length
      visit(field, bytes)
    } else if (wire === 5) {
      if (data.length - index < 4) break
      index += 4
    } else if (wire === 1) {
      if (data.length - index < 8) break
      index += 8
    } else {
      break // An unknown wire type means we are lost; stop rather than misread.
    }
  }
}

export function parseRoot(data: Uint8Array): ParsedRoot {
  const hashes: string[] = []
  const windows: string[] = []
  let cwd: string | undefined
  eachField(data, (field, value) => {
    if (!(value instanceof Uint8Array)) return
    if (field === 1 && value.length === 32) hashes.push(Buffer.from(value).toString("hex"))
    if (field === 13 && value.length === 32) windows.push(Buffer.from(value).toString("hex"))
    if (field === 9) {
      const uri = Buffer.from(value).toString("utf8")
      if (uri.startsWith("file://")) cwd = decodeURIComponent(uri.slice(7))
    }
  })
  return { hashes, cwd, windows }
}

/** A root's size without its hashes: how many it lists, the last of them, and its archived windows. */
export interface CursorRootExtent {
  count: number
  last?: string
  windows: string[]
}

/** `parseRoot` for placing a checkpoint, which needs only where it ends: one hash is decoded, not every one. */
export function parseRootExtent(data: Uint8Array): CursorRootExtent {
  let count = 0
  let last: Uint8Array | undefined
  const windows: string[] = []
  eachField(data, (field, value) => {
    if (!(value instanceof Uint8Array) || value.length !== 32) return
    if (field === 1) {
      count += 1
      last = value
    } else if (field === 13) windows.push(Buffer.from(value).toString("hex"))
  })
  return last ? { count, last: Buffer.from(last).toString("hex"), windows } : { count, windows }
}

export function parseBlobDataRow(result: SqliteStatementResult): BlobDataRow | null {
  if (!result) return null
  const data = result["data"]
  return isBytesValue(data) ? { data } : null
}

function parseCursorMessage(raw: string): CursorMessage | null {
  const value = parseJson(raw)
  if (!isJsonObject(value)) return null
  switch (stringValue(value["role"])) {
    case "user": {
      const content = parseTextContent(value["content"])
      const prompt = readPromptAttachments(plainText(content))
      return {
        role: "user",
        content: prompt.text,
        attachments: [...cursorAttachments(value["content"]), ...prompt.attachments],
        summary: cursorOption(value["providerOptions"], "isSummary") === true,
        unread: Array.isArray(value["content"]) ? value["content"].flatMap((part) => unknownPart("user", part) ?? []) : [],
      }
    }
    case "assistant":
      return {
        role: "assistant",
        content: parseAssistantContent(value["content"]),
        model: stringValue(value["model"]),
      }
    case "tool":
      return {
        role: "tool",
        content: parseToolContent(value["content"]),
        isError: cursorToolError(value["providerOptions"]),
      }
    case "system":
      return { role: "other" }
    default: {
      const role = stringValue(value["role"])
      return { role: "other", unread: { kind: `message ${role ?? "(no role)"}`, reason: role === undefined ? "unreadable" : "unknown", record: value } }
    }
  }
}

/** A part of a kind no Cursor `role` message holds; undefined for one it does. */
function unknownPart(role: string, part: JsonValue): CursorUnread | undefined {
  const type = isJsonObject(part) ? stringValue(part["type"]) : undefined
  if (type === undefined) return { kind: `${role} part`, reason: "unreadable", record: part }
  return cursorMessagePart(role, type) ? undefined : { kind: `${role} ${type}`, reason: "unknown", record: part }
}

function parseTextContent(value: JsonValue | undefined): CursorTextContent {
  if (isStringValue(value)) return value
  if (!Array.isArray(value)) return []
  const parts: CursorTextPart[] = []
  for (const candidate of value) {
    if (!isJsonObject(candidate) || stringValue(candidate["type"]) !== "text")
      continue
    const text = stringValue(candidate["text"])
    if (text !== undefined) parts.push({ type: "text", text })
  }
  return parts
}

function parseAssistantContent(
  value: JsonValue | undefined
): CursorAssistantPart[] {
  if (!Array.isArray(value)) return []
  return value.map(parseAssistantPart)
}

function parseAssistantPart(value: JsonValue): CursorAssistantPart {
  const unknown = unknownPart("assistant", value)
  if (unknown || !isJsonObject(value)) return { type: "other", unread: unknown }
  const attachment = cursorAttachments([value])[0]
  if (attachment) return { type: "attachment", value: attachment }
  const unreadable = (kind: string): CursorOtherPart => ({ type: "other", unread: { kind: `assistant ${kind}`, reason: "unreadable", record: value } })
  switch (stringValue(value["type"])) {
    case "text": {
      const text = stringValue(value["text"])
      return text === undefined ? unreadable("text") : { type: "text", text }
    }
    case "reasoning": {
      const text = stringValue(value["text"])
      return text === undefined ? unreadable("reasoning") : { type: "reasoning", text }
    }
    case "tool-call":
      return {
        type: "tool-call",
        toolName: stringValue(value["toolName"]) ?? "tool",
        args: value["args"],
        toolCallId: stringValue(value["toolCallId"]),
      }
    default:
      return { type: "other" }
  }
}

/** A field of a message's `providerOptions.cursor`. */
function cursorOption(value: JsonValue | undefined, key: string): JsonValue | undefined {
  const provider = isJsonObject(value) ? value : undefined
  const cursor = isJsonObject(provider?.["cursor"]) ? provider["cursor"] : undefined
  return cursor?.[key]
}

function cursorToolError(value: JsonValue | undefined): boolean {
  const result = cursorOption(value, "highLevelToolCallResult")
  return isJsonObject(result) && result["isError"] === true
}

function parseToolContent(value: JsonValue | undefined): CursorToolPart[] {
  if (!Array.isArray(value)) return []
  return value.map(parseToolPart)
}

function parseToolPart(value: JsonValue): CursorToolPart {
  const unknown = unknownPart("tool", value)
  if (unknown || !isJsonObject(value)) return { type: "other", unread: unknown }
  return {
    type: "tool-result",
    toolCallId: stringValue(value["toolCallId"]) ?? "",
    result: value["result"],
    attachments: cursorAttachments(value["experimental_content"]),
  }
}

export function formatToolResult(value: JsonValue | undefined): string {
  const text = isStringValue(value)
    ? value
    : (JSON.stringify(value ?? "") ?? "")
  return normalizeToolOutput(text)
}

export function plainText(content: CursorTextContent): string {
  return Array.isArray(content)
    ? content.map((part) => part.text).join("")
    : content
}

export function cursorAttachments(
  content: JsonValue | undefined
): AttachmentContent[] {
  if (!Array.isArray(content)) return []
  const result: AttachmentContent[] = []
  for (const candidate of content) {
    if (!isJsonObject(candidate)) continue
    const type = stringValue(candidate["type"])
    if (type !== "image" && type !== "file") continue
    const name = stringValue(candidate["filename"]) ?? type
    const mimeType =
      stringValue(candidate["mimeType"]) ??
      stringValue(candidate["mediaType"]) ??
      (type === "image" ? "image/png" : "application/octet-stream")
    const value =
      stringValue(candidate["image"]) ??
      stringValue(candidate["data"]) ??
      stringValue(candidate["url"])
    const path = stringValue(candidate["path"])
    result.push(
      value
        ? /^(?:https?:|file:|data:)/.test(value)
          ? attachmentFromUrl(name, mimeType, value)
          : {
              type: "attachment",
              name,
              mimeType,
              source: { kind: "inline", data: value },
            }
        : {
            type: "attachment",
            name,
            mimeType,
            source: path
              ? { kind: "file", path }
              : {
                  kind: "unavailable",
                  reason:
                    "Attachment bytes are unavailable in this native record",
                },
          }
    )
  }
  return result
}

/** A message by its hash; null when the blob is missing or isn't a message. */
export function readCursorMessage(blobs: StatementSync, hash: string): CursorMessage | null {
  try {
    const row = parseBlobDataRow(blobs.get(hash))
    return row ? parseCursorMessage(Buffer.from(row.data).toString("utf8")) : null
  } catch {
    return null
  }
}

/** A call's result as the conversation kept it. */
export interface CursorToolResult {
  output: string
  failed: boolean
}

/**
 * The results among `hashes[from..end)` of the calls in `wanted`, searched
 * from the newest message back until each is found. A run's messages are
 * mostly long results of other calls, so a message is parsed only when its
 * text names a call still wanted.
 */
export function cursorToolResults(
  blobs: StatementSync,
  hashes: readonly string[],
  from: number,
  end: number,
  wanted: ReadonlySet<string>
): Map<string, CursorToolResult> {
  const results = new Map<string, CursorToolResult>()
  const missing = new Set(wanted)
  for (let index = end - 1; index >= from && missing.size; index--) {
    const hash = hashes[index]
    const row = hash === undefined ? null : parseBlobDataRow(blobs.get(hash))
    if (!row) continue
    const raw = Buffer.from(row.data).toString("utf8")
    if (![...missing].some((id) => raw.includes(id))) continue
    const message = parseCursorMessage(raw)
    if (message?.role !== "tool") continue
    for (const part of message.content) {
      if (part.type !== "tool-result" || !missing.delete(part.toolCallId)) continue
      results.set(part.toolCallId, { output: formatToolResult(part.result), failed: message.isError })
    }
  }
  return results
}
