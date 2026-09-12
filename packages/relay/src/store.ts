import type {
  RelayCompletion,
  RelayControl,
  RelayEventEnvelope,
  RelayJobPayload,
  RelayLease,
  RelayLegacyProgress,
  RemoteAttachment,
  RemoteOrigin,
  WorkerHeartbeat,
} from "./schema.js"

/**
 * What a remote thread remembers between jobs: the device that served it, the
 * local thread it continues, and the project it runs in. A mapping with only
 * `cwd` starts fresh in that project on the next message.
 */
export interface RelayThreadMapping {
  cwd?: string
  deviceId: string
  effort?: string
  fast?: boolean
  harness: string
  model?: string
  threadPath?: string
  updatedAt: string
}

export interface RelayWorkerRecord {
  tenantId: string
  deviceId: string
  defaultHarness: string
  defaultModel?: string
  deviceName: string
  lastSeenAt: string
  version: string
}

export interface RelayDeliveryState {
  payload: RelayJobPayload
  status: "pending" | "queued" | "claimed" | "completed" | "delivered" | "failed"
  streamClosed: boolean
  streamTs?: string
  streamedChars: number
}

export type RelayLeaseResult =
  | { kind: "empty" }
  | {
      kind: "completed"
      completion: RelayCompletion
      lease: Pick<RelayLease, "messageId" | "popReceipt">
      payload: RelayJobPayload
    }
  | { kind: "work"; lease: RelayLease }

export interface RelayArtifactTarget {
  payload: RelayJobPayload
  uploaded: boolean
}

export interface RelayProgressTarget extends RelayDeliveryState {
  accepted: boolean
}

export interface RelayStore {
  registerDevice(input: {
    tenantId: string
    deviceId: string
    deviceName: string
  }): Promise<string>
  deviceKey(tenantId: string, deviceId: string): Promise<Buffer | null>
  consumeTokenRequest(input: {
    tenantId: string
    deviceId: string
    nonce: string
    timestamp: number
  }): Promise<boolean>
  enqueue(
    payload: RelayJobPayload,
    targetDeviceId?: string
  ): Promise<{ created: boolean; jobId: string }>
  heartbeat(tenantId: string, heartbeat: WorkerHeartbeat): Promise<void>
  worker(tenantId: string, deviceId: string): Promise<RelayWorkerRecord | null>
  activeWorker(tenantId: string): Promise<RelayWorkerRecord | null>
  lease(input: {
    tenantId: string
    deviceId: string
    visibilityTimeoutSeconds: number
  }): Promise<RelayLeaseResult>
  renew(input: {
    deviceId: string
    jobId: string
    messageId: string
    popReceipt: string
    visibilityTimeoutSeconds: number
  }): Promise<string>
  recordCompletion(completion: RelayCompletion): Promise<RelayJobPayload>
  markDelivered(input: {
    completion: RelayCompletion
    payload: RelayJobPayload
  }): Promise<void>
  delivery(jobId: string): Promise<RelayDeliveryState>
  recordStream(input: {
    deviceId: string
    jobId: string
    streamTs: string
  }): Promise<void>
  recordStreamClosed(input: {
    deviceId: string
    jobId: string
  }): Promise<void>
  progressTarget(progress: RelayLegacyProgress): Promise<RelayProgressTarget>
  recordProgress(progress: RelayLegacyProgress): Promise<void>
  appendEvents(events: RelayEventEnvelope[]): Promise<void>
  eventsAfter(input: {
    jobId: string
    epoch?: string
    seq?: number
    limit?: number
  }): Promise<RelayEventEnvelope[]>
  queueStatus(origin: RemoteOrigin): Promise<{ queued: number; running: number }>
  requestStop(origin: RemoteOrigin): Promise<number>
  control(input: { deviceId: string; jobId: string }): Promise<RelayControl | null>
  attachment(input: {
    jobId: string
    attachmentId: string
    deviceId: string
  }): Promise<RemoteAttachment>
  artifactTarget(input: {
    artifactKey: string
    deviceId: string
    jobId: string
  }): Promise<RelayArtifactTarget>
  markArtifactUploaded(input: {
    artifactKey: string
    deviceId: string
    jobId: string
  }): Promise<void>
  thread(origin: RemoteOrigin): Promise<RelayThreadMapping | null>
  reconcile(tenantId: string): Promise<{ processed: number; failed: number }>
}
