import { z } from "zod"

/** Account admission for a Fin's cloud machine. A reading is an explanation, never a grant to allocate. */
export const CLOUD_FINS_PATH = "/v1/cloud/fins"
const Count = z.number().int().nonnegative().safe()
const Ms = Count
const Digest = z.string().regex(/^[0-9a-f]{64}$/)

/** All devices use the same operation and immutable launch digest, including after a lost reply. */
export const CloudFinStartSchema = z.object({
  op: z.string().startsWith("start:").min(7).max(256),
  inputSha256: Digest,
  thread: z.string().regex(/^t-[0-9a-f]{16}$/),
}).strict()
export type CloudFinStart = z.infer<typeof CloudFinStartSchema>

export const CloudFinReservationSchema = CloudFinStartSchema.extend({
  by: z.uuid(),
  at: Ms,
  phase: z.enum(["reserved", "allocating", "running", "retiring", "settled", "cancelled"]),
  cancel: z.boolean(),
  generation: Count,
  planRevision: Count,
  leaseUntil: Ms,
  retireUntil: Ms,
  reservedCents: Count,
})
export type CloudFinReservation = z.infer<typeof CloudFinReservationSchema>

export const CloudFinStatusSchema = z.object({
  at: Ms,
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  unavailable: z.enum(["no-cloud", "policy", "usage", "price", "unresolved"]).optional(),
  planSandboxes: Count.optional(),
  sandboxCentsPerHour: Count.optional(),
  runningSandboxes: Count,
  dailySpendCents: Count.optional(),
  spentTodayCents: Count.optional(),
  reservedTodayCents: Count,
}).refine((status) => status.unavailable !== undefined || (status.planSandboxes !== undefined && status.sandboxCentsPerHour !== undefined && status.dailySpendCents !== undefined && status.spentTodayCents !== undefined), "An available reading includes plan, price and usage")
export type CloudFinStatus = z.infer<typeof CloudFinStatusSchema>

export const CloudFinAnswerSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), reservation: CloudFinReservationSchema, limits: CloudFinStatusSchema }),
  z.object({ ok: z.literal(false), reason: z.enum(["no-cloud", "policy", "usage", "price", "unresolved", "slots", "spend", "conflict", "cancelled", "missing", "generation"]), limits: CloudFinStatusSchema }),
])
export type CloudFinAnswer = z.infer<typeof CloudFinAnswerSchema>
