import { z } from "zod"
import { namedUuid } from "./continues.js"
import { ThreadIdSchema } from "./ids.js"
import { CarriedPathSchema, MoveCheckpointSchema } from "./moves.js"

/**
 * A device going away and coming back, as its account hears it, so a Thread at work there goes on in the cloud with
 * no deadline and only ever runs in one place. Both are calls a device makes on its own token, each the same call
 * again under the same id, whether or not its runtime link is up.
 *
 * - `quiet` (`POST /v1/devices/:deviceId/quiet`): the device is going away (sleep, shutdown, quit). It names each of its
 *   Threads with a parked turn, the Sessions it holds at their generations, and the last checkpoint the cloud
 *   acknowledged. It releases nothing: the device still owns every Session, and the account may continue one later,
 *   from that checkpoint, while the device stays quiet.
 * - `owner` (`POST /v1/devices/:deviceId/owner`): the device is back, and asks who owns each Session it holds before it
 *   runs any. The account answers each one `yours` (at the generation the account holds, the device's own, a
 *   give-back included), `departed` (another owner took it, and the continue that did), or `unknown`.
 *
 * A Session's owner and generation are the account's one record (`ListedSession.runsOn`, `generation`): every change
 * of owner is a compare-and-set on it, so a continue and a device that came back can't both win.
 */

/** At most this many Threads in one note, and Sessions in one ask. */
export const QUIET_THREADS_MAX = 32
export const OWNER_SESSIONS_MAX = 256

const SessionAt = z.object({ session: z.uuid(), generation: z.number().int().nonnegative() }).strict()
export type SessionAt = z.infer<typeof SessionAt>

/**
 * A checkpoint the cloud acknowledged, whole (`MoveCheckpointSchema`: its bundle's hash and size, HEAD, the branch, the
 * index and work commits), with the standby cloud Thread it was sent to. The arrival applies it as a move's own: its
 * bundle read by the hash from what the account keeps, nothing copied.
 */
export const AcknowledgedCheckpointSchema = MoveCheckpointSchema.extend({ standby: ThreadIdSchema }).strict()
export type AcknowledgedCheckpoint = z.infer<typeof AcknowledgedCheckpointSchema>

/** A Thread with a parked turn, as its device goes away: what the account may continue, and from what. */
/** At most this many turns parked in one Thread of a note. */
export const PARKED_PER_THREAD_MAX = 16

/**
 * A turn the device paused as it went away. The account's continue sends it on in the cloud Thread once the machine
 * has arrived, as Mako's continuation of `request` in `conversation`: `mako:live-continue-turn` under `continuation`,
 * naming the tool calls the pause cut (`stopped`). The device names `continuation` and uses the same one if it joins
 * that continue later and sends its parked turns there itself, so a turn goes on once whoever sends it first.
 */
export const ParkedTurnSchema = z.object({
  conversation: z.uuid(),
  request: z.uuid(),
  continuation: z.uuid(),
  stopped: z.array(z.string().min(1).max(200)).max(64).optional(),
}).strict()
export type ParkedTurn = z.infer<typeof ParkedTurnSchema>

/** At most this many other repositories of a project folder in one Thread of a note: a project's limit, less its first. */
export const QUIET_OTHERS_MAX = 31

/**
 * Another repository of a Thread's project folder, beside the first its cloud Thread is made for: where it sits in
 * the Thread's folder (`path`, as the machine lays it out), the GitHub repository a machine clones it from, the branch
 * it clones (one GitHub has; absent, the repository's default), and the checkpoint of the Thread's own changes in it
 * that the cloud acknowledged on the same standby as the first's, which names the branch it lays them on.
 * The arrival clones it when it isn't there and applies its checkpoint, all or nothing with the first, as a move's
 * carry does (`MoveCarryRepositorySchema`).
 */
export const QuietRepositorySchema = z.object({
  path: CarriedPathSchema,
  url: z.string().regex(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  branch: z.string().min(1).max(250).optional(),
  checkpoint: MoveCheckpointSchema,
}).strict()
export type QuietRepository = z.infer<typeof QuietRepositorySchema>

/**
 * Where a Thread's Sessions open on the machine, when it isn't the folder its standby holds: the project worktree a move
 * of it would make, around the worktree of the project's first repository (the standby's folder). Absolute. Sent only to
 * a gateway whose link agreed `QUIET_PROJECT_LINK_VERSION`: one before it refuses the whole note.
 */
export const QUIET_PROJECT_MAX = 4_096
export const QuietProjectSchema = z.string().min(1).max(QUIET_PROJECT_MAX).regex(/^\//)

export const QuietThreadSchema = z.object({
  thread: ThreadIdSchema,
  project: QuietProjectSchema.optional(),
  /**
   * With `project`, the device's folder it mirrors: the project folder its Sessions work in (absolute). A Session in a
   * folder inside it opens at the same place inside `project` on the machine (`<project>/<its path from projectFrom>`),
   * so a Session that worked in one of its repositories works in that repository there. Sent only to a gateway whose link
   * agreed `QUIET_PROJECT_FROM_LINK_VERSION`.
   */
  projectFrom: QuietProjectSchema.optional(),
  sessions: z.array(SessionAt).min(1).max(OWNER_SESSIONS_MAX),
  checkpoint: AcknowledgedCheckpointSchema.optional(),
  /** The Thread's turns parked as the device went away, for the continue to send on; absent from devices before it. */
  parked: z.array(ParkedTurnSchema).max(PARKED_PER_THREAD_MAX).optional(),
  /** The project folder's other repositories, each with its own checkpoint (`QuietRepository`); absent from devices before it. */
  others: z.array(QuietRepositorySchema).max(QUIET_OTHERS_MAX).optional(),
}).strict()
export type QuietThread = z.infer<typeof QuietThreadSchema>

/** `POST /v1/devices/:deviceId/quiet`: going away. `at` is the device's clock, only ever shown. */
export const QuietNoteSchema = z.object({
  note: z.uuid(),
  reason: z.enum(["sleep", "shutdown", "quit"]),
  at: z.number().int().nonnegative(),
  threads: z.array(QuietThreadSchema).max(QUIET_THREADS_MAX),
}).strict()
export type QuietNote = z.infer<typeof QuietNoteSchema>

/**
 * Why a Thread of a note isn't one the account will continue: a Session isn't this device's (`not-yours`) or is at
 * another generation (`stale`), the cloud acknowledged no checkpoint of it (`no-checkpoint`), or the person's
 * switch to move it when the device is off is off (`auto-off`).
 */
export const QuietRefusalSchema = z.enum(["not-yours", "stale", "no-checkpoint", "auto-off"])
export type QuietRefusal = z.infer<typeof QuietRefusalSchema>

export const QuietAnswerSchema = z.object({
  note: z.uuid(),
  threads: z.array(z.discriminatedUnion("accepted", [
    z.object({ thread: ThreadIdSchema, accepted: z.literal(true) }).strict(),
    z.object({ thread: ThreadIdSchema, accepted: z.literal(false), why: QuietRefusalSchema }).strict(),
  ])).max(QUIET_THREADS_MAX),
}).strict()
export type QuietAnswer = z.infer<typeof QuietAnswerSchema>

/** `POST /v1/devices/:deviceId/owner`: every Session the device holds, at the generation it holds it. */
export const OwnerAskSchema = z.object({ sessions: z.array(SessionAt).max(OWNER_SESSIONS_MAX) }).strict()
export type OwnerAsk = z.infer<typeof OwnerAskSchema>

/**
 * The account's word on one Session. `yours`: the device runs it, at `generation`, the device's own: a continue that
 * gives it back restores the generation it had, so the device never takes one from the account. `departed`: another
 * owner holds it, at `generation`;
 * `op` and `cloudThread` name the continue that took it, which the device joins and never runs it here. `unknown`:
 * the account never listed it.
 */
export const OwnerWordSchema = z.discriminatedUnion("answer", [
  z.object({ session: z.uuid(), answer: z.literal("yours"), generation: z.number().int().nonnegative() }).strict(),
  z.object({
    session: z.uuid(), answer: z.literal("departed"), generation: z.number().int().nonnegative(),
    cloudThread: ThreadIdSchema, op: z.uuid(), phase: z.enum(["arriving", "continued"]),
  }).strict(),
  z.object({ session: z.uuid(), answer: z.literal("unknown") }).strict(),
])
export type OwnerWord = z.infer<typeof OwnerWordSchema>

export const OwnerAnswerSchema = z.object({ sessions: z.array(OwnerWordSchema).max(OWNER_SESSIONS_MAX) }).strict()
export type OwnerAnswer = z.infer<typeof OwnerAnswerSchema>

/**
 * The continue the account makes of a quiet device's Thread, named by what it continues: the Thread, the highest
 * generation of its Sessions and the note it went quiet with. The same note heard again, or the account's alarm
 * coming round again, makes the same continue, and so the same cloud Thread (`continueCloudThread`).
 */
export function autoContinueOp(thread: string, sessions: readonly SessionAt[], note: string): Promise<string> {
  const generation = Math.max(0, ...sessions.map((each) => each.generation))
  return namedUuid(`mako auto continue\0${thread}\0${generation}\0${note}`)
}
