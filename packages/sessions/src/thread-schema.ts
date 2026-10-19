import { SessionSettingsSchema } from "./settings.js"
import { z } from "zod"
import { NativeEventSourceSchema, TurnCauseSchema, UsageLimitSchema } from "./events.js"
import {
  AttachmentContentSchema,
  ToolDetailSchema,
  ProposedPlanSchema,
} from "./content.js"
import { ToolEffectSchema } from "./tool-effects.js"
import { EntrySchema, TurnUsageSchema, unfinished } from "./entries.js"
import { entriesFromMessages } from "./entry-sink.js"

/**
 * A decoder's working shape (`DecodedEntry` in `format.ts`): a message
 * with its blocks, as decoders assemble one and as builds before
 * 2026-10-15 kept saved history (archives, journal copies). `EntrySink`
 * flattens it into entries (`entries.ts`); `entriesFromMessages` reads
 * what an earlier build kept.
 */
export const DecodedBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string(), id: z.string().optional() }),
  z.object({ type: z.literal("thinking"), text: z.string(), id: z.string().optional() }),
  AttachmentContentSchema,
  ProposedPlanSchema,
  z.object({
    type: z.literal("tool"),
    name: z.string(),
    id: z.string().optional(),
    /** A call the live reducer decoded keeps its title, kind and status (`EntryOf<"tool">`). */
    title: z.string().optional(),
    toolKind: z.string().optional(),
    status: z.string().optional(),
    input: z.string().optional(),
    output: z.string().optional(),
    /**
     * Length of the complete output when `output` holds only its head. A
     * page trims tool output so a conversation whose bytes are almost all
     * shell output opens in one small message; `block` reads the rest.
     */
    outputLength: z.number().nonnegative().optional(),
    /** Other tool fields were previewed; load the full block before copying/rendering its details. */
    contentOmitted: z.literal(true).optional(),
    /** Display-only identity assigned by the shared retained-history owner. */
    historyVersion: z.string().optional(),
    /** Inline images a page left out of `attachments`; `block` reads them. */
    attachmentsOmitted: z.number().int().positive().optional(),
    error: z.boolean().optional(),
    canceled: z.boolean().optional(),
    /** The call never returned a result in its harness's record (`EntryOf<"tool">.unfinished`). */
    unfinished,
    details: z.array(ToolDetailSchema).optional(),
    attachments: z.array(AttachmentContentSchema).optional(),
    /** What the call did to the machine as its harness reported it (`tool-effects.ts`), for attribution. */
    effects: z.array(ToolEffectSchema).max(1024).optional(),
  }),
])
const identity = { id: z.string().optional(), at: z.string().optional() }
export const DecodedEntrySchema = z.discriminatedUnion("kind", [
  z.object({
    ...identity,
    kind: z.literal("user"),
    steeringFor: z.string().optional(),
    text: z.string(),
    attachments: z.array(AttachmentContentSchema).optional(),
  }),
  z.object({
    ...identity,
    kind: z.literal("assistant"),
    blocks: z.array(DecodedBlockSchema),
    model: z.string().optional(),
    usage: TurnUsageSchema.optional(),
  }),
  z.object({
    ...identity,
    kind: z.literal("event"),
    source: NativeEventSourceSchema.optional(),
    label: z.string(),
    detail: z.string().optional(),
    /** Long text the reader opens on demand (`TranscriptEvent.body`). */
    body: z.string().optional(),
    tone: z.enum(["warning", "error"]).optional(),
    /** A fact about the harness's setup (`TranscriptEvent.setup`), gathered with its neighbours. */
    setup: z.boolean().optional(),
    /** Background work that settled (`TranscriptEvent.cause`): what the transcript words the line from. */
    cause: TurnCauseSchema.optional(),
    /** A usage limit refusing work (`TranscriptEvent.limit`), said once for all it stopped. */
    limit: UsageLimitSchema.optional(),
    /**
     * The provider started a turn on its own and this is what it reported as
     * the cause (a background command finishing). It opens the turn the way a
     * prompt would, but it is the provider's words, never the user's.
     */
    opensTurn: z.literal(true).optional(),
  }),
])
export const ThreadRefSchema = z.object({
  harness: z.string(),
  nativeId: z.string(),
  path: z.string(),
  cwd: z.string().optional(),
  currentCwd: z.string().optional(),
  workspace: z.string().optional(),
  title: z.string().optional(),
  model: z.string().optional(),
  settings: SessionSettingsSchema.optional(),
  startedAt: z.string().optional(),
  updatedAt: z.string().optional(),
  bytes: z.number().nonnegative().optional(),
  revision: z.string().optional(),
  locked: z.boolean().optional(),
  active: z.boolean().optional(),
  clientCopy: z.literal(true).optional(),
  archived: z.boolean().optional(),
  nativeArchived: z.boolean().optional(),
  nativeArchiveStamp: z.string().regex(/^\d+$/).optional(),
  resumeUnavailable: z.string().optional(),
  lineage: z
    .array(z.object({ harness: z.string(), title: z.string().optional() }))
    .optional(),
  modelProvider: z.string().optional(),
  identity: z.string().optional(),
  parentNativeId: z.string().optional(),
  childOf: z
    .object({ nativeId: z.string(), path: z.string().optional(), toolId: z.string().optional(), ended: z.literal(true).optional() })
    .optional(),
  liveResume: z.boolean().optional(),
  workspaceMissing: z.boolean().optional(),
  worktrees: z
    .array(z.object({ path: z.string(), repoRoot: z.string() }))
    .optional(),
  accessMode: z.string().optional(),
  heldBy: z.string().optional(),
  ownedElsewhere: z.boolean().optional(),
  threadId: z.string().optional(),
  sessionId: z.string().optional(),
})
export const UnreadRecordSchema = z.object({
  kind: z.string(),
  reason: z.enum(["unknown", "unreadable", "undrawn"]),
  count: z.number().int().positive(),
  sample: z.json().optional(),
})
/** History as any build kept it: entries, or an earlier build's messages read as entries. */
export const StoredEntriesSchema = z.union([
  z.array(EntrySchema),
  z.array(DecodedEntrySchema).transform((messages) => entriesFromMessages(messages)),
])
export const RecordSealSchema = z.object({
  identity: z.string(),
  from: z.number().int().nonnegative(),
  to: z.number().int().nonnegative(),
  sha256: z.string(),
})
export const ResumePointSchema = z.object({
  byte: z.number().int().nonnegative(),
  entry: z.number().int().nonnegative(),
  unread: z.array(UnreadRecordSchema).optional(),
  state: z.json().optional(),
  seal: RecordSealSchema,
})
export const ThreadSchema = z.object({
  ref: ThreadRefSchema,
  entries: StoredEntriesSchema,
  checkpoint: z.number().nonnegative().optional(),
  unread: z.array(UnreadRecordSchema).optional(),
  resume: ResumePointSchema.optional(),
})
