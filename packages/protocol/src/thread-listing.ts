import { z } from "zod"
import { ThreadIdSchema } from "./ids.js"
import { MOVES_VERSION, NATIVE_SESSIONS_VERSION, NUMBERED_LIVE_VERSION, RAIL_VERSION, WAITING_FOR_VERSION } from "./version.js"
import { WaitingMessageSchema } from "./waiting.js"
import { WaitingForSchema } from "./attention.js"

/**
 * An account's Threads as every device lists them: one row per Session, keyed by Mako's own Session and Thread IDs,
 * which every store shares and a move keeps, and nothing that takes waking a machine or a Mac to read.
 *
 * Each Session has one owner (a device, or a cloud machine) and a generation that rises with every change of owner.
 * The owner reports its Sessions over the link it already has to the cloud (its runtime's `sessions` frame, link
 * version 5 on); the cloud adds where it runs from who sent it, and the account's object keeps one row per Session,
 * taking a report only at a generation at least the row's (one from another owner at the same generation is refused).
 * So a Session that moves is listed where it is, in transit while it's moving, and never twice. `GET /v1/sessions`
 * lists them with the account stream's number, and the stream says each change (`sessions-listed`,
 * `sessions-unlisted`), so a Session one device starts shows on every other at once. A device the cloud can't hear
 * from is said once, not on each of its rows (`QuietDeviceSchema`, `device-quiet`).
 */

/**
 * Where a Session stands, as a list shows it. `working`: a turn, queued work or work it left running in the background.
 * `waiting`: on a person, an approval or a question (`waitingOn` says which). `idle`: ready for the next message.
 * `failed`: its last turn failed. `moving`: released by its owner, not yet claimed where it's going.
 */
export const ListedStateSchema = z.enum(["working", "waiting", "idle", "failed", "moving"])
export type ListedState = z.infer<typeof ListedStateSchema>

const HarnessSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/)

/**
 * A Session's Thread on its way between a device and the cloud, as its owner says it while it goes (link version 11 on):
 * `to`, where it's going; `step`, how far, in the owner's own word for its step (`packing`, `handing-over`, …); `since`,
 * when that step began, on the owner's clock. Said from the move's first step, while the row's `state` is still what it
 * was, until its new owner lists it, so every device sees a move from where it starts, not only once it's in transit.
 */
export const ListedMoveSchema = z
  .object({
    to: z.enum(["cloud", "device"]),
    step: z.string().regex(/^[a-z][a-z-]{0,31}$/),
    since: z.iso.datetime(),
  })
  .strict()
export type ListedMove = z.infer<typeof ListedMoveSchema>

const BranchSchema = z.string().min(1).max(256)

/**
 * What a checkout has checked out, as a rail shows it beside its project: a branch, the branch a rebase is replaying
 * onto, or a commit while detached (link version 12 on).
 */
export const ListedHeadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("branch"), name: BranchSchema }).strict(),
  z.object({ kind: z.literal("rebasing"), name: BranchSchema }).strict(),
  z.object({ kind: z.literal("detached"), commit: z.string().regex(/^[0-9a-f]{7,64}$/) }).strict(),
])
export type ListedHead = z.infer<typeof ListedHeadSchema>

/**
 * The project a Session is filed under on its owner's rail (link version 12 on): the project folder itself, which is
 * the Session's own folder or, for one working in a Thread's worktree, the folder that worktree was made from; and what
 * the project's own checkout has checked out, once its owner has read it.
 */
export const ListedProjectSchema = z
  .object({
    folder: z.string().min(1).max(1024),
    head: ListedHeadSchema.optional(),
  })
  .strict()
export type ListedProject = z.infer<typeof ListedProjectSchema>

/** The harnesses a Session ran in before its current one, oldest first, as its rail row wears them: at most this many. */
export const LISTED_LINEAGE = 8
const GenerationSchema = z.number().int().positive()

/** One Session as its owner says it: everything but where it runs, which the cloud knows from who said it. */
export const ReportedSessionSchema = z
  .object({
    /** Mako's Session and Thread IDs, the same in every store. */
    session: z.uuid(),
    thread: z.uuid(),
    threadTitle: z.string().max(200).optional(),
    /** The conversation every call to it names, on its owner. */
    conversation: z.string().min(1).max(128),
    harness: HarnessSchema,
    title: z.string().max(200).optional(),
    state: ListedStateSchema,
    /** What a `waiting` Session waits on, in a line: "Approve: npm test", "A question: which branch?". */
    waitingOn: z.string().max(200).optional(),
    /**
     * What a `waiting` Session waits on the person for (`attention.ts`): an approval, a question, or anything else. Said
     * by its owner, so no device reads it from `waitingOn`'s words (link version 10 on).
     */
    waitingFor: WaitingForSchema.optional(),
    /** The folder it works in, where it runs: a Thread moved from a device keeps the device's own path. */
    folder: z.string().max(1024).optional(),
    createdAt: z.iso.datetime(),
    /** When it last moved: a turn, a message, an answer. */
    activityAt: z.iso.datetime(),
    /** Its owner's generation: the report counts only at one at least the listed row's. */
    generation: GenerationSchema,
    /**
     * The harness's own ID for its session, once it has one: what its records are kept by, so its history reads on any
     * device (link version 6 on).
     */
    nativeId: z.string().min(1).max(512).optional(),
    /**
     * A session Mako hasn't opened as a conversation, one a terminal or another app runs: how its owner opens it when
     * another device does, by the path its catalog reads it at (`mako:live-capture`), as `conversation` (link version 6 on).
     */
    capture: z.object({ path: z.string().min(1).max(4096) }).strict().optional(),
    /**
     * When what a list shows of it last changed, on its owner's clock (link version 9 on): a device that hears the row
     * knows how long the change took to reach it.
     */
    changedAt: z.iso.datetime().optional(),
    /** Its Thread on its way between a device and the cloud (`ListedMoveSchema`, link version 11 on). */
    move: ListedMoveSchema.optional(),
    /** The project its owner's rail files it under, and what that project has checked out (link version 12 on). */
    project: ListedProjectSchema.optional(),
    /** It works in a Thread's worktree, on this branch (link version 12 on). */
    worktree: z.object({ branch: BranchSchema }).strict().optional(),
    /** The harnesses it ran in before its current one, oldest first (link version 12 on). */
    lineage: z.array(HarnessSchema).min(1).max(LISTED_LINEAGE).optional(),
    /**
     * Its turn ended and it waits on work it left running, which wakes it when it settles: how many (link version 12
     * on). Said with `state: "working"`, which a list before it reads as at work.
     */
    background: z.number().int().positive().max(1_000).optional(),
  })
  .strict()
export type ReportedSession = z.infer<typeof ReportedSessionSchema>

/** Where a Session runs, as the cloud knows it from who reported it: a device's own runtime, or a cloud Thread's machine. */
export const RunsOnSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("device"), deviceId: z.uuid() }).strict(),
  z.object({ kind: z.literal("cloud"), threadId: ThreadIdSchema }).strict(),
])
export type RunsOn = z.infer<typeof RunsOnSchema>

/**
 * One Session as every device lists it. Read leniently, unlike a report: a field a newer build adds is passed over by
 * an older one, which lists the rest.
 */
export const ListedSessionSchema = ReportedSessionSchema.extend({
  runsOn: RunsOnSchema,
  /** When the cloud last heard of it. */
  listedAt: z.iso.datetime(),
}).strip()
export type ListedSession = z.infer<typeof ListedSessionSchema>

/**
 * A device the cloud hasn't heard from for longer than a reconnect takes (the cloud says when; two minutes): its
 * runtime's link closed, or its token ran out unrenewed (a Mac asleep or off the network), and it didn't come back.
 * `since` is when the cloud last heard from it. Its rows stand as it last reported them; a list doesn't show one of them
 * at work or waiting on a person, since nothing on a device that can't be reached runs or answers for anyone else. A
 * message to one waits in the account (`waiting.ts`).
 */
export const QuietDeviceSchema = z.object({ deviceId: z.uuid(), since: z.iso.datetime() })
export type QuietDevice = z.infer<typeof QuietDeviceSchema>

/** At most this many rows in one frame or event, well under a message's megabyte. */
export const LISTED_PER_FRAME = 200
/** An owner lists at most this many Sessions: its sync window's (a week's) and any older one at work. */
export const LISTED_PER_OWNER = 2_000

/**
 * One report of an owner's Sessions. `owned`, on the first report of each link, is every Session it lists, by ID and
 * generation: a row this owner listed before and doesn't name goes. `listed` are rows new or changed, at most
 * `LISTED_PER_FRAME`, the rest in the reports after it; `gone` are Sessions it no longer lists (closed, or older
 * than the list keeps).
 */
export const SessionsReportSchema = z
  .object({
    owned: z.array(z.object({ session: z.uuid(), generation: GenerationSchema }).strict()).max(LISTED_PER_OWNER).optional(),
    listed: z.array(ReportedSessionSchema).max(LISTED_PER_FRAME),
    gone: z.array(z.object({ session: z.uuid(), generation: GenerationSchema }).strict()).max(LISTED_PER_OWNER),
    /** When the owner sent it, on its clock (link version 9 on), for the gateway's log of how long a report took. */
    reportedAt: z.iso.datetime().optional(),
  })
  .strict()
export type SessionsReport = z.infer<typeof SessionsReportSchema>

/**
 * A cloud Thread its person archived (a return to the archive, `moves.ts`): ended in the cloud, its machine deleted, its
 * Sessions off the list, and kept, so every device shows it with the archived ones and a Mac can take it back. Written
 * by the Thread's own object, the one authority on whether it's archived; no device keeps an archive state of its own
 * for it.
 */
export const ArchivedThreadSchema = z
  .object({
    /** The cloud Thread, as `runsOn` names it. */
    thread: ThreadIdSchema,
    /** The archive's ID, the return to the archive that ended it (`moves.ts`): a Mac takes it back under the same. */
    move: z.uuid(),
    archivedAt: z.iso.datetime(),
    /** The device whose person archived it. */
    by: z.uuid().optional(),
    /** Its Sessions as the list showed them when it was archived. */
    sessions: z.array(ListedSessionSchema).max(LISTED_PER_FRAME),
  })
  .strip()
export type ArchivedThread = z.infer<typeof ArchivedThreadSchema>

/**
 * `GET /v1/sessions`: every listed Session of the account, and the account stream's number as they were read. A client
 * lists, then follows the stream after `seq`, and misses nothing between.
 */
export const SessionListingsSchema = z.object({
  sessions: z.array(ListedSessionSchema),
  seq: z.number().int().nonnegative(),
  /** Messages waiting for Sessions whose owner is off (`waiting.ts`), as they stood at `seq`. */
  waiting: z.array(WaitingMessageSchema).optional(),
  /** The account's devices that were quiet at `seq` (`QuietDeviceSchema`); the stream says each change after it (`device-quiet`). */
  quiet: z.array(QuietDeviceSchema).optional(),
  /** The account's archived cloud Threads, newest first, as they stood at `seq`. Absent from a gateway before archiving. */
  archived: z.array(ArchivedThreadSchema).optional(),
})
export type SessionListings = z.infer<typeof SessionListingsSchema>

/**
 * The rows a link of `version` takes, each with only the fields that version knows: from link version 12, every one
 * whole; before 6 a gateway knows neither `capture` nor `nativeId`, so a Session Mako hasn't opened isn't listed there
 * and the rest go without their native IDs.
 */
export function rowsForLink(rows: readonly ReportedSession[], version: number): ReportedSession[] {
  if (version >= RAIL_VERSION) return [...rows]
  const kept: ReportedSession[] = []
  for (const row of rows) {
    if (row.capture && version < NATIVE_SESSIONS_VERSION) continue
    const older: ReportedSession = { ...row }
    // Before version 12 a gateway knows none of what a rail shows (the row's `state` still says it's at work); before
    // 11, no `move` (the row says `moving` once the Thread is in transit); before 10, no `waitingFor` (it reads
    // `waitingOn`'s words); before 9, no `changedAt`; before 6, no native IDs either.
    delete older.project
    delete older.worktree
    delete older.lineage
    delete older.background
    if (version < MOVES_VERSION) delete older.move
    if (version < WAITING_FOR_VERSION) delete older.waitingFor
    if (version < NUMBERED_LIVE_VERSION) delete older.changedAt
    if (version < NATIVE_SESSIONS_VERSION) delete older.nativeId
    kept.push(older)
  }
  return kept
}

/**
 * Whether a report about a Session may replace its row, by the one-owner rule: a higher generation always does (the
 * Session changed hands since), the same one only from the same owner, a lower one never. A row nobody listed yet takes
 * any report.
 */
export function mayReplace(row: Pick<ListedSession, "generation" | "runsOn"> | undefined, report: { generation: number; runsOn: RunsOn }): boolean {
  if (!row) return true
  if (report.generation !== row.generation) return report.generation > row.generation
  return sameRunsOn(row.runsOn, report.runsOn)
}

/** Whether two checkouts have the same checked out. */
export function sameHead(left: ListedHead | undefined, right: ListedHead | undefined): boolean {
  if (!left || !right) return left === right
  if (left.kind === "detached") return right.kind === "detached" && left.commit === right.commit
  return right.kind !== "detached" && right.kind === left.kind && right.name === left.name
}

export function sameRunsOn(left: RunsOn, right: RunsOn): boolean {
  return left.kind === "device" ? right.kind === "device" && left.deviceId === right.deviceId : right.kind === "cloud" && left.threadId === right.threadId
}

/**
 * Whether two rows would show the same, so a change a list wouldn't show tells nobody. When it was heard isn't compared.
 * `activityAt` is: an owner says it alone at most once a minute, and with any other change at once, so a row that
 * differs here moved something a list shows.
 */
export function sameListed(left: ListedSession | undefined, right: ListedSession): boolean {
  return (
    left !== undefined &&
    left.session === right.session &&
    left.thread === right.thread &&
    left.threadTitle === right.threadTitle &&
    left.conversation === right.conversation &&
    left.harness === right.harness &&
    left.title === right.title &&
    left.state === right.state &&
    left.waitingOn === right.waitingOn &&
    left.waitingFor === right.waitingFor &&
    left.folder === right.folder &&
    left.createdAt === right.createdAt &&
    left.activityAt === right.activityAt &&
    left.generation === right.generation &&
    left.nativeId === right.nativeId &&
    left.capture?.path === right.capture?.path &&
    left.move?.to === right.move?.to &&
    left.move?.step === right.move?.step &&
    left.project?.folder === right.project?.folder &&
    sameHead(left.project?.head, right.project?.head) &&
    left.worktree?.branch === right.worktree?.branch &&
    (left.lineage ?? []).join("\0") === (right.lineage ?? []).join("\0") &&
    left.background === right.background &&
    sameRunsOn(left.runsOn, right.runsOn)
  )
}
