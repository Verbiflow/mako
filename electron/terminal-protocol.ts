import { z } from "zod"
import type { TerminalSession, TerminalSnapshot } from "./shared.js"

export const TERMINAL_PROTOCOL_VERSION = 2
// Implementation revision: multi-session consumers and replay-safe history.
// Development checkout build tags can stay unchanged across source updates.
export const TERMINAL_DAEMON_VERSION = `${TERMINAL_PROTOCOL_VERSION}.2`
export const TERMINAL_HISTORY_BYTES = 2 * 1024 * 1024
export const TERMINAL_MAX_SESSIONS = 24
export const TERMINAL_MAX_INPUT_BYTES = 64 * 1024
export const TERMINAL_MAX_COLS = 500
export const TERMINAL_MAX_ROWS = 200
export const TERMINAL_MIN_COLS = 2
export const TERMINAL_MIN_ROWS = 1
export const TERMINAL_MAX_FRAME_BYTES = 16 * 1024 * 1024
export const TERMINAL_OUTPUT_CHUNK_BYTES = 32 * 1024
export const TERMINAL_FLOW_HIGH_BYTES = 256 * 1024
export const TERMINAL_FLOW_LOW_BYTES = 32 * 1024

export type TerminalRequest =
  | { protocol: number; id: number; type: "hello"; clientVersion: string }
  | { id: number; type: "list" }
  | {
      id: number
      type: "create"
      cwd: string
      title?: string
      cols: number
      rows: number
    }
  | { id: number; type: "attach"; sessionId: string }
  | { id: number; type: "detach"; sessionId: string }
  | { id: number; type: "ack"; sessionId: string; sequence: number }
  | { id: number; type: "write"; sessionId: string; data: string }
  | {
      id: number
      type: "resize"
      sessionId: string
      cols: number
      rows: number
    }
  | { id: number; type: "kill"; sessionId: string }
  | { protocol: number; id: number; type: "replace" }

export type TerminalResult =
  | { kind: "hello"; daemonVersion: string; pid: number; daemonBuild?: string }
  | { kind: "sessions"; sessions: TerminalSession[] }
  | { kind: "session"; session: TerminalSession }
  | { kind: "snapshot"; snapshot: TerminalSnapshot }
  | { kind: "ok" }

export type TerminalDaemonEvent =
  | {
      protocol: number
      type: "output"
      sessionId: string
      sequence: number
      data: string
    }
  | { protocol: number; type: "status"; session: TerminalSession }
  | { protocol: number; type: "removed"; sessionId: string }

export interface TerminalResponse {
  protocol: number
  type: "response"
  id: number
  ok: boolean
  result?: TerminalResult
  error?: string
  code?: "protocol-mismatch" | "invalid-request" | "not-found" | "limit"
}

const jsonValueSchema = z.json()
export type TerminalWireValue = z.infer<typeof jsonValueSchema>

const integer = z.number().int().finite()
const boundedText = (max: number) =>
  z.string().refine((value) => Buffer.byteLength(value) <= max)
const sessionIdSchema = boundedText(128).min(1)
const terminalSessionSchema = z.object({
  id: sessionIdSchema,
  title: z.string(),
  cwd: z.string(),
  createdAt: integer,
  updatedAt: integer,
  status: z.enum(["running", "exited", "interrupted"]),
  cols: integer,
  rows: integer,
  sequence: integer,
  exitCode: integer.optional(),
})
const terminalSnapshotSchema = z.object({
  session: terminalSessionSchema,
  data: z.string(),
  sequence: integer,
})
const terminalResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("hello"),
    daemonVersion: z.string(),
    pid: integer,
    /** The build that spawned the daemon; a host from another build replaces it. */
    daemonBuild: boundedText(256).optional(),
  }),
  z.object({ kind: z.literal("sessions"), sessions: z.array(terminalSessionSchema) }),
  z.object({ kind: z.literal("session"), session: terminalSessionSchema }),
  z.object({ kind: z.literal("snapshot"), snapshot: terminalSnapshotSchema }),
  z.object({ kind: z.literal("ok") }),
])
const requestFrameSchema = z.discriminatedUnion("type", [
  z.object({
    protocol: integer,
    id: integer,
    type: z.literal("hello"),
    clientVersion: boundedText(64),
  }),
  z.object({ protocol: z.literal(TERMINAL_PROTOCOL_VERSION), id: integer, type: z.literal("list") }),
  z.object({
    protocol: z.literal(TERMINAL_PROTOCOL_VERSION),
    id: integer,
    type: z.literal("create"),
    cwd: boundedText(4096).min(1),
    title: boundedText(256).optional(),
    cols: integer,
    rows: integer,
  }),
  z.object({
    protocol: z.literal(TERMINAL_PROTOCOL_VERSION),
    id: integer,
    type: z.literal("attach"),
    sessionId: sessionIdSchema,
  }),
  z.object({
    protocol: z.literal(TERMINAL_PROTOCOL_VERSION),
    id: integer,
    type: z.literal("detach"),
    sessionId: sessionIdSchema,
  }),
  z.object({
    protocol: z.literal(TERMINAL_PROTOCOL_VERSION),
    id: integer,
    type: z.literal("ack"),
    sessionId: sessionIdSchema,
    sequence: integer.nonnegative(),
  }),
  z.object({
    protocol: z.literal(TERMINAL_PROTOCOL_VERSION),
    id: integer,
    type: z.literal("write"),
    sessionId: sessionIdSchema,
    data: boundedText(TERMINAL_MAX_INPUT_BYTES),
  }),
  z.object({
    protocol: z.literal(TERMINAL_PROTOCOL_VERSION),
    id: integer,
    type: z.literal("resize"),
    sessionId: sessionIdSchema,
    cols: integer,
    rows: integer,
  }),
  z.object({
    protocol: z.literal(TERMINAL_PROTOCOL_VERSION),
    id: integer,
    type: z.literal("kill"),
    sessionId: sessionIdSchema,
  }),
  z.object({
    protocol: integer,
    id: integer,
    type: z.literal("replace"),
  }),
])
const responseSchema = z.object({
  protocol: z.literal(TERMINAL_PROTOCOL_VERSION),
  type: z.literal("response"),
  id: integer,
  ok: z.boolean(),
  result: terminalResultSchema.optional(),
  error: z.string().optional(),
  code: z
    .enum(["protocol-mismatch", "invalid-request", "not-found", "limit"])
    .optional(),
})
const daemonEventSchema = z.discriminatedUnion("type", [
  z.object({
    protocol: z.literal(TERMINAL_PROTOCOL_VERSION),
    type: z.literal("output"),
    sessionId: sessionIdSchema,
    sequence: integer,
    data: z.string(),
  }),
  z.object({
    protocol: z.literal(TERMINAL_PROTOCOL_VERSION),
    type: z.literal("status"),
    session: terminalSessionSchema,
  }),
  z.object({
    protocol: z.literal(TERMINAL_PROTOCOL_VERSION),
    type: z.literal("removed"),
    sessionId: sessionIdSchema,
  }),
])

export function clampTerminalSize(cols: number, rows: number) {
  return {
    cols: Math.min(TERMINAL_MAX_COLS, Math.max(TERMINAL_MIN_COLS, Math.floor(cols))),
    rows: Math.min(TERMINAL_MAX_ROWS, Math.max(TERMINAL_MIN_ROWS, Math.floor(rows))),
  }
}

function splitTerminalData(data: string, maxBytes: number): string[] {
  if (Buffer.byteLength(data) <= maxBytes) return [data]
  const chunks: string[] = []
  let rest = data
  while (rest.length > 0) {
    let end = Math.min(rest.length, maxBytes)
    while (end > 1 && Buffer.byteLength(rest.slice(0, end)) > maxBytes) {
      end = Math.floor(end * 0.8)
    }
    const finalCodeUnit = rest.charCodeAt(end - 1)
    if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) end -= 1
    chunks.push(rest.slice(0, end))
    rest = rest.slice(end)
  }
  return chunks
}

export function splitTerminalOutput(data: string) {
  return splitTerminalData(data, TERMINAL_OUTPUT_CHUNK_BYTES)
}

export function splitTerminalInput(data: string) {
  return splitTerminalData(data, TERMINAL_MAX_INPUT_BYTES)
}

export class BoundedTerminalHistory {
  readonly #chunks: Buffer[] = []
  readonly #limit: number
  #bytes = 0

  constructor(limit = TERMINAL_HISTORY_BYTES) {
    this.#limit = limit
  }

  append(data: string) {
    if (!data) return
    let chunk = Buffer.from(data)
    if (chunk.byteLength > this.#limit) chunk = chunk.subarray(chunk.byteLength - this.#limit)
    this.#chunks.push(chunk)
    this.#bytes += chunk.byteLength
    while (this.#bytes > this.#limit) {
      const first = this.#chunks[0]
      if (!first) break
      const excess = this.#bytes - this.#limit
      if (first.byteLength <= excess) {
        this.#chunks.shift()
        this.#bytes -= first.byteLength
      } else {
        this.#chunks[0] = first.subarray(excess)
        this.#bytes -= excess
      }
    }
  }

  restore(base64: string) {
    this.#chunks.length = 0
    this.#bytes = 0
    const saved = Buffer.from(base64, "base64")
    const bounded = saved.byteLength > this.#limit ? saved.subarray(saved.byteLength - this.#limit) : saved
    if (bounded.byteLength > 0) {
      this.#chunks.push(bounded)
      this.#bytes = bounded.byteLength
    }
  }

  text() {
    const buffer = Buffer.concat(this.#chunks, this.#bytes)
    let start = 0
    while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++
    return buffer.subarray(start).toString("utf8")
  }

  base64() {
    return Buffer.concat(this.#chunks, this.#bytes).toString("base64")
  }

  get byteLength() {
    return this.#bytes
  }
}

export class JsonLineDecoder {
  #parts: Buffer[] = []
  #bytes = 0

  push(chunk: Buffer): TerminalWireValue[] {
    const values: TerminalWireValue[] = []
    let start = 0
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start)
      const end = newline < 0 ? chunk.length : newline
      const part = chunk.subarray(start, end)
      this.#bytes += part.length
      if (this.#bytes > TERMINAL_MAX_FRAME_BYTES) throw new Error("Terminal protocol frame exceeded 16 MiB")
      if (part.length) this.#parts.push(part)
      if (newline < 0) break
      if (this.#bytes) {
        const line = this.#parts.length === 1 ? this.#parts[0] : Buffer.concat(this.#parts, this.#bytes)
        const parsed = jsonValueSchema.safeParse(JSON.parse(line.toString("utf8")))
        if (!parsed.success) throw new Error("Terminal protocol frame was not JSON")
        values.push(parsed.data)
      }
      this.#parts = []
      this.#bytes = 0
      start = newline + 1
    }
    return values
  }
}

export function encodeTerminalFrame(value: TerminalResponse | TerminalDaemonEvent | TerminalRequest) {
  return `${JSON.stringify({ protocol: TERMINAL_PROTOCOL_VERSION, ...value })}\n`
}

export function parseTerminalRequest(value: TerminalWireValue): TerminalRequest | null {
  const parsed = requestFrameSchema.safeParse(value)
  if (!parsed.success) return null
  const request = parsed.data
  if (request.type === "hello") {
    return {
      protocol: request.protocol,
      id: request.id,
      type: request.type,
      clientVersion: request.clientVersion,
    }
  }
  if (request.type === "replace") {
    return { protocol: request.protocol, id: request.id, type: request.type }
  }
  if (request.type === "list") return { id: request.id, type: request.type }
  if (request.type === "create") {
    return {
      id: request.id,
      type: request.type,
      cwd: request.cwd,
      title: request.title,
      ...clampTerminalSize(request.cols, request.rows),
    }
  }
  if (request.type === "resize") {
    return {
      id: request.id,
      type: request.type,
      sessionId: request.sessionId,
      ...clampTerminalSize(request.cols, request.rows),
    }
  }
  if (request.type === "write") {
    return {
      id: request.id,
      type: request.type,
      sessionId: request.sessionId,
      data: request.data,
    }
  }
  if (request.type === "ack") {
    return {
      id: request.id,
      type: request.type,
      sessionId: request.sessionId,
      sequence: request.sequence,
    }
  }
  return { id: request.id, type: request.type, sessionId: request.sessionId }
}

export function parseTerminalResponse(value: TerminalWireValue): TerminalResponse | null {
  const parsed = responseSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

export function parseTerminalDaemonEvent(value: TerminalWireValue): TerminalDaemonEvent | null {
  const parsed = daemonEventSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}
