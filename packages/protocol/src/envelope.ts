import { z } from "zod"
import {
  CorrelationIdSchema,
  DeviceIdSchema,
  GenerationSchema,
  OperationIdSchema,
  RuntimeIdSchema,
  SeqSchema,
  ThreadIdSchema,
} from "./ids.js"
import type { Payload } from "./payload.js"
import { PROTOCOL_VERSION } from "./version.js"

/** Every kind of client speaks the same operations; nothing is reserved for one of them. */
export const ClientKindSchema = z.enum([
  "desktop",
  "web",
  "phone",
  "slack",
  "agent",
  "script",
])

export const ActorSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("client"),
      client: ClientKindSchema,
      deviceId: DeviceIdSchema,
    })
    .strict(),
  z.object({ kind: z.literal("runtime"), runtimeId: RuntimeIdSchema }).strict(),
])

export const OperationNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/)

/**
 * Where an operation runs:
 * - `thread`: the Thread object admits it, numbers it in the Thread's stream and hands it to
 *   whichever runtime runs the Thread now;
 * - `runtime`: it runs on that one runtime, outside any Thread's order, such as a read of the
 *   laptop's checkout. The gateway passes it through without reading its input; the runtime
 *   that serves it owns its catalog and checks its input.
 */
export const TargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("thread"), threadId: ThreadIdSchema }).strict(),
  z.object({ kind: z.literal("runtime"), runtimeId: RuntimeIdSchema }).strict(),
])

/** What every hop reads of an operation; its input crosses after it, unread (`wire.ts`). */
export const OperationEnvelopeSchema = z
  .object({
    v: z.literal(PROTOCOL_VERSION),
    id: OperationIdSchema,
    op: OperationNameSchema,
    target: TargetSchema,
    correlationId: CorrelationIdSchema,
    actor: ActorSchema,
    /** 1 on the first send; a repeat after a dropped connection counts up. */
    attempt: z.number().int().min(1).max(8),
    /**
     * `defer`: if the Thread's runtime is asleep, don't wake it for this. The gateway takes the operation, answers
     * `deferred` at once, and delivers it, in order, when the runtime next wakes for anything else. Only for an
     * operation whose answer the caller doesn't need and that is safe to repeat, such as closing a conversation.
     */
    whenAsleep: z.literal("defer").optional(),
    /**
     * Sent ahead of a person's message while they write it, such as starting their harness on a Thread made ahead: the
     * gateway doesn't take it as the person arriving, so the Thread stays made ahead until their message comes. Like
     * `whenAsleep`, it's the gateway's to read, and isn't passed on to the runtime.
     */
    ahead: z.literal(true).optional(),
    /**
     * The caller's word that a repeat of this operation's id reaches the same end (its `replay` is `read` or
     * `replay`): the gateway may send it to the runtime before its admission is on disk, and answers it only once it
     * is. Without it, the operation waits for the disk. Like `ahead`, it's the gateway's to read.
     */
    repeatable: z.literal(true).optional(),
    /**
     * A window's own look, polled, not a person acting (an app's status a window keeps showing): if the Thread's
     * runtime is asleep, the gateway answers at once that it is, keeps nothing and wakes nothing; and the call never
     * counts as a person using the Thread, so a window left open doesn't keep its machine running. Only for a read.
     * Like `ahead`, it's the gateway's to read.
     */
    passive: z.literal(true).optional(),
  })
  .strict()

export const PROBLEM_TYPES = [
  "bad-request",
  "unauthorized",
  "forbidden",
  "not-found",
  "conflict",
  "fenced",
  "unsupported-version",
  "owner-unavailable",
  "unavailable",
  "restarting",
  "internal",
  /** It ran and reported a failure of its own; `detail` is its message. */
  "failed",
] as const
export const ProblemTypeSchema = z.enum(PROBLEM_TYPES)

/** Longer messages are cut to this many characters, ending in "…". */
export const PROBLEM_DETAIL_LIMIT = 16_000

/**
 * RFC 9457 problem details. `outcome` says whether the operation ran: a client may repeat an
 * operation that wasn't applied, and must not guess about one whose outcome is unknown.
 */
export const ProblemSchema = z
  .object({
    type: z.templateLiteral(["urn:mako:problem:", ProblemTypeSchema]),
    title: z.string().min(1).max(200),
    status: z.number().int().min(400).max(599).optional(),
    detail: z.string().max(PROBLEM_DETAIL_LIMIT).optional(),
    correlationId: CorrelationIdSchema,
    outcome: z.enum(["not-applied", "unknown"]),
    /** For `fenced`: the generation that now owns the Thread. */
    generation: GenerationSchema.optional(),
    /** For `owner-unavailable` from a runtime: the conversation whose owner is gone. */
    conversationId: z.string().min(1).max(200).optional(),
  })
  .strict()

/** What every hop reads of a reply; a success's value crosses after it, unread (`wire.ts`). */
export const ReplyEnvelopeSchema = z.discriminatedUnion("ok", [
  z
    .object({
      v: z.literal(PROTOCOL_VERSION),
      id: OperationIdSchema,
      ok: z.literal(true),
      /** For a Thread operation: the event that recorded its admission. */
      seq: SeqSchema.optional(),
      /** Taken without waking an asleep runtime (`whenAsleep: "defer"`): it runs when the runtime next wakes. */
      deferred: z.literal(true).optional(),
    })
    .strict(),
  z
    .object({
      v: z.literal(PROTOCOL_VERSION),
      id: OperationIdSchema,
      ok: z.literal(false),
      problem: ProblemSchema,
    })
    .strict(),
])

export type ClientKind = z.infer<typeof ClientKindSchema>
export type Actor = z.infer<typeof ActorSchema>
export type Target = z.infer<typeof TargetSchema>
export type OperationEnvelope = z.infer<typeof OperationEnvelopeSchema>
/** Only the runtime that serves an operation decodes its input. */
export type Operation = OperationEnvelope & { input: Payload }
export type ProblemType = z.infer<typeof ProblemTypeSchema>
export type Problem = z.infer<typeof ProblemSchema>
export type ReplyEnvelope = z.infer<typeof ReplyEnvelopeSchema>
/** Only the client that sent the operation decodes a success's value. */
export type Reply =
  | (Extract<ReplyEnvelope, { ok: true }> & { value?: Payload })
  | Extract<ReplyEnvelope, { ok: false }>

export function problemType(problem: Problem): ProblemType {
  return ProblemTypeSchema.parse(problem.type.slice("urn:mako:problem:".length))
}

export function problem(
  type: ProblemType,
  title: string,
  correlationId: string,
  outcome: Problem["outcome"],
  extra: Partial<
    Pick<Problem, "status" | "detail" | "generation" | "conversationId">
  > = {}
): Problem {
  const made: Problem = {
    type: `urn:mako:problem:${type}`,
    title,
    correlationId,
    outcome,
  }
  if (extra.status !== undefined) made.status = extra.status
  if (extra.detail !== undefined) made.detail = boundedDetail(extra.detail)
  if (extra.generation !== undefined) made.generation = extra.generation
  if (extra.conversationId !== undefined)
    made.conversationId = extra.conversationId
  return made
}

export function boundedDetail(detail: string): string {
  return detail.length > PROBLEM_DETAIL_LIMIT
    ? `${detail.slice(0, PROBLEM_DETAIL_LIMIT - 1)}…`
    : detail
}
