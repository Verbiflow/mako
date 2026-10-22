import { z } from "zod"

/**
 * A Thread moving between a device and the cloud, as the gateway arbitrates the cloud's end of it. The device that
 * owns the Thread releases it first, in its own store; from then nobody runs it until the destination answers. The
 * gateway's Thread is that answer's one keeper: for each move it records a claim (the cloud owns the Thread's
 * Sessions now, each one generation on) or a refusal (it never claimed and never will), whichever comes first, and
 * answers every later ask with the same. No timeout settles a move either way: a device that lost the answer asks
 * again by the move's id.
 *
 * What the move carries travels by its own contracts: the checkout as a checkpoint (`MoveCheckpointSchema`, kept by
 * its hash beside the Thread's records) and each Session's native records through the records routes.
 */

/** The largest checkpoint a move carries: under a request body's limit at the gateway. */
export const MOVE_CHECKPOINT_MAX_BYTES = 96 * 1024 * 1024

const CommitSchema = z.string().regex(/^[0-9a-f]{40,64}$/)

/**
 * A checkout as it stands, as one Git bundle: its commits the remote lacks, a commit whose tree is its index and one
 * whose tree is its files (untracked ones included, ignored ones never), each on HEAD. Named by the bundle's SHA-256.
 */
export const MoveCheckpointSchema = z.object({
  version: z.literal(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().int().positive().max(MOVE_CHECKPOINT_MAX_BYTES),
  head: CommitSchema,
  /** The branch checked out, or none for a detached HEAD. */
  branch: z.string().min(1).max(250).optional(),
  index: CommitSchema,
  work: CommitSchema,
}).strict()
export type MoveCheckpoint = z.infer<typeof MoveCheckpointSchema>

/** How much of a device's own record of the move the gateway keeps for the way back: its handoff, as it wrote it. */
export const MOVE_HANDOFF_BYTES = 64 * 1024

/** A device's ask that the cloud take the Thread it released: the Sessions it carries, at the generations released. */
export const MoveClaimRequestSchema = z.object({
  /** The device's own Thread, by the id its store gave it. */
  thread: z.uuid(),
  sessions: z.array(z.object({ id: z.uuid(), generation: z.number().int().positive() }).strict()).min(1).max(256),
  /** The device's handoff whole, kept as it was sent and given back on the way home. */
  handoff: z.json(),
}).strict()
export type MoveClaimRequest = z.infer<typeof MoveClaimRequestSchema>

/** The longest reason a refusal, a cancel or a give-back carries: a sentence, not a stack. */
export const MOVE_REASON_MAX = 2_000

export const MoveRefuseRequestSchema = z.object({ reason: z.string().min(1).max(MOVE_REASON_MAX) }).strict()

/** What the gateway recorded for a move: the claim, each Session one generation on, or the refusal. */
export const MoveAnswerSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("claimed"),
    move: z.uuid(),
    at: z.number(),
    sessions: z.array(z.object({ id: z.uuid(), generation: z.number().int().positive() }).strict()),
  }).strict(),
  z.object({ kind: z.literal("refused"), move: z.uuid(), at: z.number(), reason: z.string() }).strict(),
])
export type MoveAnswer = z.infer<typeof MoveAnswerSchema>

/**
 * A cloud Thread going back to the device it came from: a move the other way, by the same rules. The device asks the
 * gateway to begin the return; from then the Thread takes no work but its machine's departure (`RETURN_DEPARTURE_OP`).
 * The machine packs up only once nothing in it works: its checkout as a checkpoint and each Session's records, beside
 * the Thread's records. The device then asks the gateway to record the Thread released, with what the machine packed:
 * from then nothing runs it in the cloud. The device takes it (`returned`; the machine goes) or, unable to, gives it
 * back (`given-back`; the machine runs it again). Before the release the device can cancel (`cancelled`).
 *
 * The gateway keeps one record per return, which only goes forward: `returning`, then `cancelled` or `released`, then
 * `given-back` or `returned`. A step asked again is answered with the record as it stands; a step the record has gone
 * past is refused with it. One return runs at a time per Thread.
 */

/** The operation a Thread takes while it's returning: its machine's departure, and nothing else. */
export const RETURN_DEPARTURE_OP = "host.move-depart"

/** Each unit of a session's records by its key, at the version its sender holds: what the taker must hold at least. */
export const ReturnHoldingsSchema = z.record(z.string().min(1).max(4_096), z.number().int().min(-1))

/** What a machine packed for the way back: its checkout and, per Session, what it sent of its records. */
export const ReturnDepartureSchema = z.object({
  checkpoint: MoveCheckpointSchema,
  sessions: z.array(z.object({ harness: z.string().min(1).max(64), nativeId: z.string().min(1).max(256), holdings: ReturnHoldingsSchema }).strict()).min(1).max(256),
}).strict()
export type ReturnDeparture = z.infer<typeof ReturnDepartureSchema>

export const ReturnStateSchema = z.discriminatedUnion("phase", [
  z.object({ phase: z.literal("returning"), move: z.uuid(), at: z.number() }).strict(),
  z.object({ phase: z.literal("cancelled"), move: z.uuid(), at: z.number(), reason: z.string() }).strict(),
  z.object({ phase: z.literal("released"), move: z.uuid(), at: z.number(), departure: ReturnDepartureSchema }).strict(),
  z.object({ phase: z.literal("given-back"), move: z.uuid(), at: z.number(), reason: z.string(), departure: ReturnDepartureSchema }).strict(),
  z.object({ phase: z.literal("returned"), move: z.uuid(), at: z.number(), departure: ReturnDepartureSchema }).strict(),
])
export type ReturnState = z.infer<typeof ReturnStateSchema>

export const ReturnReleaseRequestSchema = z.object({ departure: ReturnDepartureSchema }).strict()
export const ReturnReasonRequestSchema = z.object({ reason: z.string().min(1).max(MOVE_REASON_MAX) }).strict()
