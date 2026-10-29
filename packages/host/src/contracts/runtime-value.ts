import type { Json } from "@mako/protocol"
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
}

export type RuntimeEventChannel = "event" | "terminal"

/** An event encoded once, for every subscriber of every host and window it reaches. */
export function encodeRuntimeEvent(event: HostEvent | TerminalEvent): RuntimeEvent {
  return { type: event.type, conversation: event.type === "live-batch" ? event.batch.id : undefined, payload: JSON.stringify(event) }
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
