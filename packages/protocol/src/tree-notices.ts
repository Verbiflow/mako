import { z } from "zod"
import type { Capability } from "./borrow.js"
import type { Actor, Operation, Reply, Target } from "./envelope.js"
import type { Json } from "./ids.js"
import { Payload } from "./payload.js"
import { PROTOCOL_VERSION } from "./version.js"

/**
 * A Fin's reports for its Apex, kept by the account until the Apex's Session's owner takes them. The Fin's host posts
 * each report as a notice (`POST /v1/tree/notices`) on its own credential, the same notice again under the same ID
 * after a lost reply. The account keeps it for the Apex's Session, numbers it, says who sent it from that credential
 * and never from what was posted, and delivers it as `mako:agents-notice` to whoever owns that Session now. A notice
 * waits for the Session, not a device: while its owner is off it's held, and if the Session moves meanwhile its new
 * owner takes it.
 *
 * The account reads a notice's ID, its child, and its report's ID and child, and nothing else of it: a report is its
 * Fin's host's to write and its Apex's host's to read, so whatever else a notice carries crosses as it came.
 *
 * A Session's notices reach its owner one at a time, in the order the account numbered them, each at least once. The
 * owner's answer says what becomes of one (`treeNoticeDisposal`): taken (`heard`, `deduped`, `stale-owner`), kept for a
 * later try (`unknown-child`, or no answer at all), or put aside (`conflict`). What's kept goes again when the next
 * notice is admitted, when the owner connects and when the Session changes owner, and on no clock.
 */

/** Where a Fin's host posts a notice, and reads the answer (`TreeNoticeAnswerSchema`). */
export const TREE_NOTICES_PATH = "/v1/tree/notices"

/** The most notices the account holds for one Apex's Session: one more is refused (`full`) until its owner takes some. */
export const TREE_NOTICES_HELD = 500

/** The most a notice is, in bytes of its JSON as posted (64 KiB). */
export const TREE_NOTICE_BYTES = 64 * 1024

/** The most notices one Fin has admitted in any minute; one more is refused (`rate`). A notice posted again isn't another. */
export const TREE_NOTICE_ADMITS_PER_MINUTE = 20

/** The most notices put aside for one Apex's Session after its owner answered `conflict`; the oldest goes for a newer. */
export const TREE_NOTICE_DEAD_LETTERS = 32

/**
 * What a host that takes notices from the account says in its `advertise` (`runtime-frames.ts`): the account delivers
 * a held notice only to an owner whose link said this, and holds it for any other.
 */
export const TREE_NOTICES_CAPABILITY = { capability: "tree-notices", version: "1" } as const satisfies Capability

/** Whether what a runtime advertised says it takes notices from the account. */
export function takesTreeNotices(capabilities: readonly Capability[]): boolean {
  return capabilities.some((each) => each.capability === TREE_NOTICES_CAPABILITY.capability && each.version === TREE_NOTICES_CAPABILITY.version)
}

/** The host call a notice is delivered as, to the owner of its Apex's Session: `mako:agents-notice`, its one argument the notice. */
export const TREE_NOTICE_OP = "host.agents-notice"

const REPORT_ID_CHARS = 600
const Seq = z.number().int().positive().safe()
const Ms = z.number().int().nonnegative().safe()

/** A notice's ID: `notice:{child}:{reportId}`, so a report sent again is the same notice wherever it's sent from. */
export function noticeIdOf(child: string, reportId: string): string {
  return `notice:${child}:${reportId}`
}

/** Whether a notice is under its own ID and carries a report of its own child: one that isn't is never admitted. */
export function noticeIdHolds(notice: { id: string; child: string; report: { id: string; child: string } }): boolean {
  return notice.report.child === notice.child && notice.id === noticeIdOf(notice.child, notice.report.id)
}

const NOTICE_ID_RULE = "A notice is notice:{child}:{reportId}, carrying that report of that child"

/**
 * A notice as posted. `parent` is the Apex: its Thread, and the Session the notice is held for. `report` is read for
 * its ID and child alone and otherwise crosses as it came, as `standing` does (how the Fin stands as this is sent).
 * Nothing else is taken: a notice names no device, no machine and no start, which are the account's to say (`from`).
 */
const Notice = z.object({
  id: z.string().min(1).max("notice:".length + 36 + 1 + REPORT_ID_CHARS),
  parent: z.object({ thread: z.uuid(), session: z.uuid() }).strict(),
  child: z.uuid(),
  report: z.object({ id: z.string().min(1).max(REPORT_ID_CHARS), child: z.uuid() }).loose(),
  standing: z.object({ heard: z.number(), working: z.boolean(), owner: z.number(), seq: z.number() }).loose().optional(),
}).strict()

export const TreeNoticeSchema = z.lazy(() => Notice.refine(noticeIdHolds, NOTICE_ID_RULE))
export type TreeNotice = z.infer<typeof TreeNoticeSchema>

/**
 * Who sent a notice, as the account says it from the sender's credential: where the Fin runs (a cloud Thread's
 * machine under its generation, or a device), the start that made the Fin where the credential names one (`op`: a
 * machine's does, a device's doesn't), the notice's number among its Apex's Session's, and when it was admitted.
 */
export const TreeNoticeFromSchema = z.lazy(() => z.object({
  op: z.string().min(1).max(512).optional(),
  place: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("cloud"), thread: z.string().regex(/^t-[0-9a-f]{16}$/), machine: z.string().regex(/^m-[0-9a-f]{16}$/), generation: z.number().int().nonnegative().safe() }).strict(),
    z.object({ kind: z.literal("device"), device: z.uuid() }).strict(),
  ]),
  seq: Seq,
  at: Ms,
}).strict())
export type TreeNoticeFrom = z.infer<typeof TreeNoticeFromSchema>

/** A notice as its Apex's Session's owner is handed it: what was posted, and the account's word on who sent it. */
export const TreeNoticeDeliverySchema = z.lazy(() => Notice.extend({ from: TreeNoticeFromSchema }).strict().refine(noticeIdHolds, NOTICE_ID_RULE))
export type TreeNoticeDelivery = z.infer<typeof TreeNoticeDeliverySchema>

/**
 * Why a notice wasn't admitted. `full` and `rate` pass: the sender keeps its report and posts it again. The rest don't,
 * and posting the same again answers the same: `gone` is as good as taken, since nothing is left to hear it.
 */
export const TreeNoticeRefusalSchema = z.enum(["conflict", "gone", "full", "rate", "invalid", "too-large", "forbidden"])
export type TreeNoticeRefusal = z.infer<typeof TreeNoticeRefusalSchema>

/** The answer to a post: the notice's number among its Apex's Session's (the first it got, if it was posted before), or why not. */
export const TreeNoticeAnswerSchema = z.lazy(() => z.discriminatedUnion("admitted", [
  z.object({ admitted: z.literal(true), seq: Seq }),
  z.object({ admitted: z.literal(false), reason: TreeNoticeRefusalSchema }),
]))
export type TreeNoticeAnswer = z.infer<typeof TreeNoticeAnswerSchema>

/** Each refusal as the Fin's host logs it. */
export function treeNoticeRefusalText(reason: TreeNoticeRefusal): string {
  switch (reason) {
    case "conflict": return "Another report was already sent under this notice's ID."
    case "gone": return "Its Apex was archived, or the Fin's place is over, so nothing is left to hear this report."
    case "full": return `Its Apex's Session holds ${TREE_NOTICES_HELD} reports its owner hasn't taken. This one goes once it takes some.`
    case "rate": return `This Fin sent ${TREE_NOTICE_ADMITS_PER_MINUTE} reports within a minute. This one goes in a moment.`
    case "invalid": return `${NOTICE_ID_RULE}.`
    case "too-large": return `A report crosses in at most ${TREE_NOTICE_BYTES / 1024} KiB.`
    case "forbidden": return "That Fin isn't this sender's."
  }
}

/** Whether a notice's JSON text (`JSON.stringify(notice)`) fits what the account takes. */
export function treeNoticeFits(json: string): boolean {
  return new TextEncoder().encode(json).length <= TREE_NOTICE_BYTES
}

/** Whether two notices say the same, whatever order their fields come in: one posted again under its ID is the same notice, or a conflict. */
export function sameTreeNotice(left: TreeNotice, right: TreeNotice): boolean {
  return canonical(JSON.parse(JSON.stringify(left))) === canonical(JSON.parse(JSON.stringify(right)))
}

function canonical(value: Json | undefined): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value instanceof Object)
    return `{${Object.entries(value).filter(([, each]) => each !== undefined).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)).map(([key, each]) => `${JSON.stringify(key)}:${canonical(each)}`).join(",")}}`
  return JSON.stringify(value)
}

/** A notice the account holds for its Apex's Session, under the number it was admitted at. */
export type HeldTreeNotice = { seq: number; notice: TreeNotice }

/**
 * What the account answers a notice posted for a Session, from what it holds for that Session (`held`) and the last
 * number it gave there (`head`, 0 before any). The same notice again answers the number it first got, even when the
 * Session is full; the same ID saying anything else is a conflict; a new one takes the next number, unless the Session
 * holds its most. An answer numbered above `head` is a new notice to keep: numbers only rise, so what's held stays in
 * the order it was admitted however much was taken between.
 */
export function admitTreeNotice(held: readonly HeldTreeNotice[], head: number, posted: TreeNotice): Extract<TreeNoticeAnswer, { admitted: true }> | { admitted: false; reason: "conflict" | "full" } {
  const first = held.find((each) => each.notice.id === posted.id)
  if (first) return sameTreeNotice(first.notice, posted) ? { admitted: true, seq: first.seq } : { admitted: false, reason: "conflict" }
  if (held.length >= TREE_NOTICES_HELD) return { admitted: false, reason: "full" }
  return { admitted: true, seq: head + 1 }
}

/** Whether a Fin whose notices were admitted at `admits` (each a time in ms) may have another admitted at `now`. */
export function treeNoticeRateOpen(admits: readonly number[], now: number): boolean {
  return admits.filter((at) => at > now - 60_000 && at <= now).length < TREE_NOTICE_ADMITS_PER_MINUTE
}

/**
 * What the owner of the Apex's Session answers a notice, in `mako:agents-notice`'s own words: heard (`deduped` when it
 * had it already), or refused: by a newer owner of the Fin than the report's (`stale-owner`), because it knows no such
 * Fin under that Apex yet (`unknown-child`), or because the notice isn't that report of that Fin (`conflict`).
 */
export const TreeNoticeAckSchema = z.lazy(() => z.union([
  z.object({ heard: z.literal(true), deduped: z.literal(true).optional() }),
  z.object({ refused: z.enum(["stale-owner", "unknown-child", "conflict"]), why: z.string() }),
]))
export type TreeNoticeAck = z.infer<typeof TreeNoticeAckSchema>

/** An answer by its one word: `heard`, `deduped`, `stale-owner`, `unknown-child` or `conflict`. */
export function treeNoticeAckWord(ack: TreeNoticeAck): "heard" | "deduped" | "stale-owner" | "unknown-child" | "conflict" {
  return "refused" in ack ? ack.refused : ack.deduped ? "deduped" : "heard"
}

/**
 * What the account does with a held notice once its owner answered, or didn't (`undefined`: unreachable, or an answer
 * that is none of the five). Heard, had already, or from an owner the Fin has since left: it's deleted. A conflict
 * is put aside, since sending it again would answer the same. Anything else keeps it for a later try.
 */
export function treeNoticeDisposal(ack: TreeNoticeAck | undefined): "delete" | "keep" | "dead-letter" {
  if (!ack) return "keep"
  switch (treeNoticeAckWord(ack)) {
    case "heard":
    case "deduped":
    case "stale-owner": return "delete"
    case "unknown-child": return "keep"
    case "conflict": return "dead-letter"
  }
}

/**
 * A held notice as the operation that delivers it: `mako:agents-notice` with the notice its one argument, as a host
 * call crosses. Each try is an operation of its own (`id`), since an operation's ID is answered once; the notice's own
 * ID is what makes a second delivery the same notice to whoever hears it.
 */
export function treeNoticeOperation(delivery: TreeNoticeDelivery, options: { id: string; target: Target; actor: Actor; correlationId: string }): Operation {
  return {
    v: PROTOCOL_VERSION,
    id: options.id,
    op: TREE_NOTICE_OP,
    target: options.target,
    input: Payload.encoded(JSON.stringify({ args: [{ kind: "value", value: delivery }] })),
    correlationId: options.correlationId,
    actor: options.actor,
    attempt: 1,
    repeatable: true,
  }
}

/** The owner's answer to a delivered notice, read from its reply; undefined when the reply is a failure or none of the five. */
export function treeNoticeAck(reply: Reply): TreeNoticeAck | undefined {
  if (!reply.ok || !reply.value) return undefined
  try {
    return TreeNoticeAckSchema.safeParse(reply.value.decode()).data
  } catch {
    // Not JSON: no answer.
    return undefined
  }
}
