import { closeSync, fstatSync, openSync, readSync } from "node:fs"
import { setTimeout as delay } from "node:timers/promises"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { z } from "zod"
import { claudeTaskOutput, type KeptOutputs } from "@mako/sessions"
import { claudeTaskReadsOutput, parseClaudeTaskNotification } from "@mako/sessions/harnesses"

/**
 * A `<task-notification>` Claude Code wrote into the session's transcript:
 * `queued` when it took one in while a turn ran (a `queued_command`
 * attachment, which the SDK streams nothing for), `prompt` when it ran a
 * turn on one. `output` is the end of a command's output as the body shows
 * it, read when the line was, so decoding the line reads no file.
 */
export const TranscriptNotificationSchema = z.object({
  kind: z.enum(["queued", "prompt"]),
  record: z.string(),
  at: z.string(),
  text: z.string(),
  output: z.object({ text: z.string(), from: z.enum(["output-file", "kept-copy"]) }).optional(),
})
export type TranscriptNotification = z.infer<typeof TranscriptNotificationSchema>

/** What reading the transcript has cost, for the measurements in the host log and the audit. */
export interface TranscriptTailStats {
  reads: number
  bytes: number
  /** Lines parsed as JSON: only the ones that name the queue or a notification. */
  parsed: number
  notifications: number
  /** Times the reader was further behind than it reads and jumped to the end. */
  jumps: number
  ms: number
  maxMs: number
}

const QueueOperation = z.object({
  type: z.literal("queue-operation"),
  operation: z.string(),
  content: z.string().optional(),
})
const Text = z.union([z.string(), z.array(z.object({ type: z.string(), text: z.string().optional() }).loose())])
const Attachment = z.object({
  type: z.literal("attachment"),
  uuid: z.string(),
  timestamp: z.string(),
  isSidechain: z.boolean().optional(),
  sessionId: z.string().optional(),
  attachment: z.object({ type: z.literal("queued_command"), prompt: Text }).loose(),
})
const Prompt = z.object({
  type: z.literal("user"),
  uuid: z.string(),
  timestamp: z.string(),
  isSidechain: z.boolean().optional(),
  sessionId: z.string().optional(),
  message: z.object({ content: Text }),
})

const NOTIFICATION = "<task-notification>"
const QUEUE = Buffer.from('"queue-operation"')
const MENTION = Buffer.from("task-notification>")
/** One read's most: the transcript's growth since the last read, which only a command printing megabytes into a tool result makes large. */
const CHUNK_BYTES = 1024 * 1024
/** A line longer than this is a tool's output, never a notification or a queue operation, and is passed over unkept. */
const LINE_BYTES = 1024 * 1024
/** Further behind than this, the reader starts again near the end: what matters is the newest lines. */
const BEHIND_BYTES = 16 * 1024 * 1024
const RESTART_BYTES = 2 * 1024 * 1024

function plain(text: z.infer<typeof Text>): string {
  return Array.isArray(text) ? text.flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])).join("\n") : text
}

/**
 * The notifications a session's transcript gains, read forward from where
 * the last read stopped, never from the start: each read costs what Claude
 * Code appended since, and only lines that name its queue or a
 * notification are parsed. It also follows Claude Code's queue
 * (`queue-operation` lines, written as each notification arrives), so the
 * driver knows a notification is waiting to be taken in before Claude Code
 * writes it into the turn.
 */
export class ClaudeTranscriptTail {
  readonly path: string
  private readonly session: string | undefined
  private readonly outputs: KeptOutputs | undefined
  private offset = 0
  private file: number | undefined
  /** The start of a line the last read ended inside; dropped once it is longer than any line worth reading. */
  private partial: Buffer[] = []
  private partialBytes = 0
  private skipping = false
  /** Claude Code's queue as its lines tell it: each waiting command's text, oldest first. */
  private queue: string[] = []
  private queued = 0
  readonly stats: TranscriptTailStats = { reads: 0, bytes: 0, parsed: 0, notifications: 0, jumps: 0, ms: 0, maxMs: 0 }

  /** Reads from the file's end as it is now: what it holds already is history, not this process's. */
  constructor(path: string, session: string | undefined, outputs?: KeptOutputs) {
    this.path = path
    this.session = session
    this.outputs = outputs
    this.skip()
  }

  /** Moves to the file's end, forgetting the queue: nothing before it will be drawn. */
  skip(): void {
    try {
      const fd = openSync(this.path, "r")
      try {
        const { size, ino } = fstatSync(fd)
        this.offset = size
        this.file = ino
      } finally {
        closeSync(fd)
      }
    } catch {
      this.offset = 0
      this.file = undefined
    }
    this.clear()
  }

  /** Task notifications Claude Code has queued and not yet taken in or run. */
  waiting(): number {
    return this.queue.filter((text) => text.trimStart().startsWith(NOTIFICATION)).length
  }

  /** Task notifications Claude Code has queued since this reader started, taken in or not. */
  enqueued(): number {
    return this.queued
  }

  /** The notifications written since the last read, in the transcript's order. */
  read(): TranscriptNotification[] {
    const found: TranscriptNotification[] = []
    const started = performance.now()
    let fd: number | undefined
    try {
      fd = openSync(this.path, "r")
      const { size, ino } = fstatSync(fd)
      if (this.file !== undefined && (ino !== this.file || size < this.offset)) {
        this.offset = 0
        this.clear()
      }
      this.file = ino
      if (size - this.offset > BEHIND_BYTES) {
        this.offset = size - RESTART_BYTES
        this.clear()
        this.skipping = true
        this.stats.jumps++
      }
      while (this.offset < size) {
        const length = Math.min(CHUNK_BYTES, size - this.offset)
        const chunk = Buffer.allocUnsafe(length)
        const read = readSync(fd, chunk, 0, length, this.offset)
        if (read <= 0) break
        this.offset += read
        this.stats.bytes += read
        this.scan(chunk.subarray(0, read), found)
      }
    } catch {
      // A transcript that is gone or unreadable has nothing new to say.
    } finally {
      if (fd !== undefined) closeSync(fd)
      const ms = performance.now() - started
      this.stats.reads++
      this.stats.ms += ms
      this.stats.maxMs = Math.max(this.stats.maxMs, ms)
      this.stats.notifications += found.length
    }
    return found
  }

  private clear(): void {
    this.partial = []
    this.partialBytes = 0
    this.skipping = false
    this.queue = []
  }

  private scan(chunk: Buffer, found: TranscriptNotification[]): void {
    let start = 0
    for (let end = chunk.indexOf(10); end >= 0; end = chunk.indexOf(10, start)) {
      const piece = chunk.subarray(start, end)
      start = end + 1
      if (this.skipping) {
        this.skipping = false
        continue
      }
      const line = this.partialBytes ? Buffer.concat([...this.partial, piece]) : piece
      this.partial = []
      this.partialBytes = 0
      if (line.length <= LINE_BYTES && (line.includes(QUEUE) || line.includes(MENTION))) this.line(line, found)
    }
    if (this.skipping || start >= chunk.length) return
    const rest = chunk.subarray(start)
    if (this.partialBytes + rest.length > LINE_BYTES) {
      this.partial = []
      this.partialBytes = 0
      this.skipping = true
      return
    }
    // A copy, so a line's start doesn't keep its whole chunk alive.
    this.partial.push(Buffer.from(rest))
    this.partialBytes += rest.length
  }

  private line(line: Buffer, found: TranscriptNotification[]): void {
    let value: unknown
    try {
      value = JSON.parse(line.toString("utf8"))
    } catch {
      return
    }
    this.stats.parsed++
    const operation = QueueOperation.safeParse(value)
    if (operation.success) {
      const { operation: kind, content } = operation.data
      if (kind === "enqueue") {
        this.queue.push(content ?? "")
        if (content?.trimStart().startsWith(NOTIFICATION)) this.queued++
      }
      else if (kind === "dequeue") this.queue.shift()
      else if (kind === "remove" && content !== undefined) {
        const index = this.queue.indexOf(content)
        if (index >= 0) this.queue.splice(index, 1)
      } else if (kind === "clear" || kind === "popAll") this.queue = []
      return
    }
    const attachment = Attachment.safeParse(value)
    const prompt = attachment.success ? undefined : Prompt.safeParse(value)
    const record = attachment.success ? attachment.data : prompt?.success ? prompt.data : undefined
    if (!record || record.isSidechain || (this.session && record.sessionId && record.sessionId !== this.session)) return
    const text = plain("attachment" in record ? record.attachment.prompt : record.message.content)
    if (!text.trimStart().startsWith(NOTIFICATION)) return
    found.push(transcriptNotification("attachment" in record ? "queued" : "prompt", record.uuid, record.timestamp, text, this.outputs))
  }
}

/** A notification line as the driver records it, with the end of a command's output read now, while its file is there. */
export function transcriptNotification(kind: TranscriptNotification["kind"], record: string, at: string, text: string, outputs?: KeptOutputs): TranscriptNotification {
  const notification: TranscriptNotification = { kind, record, at, text }
  const parsed = parseClaudeTaskNotification(text)
  const read = parsed && claudeTaskReadsOutput(parsed) ? claudeTaskOutput(parsed.outputFile, parsed.taskId, outputs) : undefined
  if (read) notification.output = { text: read.output, from: read.from }
  return notification
}

const REQUESTING = "(requesting)"

/**
 * Where each model request starts, which is where a notification Claude Code
 * took in for it belongs: Claude Code writes what it takes in for a request
 * into the turn, then reports `requesting` and sends it. A reply's first
 * stream event (or first whole message when nothing is streamed) stands in
 * when no `requesting` came before it. In the real session of 2026-10-12
 * `requesting` came 1.5 s before the reply's first event.
 */
export class ClaudeRequests {
  private last: string | undefined

  /** Whether `message` starts a request the transcript wasn't read for yet. */
  starts(message: SDKMessage): boolean {
    if (message.type === "system" && message.subtype === "status" && message.status === "requesting") {
      this.last = REQUESTING
      return true
    }
    const id = message.type === "stream_event" && !message.parent_tool_use_id && message.event.type === "message_start" ? message.event.message.id
      : message.type === "assistant" && !message.parent_tool_use_id ? message.message.id : undefined
    if (id === undefined) return false
    const fresh = this.last !== REQUESTING && id !== this.last
    this.last = id
    return fresh
  }
}

/** How long a model request waits for a notification Claude Code queued to be written into the turn: about one flush of its writer. */
export const TAKE_IN_WAIT_MS = 750

/**
 * What Claude Code took in for a model request that is starting, which it
 * writes into the turn right before sending the request and the SDK never
 * streams (a monitor's event, a command or agent that settled while the
 * turn ran). A notification it has queued but not yet written is waited
 * for once per notification queued (`waited` holds how many were), for at
 * most `TAKE_IN_WAIT_MS`, since its writer flushes on a timer.
 */
export async function takenIn(tail: ClaudeTranscriptTail, waited: { queued: number }, closed: () => boolean): Promise<TranscriptNotification[]> {
  const found = tail.read()
  const queued = tail.enqueued()
  if (tail.waiting() === 0 || queued <= waited.queued) return found
  waited.queued = queued
  for (const deadline = Date.now() + TAKE_IN_WAIT_MS; tail.waiting() > 0 && Date.now() < deadline && !closed();) {
    await delay(25)
    found.push(...tail.read())
  }
  return found
}
