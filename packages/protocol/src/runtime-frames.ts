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
import { MediaStreamIdSchema } from "./media.js"
import { SessionsReportSchema } from "./thread-listing.js"
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
  /**
   * Whether the runtime is working on the Thread (version 2 on): a turn, queued work or the harness's background
   * work, even when it streams nothing. Sent when it changes, and while busy at least every `ACTIVITY_HEARTBEAT_MS`,
   * so a gateway that hears nothing for a while takes it as idle. `work` names what's running, for people reading
   * logs; nothing decides on it.
   */
  z
    .object({
      type: z.literal("activity"),
      threadId: ThreadIdSchema,
      generation: GenerationSchema,
      busy: z.boolean(),
      work: z.array(z.string().min(1).max(120)).max(20),
    })
    .strict(),
  /**
   * Link version 4's listing, keyed by cloud Thread (2026-10-24): runtimes on that version send it, and a gateway
   * decodes it so their link holds, then drops it. `sessions` replaced it.
   */
  z
    .object({
      type: z.literal("listing"),
      threadId: ThreadIdSchema,
      generation: GenerationSchema,
      listing: z.object({ conversations: z.array(z.object({ id: z.string() }).loose()).max(50) }).strict(),
    })
    .strict(),
  /**
   * The runtime's Sessions, as the account's list shows them (version 5 on, `thread-listing.ts`): every one it owns on
   * each enrolment (`owned`), then what changes, never as a heartbeat. Where they run, the cloud knows from who sent it.
   */
  z.object({ type: z.literal("sessions"), report: SessionsReportSchema }).strict(),
  /**
   * One live update of a conversation someone watches (version 5 on, `sessionStream`), its event after the envelope as
   * the runtime encoded it. Not kept and not acknowledged: a watcher that misses one asks for a snapshot.
   */
  z.object({ type: z.literal("live"), conversation: z.string().min(1).max(128) }).strict(),
  /** The runtime ended a stream it served (version 3 on, `media.ts`); its viewer hears why. */
  z
    .object({
      type: z.literal("media-end"),
      stream: MediaStreamIdSchema,
      problem: ProblemSchema.optional(),
    })
    .strict(),
])

/** A busy runtime says so at least this often; a gateway takes three missed as idle. */
export const ACTIVITY_HEARTBEAT_MS = 60_000

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
  /**
   * An event the Thread object didn't record, and why: `fenced` when the runtime no longer runs the Thread under
   * that generation; otherwise it wasn't taken, and neither was anything sent after it until it's sent again.
   */
  z
    .object({
      type: z.literal("rejected"),
      threadId: ThreadIdSchema,
      /** The event's generation, as the runtime sent it. */
      generation: GenerationSchema,
      localSeq: SeqSchema,
      problem: ProblemSchema,
    })
    .strict(),
  /**
   * A client watches a stream of a Thread this runtime runs (version 3 on, `media.ts`); the client's request crosses
   * after it, unread. Again for the same stream when the client changes its request.
   */
  z
    .object({
      type: z.literal("media-watch"),
      threadId: ThreadIdSchema,
      stream: MediaStreamIdSchema,
    })
    .strict(),
  /** Every byte of the stream's messages its viewer has taken so far. */
  z
    .object({
      type: z.literal("media-ack"),
      stream: MediaStreamIdSchema,
      received: z.number().int().nonnegative(),
    })
    .strict(),
  /** The stream's viewer stopped watching or left: send nothing more on it. */
  z.object({ type: z.literal("media-unwatch"), stream: MediaStreamIdSchema }).strict(),
  /**
   * The conversations of this runtime someone watches now, the whole set, replacing the last (version 5 on): send their
   * live updates and no others'. A new link starts with none watched; this is said on enrolment when some are, and on
   * each change, so any one frame is the truth for its link.
   */
  z.object({ type: z.literal("watch"), conversations: z.array(z.string().min(1).max(128)).max(1_000) }).strict(),
])

export type RuntimeFrameEnvelope = z.infer<typeof RuntimeFrameEnvelopeSchema>
export type GatewayFrameEnvelope = z.infer<typeof GatewayFrameEnvelopeSchema>

export type RuntimeFrame =
  | Exclude<RuntimeFrameEnvelope, { type: "event" | "reply" | "live" }>
  | (Extract<RuntimeFrameEnvelope, { type: "event" }> & { event: Payload })
  | (Extract<RuntimeFrameEnvelope, { type: "live" }> & { event: Payload })
  | { type: "reply"; reply: Reply }
export type GatewayFrame =
  | Exclude<GatewayFrameEnvelope, { type: "operation" | "media-watch" }>
  | (Omit<Extract<GatewayFrameEnvelope, { type: "operation" }>, "operation"> & {
      operation: Operation
    })
  | (Extract<GatewayFrameEnvelope, { type: "media-watch" }> & { request: Payload })
