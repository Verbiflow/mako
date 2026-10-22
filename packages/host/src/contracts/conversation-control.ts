import { LiveQuestionSchema } from "./live-questions.js"
import { ApprovalResponseSchema, NativeApprovalDecisionSchema, NativeApprovalIdentitySchema, sameNativeApproval } from "./approval-response.js"
import { SessionSettingsSchema } from "@mako/sessions/settings"
import { z } from "zod"
import { ExecutionContextSchema } from "./execution-context.js"
import { LiveActionSchema } from "./live-actions.js"
import { PromptAttachmentSchema } from "./prompt-attachments.js"
import { PROVIDER_FAILURE_KINDS } from "./provider-failure.js"
import { MessageAnchorSchema } from "./message-anchor.js"
import { ActorSchema } from "./thread-identity.js"
import { INTERRUPTION_REASONS } from "./live-conversations.js"
import { OutdatedRestoreSchema, type OutdatedRestore } from "./restore-plan.js"
export { PromptAttachmentSchema } from "./prompt-attachments.js"

export const ProviderSelectionSchema = SessionSettingsSchema
export const TransferInputSchema = z.object({
  bindingId: z.string().uuid().optional(),
  id: z.string().uuid(),
  provider: z.string().min(1),
  text: z.string().max(1_000_000),
  displayText: z.string().max(1_000_000).optional(),
  attachments: z.array(PromptAttachmentSchema).max(100),
  tuning: ProviderSelectionSchema.optional(),
  modeId: z.string().optional(),
})
export type TransferInput = z.infer<typeof TransferInputSchema>
/** A harness's running totals for one native session, as `NativeTotals`. */
export const NativeTotalsSchema = z.object({
  tokens: z.object({ input: z.number(), cacheRead: z.number(), cacheWrite: z.number(), output: z.number(), reasoning: z.number().optional() }),
  cost: z.number().nonnegative().optional(),
})
export const ProviderBindingSchema = z.object({
  executionContext: ExecutionContextSchema.optional(),
  checkpoint: z.string().optional(),
  id: z.string().uuid(),
  provider: z.string(),
  nativeId: z.string().optional(),
  path: z.string().optional(),
  tuning: ProviderSelectionSchema.optional(),
  modeId: z.string().optional(),
  coveredBlocks: z.number().int().nonnegative(),
  includesBase: z.boolean(),
  /**
   * The conversation Mako wrote into this native session's store to start it,
   * tool calls as text: the first `native` entries the store reads back as,
   * with their `historyDigest`, are the conversation's first `entries`.
   * A seed without `unit` counted messages, each prompt, marker or reply one,
   * as entries were grouped before 2026-10-15 (`withSeed`).
   */
  seeded: z.object({
    native: z.number().int().nonnegative(),
    entries: z.number().int().nonnegative(),
    digest: z.string(),
    unit: z.literal("entry").optional(),
  }).optional(),
  /** The native session's own totals when the conversation last moved off it, for a resume that restores them. */
  nativeUsage: NativeTotalsSchema.optional(),
  /**
   * It opened a native session that already had its records (a resume, as a Thread arriving from another device
   * does): its provider can close and the same session open again before it runs a turn here.
   */
  resumed: z.literal(true).optional(),
})
export type ProviderBinding = z.infer<typeof ProviderBindingSchema>

/**
 * Whether a saved binding's native session may be picked up again, with
 * ownership and content answered separately. A record that `moved` past the
 * binding's checkpoint is still the same unowned session — the turn Mako
 * lost when its host died finished writing, or the CLI continued it — and a
 * reconnect may go on from it; only a provider switch that reuses an old
 * binding insists on `same`, because it sends context from that point.
 */
export type ResumeVerdict =
  | { kind: "resumable"; record: "same" | "moved" | "unknown" }
  /** Something else has the session open; `by` names it for the user. */
  | { kind: "held"; by: string }
  | { kind: "unavailable"; reason: string }
  /**
   * The harness keeps this record closed to resumes (a Codex archive, a
   * Cursor desktop chat) and the catalog says so; continuing it starts a new
   * session of the same harness from the conversation, the record untouched.
   * `outdated`: the records are Mako's, and the harness installed here is
   * older than the version that wrote them, so they weren't restored; an
   * update makes the same resume native.
   */
  | { kind: "closed"; reason: string; outdated?: OutdatedRestore }

/** An absent baseline permits no claim that native history is unchanged. */
export function compareNativeCheckpoint(previous: string | undefined, current: string): "same" | "moved" | "unknown" {
  return previous === undefined ? "unknown" : previous === current ? "same" : "moved"
}

export function resumable(verdict: ResumeVerdict, record: "same" | "moved" = "moved"): boolean {
  return verdict.kind === "resumable" && (record === "moved" || verdict.record === "same")
}
export const ContextManifestSchema = z.object({
  file: z.string(),
  resources: z.array(z.string()).optional(),
  digest: z.string(),
  sourceRevision: z.number().int().nonnegative(),
  fromBlock: z.number().int().nonnegative(),
  toBlock: z.number().int().nonnegative(),
  includesBase: z.boolean(),
  losses: z.array(z.string()),
  /** How many turns the transcript carries; absent on manifests from before it was counted. */
  turns: z.number().int().nonnegative().optional(),
  /** The harnesses that wrote the carried turns, in the order they first appear. */
  from: z.array(z.string()).optional(),
  /**
   * Why a harness that could have resumed its own session was given the
   * transcript instead: Mako keeps that session's records, and the version
   * installed here is older than the one that wrote them (`restoreGate`).
   */
  outdated: OutdatedRestoreSchema.optional(),
})
export type ContextManifest = z.infer<typeof ContextManifestSchema>
export const TransferStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("queued") }),
  z.object({ kind: z.literal("preparing") }),
  z.object({
    kind: z.literal("accepted"),
    bindingId: z.string().uuid(),
    /** The history as a transcript, sent with the request. */
    manifest: ContextManifestSchema,
    /**
     * How an earlier build carried it: `native` when it wrote the history into
     * the destination's own store, which no build does now; absent or
     * `transcript` otherwise. Kept so journals from then read as they were.
     */
    carried: z.enum(["native", "transcript"]).optional(),
    /** Why an earlier build's requested native carry went as transcript instead. */
    fallback: z.string().optional(),
    /** Why the harness could not fork this session itself, so the fork was carried into a new session instead. */
    nativeForkDeclined: z.string().optional(),
  }),
  z.object({
    kind: z.literal("failed"),
    error: z.string(),
    /** What `error` means; see `provider-failure.ts`. */
    failure: z.enum(PROVIDER_FAILURE_KINDS).optional(),
  }),
  z.object({ kind: z.literal("uncertain"), error: z.string() }),
])
export const ContextTransferSchema = z.object({
  inputDigest: z.string().optional(),
  input: TransferInputSchema,
  /** Who asked for the handoff; kept beside the caller's input, never read from it. */
  actor: ActorSchema.optional(),
  /** The cut-short turn a reconnect carries on, set by the host and never by the caller. */
  continues: z.object({
    requestId: z.string(),
    reason: z.enum(INTERRUPTION_REASONS),
    auto: z.boolean(),
  }).optional(),
  createdAt: z.number(),
  state: TransferStateSchema,
})
export type ContextTransfer = z.infer<typeof ContextTransferSchema>
export const ConversationControlSchema = z.object({
  questions: z.array(LiveQuestionSchema).max(2000).optional(),
  approvalResponses: z.array(ApprovalResponseSchema).optional(),
  // Native questions and later resolutions, independent of local answer intents.
  approvalObservations: z.array(z.object({ bindingId: z.string(), identity: NativeApprovalIdentitySchema, decision: NativeApprovalDecisionSchema.optional() })
    .refine(item => !item.decision || sameNativeApproval(item.identity, item.decision.identity), "Native decision belongs to another question")).max(2000).optional(),
  actions: z.array(LiveActionSchema).optional(),
  merges: z
    .array(
      z.object({
        id: z.string().uuid(),
        sourceId: z.string().uuid(),
        sourceRevision: z.number(),
        manifest: ContextManifestSchema,
        status: z.enum(["pending", "consumed"]),
      })
    )
    .default([]),
  ancestry: z
    .object({
      kind: z.literal("fork"),
      nativeFork: z
        .object({
          provider: z.string(),
          nativeId: z.string(),
          runId: z.string(),
          /** The source session's native store, for a harness that checks whether it can fork it (`NativeFork.declines`). */
          path: z.string().optional(),
          /** Messages sent into the run while it ran (`NativeForkSource.steers`). */
          steers: z.number().int().positive().optional(),
        })
        .optional(),
      provider: z.string().optional(),
      parentId: z.string().uuid(),
      sourceRevision: z.number().int().nonnegative(),
      point: z.string(),
      /** A fork made with this set joins its parent's Thread as a tab. Older forks have their own Thread. */
      placement: z.literal("parent-thread").optional(),
    })
    .optional(),
  /** The Thread-store Session this journal was started in (a `+` tab), recorded before the first commit. */
  session: z.string().uuid().optional(),
  activeBindingId: z.string().uuid(),
  bindings: z.array(ProviderBindingSchema),
  transfers: z.array(ContextTransferSchema),
})
export type ConversationControl = z.infer<typeof ConversationControlSchema>

/** The answer a fork goes on from: a live turn's, the prompt before one, or a saved answer by its place and identity. */
export const ForkPointSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("run"), requestId: z.string().uuid() }),
  z.object({ kind: z.literal("before-run"), requestId: z.string().uuid() }),
  z.object({
    kind: z.literal("native"),
    index: z.number().int().nonnegative(),
    revision: z.string(),
    /**
     * The chosen answer's own identity. When the store moved since
     * `revision` was read, the host finds the answer by it instead of
     * refusing; absent, a moved store is refused as before.
     */
    anchor: MessageAnchorSchema.optional(),
  }),
])

export const ForkInputSchema = z.object({
  id: z.string().uuid(),
  provider: z.string().min(1),
  point: ForkPointSchema,
  /** Where the fork's Session goes. Absent means its parent's Thread, the default since track A3. */
  thread: z.enum(["parent", "new"]).optional(),
  /** The fork runs in a new worktree of its parent's checkout, and the checkout's uncommitted changes move there. */
  worktree: z.boolean().optional(),
  /** The Session moves rather than branches off, so the fork keeps its parent's title. */
  move: z.boolean().optional(),
})
export type ForkInput = z.infer<typeof ForkInputSchema>
