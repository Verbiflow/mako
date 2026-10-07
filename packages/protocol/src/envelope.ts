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

export const OperationSchema = z
  .object({
    v: z.literal(PROTOCOL_VERSION),
    id: OperationIdSchema,
    op: OperationNameSchema,
    /** Set for an operation the Thread object admits and orders. */
    threadId: ThreadIdSchema.optional(),
    input: z.json(),
    correlationId: CorrelationIdSchema,
    actor: ActorSchema,
    /** 1 on the first send; a repeat after a dropped connection counts up. */
    attempt: z.number().int().min(1).max(8),
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
] as const
export const ProblemTypeSchema = z.enum(PROBLEM_TYPES)

/**
 * RFC 9457 problem details. `outcome` says whether the operation ran: a client may repeat an
 * operation that wasn't applied, and must not guess about one whose outcome is unknown.
 */
export const ProblemSchema = z
  .object({
    type: z.templateLiteral(["urn:mako:problem:", ProblemTypeSchema]),
    title: z.string().min(1).max(200),
    status: z.number().int().min(400).max(599).optional(),
    detail: z.string().max(2_000).optional(),
    correlationId: CorrelationIdSchema,
    outcome: z.enum(["not-applied", "unknown"]),
    /** For `fenced`: the generation that now owns the Thread. */
    generation: GenerationSchema.optional(),
  })
  .strict()

export const ReplySchema = z.discriminatedUnion("ok", [
  z
    .object({
      v: z.literal(PROTOCOL_VERSION),
      id: OperationIdSchema,
      ok: z.literal(true),
      value: z.json().optional(),
      /** For a Thread operation: the event that recorded its admission. */
      seq: SeqSchema.optional(),
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
export type Operation = z.infer<typeof OperationSchema>
export type ProblemType = z.infer<typeof ProblemTypeSchema>
export type Problem = z.infer<typeof ProblemSchema>
export type Reply = z.infer<typeof ReplySchema>

export function problemType(problem: Problem): ProblemType {
  return ProblemTypeSchema.parse(problem.type.slice("urn:mako:problem:".length))
}

export function problem(
  type: ProblemType,
  title: string,
  correlationId: string,
  outcome: Problem["outcome"],
  extra: Partial<Pick<Problem, "status" | "detail" | "generation">> = {}
): Problem {
  return {
    type: `urn:mako:problem:${type}`,
    title,
    correlationId,
    outcome,
    ...extra,
  }
}
