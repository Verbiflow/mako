import { z } from "zod"

export const RelayHarnessSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9._-]*$/)
export type RelayHarness = z.infer<typeof RelayHarnessSchema>

const RemoteIdSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9._:-]+$/)

export const RemoteOriginSchema = z.object({
  provider: RemoteIdSchema,
  tenantId: RemoteIdSchema,
  conversationId: RemoteIdSchema,
  threadId: RemoteIdSchema,
  eventId: RemoteIdSchema,
  userId: RemoteIdSchema,
})
export type RemoteOrigin = z.infer<typeof RemoteOriginSchema>

export const RemoteAttachmentSchema = z.object({
  id: z.string().min(1).max(160),
  kind: z.enum(["audio", "file", "image", "video"]),
  name: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(255).optional(),
  size: z
    .number()
    .int()
    .nonnegative()
    .max(100 * 1024 * 1024)
    .optional(),
})
export type RemoteAttachment = z.infer<typeof RemoteAttachmentSchema>

const WorkspacePathSchema = z.string().min(1).max(4_000)

export const RuntimeSelectionSchema = z.object({
  /** The project directory on the worker. Absent means the worker chooses. */
  cwd: WorkspacePathSchema.optional(),
  effort: z.string().min(1).max(80).optional(),
  fast: z.boolean().optional(),
  harness: RelayHarnessSchema.optional(),
  model: z.string().min(1).max(160).optional(),
})
export type RuntimeSelection = z.infer<typeof RuntimeSelectionSchema>

const PromptFields = {
  attachments: z.array(RemoteAttachmentSchema).max(20).default([]),
  text: z.string().max(20_000),
}

export const RelayJobPayloadSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("new"),
    forceNew: z.boolean().default(false),
    origin: RemoteOriginSchema,
    selection: RuntimeSelectionSchema,
    ...PromptFields,
  }),
  z.object({
    kind: z.literal("resume"),
    origin: RemoteOriginSchema,
    selection: RuntimeSelectionSchema,
    threadPath: z.string().min(1).max(4_000),
    ...PromptFields,
  }),
  z.object({
    kind: z.literal("resume-query"),
    origin: RemoteOriginSchema,
    query: z.string().min(1).max(500),
    selection: RuntimeSelectionSchema,
    ...PromptFields,
  }),
  z.object({
    kind: z.literal("inspect-threads"),
    origin: RemoteOriginSchema,
    query: z.string().max(500).optional(),
    selection: RuntimeSelectionSchema,
  }),
  z.object({
    kind: z.literal("inspect-models"),
    origin: RemoteOriginSchema,
    selection: RuntimeSelectionSchema,
  }),
  z.object({
    kind: z.literal("inspect-projects"),
    origin: RemoteOriginSchema,
    query: z.string().max(500).optional(),
    selection: RuntimeSelectionSchema,
  }),
  /**
   * Bind this remote thread to a local thread, a project, or both. With only
   * `selection.cwd` the next message starts fresh in that project.
   */
  z.object({
    kind: z.literal("configure"),
    origin: RemoteOriginSchema,
    selection: RuntimeSelectionSchema,
    threadPath: WorkspacePathSchema.optional(),
  }),
])
export type RelayJobPayload = z.infer<typeof RelayJobPayloadSchema>

export function parseRelayJobPayload<Value>(value: Value): RelayJobPayload {
  return RelayJobPayloadSchema.parse(value)
}

/** Where a worker runs. A cloud worker is the same loop in a container. */
export const RelayWorkerKindSchema = z.enum(["desktop", "cloud"])
export type RelayWorkerKind = z.infer<typeof RelayWorkerKindSchema>

/** What the worker is doing, as the gateway may tell the user. */
export const RelayWorkerActivitySchema = z.enum(["idle", "busy", "failing"])
export type RelayWorkerActivity = z.infer<typeof RelayWorkerActivitySchema>

/**
 * A heartbeat is the worker's presence and its sanitized state: the gateway
 * answers "is anything listening, and what is it doing" from this row alone,
 * never from transcripts. `generation` changes on every worker start so a
 * restarted worker is distinguishable from one that kept running.
 */
export const WorkerHeartbeatSchema = z.object({
  defaultHarness: RelayHarnessSchema,
  defaultModel: z.string().min(1).max(160).optional(),
  deviceId: z.uuid(),
  deviceName: z.string().min(1).max(160),
  version: z.string().min(1).max(80),
  kind: RelayWorkerKindSchema.optional(),
  generation: z.uuid().optional(),
  startedAt: z.iso.datetime().optional(),
  activity: RelayWorkerActivitySchema.optional(),
  currentJobId: z.uuid().optional(),
  /** The project a new request would run in, by name. */
  workspace: z.string().min(1).max(256).optional(),
})
export type WorkerHeartbeat = z.infer<typeof WorkerHeartbeatSchema>

export const RelayLeaseRequestSchema = WorkerHeartbeatSchema.extend({
  visibilityTimeoutSeconds: z.number().int().min(30).max(300).default(120),
})
export type RelayLeaseRequest = z.infer<typeof RelayLeaseRequestSchema>

/**
 * A renewal may carry the heartbeat too: a worker busy with a long job sends
 * no lease requests, and without this it looked offline while working.
 */
export const RelayRenewalSchema = z.object({
  deviceId: z.uuid(),
  jobId: z.uuid(),
  messageId: z.string().min(1),
  popReceipt: z.string().min(1),
  visibilityTimeoutSeconds: z.number().int().min(30).max(300).default(120),
  heartbeat: WorkerHeartbeatSchema.optional(),
})
export type RelayRenewal = z.infer<typeof RelayRenewalSchema>

export const RelayLeaseSchema = z.object({
  jobId: z.uuid(),
  messageId: z.string().min(1),
  payload: RelayJobPayloadSchema,
  popReceipt: z.string().min(1),
})
export type RelayLease = z.infer<typeof RelayLeaseSchema>

export const RelayLegacyProgressSchema = z.object({
  deviceId: z.uuid(),
  jobId: z.uuid(),
  sequence: z.number().int().positive(),
  text: z.string().min(1).max(11_000),
})
export type RelayLegacyProgress = z.infer<typeof RelayLegacyProgressSchema>

export const RelayControlPollSchema = z.object({
  deviceId: z.uuid(),
  jobId: z.uuid(),
})
export type RelayControlPoll = z.infer<typeof RelayControlPollSchema>

export const RelayControlSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("stop") }),
  z.object({
    kind: z.literal("permission"),
    requestId: z.string().min(1).max(160),
    optionId: z.string().min(1).max(160),
  }),
])
export type RelayControl = z.infer<typeof RelayControlSchema>

export const RelayPresentationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("threads"),
    items: z
      .array(
        z.object({
          harness: RelayHarnessSchema,
          path: z.string().min(1).max(4_000),
          title: z.string().min(1).max(256),
        })
      )
      .max(15),
  }),
  z.object({
    kind: z.literal("models"),
    harness: RelayHarnessSchema,
    items: z
      .array(
        z.object({
          id: z.string().min(1).max(160),
          label: z.string().min(1).max(160),
        })
      )
      .max(100),
  }),
  z.object({
    kind: z.literal("projects"),
    items: z
      .array(
        z.object({
          name: z.string().min(1).max(256),
          path: WorkspacePathSchema,
        })
      )
      .max(15),
  }),
])
export type RelayPresentation = z.infer<typeof RelayPresentationSchema>

export const RelayCompletionSchema = z.object({
  /** The project the work ran in; the gateway remembers it for the thread. */
  cwd: WorkspacePathSchema.optional(),
  deviceId: z.uuid(),
  effort: z.string().min(1).max(80).optional(),
  fast: z.boolean().optional(),
  harness: RelayHarnessSchema,
  jobId: z.uuid(),
  messageId: z.string().min(1),
  model: z.string().min(1).max(160).optional(),
  popReceipt: z.string().min(1),
  presentation: RelayPresentationSchema.optional(),
  progressFailed: z.boolean().default(false),
  result: z.string().min(1).max(1_000_000),
  status: z.enum(["done", "failed", "stopped"]).default("done"),
  threadPath: z.string().min(1).max(4_000).optional(),
})
export type RelayCompletion = z.infer<typeof RelayCompletionSchema>

export const RelayCursorSchema = z.object({
  epoch: z.uuid(),
  seq: z.number().int().nonnegative(),
})
export type RelayCursor = z.infer<typeof RelayCursorSchema>

export const RelayPlanStatusSchema = z.enum([
  "pending",
  "in_progress",
  "completed",
  "failed",
  "canceled",
])

const RelayPlanEntrySchema = z.object({
  id: z.string().min(1).max(160),
  title: z.string().min(1).max(256),
  status: RelayPlanStatusSchema,
})

const RelayPermissionOptionSchema = z.object({
  id: z.string().min(1).max(160),
  label: z.string().min(1).max(256),
  kind: z.string().max(80).optional(),
})

export const RelayCanonicalEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string().min(1).max(32_000) }),
  z.object({
    kind: z.literal("reasoning"),
    id: z.string().min(1).max(160),
    title: z.string().min(1).max(256).default("Reasoning"),
    status: z.enum(["in_progress", "completed"]),
    detail: z.string().max(2_000).optional(),
  }),
  z.object({
    kind: z.literal("tool"),
    id: z.string().min(1).max(160),
    title: z.string().min(1).max(256),
    status: z.enum([
      "pending",
      "in_progress",
      "completed",
      "failed",
      "canceled",
    ]),
    detail: z.string().max(2_000).optional(),
    output: z.string().max(4_000).optional(),
  }),
  z.object({
    kind: z.literal("plan"),
    id: z.string().min(1).max(160),
    title: z.string().min(1).max(256),
    entries: z.array(RelayPlanEntrySchema).max(100),
  }),
  z.object({
    kind: z.literal("permission"),
    id: z.string().min(1).max(160),
    title: z.string().min(1).max(256),
    options: z.array(RelayPermissionOptionSchema).max(20),
  }),
  z.object({
    kind: z.literal("lifecycle"),
    status: z.enum([
      "queued",
      "starting",
      "running",
      "suspended",
      "completed",
      "failed",
      "stopped",
    ]),
    detail: z.string().max(2_000).optional(),
  }),
])
export type RelayCanonicalEvent = z.infer<typeof RelayCanonicalEventSchema>

export const RelayEventEnvelopeSchema = z.object({
  version: z.literal(1),
  eventId: z.uuid(),
  jobId: z.uuid(),
  workerId: z.uuid(),
  cursor: RelayCursorSchema,
  jobSeq: z.number().int().positive(),
  at: z.iso.datetime(),
  event: RelayCanonicalEventSchema,
})
export type RelayEventEnvelope = z.infer<typeof RelayEventEnvelopeSchema>

export const RelayEventBatchSchema = z
  .object({
    deviceId: z.uuid(),
    jobId: z.uuid(),
    cursor: RelayCursorSchema.optional(),
    events: z.array(RelayEventEnvelopeSchema).min(1).max(100),
  })
  .superRefine((batch, context) => {
    if (
      batch.events.some(
        (event) =>
          event.jobId !== batch.jobId || event.workerId !== batch.deviceId
      )
    )
      context.addIssue({
        code: "custom",
        message: "Relay event batch ownership does not match its envelope",
      })
    const last = batch.events.at(-1)?.cursor
    if (
      batch.cursor &&
      (last?.epoch !== batch.cursor.epoch || last.seq !== batch.cursor.seq)
    )
      context.addIssue({
        code: "custom",
        message: "Relay event batch cursor does not match its final event",
      })
  })
export type RelayEventBatch = z.infer<typeof RelayEventBatchSchema>

export const RelayRegistrationSchema = z.object({
  tenantId: z.string().min(1).max(80),
  deviceId: z.uuid(),
  deviceName: z.string().min(1).max(160),
  defaultHarness: RelayHarnessSchema,
  defaultModel: z.string().min(1).max(160).optional(),
})
export type RelayRegistration = z.infer<typeof RelayRegistrationSchema>

export const RelayTokenClaimsSchema = z.object({
  version: z.literal(1),
  tenantId: z.string().min(1).max(80),
  deviceId: z.uuid(),
  scopes: z.array(z.enum(["relay:read", "relay:write"])).min(1),
  issuedAt: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
})
export type RelayTokenClaims = z.infer<typeof RelayTokenClaimsSchema>

export const RelayTokenRequestSchema = z.object({
  tenantId: z.string().min(1).max(80),
  deviceId: z.uuid(),
  nonce: z.uuid(),
  timestamp: z.number().int().positive(),
  signature: z.string().min(40).max(128),
})
export type RelayTokenRequest = z.infer<typeof RelayTokenRequestSchema>

export const RelayTokenResponseSchema = z.object({
  token: z.string().min(80),
  expiresAt: z.number().int().positive(),
})
export type RelayTokenResponse = z.infer<typeof RelayTokenResponseSchema>

export const RelayRegistrationResponseSchema = z.object({
  tenantId: z.string().min(1).max(80),
  deviceId: z.uuid(),
  deviceSecret: z.string().min(64),
})
export type RelayRegistrationResponse = z.infer<
  typeof RelayRegistrationResponseSchema
>
