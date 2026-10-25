import { z } from "zod"
import { ThreadIdSchema } from "./ids.js"

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
 * `sessions-unlisted`), so a Session one device starts shows on every other at once.
 */

/**
 * Where a Session stands, as a list shows it. `working`: a turn, queued work or work it left running in the background.
 * `waiting`: on a person, an approval or a question (`waitingOn` says which). `idle`: ready for the next message.
 * `failed`: its last turn failed. `moving`: released by its owner, not yet claimed where it's going.
 */
export const ListedStateSchema = z.enum(["working", "waiting", "idle", "failed", "moving"])
export type ListedState = z.infer<typeof ListedStateSchema>

const HarnessSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/)
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
    /** The folder it works in, where it runs: a Thread moved from a device keeps the device's own path. */
    folder: z.string().max(1024).optional(),
    createdAt: z.iso.datetime(),
    /** When it last moved: a turn, a message, an answer. */
    activityAt: z.iso.datetime(),
    /** Its owner's generation: the report counts only at one at least the listed row's. */
    generation: GenerationSchema,
  })
  .strict()
export type ReportedSession = z.infer<typeof ReportedSessionSchema>

/** Where a Session runs, as the cloud knows it from who reported it: a device's own runtime, or a cloud Thread's machine. */
export const RunsOnSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("device"), deviceId: z.uuid() }).strict(),
  z.object({ kind: z.literal("cloud"), threadId: ThreadIdSchema }).strict(),
])
export type RunsOn = z.infer<typeof RunsOnSchema>

/** One Session as every device lists it. */
export const ListedSessionSchema = ReportedSessionSchema.extend({
  runsOn: RunsOnSchema,
  /** When the cloud last heard of it. */
  listedAt: z.iso.datetime(),
}).strict()
export type ListedSession = z.infer<typeof ListedSessionSchema>

/** At most this many rows in one frame or event, well under a message's megabyte. */
export const LISTED_PER_FRAME = 200
/** An owner lists at most this many Sessions: the last 30 days' and any older one at work. */
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
  })
  .strict()
export type SessionsReport = z.infer<typeof SessionsReportSchema>

/**
 * `GET /v1/sessions`: every listed Session of the account, and the account stream's number as they were read. A client
 * lists, then follows the stream after `seq`, and misses nothing between.
 */
export const SessionListingsSchema = z
  .object({ sessions: z.array(ListedSessionSchema), seq: z.number().int().nonnegative() })
  .strict()
export type SessionListings = z.infer<typeof SessionListingsSchema>

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

export function sameRunsOn(left: RunsOn, right: RunsOn): boolean {
  return left.kind === "device" ? right.kind === "device" && left.deviceId === right.deviceId : right.kind === "cloud" && left.threadId === right.threadId
}

/** Whether two rows would show the same, so a change a list wouldn't show tells nobody. When it was heard isn't compared. */
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
    left.folder === right.folder &&
    left.createdAt === right.createdAt &&
    left.activityAt === right.activityAt &&
    left.generation === right.generation &&
    sameRunsOn(left.runsOn, right.runsOn)
  )
}
