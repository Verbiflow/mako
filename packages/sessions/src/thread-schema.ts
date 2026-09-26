import { SessionSettingsSchema } from "./settings.js"
import { z } from "zod"
import {
  AttachmentContentSchema,
  ToolDetailSchema,
  ProposedPlanSchema,
} from "./content.js"

export const TurnUsageSchema = z.object({
  input: z.number().optional(),
  output: z.number().optional(),
  cacheRead: z.number().optional(),
  cacheWrite: z.number().optional(),
  costUsd: z.number().optional(),
})
export const EntryBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("thinking"), text: z.string() }),
  AttachmentContentSchema,
  ProposedPlanSchema,
  z.object({
    type: z.literal("tool"),
    name: z.string(),
    id: z.string().optional(),
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
    details: z.array(ToolDetailSchema).optional(),
    attachments: z.array(AttachmentContentSchema).optional(),
  }),
])
const identity = { id: z.string().optional(), at: z.string().optional() }
export const ThreadEntrySchema = z.discriminatedUnion("kind", [
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
    blocks: z.array(EntryBlockSchema),
    model: z.string().optional(),
    usage: TurnUsageSchema.optional(),
  }),
  z.object({
    ...identity,
    kind: z.literal("event"),
    label: z.string(),
    detail: z.string().optional(),
  }),
])
export const ThreadRefSchema = z.object({
  harness: z.string(),
  nativeId: z.string(),
  path: z.string(),
  cwd: z.string().optional(),
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
  archived: z.boolean().optional(),
  resumeUnavailable: z.string().optional(),
  lineage: z
    .array(z.object({ harness: z.string(), title: z.string().optional() }))
    .optional(),
  modelProvider: z.string().optional(),
  identity: z.string().optional(),
  liveResume: z.boolean().optional(),
  workspaceMissing: z.boolean().optional(),
  accessMode: z.string().optional(),
  heldBy: z.string().optional(),
  threadId: z.string().optional(),
  sessionId: z.string().optional(),
})
export const ThreadSchema = z.object({
  ref: ThreadRefSchema,
  entries: z.array(ThreadEntrySchema),
  checkpoint: z.number().nonnegative().optional(),
})
