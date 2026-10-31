import type { Json } from "@mako/protocol"
import { COMPACT_LIVE_FORM, WHOLE_LIVE_FORM, readsLiveForm, type LiveForm } from "@mako/protocol/live-form"
import type { HostEvent } from "./host-events-boot.js"
import type { TerminalEvent } from "./terminal.js"

/**
 * A host call's value as the host encoded it: JSON text, or `undefined` for a
 * call that returned nothing. The host encodes it once; every hop between the
 * host and the caller (the socket, the desktop's main process, a gateway)
 * carries the text, and only the caller decodes it.
 *
 * Imports no code, so the desktop preload can decode without bundling zod.
 */
export type EncodedValue = string | undefined

/** What JSON can't hold throws (a BigInt, a cycle); what it drops (`undefined`, a function) is a call that returned nothing. */
export function encodeRuntimeValue<Value>(value: Value): EncodedValue {
  // JSON.stringify gives undefined for undefined, a function or a symbol, which its declared type leaves out.
  const encoded: string | undefined = JSON.stringify(value)
  return encoded
}

export function decodeRuntimeValue(encoded: EncodedValue): Json | undefined {
  return encoded === undefined ? undefined : JSON.parse(encoded)
}

/**
 * A handler's answer that another call already encoded, such as the owner's
 * snapshot it asked for: it crosses as that text, unread, and whoever encoded
 * it paged its history.
 */
export class EncodedAnswer {
  readonly value: EncodedValue
  constructor(value: EncodedValue) {
    this.value = value
  }
}

/** What a hop routes an event by: its type, and the conversation a live batch is about. */
export interface RuntimeEventRouting {
  type?: string
  conversation?: string
  /** A sampled live batch's trace (`LiveBatch.trace`), which each hop that carries it logs. */
  trace?: string
}

/** An event as its producer encoded it, with what a hop routes it by. */
export interface RuntimeEvent extends RuntimeEventRouting {
  payload: string
  /** The same event in the compact live form, where it has one (a batch its host emitted): for a reader of that form. */
  compact?: string
  /**
   * The live form `payload` is in, when above 1: a batch heard so from another device, which this host has in no other.
   * A reader of an older form is told to read the conversation again in its place.
   */
  form?: LiveForm
}

/**
 * What a reader of live form `reads` is sent of `event`: its payload in the newest form the reader reads, or undefined
 * when it has none the reader reads, where the notice that its conversation changed goes instead (`historyChangedNotice`).
 */
export function payloadFor(event: RuntimeEvent, reads: LiveForm): string | undefined {
  if (event.compact !== undefined && reads >= COMPACT_LIVE_FORM) return event.compact
  return readsLiveForm(reads, event.form) ? event.payload : undefined
}

export type RuntimeEventChannel = "event" | "terminal"

/** An event encoded once, for every subscriber of every host and window it reaches. */
export function encodeRuntimeEvent(event: HostEvent | TerminalEvent): RuntimeEvent {
  if (event.type !== "live-batch") return { type: event.type, conversation: undefined, payload: JSON.stringify(event) }
  const { compact, ...whole } = event
  return {
    type: event.type,
    conversation: event.batch.id,
    ...(event.batch.trace && { trace: event.batch.trace }),
    payload: JSON.stringify(whole),
    ...(compact && { compact: JSON.stringify({ type: event.type, batch: compact }) }),
  }
}

/** An event for its window, decoded once; only the host and the desktop's main process write what reaches it. */
export function decodeRuntimeEvent<Event extends HostEvent | TerminalEvent>(payload: string): Event {
  return JSON.parse(payload)
}

/**
 * Whether a call's answer crosses from the desktop's main process to its window as its
 * encoding, which the window decodes. Every answer does, so main forwards the host's text
 * unread, except a preview's and its video's, whose pixels cross as bytes.
 */
export function answerCrossesEncoded(channel: string): boolean {
  return channel !== "mako:control-preview" && channel !== "mako:control-video"
}

const EMPTY_SUCCESS = '{"ok":true}'
const VALUE_SUCCESS = '{"ok":true,"value":'

/**
 * A successful call's body on the host socket: byte for byte what
 * `JSON.stringify({ ok: true, value })` writes, which is what every build of
 * the host has sent and every client reads, so hosts and clients of different
 * builds keep understanding each other.
 */
export function runtimeSuccessBody(value: EncodedValue): string {
  return value === undefined ? EMPTY_SUCCESS : `${VALUE_SUCCESS}${value}}`
}

/**
 * The value a success body carries, cut out without decoding it, or `null`
 * when the body isn't a success (a failure, which its reader decodes).
 */
export function runtimeSuccessValue(body: string): EncodedValue | null {
  if (body === EMPTY_SUCCESS) return undefined
  if (body.startsWith(VALUE_SUCCESS) && body.endsWith("}")) return body.slice(VALUE_SUCCESS.length, -1)
  return null
}

const PAYLOAD_FIELD = ',"payload":'
const EVENT_LINES = ['{"channel":"event",', '{"channel":"terminal",']

/**
 * An event's line on `/events`: its header, then its payload's text, last.
 * Every build has written `{"channel":…,"payload":…}` and read the line as one
 * JSON object, so a header field added between them reaches older readers as a
 * key they ignore.
 */
export function runtimeEventLine(channel: RuntimeEventChannel, event: RuntimeEvent): string {
  const head = JSON.stringify({ channel, type: event.type, conversation: event.conversation })
  return `${head.slice(0, -1)}${PAYLOAD_FIELD}${event.payload}}\n`
}

/**
 * An event line's header, as JSON, and its payload's text, cut apart without
 * reading the payload; `null` for a line that carries none (`ready`). A JSON
 * string never holds a bare `"`, so the header's first `,"payload":` ends it.
 */
export function splitRuntimeEventLine(line: string): { head: string; payload: string } | null {
  if (!EVENT_LINES.some((start) => line.startsWith(start)) || !line.endsWith("}")) return null
  const at = line.indexOf(PAYLOAD_FIELD)
  if (at < 0) return null
  return { head: `${line.slice(0, at)}}`, payload: line.slice(at + PAYLOAD_FIELD.length, -1) }
}

/** The live form a `live-batch` event's payload is written in (`CompactLiveBatch` says it); form 1 for any other. */
export function batchPayloadForm(payload: string): LiveForm {
  // SAFETY: a `live-batch` event's payload as its host wrote it, whose batch says `form` only in the compact form.
  const event = JSON.parse(payload) as { batch?: { form?: LiveForm } } | null
  return event?.batch?.form === COMPACT_LIVE_FORM ? COMPACT_LIVE_FORM : WHOLE_LIVE_FORM
}

/** How a batch's payload begins in the compact live form: its conversation leads (`compactLiveBatch`). */
const COMPACT_BATCH_START = '{"type":"live-batch","batch":{"id":"'

/** What a line of an owner's stream says, as every reader reads it (`readEventLine`). */
export type EventLine = { channel: string; type: string | undefined; conversation: string | undefined; payload: string; form: LiveForm }

/**
 * A line of an owner's stream through the gateway, as a device reads it: a header then the payload (`runtimeEventLine`),
 * or, in the compact live form, a batch's payload alone, read as one by its first characters. `null` for a line that is
 * neither, or one whose header isn't JSON.
 */
export function readEventLine(line: string): EventLine | null {
  if (line.startsWith(COMPACT_BATCH_START)) {
    const end = line.indexOf('"', COMPACT_BATCH_START.length)
    if (end < 0) return null
    return { channel: "event", type: "live-batch", conversation: line.slice(COMPACT_BATCH_START.length, end), payload: line, form: COMPACT_LIVE_FORM }
  }
  const parts = splitRuntimeEventLine(line)
  if (!parts) return null
  let head: EventHead | null
  try {
    // SAFETY: a header as every build's `runtimeEventLine` writes it: its channel, its event's type and conversation.
    head = JSON.parse(parts.head) as EventHead | null
  } catch {
    return null
  }
  if (!head?.channel) return null
  return { channel: head.channel, type: head.type, conversation: head.conversation, payload: parts.payload, form: WHOLE_LIVE_FORM }
}

/** What an event line's header says (`runtimeEventLine`). */
type EventHead = { channel?: string; type?: string; conversation?: string }
