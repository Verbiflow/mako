/**
 * One conversation entry, live or saved: what the person said, each thing
 * the agent wrote or did, and the markers between them, one item each.
 *
 * A live turn reduces into entries as the harness streams (`live-content.ts`),
 * a saved session decodes into the same entries (`format.ts`'s `EntrySink`),
 * and a view, the journal, the wire and the window all carry them as they
 * are. An entry in a view always has an `id` taken from the record it came
 * from (the harness's own item id where it has one, else the record's
 * place), so two decodes, and two builds of the decoder, name it the same,
 * and `record` says which bytes those are. A live entry names the frames of
 * the stream it was built from in `stream`; a prompt Mako sent names its
 * request (`requestId`), which Mako's log holds.
 */
import { z } from "zod"
import { AttachmentContentSchema, ProposedPlanSchema, ToolDetailSchema, type AttachmentContent, type ProposedPlan } from "./content.js"
import { NativeEventSourceSchema, TurnCauseSchema, UsageLimitSchema } from "./events.js"
import { ToolEffectSchema } from "./tool-effects.js"

export const TurnUsageSchema = z.object({
  input: z.number().optional(),
  output: z.number().optional(),
  cacheRead: z.number().optional(),
  cacheWrite: z.number().optional(),
  costUsd: z.number().optional(),
})
export type TurnUsage = z.infer<typeof TurnUsageSchema>

const offset = z.number().int().nonnegative()

/**
 * The native bytes an entry was read from: plain byte ranges of a file,
 * oldest first, or database rows by table and primary key. `file` is the
 * session's own file (the part of its path before `#`) when unset.
 */
export const RecordRefSchema = z.object({
  file: z.string().optional(),
  ranges: z.array(z.tuple([offset, offset])).optional(),
  rows: z.array(z.object({ table: z.string(), key: z.record(z.string(), z.union([z.string(), z.number()])) })).optional(),
})
export type RecordRef = z.infer<typeof RecordRefSchema>

/**
 * `record` added to what an item already names, as a new reference: one an
 * entry already handed out never changes. Ranges stay sorted and merged. An
 * item names records of one file; a later file's record is left out.
 */
export function joined(held: RecordRef | undefined, record: RecordRef | undefined): RecordRef | undefined {
  if (!record) return held
  if (!held) return record
  if (held.file !== record.file) return held
  const next: RecordRef = {}
  if (held.file !== undefined) next.file = held.file
  if (held.ranges || record.ranges) next.ranges = joinedRanges(held.ranges ?? [], record.ranges ?? [])
  if (held.rows || record.rows) {
    const rows = [...held.rows ?? []]
    for (const row of record.rows ?? []) if (!rows.some((kept) => kept.table === row.table && sameKey(kept.key, row.key))) rows.push(row)
    next.rows = rows
  }
  return next
}

/** Two sorted lists of ranges as one, merged; a list that continues the first, as streams grow, joins without sorting. */
function joinedRanges(held: [number, number][], added: [number, number][]): [number, number][] {
  const last = held.at(-1)
  const copy = ([from, to]: [number, number]): [number, number] => [from, to]
  if (last && added.length > 0 && added[0]![0] >= last[0] && ascending(added) && apart(held)) {
    // A stream's next lines, the reducer's case on every update: only the last range can
    // grow, so the ranges before it are shared rather than copied, each update again.
    const ranges = held.slice(0, -1)
    let tail = last
    for (const range of added) {
      if (range[0] > tail[1]) {
        ranges.push(tail)
        tail = copy(range)
      } else if (range[1] > tail[1]) tail = [tail[0], range[1]]
    }
    ranges.push(tail)
    return ranges
  }
  const ranges: [number, number][] =
    !last || (added.length > 0 && added[0]![0] >= last[0] && ascending(added))
      ? [...held.slice(0, -1).map(copy), ...(last ? [copy(last)] : []), ...added.map(copy)]
      : [...held, ...added].sort((a, b) => a[0] - b[0]).map(copy)
  // Every range here is a copy, so widening one never reaches the caller's (`held` stays as it was given).
  let kept = 0
  for (const range of ranges) {
    const previous = kept > 0 ? ranges[kept - 1]! : undefined
    if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1])
    else ranges[kept++] = range
  }
  ranges.length = kept
  return ranges
}

/** Whether no range reaches the next, as `joinedRanges` leaves them. */
function apart(ranges: [number, number][]): boolean {
  for (let index = 1; index < ranges.length; index++) if (ranges[index]![0] <= ranges[index - 1]![1]) return false
  return true
}

function ascending(ranges: [number, number][]): boolean {
  for (let index = 1; index < ranges.length; index++) if (ranges[index]![0] < ranges[index - 1]![0]) return false
  return true
}

function sameKey(left: Record<string, string | number>, right: Record<string, string | number>): boolean {
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key])
}

/** A moment in epoch milliseconds: when the record says it was written, or when the host received or sent it. */
const at = z.number().nonnegative().optional()
/**
 * A prompt Mako sent for one of its own commands, as Mako words it
 * (`/review uncommitted changes`, `/goal …`): what a harness that runs the
 * command through its own API may record otherwise, or not at all.
 */
export const MakoCommandSchema = z.enum(["goal", "review"])
export type MakoCommand = z.infer<typeof MakoCommandSchema>
const id = z.string().optional()
const record = RecordRefSchema.optional()
/**
 * The frames of Mako's stream of the harness's live transport the entry was
 * built from (`record-streams.ts`): `file` is the stream's key in the record
 * store (`mako-streams:<harness>/<file>`), its ranges whole lines of it. A
 * live entry has these alone; once its turn's record lands, the record's
 * entry holds them beside its own `record` (`stream-merge.ts`).
 */
const stream = RecordRefSchema.optional()
/**
 * What an entry of the agent's reply carries of the message it was part
 * of: the model that wrote it, on its first entry, and what it cost, on its
 * last. These and `record` follow an entry's own fields, so an entry
 * written before them serializes as it did.
 */
const message = { model: z.string().optional(), usage: TurnUsageSchema.optional() }
export const plan = z.array(z.object({ content: z.string(), status: z.string() }))
/**
 * The call never returned a result: its turn ended while it was still
 * running. `status` is what closed the row, not the call's own; `output` is
 * what the call had produced by then. Rows closed before 2026-10-15 hold
 * Mako's note in place of the output.
 */
export const unfinished = z.literal(true).optional()
/**
 * What the call did to the machine as its harness reported it
 * (`tool-effects.ts`), whole: a later update replaces the list. For
 * attribution, never drawn.
 */
export const effects = z.array(ToolEffectSchema).max(1024).optional()
/** `TranscriptEvent` from `@mako/sessions/events`. */
export const transcriptEventFields = {
  source: NativeEventSourceSchema.optional(),
  label: z.string(),
  detail: z.string().optional(),
  body: z.string().optional(),
  tone: z.enum(["warning", "error"]).optional(),
  setup: z.boolean().optional(),
  cause: TurnCauseSchema.optional(),
  limit: UsageLimitSchema.optional(),
}
/** A turn the provider started on its own, as `ProviderTurnCause` from `@mako/sessions/provider-turn` says it. */
export const providerTurnFields = {
  /** The record the turn ran on, when the harness wrote one: its prompt line. */
  source: NativeEventSourceSchema.optional(),
  reason: z.string(),
  cause: TurnCauseSchema.optional(),
  body: z.string().optional(),
  /** What a saved opener says beside its reason, and how it ended, as a reader gave it (Cursor's plan builds and failed shells). */
  detail: z.string().optional(),
  tone: z.enum(["warning", "error"]).optional(),
}

export const EntrySchema = z.discriminatedUnion("type", [
  ProposedPlanSchema.extend({
    /**
     * The harness's id for the plan, when an entry before it already took
     * that id (a plan named by the call that wrote it): what the plan's
     * builds and decisions are kept by. Unset, `id` is the plan's.
     */
    plan: z.string().optional(),
    at,
    record,
    stream,
    ...message,
  }),
  z.object({
    type: z.literal("user"),
    steeringFor: z.string().optional(),
    command: MakoCommandSchema.optional(),
    provider: z.string().optional(),
    requestId: z.string().optional(),
    at,
    /** The harness's id for the message; a chunk right after one with the same id continues it. */
    messageId: z.string().optional(),
    contextFiles: z.array(z.string()).optional(),
    text: z.string(),
    attachments: z.array(AttachmentContentSchema).optional(),
    id,
    record,
    stream,
  }),
  z.object({ type: z.literal("text"), text: z.string(), id, at, record, stream, ...message }),
  z.object({ type: z.literal("thinking"), text: z.string(), id, at, record, stream, ...message }),
  z.object({ type: z.literal("attachment"), attachment: AttachmentContentSchema, id, at, record, stream, ...message }),
  z.object({
    type: z.literal("tool"),
    /** A live window's preview, resolved from the retained snapshot on expansion. */
    historyRest: z.object({ index: z.number().int().nonnegative(), length: z.number().nonnegative() }).optional(),
    /** Display-only immutable content identity, including a resolved detail. */
    historyVersion: z.string().optional(),
    id: z.string(),
    /** The harness's words for the call (ACP's title); a saved call has its `name` only. */
    title: z.string().optional(),
    /** The harness's own tool name, which `identifyTool` resolves; ACP calls it nothing. */
    name: z.string().optional(),
    /** ACP's kind for the call (`execute`, `read`), when the harness speaks ACP. */
    toolKind: z.string().optional(),
    /** Unset for a saved call whose record holds no result. */
    status: z.string().optional(),
    input: z.string().optional(),
    output: z.string().optional(),
    details: z.array(ToolDetailSchema).optional(),
    attachments: z.array(AttachmentContentSchema).optional(),
    unfinished,
    effects,
    at,
    /** When the call finished, beside `at` when it started; a live call has both from the host's clock. */
    endedAt: at,
    record,
    stream,
    ...message,
    /**
     * A page's preview of the call: the length of the whole output when
     * `output` holds its head, other fields left out, and how many inline
     * images it left out. `entry` by id reads the whole call.
     */
    outputLength: z.number().nonnegative().optional(),
    contentOmitted: z.literal(true).optional(),
    attachmentsOmitted: z.number().int().positive().optional(),
  }),
  z.object({ type: z.literal("plan"), entries: plan, id, at, record, stream }),
  z.object({ type: z.literal("provider-turn"), ...providerTurnFields, at, id, record, stream }),
  /**
   * A marker the provider gave the conversation (`TranscriptEvent`). In a
   * live turn, `id` names the native event it came from: the same id again
   * replaces the marker, so a replayed or amended event is drawn once.
   */
  z.object({ type: z.literal("event"), id, ...transcriptEventFields, at, record, stream }),
  /**
   * A native record the decoder doesn't understand, where it stood: its
   * kind, why it wasn't read, and the record itself, shown raw.
   */
  z.object({
    type: z.literal("unread"),
    kind: z.string(),
    reason: z.enum(["unknown", "unreadable", "undrawn"]),
    raw: z.json().optional(),
    /** A page left `raw` out for being large; `entry` by id reads it. */
    rawOmitted: z.literal(true).optional(),
    id,
    at,
    record,
    stream,
  }),
])
export type Entry = z.infer<typeof EntrySchema>
export type EntryOf<Type extends Entry["type"]> = Extract<Entry, { type: Type }>
export type ToolEntry = EntryOf<"tool">

/** Entries of the agent's reply, which carry its message's model and usage. */
export type ReplyEntry = EntryOf<"text" | "thinking" | "attachment" | "proposed-plan" | "tool">

export function isReplyEntry(entry: Entry): entry is ReplyEntry {
  return entry.type === "text" || entry.type === "thinking" || entry.type === "attachment" || entry.type === "proposed-plan" || entry.type === "tool"
}

/** A plan entry as the plan card it is, under the harness's id for the plan. */
export function proposedPlan(entry: EntryOf<"proposed-plan">): ProposedPlan {
  const plan: ProposedPlan = { type: "proposed-plan", id: entry.plan ?? entry.id, text: entry.text, status: entry.status }
  if (entry.truncated) plan.truncated = true
  return plan
}

/** What an entry attaches: a prompt's files, an attachment the model sent, or what a call returned. */
export function entryAttachments(entry: Entry): readonly AttachmentContent[] {
  if (entry.type === "attachment") return [entry.attachment]
  return entry.type === "user" || entry.type === "tool" ? (entry.attachments ?? []) : []
}
