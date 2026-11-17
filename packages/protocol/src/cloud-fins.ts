import { z } from "zod"
import { ContinueRepositorySchema } from "./continue-rows.js"
import { namedUuid } from "./continues.js"
import type { Json } from "./ids.js"

/** Account admission for a Fin's cloud machine. A reading is an explanation, never a grant to allocate. */
export const CLOUD_FINS_PATH = "/v1/cloud/fins"
const Count = z.number().int().nonnegative().safe()
const Ms = Count
const Digest = z.string().regex(/^[0-9a-f]{64}$/)
/** A cloud Fin's Thread, as the account knows it: `t-` and 16 hex (`cloudFinThread`). */
const CloudThreadId = z.string().regex(/^t-[0-9a-f]{16}$/)

/** All devices use the same operation and immutable launch digest, including after a lost reply. */
export const CloudFinStartSchema = z.object({
  op: z.string().startsWith("start:").min(7).max(256),
  inputSha256: Digest,
  thread: CloudThreadId,
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

/** Where a device asks the account to make a reserved start into a Fin's cloud Thread on its own machine. */
export const CLOUD_FIN_START_PATH = "/v1/cloud/fins/start"

/**
 * A reserved start, made: the same start (its op, launch digest and Thread) with the repository its machine clones and
 * the harness it runs. Repeated after a lost reply, it reaches the same Thread and machine, never a second allocation.
 */
export const CloudFinPlaceSchema = CloudFinStartSchema.extend({
  repository: ContinueRepositorySchema,
  harness: z.string().min(1).max(64),
}).strict()
export type CloudFinPlace = z.infer<typeof CloudFinPlaceSchema>

/**
 * How a start was made: its Thread on its machine, the folder there its repository is cloned into (where the Fin's
 * committed source is prepared and verified before its brief), with the reservation as it stands; or why not.
 */
export const CloudFinPlacedSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), thread: CloudThreadId, machine: z.string().regex(/^m-[0-9a-f]{16}$/), folder: z.string().startsWith("/").max(1_024), reservation: CloudFinReservationSchema }),
  z.object({ ok: z.literal(false), reason: z.enum(["no-cloud", "policy", "usage", "price", "unresolved", "slots", "spend", "conflict", "cancelled", "missing", "generation", "thread", "closed"]), detail: z.string().max(2_000) }),
])
export type CloudFinPlaced = z.infer<typeof CloudFinPlacedSchema>

/** A cloud Fin's Thread: a fixed ID of its start's op, so every repeat of that start reaches the one Thread. */
export async function cloudFinThread(op: string): Promise<string> {
  return `t-${(await namedUuid(`mako cloud fin thread\0${op}`)).replaceAll("-", "").slice(0, 16)}`
}

/** What a start launches, as its digest covers it: everything a repeat must send the same. */
export type CloudFinLaunch = {
  version: number
  op: string
  parentThread: string
  brief: Json
  name?: string
  title?: string
  role?: string
  harness: string
  model?: string
  reasoning?: string
  fast?: boolean
  access: string
  mode?: string
  wake?: string
  /** The committed source's own digest. */
  source: string
}

/**
 * A start's launch digest: SHA-256 of its launch as canonical JSON (keys sorted at every depth, nothing absent
 * written). Any change to what it launches is another digest, so a start can't be repeated with other work.
 */
export async function cloudFinInputSha256(launch: CloudFinLaunch): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(launch)))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

function canonical(value: Json | CloudFinLaunch | undefined): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value instanceof Object)
    return `{${Object.entries(value).filter(([, each]) => each !== undefined).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)).map(([key, each]) => `${JSON.stringify(key)}:${canonical(each)}`).join(",")}}`
  return JSON.stringify(value)
}
