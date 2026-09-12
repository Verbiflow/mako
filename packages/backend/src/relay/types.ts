import { RelayJobPayloadSchema as SharedRelayJobPayloadSchema } from "@mako/relay"
import { z } from "zod"

export {
  relayThreadMappingFromCompletion,
  RelayCanonicalEventSchema,
  RelayCompletionSchema,
  RelayControlPollSchema,
  RelayControlSchema,
  RelayCursorSchema,
  RelayEventBatchSchema,
  RelayEventEnvelopeSchema,
  RelayHarnessSchema,
  RelayLeaseRequestSchema,
  RelayLeaseSchema,
  RelayLegacyProgressSchema as RelayProgressSchema,
  RelayPresentationSchema,
  RelayRegistrationSchema,
  RelayRenewalSchema,
  RelayTokenClaimsSchema,
  RemoteAttachmentSchema,
  RemoteOriginSchema,
  RuntimeSelectionSchema,
  WorkerHeartbeatSchema,
} from "@mako/relay"
export type {
  RelayCanonicalEvent,
  RelayCompletion,
  RelayControl,
  RelayControlPoll,
  RelayCursor,
  RelayEventBatch,
  RelayEventEnvelope,
  RelayHarness,
  RelayJobPayload,
  RelayLease,
  RelayLeaseRequest,
  RelayLegacyProgress as RelayProgress,
  RelayPresentation,
  RelayRegistration,
  RelayRenewal,
  RelayTokenClaims,
  RemoteAttachment,
  RemoteOrigin,
  RuntimeSelection,
  WorkerHeartbeat,
} from "@mako/relay"

export const RelayJobPayloadSchema = SharedRelayJobPayloadSchema

export const LegacySlackOriginSchema = z.object({
  channel: z.string().min(1).max(160),
  eventId: z.string().min(1).max(160),
  teamId: z.string().min(1).max(80),
  threadTs: z.string().min(1).max(160),
  userId: z.string().min(1).max(80),
})

export function parseRelayJobPayload<Value>(value: Value) {
  const current = RelayJobPayloadSchema.safeParse(value)
  if (current.success) return current.data
  const record = z.record(z.string(), z.json()).parse(value)
  const slack = LegacySlackOriginSchema.parse(record.slack)
  return RelayJobPayloadSchema.parse({
    ...record,
    attachments: record.attachments ?? [],
    origin: {
      provider: "slack",
      tenantId: slack.teamId,
      conversationId: slack.channel,
      threadId: slack.threadTs,
      eventId: slack.eventId,
      userId: slack.userId,
    },
  })
}
