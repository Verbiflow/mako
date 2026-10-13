import { z } from "zod"
import {
  problem,
  type Operation,
  OperationEnvelopeSchema,
  ProblemSchema,
  type Reply,
  ReplyEnvelopeSchema,
} from "./envelope.js"
import {
  type EventFrame,
  EventFrameEnvelopeSchema,
  StreamIdSchema,
} from "./events.js"
import { CorrelationIdSchema } from "./ids.js"
import { PROTOCOL_VERSION } from "./version.js"

/**
 * A client's connection to the gateway: its calls and their replies, its subscriptions and their
 * events, multiplexed on one socket. A client may hold one connection per endpoint (a Thread, a
 * runtime, its account), and each carries the same frames.
 *
 * These are the frames' envelopes; an operation's input, a reply's value and an event cross after
 * them, unread (`wire.ts`).
 */
export const ClientFrameEnvelopeSchema = z.discriminatedUnion("type", [
  /** An operation; its reply comes back as a `reply` frame with its id, in any order. */
  z
    .object({ type: z.literal("call"), operation: OperationEnvelopeSchema })
    .strict(),
  /** Every event of `stream` after `after`, then the live ones, each as an `event` frame. */
  z
    .object({
      type: z.literal("subscribe"),
      stream: StreamIdSchema,
      after: z.number().int().nonnegative(),
    })
    .strict(),
  z.object({ type: z.literal("unsubscribe"), stream: StreamIdSchema }).strict(),
  /** Keeps an idle connection open: `PING` as it is, answered `PONG` (`heartbeat.ts`). */
  z.object({ type: z.literal("ping") }).strict(),
  /** A fresh token for this connection, before its own runs out (`credential.ts`). */
  z
    .object({ type: z.literal("renew"), token: z.string().min(1).max(8_192) })
    .strict(),
])

export const GatewayClientFrameEnvelopeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("reply"), reply: ReplyEnvelopeSchema }).strict(),
  z
    .object({ type: z.literal("event"), event: EventFrameEnvelopeSchema })
    .strict(),
  /**
   * A frame the gateway couldn't read, or a subscription it won't serve, and why. A call it couldn't
   * read is answered as a `reply` with its id where it has one.
   */
  z
    .object({
      type: z.literal("refused"),
      problem: ProblemSchema,
      stream: StreamIdSchema.optional(),
    })
    .strict(),
  z.object({ type: z.literal("pong") }).strict(),
  /** The renewal was taken: the connection's credential is good until `expiresAt`, in seconds since 1970. */
  z
    .object({
      type: z.literal("renewed"),
      expiresAt: z.number().int().positive(),
    })
    .strict(),
  /**
   * The gateway is closing the connection, and why: `unauthorized` when its credential ran out or a renewal was
   * refused (connect again with a fresh one), `forbidden` when its device was removed. The close follows.
   */
  z.object({ type: z.literal("closing"), problem: ProblemSchema }).strict(),
])

export type ClientFrameEnvelope = z.infer<typeof ClientFrameEnvelopeSchema>
export type GatewayClientFrameEnvelope = z.infer<
  typeof GatewayClientFrameEnvelopeSchema
>

export type ClientFrame =
  | Exclude<ClientFrameEnvelope, { type: "call" }>
  | { type: "call"; operation: Operation }
export type GatewayClientFrame =
  | Exclude<GatewayClientFrameEnvelope, { type: "reply" | "event" }>
  | { type: "reply"; reply: Reply }
  | { type: "event"; event: EventFrame }

/**
 * What a gateway answers to client text it couldn't read: a call is answered as a `bad-request` reply
 * under the id and correlation ID its envelope carries, where it has them, so its caller hears; anything
 * else is refused. Neither was applied.
 */
export function answerUnreadable(
  text: string,
  detail: string
): GatewayClientFrame {
  const end = text.indexOf("\n")
  let head: unknown
  try {
    head = JSON.parse(end === -1 ? text : text.slice(0, end))
  } catch {
    // Not JSON: there is nothing to echo.
  }
  const call = z
    .object({
      type: z.literal("call"),
      operation: z
        .object({ id: z.uuid(), correlationId: CorrelationIdSchema.optional() })
        .loose(),
    })
    .loose()
    .safeParse(head)
  const correlationId =
    call.data?.operation.correlationId ?? crypto.randomUUID()
  const reason = problem(
    "bad-request",
    call.success ? "Not a valid operation" : "Not a client frame",
    correlationId,
    "not-applied",
    {
      status: 400,
      detail,
    }
  )
  if (call.success)
    return {
      type: "reply",
      reply: {
        v: PROTOCOL_VERSION,
        id: call.data.operation.id,
        ok: false,
        problem: reason,
      },
    }
  return { type: "refused", problem: reason }
}
