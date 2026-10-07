import { z } from "zod"
import { OperationSchema, ProblemSchema, ReplySchema } from "./envelope.js"
import {
  CorrelationIdSchema,
  GenerationSchema,
  RuntimeIdSchema,
  SeqSchema,
  ThreadIdSchema,
} from "./ids.js"
import { VersionRangeSchema } from "./version.js"

/**
 * One runtime's connection to the gateway. A runtime proposes events with its own counter
 * (`localSeq`, per Thread and generation); the Thread object gives each its place in the stream
 * and acknowledges it, so a runtime that reconnects resends what wasn't acknowledged and nothing
 * is recorded twice.
 */
export const RuntimeFrameSchema = z.discriminatedUnion("type", [
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
  z.object({ type: z.literal("heartbeat") }).strict(),
  z
    .object({
      type: z.literal("event"),
      threadId: ThreadIdSchema,
      generation: GenerationSchema,
      localSeq: SeqSchema,
      correlationId: CorrelationIdSchema.optional(),
      event: z.json(),
    })
    .strict(),
  z.object({ type: z.literal("reply"), reply: ReplySchema }).strict(),
])

export const GatewayFrameSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("enrolled"),
      version: z.number().int().positive(),
      /** Send a heartbeat at least this often; the gateway treats twice this as gone. */
      heartbeatMs: z.number().int().positive(),
    })
    .strict(),
  z.object({ type: z.literal("refused"), problem: ProblemSchema }).strict(),
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
      operation: OperationSchema,
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

export type RuntimeFrame = z.infer<typeof RuntimeFrameSchema>
export type GatewayFrame = z.infer<typeof GatewayFrameSchema>
