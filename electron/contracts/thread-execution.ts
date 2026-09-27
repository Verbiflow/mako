import { z } from "zod"
import { PrincipalIdSchema, SessionIdSchema, ThreadIdSchema } from "./thread-identity.js"

/**
 * Where a Session may execute (primitive P2). Exactly one environment owns a
 * Session at a time: a device running Mako's runtime (this Mac or another) or
 * a named cloud runtime. Ownership changes only when the owner releases the
 * Session and the destination claims it; no timeout, heartbeat or lost
 * connection ever moves it, because an unreachable owner may still be running.
 * The generation counts owner changes, including to nobody while a Session is
 * in transit, so any two records about one Session order without clocks.
 */
export const DeviceIdSchema = z.string().uuid().brand<"DeviceId">()
export type DeviceId = z.infer<typeof DeviceIdSchema>
export const RuntimeIdSchema = z.string().uuid().brand<"RuntimeId">()
export type RuntimeId = z.infer<typeof RuntimeIdSchema>
export const MoveIdSchema = z.string().uuid().brand<"MoveId">()
export type MoveId = z.infer<typeof MoveIdSchema>

export const ExecutionOwnerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("device"), device: DeviceIdSchema }),
  z.object({ kind: z.literal("cloud"), runtime: RuntimeIdSchema }),
])
export type ExecutionOwner = z.infer<typeof ExecutionOwnerSchema>

/** What a store knows about one Session's execution, from its own point of view. */
export type SessionExecution =
  | { state: "here"; owner: ExecutionOwner; generation: number }
  /** Owned here; running turns finish and new work is held until the move ends. */
  | { state: "leaving"; owner: ExecutionOwner; generation: number; move: MoveId; target: ExecutionOwner }
  /** Released by this store; nobody may execute it until the destination answers. */
  | { state: "in-transit"; generation: number; move: MoveId; target: ExecutionOwner }
  | { state: "elsewhere"; owner: ExecutionOwner; generation: number }

export const SessionOriginSchema = z.enum(["imported", "started", "captured", "fork", "delegation", "new"])

/**
 * What a released Thread carries to its destination: the same identities,
 * never new ones. Journal contents, native records and workspace bytes travel
 * through their own contracts; the handoff names the journals only.
 */
export const HandoffSchema = z.object({
  move: MoveIdSchema,
  source: ExecutionOwnerSchema,
  target: ExecutionOwnerSchema,
  releasedAt: z.number(),
  thread: z.object({
    id: ThreadIdSchema,
    owner: PrincipalIdSchema,
    title: z.string().optional(),
    titleSource: z.enum(["user", "frozen", "auto"]).optional(),
  }),
  sessions: z.array(z.object({
    id: SessionIdSchema,
    origin: SessionOriginSchema,
    parent: SessionIdSchema.optional(),
    position: z.number().int().nonnegative(),
    /** The generation the release gave it; the claim adds one. */
    generation: z.number().int().positive(),
    journals: z.array(z.string().uuid()),
  })).min(1),
})
export type Handoff = z.infer<typeof HandoffSchema>

/** The destination's answer that it owns the Thread's Sessions now. */
export const ClaimReceiptSchema = z.object({
  move: MoveIdSchema,
  owner: ExecutionOwnerSchema,
  sessions: z.array(z.object({ id: SessionIdSchema, generation: z.number().int().positive() })).min(1),
})
export type ClaimReceipt = z.infer<typeof ClaimReceiptSchema>

/** The destination's durable promise that it never claimed and never will. */
export const RefusalSchema = z.object({
  move: MoveIdSchema,
  by: ExecutionOwnerSchema,
  reason: z.string().min(1),
})
export type Refusal = z.infer<typeof RefusalSchema>

export function sameOwner(left: ExecutionOwner, right: ExecutionOwner): boolean {
  return left.kind === "device"
    ? right.kind === "device" && left.device === right.device
    : right.kind === "cloud" && left.runtime === right.runtime
}

/** Why this environment will not run the Session, in words for the person sending. */
export function executionRefusal(execution: SessionExecution): string | undefined {
  const where = (owner: ExecutionOwner) => owner.kind === "cloud" ? "a cloud runtime" : "another device"
  switch (execution.state) {
    case "here":
    case "leaving":
      return undefined
    case "in-transit":
      return `This session is moving to ${where(execution.target)}. Send again once it has arrived.`
    case "elsewhere":
      return `This session runs on ${where(execution.owner)}, so this Mako doesn't start it here.`
  }
}
