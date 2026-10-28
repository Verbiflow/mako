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

/** The most operations one hand-over carries: an arrival, and a start, a continued turn and a few waiting messages per Session. */
export const MOVE_HANDOVER_OPERATIONS = 1_024

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

/**
 * A device's move handed to the cloud once the device has sent everything only it has (the checkout, each Session's
 * records) and released the Thread: from then the cloud carries the move through, as the Thread's one owner, and the
 * device needn't stay awake for it. The Thread's object runs `operations` in order, each through the Thread's own
 * queue to its machine: the first is the machine's arrival (`MOVE_ARRIVAL_OP`); once it's answered the object claims
 * the move with `claim` (or, if the machine can't take the Thread, refuses it); then each of the rest, each retried
 * until its machine answers. Every operation is the device's, encoded as it would have sent it (`encodeOperation`),
 * under an id of the move's, so a repeat reaches the same end. Posted again, the first stands.
 */
export const MoveHandOverRequestSchema = z.object({
  claim: MoveClaimRequestSchema,
  operations: z.array(z.string().min(1)).min(1).max(MOVE_HANDOVER_OPERATIONS),
}).strict()
export type MoveHandOverRequest = z.infer<typeof MoveHandOverRequestSchema>

/** What a hand-over's operations may be: the arrival first, then the starts, the turns continued and the messages that waited. */
export const MOVE_ARRIVAL_OP = "host.move-arrive"
export const MOVE_HANDOVER_OPS: readonly string[] = [MOVE_ARRIVAL_OP, "host.live-start", "host.live-continue-turn", "host.live-prompt"]

/**
 * How a hand-over stands in the cloud: `arriving` (its machine takes the checkout and the records; nothing's claimed),
 * `running` (claimed: the rest of its operations go), `done`, `refused` (the machine couldn't take the Thread, so the
 * move was refused and the device takes it back), or `failed` (claimed, but an operation after the arrival kept
 * failing: the Thread is the cloud's, and the person's next call starts it again). `step` is the operation now.
 */
export const MoveHandOverStateSchema = z.object({
  move: z.uuid(),
  phase: z.enum(["arriving", "running", "done", "refused", "failed"]),
  step: z.number().int().nonnegative(),
  of: z.number().int().positive(),
  since: z.number(),
  attempt: z.number().int().nonnegative(),
  lastError: z.string().optional(),
  endedAt: z.number().optional(),
}).strict()
export type MoveHandOverState = z.infer<typeof MoveHandOverStateSchema>

/** How long a device's ask for a move's answer is held open for it at most, in ms. */
export const MOVE_ANSWER_WAIT_MS = 25_000

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
 *
 * Archiving a cloud Thread is a return whose destination is the archive (`to: "archive"`), by the person's word from any
 * of the account's devices: begun only while nothing in it works and nothing moves it, packed the same way, released,
 * then `archived`: its machine is deleted, its Sessions leave the account's list, and what the machine packed is kept
 * with its records, so a Mac can take it back later (`done`, as any return ends: `returned`). One whose machine has
 * nothing to pack, or can't start, is archived from `returning`, keeping only its records. An archived Thread takes no
 * work. Any Thread of the cloud's may be archived; only one that came from a device, packed, goes back to one.
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

/**
 * A return to the archive, and who asked: the device whose person archived the Thread. Absent from a return to the
 * device, whose record never had it.
 */
const ArchiveMarkSchema = { to: z.literal("archive").optional(), by: z.uuid().optional() }

export const ReturnStateSchema = z.discriminatedUnion("phase", [
  z.object({ phase: z.literal("returning"), move: z.uuid(), at: z.number(), ...ArchiveMarkSchema }).strict(),
  z.object({ phase: z.literal("cancelled"), move: z.uuid(), at: z.number(), reason: z.string(), ...ArchiveMarkSchema }).strict(),
  z.object({ phase: z.literal("released"), move: z.uuid(), at: z.number(), departure: ReturnDepartureSchema, ...ArchiveMarkSchema }).strict(),
  z.object({ phase: z.literal("given-back"), move: z.uuid(), at: z.number(), reason: z.string(), departure: ReturnDepartureSchema, ...ArchiveMarkSchema }).strict(),
  /**
   * Archived: its machine deleted, its Sessions off the account's list, what the machine packed kept for a Mac to take.
   * Without a departure when its machine had nothing to pack, or couldn't start and the person archived it anyway.
   */
  z.object({ phase: z.literal("archived"), move: z.uuid(), at: z.number(), departure: ReturnDepartureSchema.optional(), to: z.literal("archive"), by: z.uuid().optional() }).strict(),
  z.object({ phase: z.literal("returned"), move: z.uuid(), at: z.number(), departure: ReturnDepartureSchema, ...ArchiveMarkSchema }).strict(),
])
export type ReturnState = z.infer<typeof ReturnStateSchema>

/** A return's beginning: to its device (the default), or to the archive. */
export const ReturnBeginRequestSchema = z.object({ to: z.literal("archive").optional() }).strict()
export type ReturnBeginRequest = z.infer<typeof ReturnBeginRequestSchema>

export const ReturnReleaseRequestSchema = z.object({ departure: ReturnDepartureSchema }).strict()
export const ReturnReasonRequestSchema = z.object({ reason: z.string().min(1).max(MOVE_REASON_MAX) }).strict()
