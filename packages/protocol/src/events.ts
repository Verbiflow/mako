import { z } from "zod"
import { CorrelationIdSchema, GenerationSchema, SeqSchema } from "./ids.js"
import type { Payload } from "./payload.js"
import { PROTOCOL_VERSION } from "./version.js"

/** A Thread's events, or an account's (its Threads list, its connections), each numbered by its one object. */
export const StreamIdSchema = z
  .string()
  .regex(/^(?:thread|account|session):[A-Za-z0-9._:-]{1,160}$/)

/** What every hop reads of a stream's event; the event crosses after it, as its runtime encoded it (`wire.ts`). */
export const EventFrameEnvelopeSchema = z.lazy(() => z
  .object({
    v: z.literal(PROTOCOL_VERSION),
    stream: StreamIdSchema,
    seq: SeqSchema,
    at: z.iso.datetime(),
    /** The generation of the runtime that produced it; absent for events the object itself records. */
    generation: GenerationSchema.optional(),
    correlationId: CorrelationIdSchema.optional(),
  })
  .strict())

/**
 * What every hop reads of a stream's passing state (`ephemeral`, `EPHEMERAL_LIVE_VERSION`): an event without a place in
 * the stream, so no `seq`. Nothing keeps it, and a reader that missed it reads the next one or none.
 */
export const EphemeralFrameEnvelopeSchema = z.lazy(() => z
  .object({
    v: z.literal(PROTOCOL_VERSION),
    stream: StreamIdSchema,
    at: z.iso.datetime(),
    correlationId: CorrelationIdSchema.optional(),
  })
  .strict())

/** Asks for every event after `after` (0 for all), then the live ones, in order. */
export const SubscribeSchema = z.lazy(() => z
  .object({ stream: StreamIdSchema, after: z.number().int().nonnegative() })
  .strict())

export type StreamId = z.infer<typeof StreamIdSchema>
export type EventFrameEnvelope = z.infer<typeof EventFrameEnvelopeSchema>
/**
 * A stream's event as its subscription hands it on. One marked `ephemeral` is passing state, not a place in the stream:
 * its `seq` is 0, and a reader neither applies it to its cursor nor counts it (`LiveCursor.heard`).
 */
export type EventFrame = EventFrameEnvelope & { event: Payload; ephemeral?: true }
export type EphemeralFrameEnvelope = z.infer<typeof EphemeralFrameEnvelopeSchema>
export type EphemeralFrame = EphemeralFrameEnvelope & { event: Payload }
export type Subscribe = z.infer<typeof SubscribeSchema>

export type CursorStep =
  { kind: "apply" } | { kind: "duplicate" } | { kind: "gap"; after: number }

/**
 * What a reader holding everything up to `last` does with the next frame: apply it, drop a repeat,
 * or resubscribe after `last` because something in between went missing.
 */
export function nextStep(
  last: number,
  frame: Pick<EventFrame, "seq">
): CursorStep {
  if (frame.seq === last + 1) return { kind: "apply" }
  if (frame.seq <= last) return { kind: "duplicate" }
  return { kind: "gap", after: last }
}

export const threadStream = (threadId: string): StreamId => `thread:${threadId}`
export const accountStream = (accountId: string): StreamId =>
  `account:${accountId}`
