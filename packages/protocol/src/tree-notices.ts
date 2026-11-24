import { z } from "zod"
import type { Capability } from "./borrow.js"
import type { Actor, Operation, Reply, Target } from "./envelope.js"
import type { Json } from "./ids.js"
import { Payload } from "./payload.js"
import { PROTOCOL_VERSION } from "./version.js"

/**
 * A Fin's reports for its Apex, kept by the account until the Apex's Session's owner takes them. The Fin's host posts
 * each report as a notice on its own credential (a device to `TREE_NOTICES_PATH`, a cloud machine to
 * `machineNoticesPath`), the same notice again under the same ID after a lost reply. The account keeps it for the Apex's Session, numbers it, says who sent it from that credential
 * and never from what was posted, and delivers it as `mako:agents-notice` to whoever owns that Session now. A notice
 * waits for the Session, not a device: while its owner is off it's held, and if the Session moves meanwhile its new
 * owner takes it.
 *
 * The account reads a notice's ID, its child, and its report's ID and child, and nothing else of it: a report is its
 * Fin's host's to write and its Apex's host's to read, so whatever else a notice carries crosses as it came.
 *
 * A Session's notices reach its owner one at a time, in the order the account numbered them, each at least once. The
 * owner's answer says what becomes of one (`treeNoticeDisposal`): taken (`heard`, `deduped`, `stale-owner`), kept for a
 * later try (`unknown-child` for up to an hour, or no answer at all), or put aside (`conflict`). What's kept goes again
 * when the next notice is admitted, when the owner connects and when the Session changes owner, and on no clock.
 *
 * A notice is its ID and its report. How its Fin stands (`standing`) is the Fin's latest word on itself, said again
 * with the same report whenever it changes: the newest replaces the one before, and is never a conflict.
 *
 * A cloud machine is the account's own making, so the account knows whose Fin it runs. A device isn't: the account
 * knows a Fin on one only by the record its Apex's device keeps there (`TreeEdgeSchema`), and admits a device's notice
 * only under such a record. A Fin on a device whose Apex's device keeps none sends its notices to that device itself.
 */

/**
 * Where a device's host posts a notice of a Fin it runs, on the device's own credential, and reads the answer
 * (`TreeNoticeAnswerSchema`). A device's path: a machine has its own.
 */
export const TREE_NOTICES_PATH = "/v1/tree/notices"

/**
 * Where the device that owns an Apex's Session keeps the account's record of a Fin it placed elsewhere, and ends it:
 * it posts an ask (`TreeEdgeAskSchema`) on its own credential and reads the answer (`TreeEdgeAnswerSchema`).
 */
export const TREE_EDGES_PATH = "/v1/tree/edges"

/** Where a cloud machine's host posts a notice of its Fin, on the machine's credential, and reads the same answer. */
export function machineNoticesPath(machine: string): string {
  return `/v1/machines/${encodeURIComponent(machine)}/notices`
}

/**
 * The room an Apex's Session's mailbox shares among its Fins, by count: each Fin holding notices there may hold its
 * fair share of it (`treeNoticeFinShare`), and always one (`TREE_NOTICE_FIN_FLOOR`). It's a buffer, not a ceiling on
 * what a Fin may say: a notice past a Fin's share is `full` for that Fin alone and stays in its own host's outbox,
 * which never drops it, until its owner takes some of that Fin's. Five hundred is a Fin's 20 posts a minute
 * (`TREE_NOTICE_ADMITS_PER_MINUTE`) for 25 minutes with nothing taken, or a minute of 25 Fins at that rate.
 */
export const TREE_NOTICES_HELD = 500

/**
 * How many notices a Fin may always hold for its Apex's Session, whatever its siblings hold: one, of any size a notice
 * may be (`TREE_NOTICE_BYTES`). So a Fin that holds none is never refused `full`, however many siblings flood the
 * Session: its next report is held as soon as its owner took its last one.
 */
export const TREE_NOTICE_FIN_FLOOR = 1

/** What a Fin holds, or may hold, in its Apex's Session: how many notices, and their bytes as posted. */
export type TreeNoticeHolding = { count: number; bytes: number }

/**
 * A Fin's fair share of its Apex's Session's room while `holders` Fins hold notices there, itself counted: an equal
 * part of `TREE_NOTICES_HELD` and of `TREE_NOTICES_HELD_BYTES`, and never less than `TREE_NOTICE_FIN_FLOOR` notices.
 */
export function treeNoticeFinShare(holders: number): TreeNoticeHolding {
  const among = Math.max(1, Math.floor(holders))
  return { count: Math.max(TREE_NOTICE_FIN_FLOOR, Math.floor(TREE_NOTICES_HELD / among)), bytes: Math.floor(TREE_NOTICES_HELD_BYTES / among) }
}

/**
 * Whether a Fin may hold what it would hold after a post (`held`, its notices' count and bytes then) while `others`
 * other Fins hold notices in the same Session. At or under the floor it always may; past it, only within its fair
 * share among `others + 1` holders (`treeNoticeFinShare`).
 *
 * What decides is the Fin's own holdings and how many Fins hold: never how much the others hold. A Fin is refused only
 * when it holds its own share, so no sibling, however much it posts, refuses another's notice. The pool can't be
 * overdrawn by it either: with every Fin within the share of `h` holders, they hold `h × ⌊500 / h⌋ ≤ 500` notices, so a
 * pool check would admit whatever this does. What the shares can leave over the pool is what Fins took while they were
 * fewer and kept as more came: each keeps what it holds and takes no more until it's under the new share, so the
 * Session holds at most what each Fin's largest share was when it was admitted, `500 × (1 + ½ + … + 1/h)` notices for
 * `h` holders, and the same of 16 MiB, and each holder's one notice past that floor. Nothing waits on anything but its
 * owner taking notices, which admission never holds up, so nothing deadlocks.
 */
export function treeNoticeFinRoom(held: TreeNoticeHolding, others: number): boolean {
  if (held.count <= TREE_NOTICE_FIN_FLOOR) return true
  const share = treeNoticeFinShare(others + 1)
  return held.count <= share.count && held.bytes <= share.bytes
}

/**
 * The most a notice is, in bytes of its JSON as posted: 2 MiB, which is above the largest report a host writes, so a
 * report is never too large to send. A report's own limits come to 333,744 characters of free text: its ID 600, its
 * summary 16,000, 64 artifacts of 4,296 (a reference of 4,096 and a label of 200), a question of 4,000, 8 superseded
 * IDs of 600, 8 answered requests of 200, 8 waits of 600, 12 options of 800, an action of 400, a follow-up of 800 and
 * a handoff of 16,200. JSON writes a character in at most 6 bytes (a control character, as `\u0000`), so that text is
 * at most 2,002,464 bytes. The notice's own ID repeats the report's (3,644 bytes), and every key, quote, number, flag
 * and bracket of the fullest notice with its `standing` is 4,710 more: 2,010,818 bytes in all, with 86,334 to spare.
 */
export const TREE_NOTICE_BYTES = 2 * 1024 * 1024

/**
 * The room an Apex's Session's mailbox shares among its Fins, by bytes of notices as they were posted: 16 MiB, eight
 * of the largest notice there may be (`TREE_NOTICE_BYTES`). Shared as `TREE_NOTICES_HELD` is (`treeNoticeFinShare`).
 */
export const TREE_NOTICES_HELD_BYTES = 8 * TREE_NOTICE_BYTES

/**
 * The most posts one Fin makes in any minute; one more is refused (`rate`). Every post counts, whatever became of it: a
 * new notice, one posted again, and one said again with a newer `standing`.
 */
export const TREE_NOTICE_ADMITS_PER_MINUTE = 20

/**
 * The most records of notices put aside (`treeNoticeDisposal`'s `dead-letter`) the account keeps of one Fin, for
 * whoever looks into why: the oldest of that Fin's goes for its newer, so a Fin whose notices keep being put aside
 * (an impostor's conflicts, a child its Apex never knew) never pushes out another Fin's. A record is its ID, start,
 * number, size and why, never its text, so 32 of them are a few kilobytes: a safety bound, not a limit a Fin meets.
 */
export const TREE_NOTICE_DEAD_LETTERS = 32

/**
 * How long from its admission a notice is kept while its owner answers `unknown-child`. That answer is for a notice
 * that outran its own start's answer, which an hour settles; one still unknown after it is put aside.
 */
export const TREE_NOTICE_UNKNOWN_CHILD_MS = 60 * 60_000

/**
 * What a host that takes notices from the account says in its `advertise` (`runtime-frames.ts`): the account delivers
 * a held notice only to an owner whose link said this, and holds it for any other.
 */
export const TREE_NOTICES_CAPABILITY = { capability: "tree-notices", version: "1" } as const satisfies Capability

/** Whether what a runtime advertised says it takes notices from the account. */
export function takesTreeNotices(capabilities: readonly Capability[]): boolean {
  return capabilities.some((each) => each.capability === TREE_NOTICES_CAPABILITY.capability && each.version === TREE_NOTICES_CAPABILITY.version)
}

/**
 * The host call a notice is delivered as, to the owner of its Apex's Session: `mako:agents-notice`, its one argument
 * the notice as `TreeNoticeDeliverySchema` reads it. A host that advertises `TREE_NOTICES_CAPABILITY` takes this
 * operation from the account itself, not only from another device, and takes the notice in this shape: who sent it
 * and the Fin's start are in `from`, and there is no `op` beside `id` as there is when a device sends one directly.
 */
export const TREE_NOTICE_OP = "host.agents-notice"

const REPORT_ID_CHARS = 600
const Uuid = z.uuid()
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

/**
 * The Apex's Session a start was made for, read from the start's op where it has a start's form:
 * `start:{apexSession}:{clientKey}`, the Session a UUID and the client's key any text at all, colons and none
 * included. Undefined for anything else (a migrated edge's op, a message's, a move's), which names no Session to
 * trust. The account reads where a machine's notices go from the op it made the machine for, and refuses a notice
 * (`forbidden`) from a machine whose op gives none.
 */
export function apexSessionOfStart(op: string): string | undefined {
  const session = /^start:([^:]+):/.exec(op)?.[1]
  return session !== undefined && Uuid.safeParse(session).success ? session : undefined
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
 * machine under its generation, or a device), the notice's number among its Apex's Session's, and when it was admitted.
 * `op` is the start that made the Fin, as the account has it on record: a machine's is the start the machine was made
 * for, and a device's is its record's (`TreeEdgeSchema`), which its Apex's device keeps with the account. A device's
 * credential names no start by itself, so its notice is admitted only under such a record, and is stamped with it.
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
 * and posting the same again answers the same: `gone` is as good as taken, since nothing is left to hear it;
 * `conflict` is another report under the same ID; `forbidden` is a notice for a Fin or an Apex that isn't the sender's:
 * a machine's for another child or Apex than its own, a device's with no record that names the three (`treeEdgeOfNotice`).
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
    case "full": return `This Fin holds its share of what its Apex's Session keeps (${TREE_NOTICES_HELD} reports or ${TREE_NOTICES_HELD_BYTES / 1024 / 1024} MiB shared equally among the Fins holding some, and always one) until its owner takes some of this Fin's. This one goes once it has.`
    case "rate": return `This Fin posted ${TREE_NOTICE_ADMITS_PER_MINUTE} times within a minute. This one goes in a moment.`
    case "invalid": return `${NOTICE_ID_RULE}.`
    case "too-large": return `A report crosses in at most ${TREE_NOTICE_BYTES / 1024 / 1024} MiB.`
    case "forbidden": return "That Fin, or that Apex, isn't this sender's."
  }
}

/** A notice's size as the account counts it: the bytes of its JSON text as posted (`JSON.stringify(notice)`). */
export function treeNoticeBytes(json: string): number {
  return new TextEncoder().encode(json).length
}

/** Whether a notice's JSON text fits what the account takes. */
export function treeNoticeFits(json: string): boolean {
  return treeNoticeBytes(json) <= TREE_NOTICE_BYTES
}

/**
 * Whether two notices are the same notice, whatever order their fields come in: the same ID, Apex, child and report.
 * How the Fin stands isn't part of it, so a report said again with a newer `standing` is the same notice.
 */
export function sameTreeNotice(left: TreeNotice, right: TreeNotice): boolean {
  return canonical(JSON.parse(JSON.stringify({ ...left, standing: undefined }))) === canonical(JSON.parse(JSON.stringify({ ...right, standing: undefined })))
}

function canonical(value: Json | undefined): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value instanceof Object)
    return `{${Object.entries(value).filter(([, each]) => each !== undefined).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)).map(([key, each]) => `${JSON.stringify(key)}:${canonical(each)}`).join(",")}}`
  return JSON.stringify(value)
}

/** Which word of a Fin's host on how the Fin stands this is: the host that said it, by its generation, and its count of sayings. */
export type TreeStandingMark = { owner: number; seq: number }

/**
 * Whether `next` is a newer word on how a Fin stands than `said`, as every host orders them: by the generation of the
 * host that said it, then by its count. Anything is newer than none.
 */
export function newerTreeStanding(said: TreeStandingMark | undefined, next: TreeStandingMark): boolean {
  return !said || next.owner > said.owner || (next.owner === said.owner && next.seq > said.seq)
}

/**
 * The account's record of a Fin that runs off its Apex's host: the start that made it (`op`), its Apex, its Thread as
 * its Apex knows it (`child`) and where it runs, a device of the account or a cloud Thread. The device that owns the
 * Apex's Session keeps it there once the Fin is placed, and it's what the account holds a device's notices to: only the
 * device a record names posts for that record's child, and only to that record's Apex. It says nothing else of the
 * Fin, and isn't the tree: a Fin with no record is one its Apex's device alone knows.
 *
 * The start is one of its own Apex's Session's (`apexSessionOfStart`); a record whose start names another isn't one.
 */
const Edge = z.object({
  op: z.string().min(1).max(512),
  apex: z.object({ thread: z.uuid(), session: z.uuid() }).strict(),
  child: z.uuid(),
  place: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("device"), device: z.uuid() }).strict(),
    z.object({ kind: z.literal("cloud"), thread: z.string().regex(/^t-[0-9a-f]{16}$/) }).strict(),
  ]),
}).strict()

const TREE_EDGE_RULE = "A record's start is start:{its Apex's Session}:{clientKey}"

export const TreeEdgeSchema = z.lazy(() => Edge.refine((edge) => apexSessionOfStart(edge.op) === edge.apex.session, TREE_EDGE_RULE))
export type TreeEdge = z.infer<typeof TreeEdgeSchema>

/**
 * What an Apex's device asks of the account's records: `keep` this one, or `end` the one under a start. Either again
 * is the same ask, so one whose answer was lost is asked again as it is.
 */
export const TreeEdgeAskSchema = z.lazy(() => z.discriminatedUnion("ask", [
  z.object({ ask: z.literal("keep"), edge: TreeEdgeSchema }).strict(),
  z.object({ ask: z.literal("end"), op: z.string().min(1).max(512) }).strict(),
]))
export type TreeEdgeAsk = z.infer<typeof TreeEdgeAskSchema>

/**
 * Why an ask wasn't done, and asking the same again answers the same: `forbidden` is an ask from a device that doesn't
 * own the record's Apex's Session, as the account lists who owns it; `conflict` is a start already on record with
 * another Apex, child or place; `invalid` is an ask that isn't one.
 */
export const TreeEdgeRefusalSchema = z.enum(["conflict", "forbidden", "invalid"])
export type TreeEdgeRefusal = z.infer<typeof TreeEdgeRefusalSchema>

/** The answer to an ask: done (a record kept that was kept already, or ended that wasn't there, is done too), or why not. */
export const TreeEdgeAnswerSchema = z.lazy(() => z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), reason: TreeEdgeRefusalSchema }),
]))
export type TreeEdgeAnswer = z.infer<typeof TreeEdgeAnswerSchema>

/** Each refusal as the Apex's host logs it. */
export function treeEdgeRefusalText(reason: TreeEdgeRefusal): string {
  switch (reason) {
    case "conflict": return "That start is on record already, with another Apex, Fin or place."
    case "forbidden": return "This device doesn't own that Apex's Session, as the account lists it."
    case "invalid": return `${TREE_EDGE_RULE}, and an ask keeps a record or ends one.`
  }
}

/** Whether two records are the same record: the same start, Apex, child and place. */
export function sameTreeEdge(left: TreeEdge, right: TreeEdge): boolean {
  return canonical(JSON.parse(JSON.stringify(left))) === canonical(JSON.parse(JSON.stringify(right)))
}

/**
 * A record as the account keeps it. `ending`: its Apex's device ended it, or it lapsed (`TREE_EDGE_LEASE_MS`), while
 * the account still held notices admitted under it, so it stands until they're taken and goes then.
 */
export type KeptTreeEdge = { edge: TreeEdge; ending: boolean }

/** What the account does with an ask it takes: `keep` the record, `end` the one it has, or `nothing`, a plain repeat. */
export type TreeEdgeDecision = { ok: true; does: "keep" | "end" | "nothing" } | { ok: false; reason: "conflict" | "forbidden" }

/**
 * What the account answers an ask, from the record it has under that start (`kept`) and whether the asking device owns
 * a Session (`owns`), by the account's own list of who owns each and never by the ask.
 *
 * Only the device that owns a record's Apex's Session keeps it or ends it. Which Session that is comes from the ask
 * (a record's Apex, or the Session an ended start names, `apexSessionOfStart`) and is settled before anything is said
 * of what's on record, so a device learns nothing of another Apex's records. A record kept again as it is changes
 * nothing; the same start with another Apex, child or place is a conflict; and one that was ending stands again. Ending
 * a start with no record is done already.
 *
 * `end` is the account's to carry out: with nothing held under the record it goes at once, and with notices still
 * held it's `ending` until they're taken, admitting as before. So a device is refused a notice for want of a record
 * only while the account holds nothing of that Fin's.
 */
export function decideTreeEdge(ask: TreeEdgeAsk, kept: KeptTreeEdge | undefined, owns: (session: string) => boolean): TreeEdgeDecision {
  const session = ask.ask === "end" ? apexSessionOfStart(ask.op) : ask.edge.apex.session
  if (session === undefined || !owns(session)) return { ok: false, reason: "forbidden" }
  if (ask.ask === "end") return { ok: true, does: kept && !kept.ending ? "end" : "nothing" }
  if (!kept) return { ok: true, does: "keep" }
  if (!sameTreeEdge(kept.edge, ask.edge)) return { ok: false, reason: "conflict" }
  return { ok: true, does: kept.ending ? "keep" : "nothing" }
}

/**
 * The record a device's notice is admitted under, among the account's (`edges`, oldest first): the oldest that names
 * that device as the Fin's place, the notice's child as its Fin and the notice's Apex, Thread and Session both, as its
 * own. None, and the notice is `forbidden`. The device is the one its credential names. The notice is then held for
 * the record's Apex's Session, under the record's start, which is what the account says sent it (`from.op`).
 */
export function treeEdgeOfNotice(edges: readonly TreeEdge[], device: string, notice: Pick<TreeNotice, "child" | "parent">): TreeEdge | undefined {
  const key = treeNoticeEdgeKey(device, notice)
  return edges.find((edge) => treeEdgeNoticeKey(edge) === key)
}

/**
 * What a device's notice is matched to a record by (`treeEdgeOfNotice`): the device that posts it, its Apex's Session
 * and Thread, and its child, as one key. The account keeps each record of a Fin on a device under its record's key
 * (`treeEdgeNoticeKey`), so the record a post goes under is one lookup, whatever else the account keeps.
 */
export function treeNoticeEdgeKey(device: string, notice: Pick<TreeNotice, "child" | "parent">): string {
  return `${device}:${notice.parent.session}:${notice.parent.thread}:${notice.child}`
}

/** The key a device's notice finds this record under (`treeNoticeEdgeKey`); none for a Fin in the cloud, whose machine posts its notices. */
export function treeEdgeNoticeKey(edge: TreeEdge): string | undefined {
  return edge.place.kind === "device" ? treeNoticeEdgeKey(edge.place.device, { parent: edge.apex, child: edge.child }) : undefined
}

/**
 * How long the account keeps an Apex's Session's records after it last knew the Session's owner was there: 30 days,
 * as long as it remembers a Session that left its owner (`DEPARTED_KEPT_MS` in the account). A record exists so a Fin
 * can report while its Apex's device is off; a device off that long, or gone for good without being removed (wiped,
 * lost), leaves nobody to end its records, and nor does a Session that moved to the cloud or left the list without
 * ending, whose owner is no device. Past this they lapse (`treeEdgesStandUntil`), each once nothing admitted under it
 * is still held, so a record never goes while a notice its Fin posted under it waits.
 *
 * A record that lapsed is kept again as any is: the Fin's next notice goes to its Apex's device itself, and that device,
 * hearing from a Fin it had on record, asks the account to keep it again (`recordPlaced`).
 */
export const TREE_EDGE_LEASE_MS = 30 * 24 * 60 * 60_000

/**
 * The owner of an Apex's Session as the account last knew its link: up, or down since `at`. Undefined when the Session
 * has no device for an owner (it runs in the cloud, or isn't listed), or the account never heard that device's link.
 */
export type TreeEdgeOwnerLink = { up: boolean; at: number } | undefined

/**
 * Until when a Session's records stand: `TREE_EDGE_LEASE_MS` from the last the account knew its owner was there, which
 * is now while its owner's link is up, when the link went down, or the owner's last ask of the records
 * (`renewedAt`), whichever is latest. So an owner renews its records by being connected, with nothing asked of it.
 */
export function treeEdgesStandUntil(renewedAt: number, owner: TreeEdgeOwnerLink, now: number): number {
  const seen = owner === undefined ? renewedAt : owner.up ? now : owner.at
  return Math.max(renewedAt, seen) + TREE_EDGE_LEASE_MS
}

/** A notice the account holds for its Apex's Session: the number it was admitted at, and its bytes as posted. */
export type HeldTreeNotice = { seq: number; bytes: number; notice: TreeNotice }

/**
 * The last notice the account admitted from a Fin, kept after its owner took it: one record a Fin, not a log. It's
 * what tells that notice posted again from a new one once nothing of it is held, and `said` is the newest standing
 * the account took with it.
 */
export type LastTreeNotice = { id: string; seq: number; said?: TreeStandingMark }

/**
 * What the account does with an admitted post: `hold` a new notice under its number; `restand` one it holds, whose
 * `standing` the post's replaces; `forward` the post once to the Session's owner if it's connected, keeping nothing (a
 * newer standing on the Fin's last notice, which its owner already took); or `nothing`, a plain repeat.
 */
export type TreeNoticeAdmission =
  | { admitted: true; seq: number; does: "hold" | "restand" | "forward" | "nothing" }
  | { admitted: false; reason: "conflict" | "full" }

/**
 * What the account holds as a notice is posted: the sender's own notices held for the Session (`own`, those admitted
 * under its start), how many other Fins hold notices there (`others`), the last number given there (`head`, 0 before
 * any) and the last notice admitted from the sender (`last`). A notice is the sender's own by its start and its ID
 * together, so another Fin's notice under the same ID is neither this one nor a conflict. A machine's start is the
 * one it was made for, and a device's is its record's (`treeEdgeOfNotice`). Nothing of what the others hold is read:
 * the rule asks only how many they are (`treeNoticeFinRoom`).
 */
export type TreeNoticeMailbox = { own: readonly HeldTreeNotice[]; others: number; head: number; last?: LastTreeNotice }

/**
 * What the account answers a notice posted for a Session, from what it holds there (`TreeNoticeMailbox`). `bytes` is
 * the post's size (`treeNoticeBytes`).
 *
 * A notice of the sender's it holds, posted again, answers the number it first got, even when the sender is at its
 * share, and a newer `standing` replaces the held one's; the same ID with another report, child or Apex is a conflict.
 * The sender's last notice, no longer held, answers its number too and isn't kept again: only a newer `standing` on
 * it goes on, once. Anything else is new and takes the next number, unless the sender would hold more than its share
 * of the Session's room (`treeNoticeFinRoom`), by count or by bytes: a Fin holding none always has room. Numbers only
 * rise, so what's held stays in the order it was admitted however much was taken between.
 */
export function admitTreeNotice(mailbox: TreeNoticeMailbox, posted: TreeNotice, bytes: number): TreeNoticeAdmission {
  const newer = (said: TreeStandingMark | undefined) => posted.standing !== undefined && newerTreeStanding(said, posted.standing)
  const first = mailbox.own.find((each) => each.notice.id === posted.id)
  if (first) return sameTreeNotice(first.notice, posted) ? { admitted: true, seq: first.seq, does: newer(first.notice.standing) ? "restand" : "nothing" } : { admitted: false, reason: "conflict" }
  if (mailbox.last?.id === posted.id) return { admitted: true, seq: mailbox.last.seq, does: newer(mailbox.last.said) ? "forward" : "nothing" }
  const held = { count: mailbox.own.length + 1, bytes: mailbox.own.reduce((sum, each) => sum + each.bytes, bytes) }
  if (!treeNoticeFinRoom(held, mailbox.others)) return { admitted: false, reason: "full" }
  return { admitted: true, seq: mailbox.head + 1, does: "hold" }
}

/** Whether a Fin that posted at `posts` (each a time in ms, every post counted) may post another at `now`. */
export function treeNoticeRateOpen(posts: readonly number[], now: number): boolean {
  return posts.filter((at) => at > now - 60_000 && at <= now).length < TREE_NOTICE_ADMITS_PER_MINUTE
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
 * is put aside, since sending it again would answer the same. An owner that doesn't know the Fin yet keeps it for a
 * later try until the notice is `TREE_NOTICE_UNKNOWN_CHILD_MS` old (`ageMs`, since it was admitted), then it's put
 * aside too. No answer keeps it, however old.
 */
export function treeNoticeDisposal(ack: TreeNoticeAck | undefined, ageMs: number): "delete" | "keep" | "dead-letter" {
  if (!ack) return "keep"
  switch (treeNoticeAckWord(ack)) {
    case "heard":
    case "deduped":
    case "stale-owner": return "delete"
    case "unknown-child": return ageMs >= TREE_NOTICE_UNKNOWN_CHILD_MS ? "dead-letter" : "keep"
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
