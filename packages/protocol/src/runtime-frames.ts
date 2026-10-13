import { z } from "zod"
import {
  type Operation,
  OperationEnvelopeSchema,
  ProblemSchema,
  type Reply,
  ReplyEnvelopeSchema,
} from "./envelope.js"
import {
  CorrelationIdSchema,
  GenerationSchema,
  RuntimeIdSchema,
  SeqSchema,
  ThreadIdSchema,
} from "./ids.js"
import type { Payload } from "./payload.js"
import { VersionRangeSchema } from "./version.js"

/**
 * One runtime's connection to the gateway. A runtime proposes events with its own counter
 * (`localSeq`, per Thread and generation); the Thread object gives each its place in the stream
 * and acknowledges it, so a runtime that reconnects resends what wasn't acknowledged and nothing
 * is recorded twice.
 *
 * These are the frames' envelopes; an event, a reply's value and an operation's input cross
 * after them, unread (`wire.ts`).
 */
export const RuntimeFrameEnvelopeSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("enroll"),
      runtimeId: RuntimeIdSchema,
      versions: VersionRangeSchema,
      /** The runtime's own build, for logs and for retiring old images. */
      build: z.string().min(1).max(120),
      /** The Threads it believes it runs. The gateway fences any it no longer does. */
      threads: z
        .array(
          z
            .object({ threadId: ThreadIdSchema, generation: GenerationSchema })
            .strict()
        )
        .max(1_000),
    })
    .strict(),
  /** The heartbeat, `PING` as it is; answered `PONG` before enrolment as after. */
  z.object({ type: z.literal("ping") }).strict(),
  /** A fresh token for this link, before its own runs out (`credential.ts`). A machine's credential doesn't. */
  z
    .object({ type: z.literal("renew"), token: z.string().min(1).max(8_192) })
    .strict(),
  z
    .object({
      type: z.literal("event"),
      threadId: ThreadIdSchema,
      generation: GenerationSchema,
      localSeq: SeqSchema,
      correlationId: CorrelationIdSchema.optional(),
    })
    .strict(),
  z.object({ type: z.literal("reply"), reply: ReplyEnvelopeSchema }).strict(),
])

export const GatewayFrameEnvelopeSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("enrolled"),
      version: z.number().int().positive(),
      /** Send a ping at least this often; the gateway treats twice this as gone. */
      heartbeatMs: z.number().int().positive(),
    })
    .strict(),
  /**
   * The link is refused and closes after this frame: `unauthorized` when its credential ran out or a renewal was
   * refused (connect again with a fresh one), `forbidden` when its device was removed.
   */
  z.object({ type: z.literal("refused"), problem: ProblemSchema }).strict(),
  z.object({ type: z.literal("pong") }).strict(),
  /** The renewal was taken: the link's credential is good until `expiresAt`, in seconds since 1970. */
  z
    .object({
      type: z.literal("renewed"),
      expiresAt: z.number().int().positive(),
    })
    .strict(),
  /** Run this Thread from now on, under this generation. */
  z
    .object({
      type: z.literal("assign"),
      threadId: ThreadIdSchema,
      generation: GenerationSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("operation"),
      /** For a Thread operation: the generation it was admitted under. */
      generation: GenerationSchema.optional(),
      operation: OperationEnvelopeSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("ack"),
      threadId: ThreadIdSchema,
      generation: GenerationSchema,
      localSeq: SeqSchema,
      seq: SeqSchema,
    })
    .strict(),
  /** Stop acting for this Thread under any generation below `generation`, now. */
  z
    .object({
      type: z.literal("fence"),
      threadId: ThreadIdSchema,
      generation: GenerationSchema,
    })
    .strict(),
  /** An event the Thread object didn't record, and why. */
  z
    .object({
      type: z.literal("rejected"),
      threadId: ThreadIdSchema,
      localSeq: SeqSchema,
      problem: ProblemSchema,
    })
    .strict(),
])

export type RuntimeFrameEnvelope = z.infer<typeof RuntimeFrameEnvelopeSchema>
export type GatewayFrameEnvelope = z.infer<typeof GatewayFrameEnvelopeSchema>

export type RuntimeFrame =
  | Exclude<RuntimeFrameEnvelope, { type: "event" | "reply" }>
  | (Extract<RuntimeFrameEnvelope, { type: "event" }> & { event: Payload })
  | { type: "reply"; reply: Reply }
export type GatewayFrame =
  | Exclude<GatewayFrameEnvelope, { type: "operation" }>
  | (Omit<Extract<GatewayFrameEnvelope, { type: "operation" }>, "operation"> & {
      operation: Operation
    })
