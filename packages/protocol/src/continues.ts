import { z } from "zod"
import type { Actor, Operation } from "./envelope.js"
import { ThreadIdSchema } from "./ids.js"
import { CONTINUE_REASON_MAX, ContinuePhaseSchema, ContinueRepositorySchema } from "./continue-rows.js"
import { MOVE_ARRIVAL_OP, MoveCheckpointSchema, type MoveHandOverRequest } from "./moves.js"
import { Payload } from "./payload.js"
import type { ListedSession, QuietDevice } from "./thread-listing.js"
import { PROTOCOL_VERSION } from "./version.js"
import { encodeOperation } from "./wire.js"

/**
 * A Session continued in the cloud while the device that runs it is off: pressed on any of the account's devices,
 * carried through by the account for the device that can't be asked, and taken by that device as a move when it's
 * back. The Thread keeps its IDs: the account composes what the device's own move would have handed the cloud (its
 * handoff, its machine's arrival, each Session's start and every message that waited), from what the account holds of
 * the device (each Session's originals, its row, the branch it last pushed), and hands it to a cloud Thread made for
 * it, whose machine claims the Thread at the row's generation plus two. So the list moves the rows to the cloud by the
 * one-owner rule, a report the device makes at the old generation is passed over, and the device, back, joins the move
 * (it releases the Thread at the same generation plus one, and confirms the cloud's claim) rather than run it.
 *
 * A continue goes `making` (the cloud Thread made, the records copied, the hand-over posted), `arriving` (its machine
 * takes the Thread), then `continued` (claimed) or `failed` (refused, with why): the account keeps it by its op ID, so
 * a press repeated, or a client that went away, reaches the same end.
 */

export { CONTINUE_REASON_MAX, ContinuePhaseSchema, ContinueRepositorySchema, ListedContinueSchema, type ContinuePhase, type ContinueRepository, type ListedContinue } from "./continue-rows.js"

/**
 * How far the device's originals reached before it went quiet, against its reading copy (what the person read), each
 * as when the account last took something of it, on the account's clock. `behind`: the copy took something after the
 * originals last did, so the turns the person read last may not be in what the cloud continues from; they stay on the
 * device, which says so when it's back.
 */
export const ContinueFreshnessSchema = z
  .object({
    originalsAt: z.iso.datetime().optional(),
    copyAt: z.iso.datetime().optional(),
    behind: z.boolean(),
  })
  .strict()
export type ContinueFreshness = z.infer<typeof ContinueFreshnessSchema>

/** One Session a continue carries, as its row named it and its originals held it. */
export const ContinueSessionSchema = z
  .object({
    session: z.uuid(),
    conversation: z.uuid(),
    harness: z.string().min(1).max(64),
    nativeId: z.string().min(1).max(512),
    /** Its generation on the device, as listed: the account's handoff releases it at one more. */
    generation: z.number().int().positive(),
    folder: z.string().min(1).max(1024),
    /** What the originals held of it, each unit at its head: the machine holds at least this before it writes any. */
    holdings: z.record(z.string(), z.number().int()).optional(),
    freshness: ContinueFreshnessSchema.optional(),
  })
  .strict()
export type ContinueSession = z.infer<typeof ContinueSessionSchema>

/** A continue as the account keeps it, and every route about it answers. */
/** At most this many checkpoints a continue's arrival applies: a project folder's first repository and its others. */
export const CONTINUE_APPLIED_MAX = 32

export const ContinueStateSchema = z
  .object({
    op: z.uuid(),
    /** The device's Thread, under its own ID, which the cloud keeps. */
    thread: z.uuid(),
    threadTitle: z.string().max(200).optional(),
    from: z.uuid(),
    by: z.uuid(),
    cloudThread: ThreadIdSchema,
    /** The folder the cloud Thread is made at: the device's worktree, at the same path. */
    folder: z.string().min(1).max(1024),
    repository: ContinueRepositorySchema,
    sessions: z.array(ContinueSessionSchema).min(1).max(64),
    phase: ContinuePhaseSchema,
    reason: z.string().max(CONTINUE_REASON_MAX).optional(),
    /** The messages that waited for its Sessions, sent on to the cloud with it, by ID. */
    waiting: z.array(z.uuid()).max(1_280),
    /**
     * The machine's checkout as the Thread arrived (its clone of the branch), once it did: what the device's worktree
     * is weighed against, as a move's own checkpoint is, so what the device has that the clone hadn't is never written over.
     */
    start: MoveCheckpointSchema.optional(),
    /**
     * The checkpoints the machine's arrival applied, each by its SHA-256: the first repository's and each other one's
     * of a project folder (a quiet device's `others`), once the arrival applied them all. Absent before then, and for a
     * continue that carried none. A device takes the Thread's changes out of its own checkouts only for the
     * repositories named here: one it doesn't find here kept nothing of its in the cloud.
     */
    applied: z.array(z.string().regex(/^[0-9a-f]{64}$/)).max(CONTINUE_APPLIED_MAX).optional(),
    /** The cloud Thread's machine, once it has one: what its logs and its provider name it by. Said by newer accounts. */
    machine: z.string().min(1).max(200).optional(),
    at: z.iso.datetime(),
    changedAt: z.iso.datetime(),
  })
  .strip()
export type ContinueState = z.infer<typeof ContinueStateSchema>

/** `POST /v1/sessions/:session/continue/:op`: nothing to say but the press, which the op ID names. */
export const ContinueRequestSchema = z.object({}).strict()

/** How long a client's ask for a continue's state is held open for it at most, in ms. */
export const CONTINUE_WAIT_MS = 20_000

/**
 * Why a Session can't continue in the cloud now, in words a person reads: its device is reachable (send it there),
 * it was at work or waiting when its device went quiet, it isn't in a worktree of its own on a pushed branch, or its
 * device's Mako is from before continues, or the account's plan has no cloud (the gateway's word alone).
 */
export const ContinueRefusalSchema = z.enum(["reachable", "working", "waiting", "moving", "continuing", "not-mako", "no-worktree", "no-repository", "older-device", "cloud", "no-cloud"])
export type ContinueRefusal = z.infer<typeof ContinueRefusalSchema>

/** `GET /v1/sessions/:session/continue`: whether its Thread may continue in the cloud now, and what from. */
export const ContinueOfferSchema = z.discriminatedUnion("offer", [
  z
    .object({
      offer: z.literal(true),
      thread: z.uuid(),
      from: z.uuid(),
      /** Its device has been quiet since. */
      since: z.iso.datetime(),
      folder: z.string(),
      repository: ContinueRepositorySchema,
      sessions: z.array(z.object({ session: z.uuid(), harness: z.string(), title: z.string().optional(), freshness: ContinueFreshnessSchema })).min(1),
    })
    .strip(),
  z.object({ offer: z.literal(false), why: ContinueRefusalSchema, detail: z.string().max(500) }).strip(),
])
export type ContinueOffer = z.infer<typeof ContinueOfferSchema>

/** A row a continue may take: its owner's Session, on a device. */
type OfferRow = Pick<ListedSession, "session" | "thread" | "state" | "runsOn" | "move" | "capture" | "nativeId" | "worktree" | "folder" | "repository" | "continued" | "conversation">

/**
 * Whether the Thread of `row` may continue in the cloud now, by every device's one rule: its rows (`rows`, the
 * account's list) all its device's, that device quiet and from a Mako that takes a continue back, each row ready for
 * its next message (`idle` or `failed`) with its native session known, in a worktree of the Thread's own whose branch
 * its origin on GitHub has, and no move or continue under way. Undefined when it may; else why not.
 */
export function continueRefusal(row: OfferRow, rows: readonly OfferRow[], quiet: readonly QuietDevice[]): ContinueRefusal | undefined {
  if (row.runsOn.kind === "cloud") return "cloud"
  const device = row.runsOn.deviceId
  const away = quiet.find((each) => each.deviceId === device)
  if (!away) return "reachable"
  const thread = rows.filter((each) => each.thread === row.thread)
  if (thread.some((each) => each.runsOn.kind !== "device" || each.runsOn.deviceId !== device)) return "moving"
  if (thread.some((each) => each.continued && each.continued.phase !== "failed")) return "continuing"
  if (thread.some((each) => each.move || each.state === "moving")) return "moving"
  if (thread.some((each) => each.state === "working")) return "working"
  if (thread.some((each) => each.state === "waiting")) return "waiting"
  if (thread.some((each) => each.capture || !each.nativeId || !z.uuid().safeParse(each.conversation).success)) return "not-mako"
  if (thread.some((each) => !each.worktree || !each.folder)) return "no-worktree"
  if (thread.some((each) => !each.repository?.branch)) return "no-repository"
  if (!away.continues) return "older-device"
  return undefined
}

/** Each refusal as a person reads it, `device` naming the Session's device. */
export function continueRefusalText(why: ContinueRefusal, device: string): string {
  switch (why) {
    case "reachable": return `${device} is on, so this Session runs there.`
    case "working": return `It was working when ${device} went quiet. It can continue in the cloud once ${device} says the turn ended.`
    case "waiting": return `It's waiting on you on ${device}, which only ${device} can answer.`
    case "moving": return "Its Thread is on its way somewhere already."
    case "continuing": return "It's continuing in the cloud already."
    case "not-mako": return `A Session Mako didn't start on ${device} continues only there.`
    case "no-worktree": return "Only a Thread in its own worktree continues in the cloud. This one works in the project folder."
    case "no-repository": return `Its branch isn't on GitHub, so the cloud has nothing to clone. Push it from ${device} first.`
    case "older-device": return `${device} hasn't connected on a Mako that takes Continue in the cloud. Once it has, its Threads can continue here while it's off.`
    case "cloud": return "It runs in the cloud already."
    case "no-cloud": return "This account's plan doesn't include the cloud."
  }
}

/** A name a continue's IDs are made from, the same in every place (`namedUuid`). */
export async function namedUuid(name: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(name))).slice(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x80
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** The cloud runtime a cloud Thread is, as a Thread store names an owner: a fixed UUID of its ID. */
export function cloudRuntimeOf(cloudThread: string): Promise<string> {
  return namedUuid(`mako cloud thread\0${cloudThread}`)
}

/** The cloud Thread a continue makes: a fixed ID of its op, so a press repeated makes the one Thread. */
export async function continueCloudThread(op: string): Promise<string> {
  return `t-${(await namedUuid(`mako continue cloud thread\0${op}`)).replaceAll("-", "").slice(0, 16)}`
}

/** A message that waited for one of the Sessions, sent on with it under its own ID. */
export type ContinueWaiting = { id: string; conversation: string; text: string }

/**
 * What the account hands the cloud Thread for a continue (`MoveHandOverRequest`), composed as the device's own move
 * would: the handoff (the Thread and its Sessions under their IDs, each released at its generation plus one, owned by
 * the account's person), then the machine's arrival with no checkpoint (it continues from its clone of the branch),
 * each conversation started, and each message that waited. Each operation is `actor`'s, under an ID of the op's.
 */
export async function continueHandOver(state: ContinueState, input: { account: string; actor: Extract<Actor, { kind: "client" }>; waiting: readonly ContinueWaiting[]; releasedAt: number }): Promise<MoveHandOverRequest> {
  const named = (key: string) => namedUuid(`mako continue\0${state.op}\0${key}`)
  const handoff = {
    move: state.op,
    source: { kind: "device", device: state.from },
    target: { kind: "cloud", runtime: await cloudRuntimeOf(state.cloudThread) },
    releasedAt: input.releasedAt,
    thread: { id: state.thread, owner: input.account, ...state.threadTitle && { title: state.threadTitle } },
    sessions: state.sessions.map((session, position) => ({ id: session.session, origin: "started", position, generation: session.generation + 1, journals: [session.conversation] })),
  }
  const calls: Array<{ op: string; args: unknown[]; key: string }> = [{
    op: MOVE_ARRIVAL_OP,
    args: [{
      move: state.op,
      folder: state.folder,
      sessions: state.sessions.map((session) => ({ harness: session.harness, nativeId: session.nativeId, ...session.holdings && { holdings: session.holdings }, open: { conversationId: session.conversation, ...session.folder !== state.folder && { cwd: session.folder } } })),
      handoff,
    }],
    key: "arrive",
  }]
  for (const session of state.sessions)
    calls.push({ op: "host.live-start", args: [session.harness, session.folder, { conversationId: session.conversation, resume: session.nativeId }], key: `start\0${session.conversation}` })
  for (const message of input.waiting)
    calls.push({ op: "host.live-prompt", args: [message.conversation, message.id, message.text, [], undefined], key: `prompt\0${message.id}` })
  const correlationId = await named("correlation")
  const operations = await Promise.all(calls.map(async ({ op, args, key }) => {
    const operation: Operation = {
      v: PROTOCOL_VERSION,
      id: await named(key),
      op,
      target: { kind: "thread", threadId: state.cloudThread },
      input: Payload.encoded(JSON.stringify({ args: args.map((value) => (value === undefined ? { kind: "absent" } : { kind: "value", value })) })),
      correlationId,
      actor: input.actor,
      attempt: 1,
      repeatable: true,
    }
    return encodeOperation(operation)
  }))
  return { claim: { thread: state.thread, sessions: handoff.sessions.map(({ id, generation }) => ({ id, generation })), handoff }, operations }
}
