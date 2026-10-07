import { z } from "zod"
import { CorrelationIdSchema, GenerationSchema, SeqSchema } from "./ids.js"
import { PROTOCOL_VERSION } from "./version.js"

/** A Thread's events, or an account's (its Threads list, its connections), each numbered by its one object. */
export const StreamIdSchema = z
  .string()
  .regex(/^(?:thread|account):[A-Za-z0-9._:-]{1,160}$/)

export const EventFrameSchema = z
  .object({
    v: z.literal(PROTOCOL_VERSION),
    stream: StreamIdSchema,
    seq: SeqSchema,
    at: z.iso.datetime(),
    /** The generation of the runtime that produced it; absent for events the object itself records. */
    generation: GenerationSchema.optional(),
    correlationId: CorrelationIdSchema.optional(),
    event: z.json(),
  })
  .strict()

/** Asks for every event after `after` (0 for all), then the live ones, in order. */
export const SubscribeSchema = z
  .object({ stream: StreamIdSchema, after: z.number().int().nonnegative() })
  .strict()

export type StreamId = z.infer<typeof StreamIdSchema>
export type EventFrame = z.infer<typeof EventFrameSchema>
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
