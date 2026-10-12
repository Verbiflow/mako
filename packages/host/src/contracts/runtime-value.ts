import type { Json } from "@mako/protocol"

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
 * Whether a call's answer crosses from the desktop's main process to its window as its
 * encoding, which the window decodes. Every answer does, so main forwards the host's text
 * unread, except a preview's, whose pixels cross as bytes.
 */
export function answerCrossesEncoded(channel: string): boolean {
  return channel !== "mako:control-preview"
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
