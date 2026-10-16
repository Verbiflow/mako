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
 * and `record` says which bytes those are.
 */
import { z } from "zod"
import { AttachmentContentSchema, ProposedPlanSchema, ToolDetailSchema } from "./content.js"
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

/** A moment in epoch milliseconds: when the record says it was written, or when the host received or sent it. */
const at = z.number().nonnegative().optional()
const id = z.string().optional()
const record = RecordRefSchema.optional()
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
}

export const EntrySchema = z.discriminatedUnion("type", [
  ProposedPlanSchema.extend({ at, record, ...message }),
  z.object({
    type: z.literal("user"),
    steeringFor: z.string().optional(),
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
  }),
  z.object({ type: z.literal("text"), text: z.string(), id, at, record, ...message }),
  z.object({ type: z.literal("thinking"), text: z.string(), id, at, record, ...message }),
  z.object({ type: z.literal("attachment"), attachment: AttachmentContentSchema, id, at, record, ...message }),
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
    record,
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
  z.object({ type: z.literal("plan"), entries: plan, id, at, record }),
  z.object({ type: z.literal("provider-turn"), ...providerTurnFields, at, id, record }),
  /**
   * A marker the provider gave the conversation (`TranscriptEvent`). In a
   * live turn, `id` names the native event it came from: the same id again
   * replaces the marker, so a replayed or amended event is drawn once.
   */
  z.object({ type: z.literal("event"), id, ...transcriptEventFields, at, record }),
  /**
   * A native record the decoder doesn't understand, where it stood: its
   * kind, why it wasn't read, and the record itself, shown raw.
   */
  z.object({
    type: z.literal("unread"),
    kind: z.string(),
    reason: z.enum(["unknown", "unreadable", "undrawn"]),
    raw: z.json().optional(),
    id,
    at,
    record,
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
