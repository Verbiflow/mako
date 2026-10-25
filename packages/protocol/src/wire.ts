import { z } from "zod"
import {
  type ClientFrame,
  type ClientFrameEnvelope,
  ClientFrameEnvelopeSchema,
  type GatewayClientFrame,
  type GatewayClientFrameEnvelope,
  GatewayClientFrameEnvelopeSchema,
} from "./client-frames.js"
import {
  type Operation,
  type OperationEnvelope,
  OperationEnvelopeSchema,
  type Reply,
  type ReplyEnvelope,
  ReplyEnvelopeSchema,
} from "./envelope.js"
import {
  type EventFrame,
  type EventFrameEnvelope,
  EventFrameEnvelopeSchema,
} from "./events.js"
import { Payload } from "./payload.js"
import {
  type GatewayFrame,
  type GatewayFrameEnvelope,
  GatewayFrameEnvelopeSchema,
  type RuntimeFrame,
  type RuntimeFrameEnvelope,
  RuntimeFrameEnvelopeSchema,
} from "./runtime-frames.js"
import { WireError } from "./wire-error.js"

/**
 * How frames cross a connection. A frame is its envelope as one line of JSON, then, for a frame
 * that carries a payload, a newline and the payload's text as its producer encoded it:
 *
 *     {"type":"reply","reply":{"v":1,"id":"…","ok":true}}
 *     {"files":[…]}
 *
 * A hop reads the envelope alone and forwards the rest unread, so a payload is encoded once by
 * its producer and decoded once by its consumer however many hops it crosses, and a hop's cost
 * doesn't grow with it. JSON.stringify never writes a raw newline, so the first one ends the
 * envelope; the payload after it may hold any.
 */

export { WireError }

export function encodeOperation({ input, ...envelope }: Operation): string {
  return framed(envelope, input)
}

export function decodeOperation(text: string): Operation {
  const { head, payload } = split(text)
  return {
    ...envelope(OperationEnvelopeSchema, head),
    input: required(payload, "An operation"),
  }
}

export function encodeReply(reply: Reply): string {
  if (!reply.ok) return framed(reply, undefined)
  const { value, ...envelope } = reply
  return framed(envelope, value)
}

export function decodeReply(text: string): Reply {
  const { head, payload } = split(text)
  return withValue(envelope(ReplyEnvelopeSchema, head), payload)
}

export function encodeEventFrame({ event, ...envelope }: EventFrame): string {
  return framed(envelope, event)
}

export function decodeEventFrame(text: string): EventFrame {
  const { head, payload } = split(text)
  return {
    ...envelope(EventFrameEnvelopeSchema, head),
    event: required(payload, "An event frame"),
  }
}

export function encodeRuntimeFrame(frame: RuntimeFrame): string {
  if (frame.type === "event" || frame.type === "live") {
    const { event, ...envelope } = frame
    return framed(envelope, event)
  }
  if (frame.type === "reply" && frame.reply.ok) {
    const { value, ...reply } = frame.reply
    return framed({ type: "reply", reply }, value)
  }
  return framed(frame, undefined)
}

export function decodeRuntimeFrame(text: string): RuntimeFrame {
  const { head, payload } = split(text)
  const frame = envelope(RuntimeFrameEnvelopeSchema, head)
  if (frame.type === "event")
    return { ...frame, event: required(payload, "An event") }
  if (frame.type === "live")
    return { ...frame, event: required(payload, "A live update") }
  if (frame.type === "reply")
    return { type: "reply", reply: withValue(frame.reply, payload) }
  return bare(frame, payload)
}

export function encodeGatewayFrame(frame: GatewayFrame): string {
  if (frame.type === "media-watch") {
    const { request, ...watch } = frame
    return framed(watch, request)
  }
  if (frame.type !== "operation") return framed(frame, undefined)
  const { input, ...operation } = frame.operation
  return framed({ ...frame, operation }, input)
}

export function decodeGatewayFrame(text: string): GatewayFrame {
  const { head, payload } = split(text)
  const frame = envelope(GatewayFrameEnvelopeSchema, head)
  if (frame.type === "media-watch")
    return { ...frame, request: required(payload, "A media watch") }
  if (frame.type !== "operation") return bare(frame, payload)
  return {
    ...frame,
    operation: {
      ...frame.operation,
      input: required(payload, "An operation"),
    },
  }
}

export function encodeClientFrame(frame: ClientFrame): string {
  if (frame.type === "media-watch") {
    const { request, ...watch } = frame
    return framed(watch, request)
  }
  if (frame.type !== "call") return framed(frame, undefined)
  const { input, ...operation } = frame.operation
  return framed({ type: "call", operation }, input)
}

export function decodeClientFrame(text: string): ClientFrame {
  const { head, payload } = split(text)
  const frame = envelope(ClientFrameEnvelopeSchema, head)
  if (frame.type === "media-watch")
    return { ...frame, request: required(payload, "A media watch") }
  if (frame.type !== "call") return bare(frame, payload)
  return {
    type: "call",
    operation: { ...frame.operation, input: required(payload, "A call") },
  }
}

export function encodeGatewayClientFrame(frame: GatewayClientFrame): string {
  if (frame.type === "event") {
    const { event, ...head } = frame.event
    return framed({ type: "event", event: head }, event)
  }
  if (frame.type === "reply") {
    if (!frame.reply.ok)
      return framed({ type: "reply", reply: frame.reply }, undefined)
    const { value, ...reply } = frame.reply
    return framed({ type: "reply", reply }, value)
  }
  return framed(frame, undefined)
}

export function decodeGatewayClientFrame(text: string): GatewayClientFrame {
  const { head, payload } = split(text)
  const frame = envelope(GatewayClientFrameEnvelopeSchema, head)
  if (frame.type === "event")
    return {
      type: "event",
      event: { ...frame.event, event: required(payload, "An event") },
    }
  if (frame.type === "reply")
    return { type: "reply", reply: withValue(frame.reply, payload) }
  return bare(frame, payload)
}

type Envelope =
  | ClientFrameEnvelope
  | GatewayClientFrameEnvelope
  | OperationEnvelope
  | ReplyEnvelope
  | EventFrameEnvelope
  | RuntimeFrameEnvelope
  | GatewayFrameEnvelope

function framed(envelope: Envelope, payload: Payload | undefined): string {
  const head = JSON.stringify(envelope)
  return payload === undefined ? head : `${head}\n${payload.text}`
}

function split(text: string) {
  const end = text.indexOf("\n")
  return end === -1
    ? { head: text, payload: undefined }
    : {
        head: text.slice(0, end),
        payload: Payload.encoded(text.slice(end + 1)),
      }
}

function envelope<T>(schema: z.ZodType<T>, head: string): T {
  let decoded: unknown
  try {
    decoded = JSON.parse(head)
  } catch (error) {
    throw new WireError(
      `The envelope isn't JSON: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  const parsed = schema.safeParse(decoded)
  if (!parsed.success) throw new WireError(z.prettifyError(parsed.error))
  return parsed.data
}

function required(payload: Payload | undefined, carrier: string): Payload {
  if (payload === undefined)
    throw new WireError(`${carrier} carries a payload, and this one has none`)
  return payload
}

function bare<T extends { type: string }>(
  frame: T,
  payload: Payload | undefined
): T {
  if (payload !== undefined)
    throw new WireError(`A ${frame.type} frame carries no payload`)
  return frame
}

function withValue(reply: ReplyEnvelope, payload: Payload | undefined): Reply {
  if (!reply.ok) {
    if (payload !== undefined)
      throw new WireError("A failed reply carries no value")
    return reply
  }
  return payload === undefined ? reply : { ...reply, value: payload }
}
