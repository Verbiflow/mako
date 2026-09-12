import { randomBytes, randomUUID } from "node:crypto"
import { relayDeviceKey } from "./auth.js"
import { relayEventsAfter } from "./events.js"
import { deterministicRelayJobId } from "./ids.js"
import {
  RelayCompletionSchema,
  RelayEventEnvelopeSchema,
  RelayJobPayloadSchema,
  RelayLegacyProgressSchema,
  WorkerHeartbeatSchema,
  parseRelayJobPayload,
  type RelayCompletion,
  type RelayControl,
  type RelayEventEnvelope,
  type RelayJobPayload,
  type RemoteOrigin,
} from "./schema.js"
import type {
  RelayDeliveryState,
  RelayStore,
  RelayThreadMapping,
  RelayWorkerRecord,
} from "./store.js"

interface MemoryJob {
  payload: RelayJobPayload
  status: RelayDeliveryState["status"]
  targetDeviceId?: string
  workerId?: string
  messageId: string
  popReceipt: string
  visibleAt: number
  completion?: RelayCompletion
  streamTs?: string
  streamClosed: boolean
  streamedChars: number
  lastProgressSequence: number
  control: RelayControl | null
  uploadedArtifacts: Set<string>
}

interface OutboxEntry {
  kind: "enqueue" | "delete"
  jobId: string
  tenantId: string
}

export interface MemoryRelayStoreOptions {
  failEnqueue?: number
  failDelete?: number
  now?: () => number
}

function originKey(origin: RemoteOrigin): string {
  return `${origin.provider}\0${origin.tenantId}\0${origin.conversationId}\0${origin.threadId}`
}

/**
 * Fold what the remote thread remembers into a new-message job. A plain
 * message continues the mapped local thread; `new` keeps the project but
 * starts fresh; an explicit selection on the message always wins.
 */
export function applyRelayThreadMapping(
  payload: RelayJobPayload,
  mapping: Pick<
    RelayThreadMapping,
    "cwd" | "effort" | "fast" | "harness" | "model" | "threadPath"
  > | null
): RelayJobPayload {
  if (payload.kind !== "new" || !mapping) return payload
  const selection = {
    cwd: payload.selection.cwd ?? mapping.cwd,
    effort: payload.selection.effort ?? mapping.effort,
    fast: payload.selection.fast ?? mapping.fast,
    harness: payload.selection.harness ?? mapping.harness,
    model: payload.selection.model ?? mapping.model,
  }
  if (payload.forceNew || !mapping.threadPath)
    return RelayJobPayloadSchema.parse({ ...payload, selection })
  return RelayJobPayloadSchema.parse({
    kind: "resume",
    attachments: payload.attachments,
    origin: payload.origin,
    selection,
    text: payload.text,
    threadPath: mapping.threadPath,
  })
}

/**
 * What a completed job leaves behind for the thread, or `null` when it
 * settled nothing: a failed lookup, a list, a stop before any thread existed.
 * A run records both its thread and its project; a project selection records
 * only the project so the next message starts fresh there.
 */
export function relayThreadMappingFromCompletion(
  completion: RelayCompletion,
  at: string
): RelayThreadMapping | null {
  if (!completion.threadPath && !completion.cwd) return null
  return {
    cwd: completion.cwd,
    deviceId: completion.deviceId,
    effort: completion.effort,
    fast: completion.fast,
    harness: completion.harness,
    model: completion.model,
    threadPath: completion.threadPath,
    updatedAt: at,
  }
}

export function createMemoryRelayStore(
  options: MemoryRelayStoreOptions = {}
): RelayStore {
  const now = options.now ?? Date.now
  let failEnqueue = options.failEnqueue ?? 0
  let failDelete = options.failDelete ?? 0
  const jobs = new Map<string, MemoryJob>()
  const queue: string[] = []
  const outbox = new Map<string, OutboxEntry>()
  const workers = new Map<string, RelayWorkerRecord>()
  const registrations = new Map<string, Buffer>()
  const tokenRequests = new Map<string, { nonce: string; timestamp: number }>()
  const threads = new Map<string, RelayThreadMapping>()
  const events = new Map<string, RelayEventEnvelope>()

  const registrationKey = (tenantId: string, deviceId: string) =>
    `${tenantId}\0${deviceId}`
  const workerKey = registrationKey

  const enqueueMessage = (jobId: string) => {
    if (failEnqueue > 0) {
      failEnqueue -= 1
      throw new Error("injected queue failure")
    }
    if (!queue.includes(jobId)) queue.push(jobId)
    const job = jobs.get(jobId)
    if (job) job.status = "queued"
  }

  const deleteMessage = (jobId: string) => {
    if (failDelete > 0) {
      failDelete -= 1
      throw new Error("injected delete failure")
    }
    const index = queue.indexOf(jobId)
    if (index >= 0) queue.splice(index, 1)
  }

  const ownedJob = (jobId: string, deviceId: string): MemoryJob => {
    const job = jobs.get(jobId)
    if (!job || job.status !== "claimed" || job.workerId !== deviceId)
      throw new Error("Relay job is not owned by this device")
    return job
  }

  const store: RelayStore = {
    async registerDevice(input) {
      const key = registrationKey(input.tenantId, input.deviceId)
      if (registrations.has(key)) throw new Error("Relay device is already registered")
      const secret = randomBytes(48).toString("base64url")
      registrations.set(key, relayDeviceKey(secret))
      return secret
    },

    async deviceKey(tenantId, deviceId) {
      return registrations.get(registrationKey(tenantId, deviceId)) ?? null
    },

    async consumeTokenRequest(input) {
      const key = registrationKey(input.tenantId, input.deviceId)
      if (!registrations.has(key)) return false
      const current = tokenRequests.get(key)
      if (current && input.timestamp <= current.timestamp) return false
      tokenRequests.set(key, { nonce: input.nonce, timestamp: input.timestamp })
      return true
    },

    async enqueue(input, targetDeviceId) {
      const payload = parseRelayJobPayload(input)
      const jobId = deterministicRelayJobId(payload.origin.eventId)
      if (jobs.has(jobId)) return { created: false, jobId }
      jobs.set(jobId, {
        payload,
        status: "pending",
        targetDeviceId,
        messageId: randomUUID(),
        popReceipt: randomUUID(),
        visibleAt: now(),
        streamClosed: false,
        streamedChars: 0,
        lastProgressSequence: 0,
        control: null,
        uploadedArtifacts: new Set(),
      })
      const outboxId = `enqueue:${jobId}`
      outbox.set(outboxId, { kind: "enqueue", jobId, tenantId: payload.origin.tenantId })
      try {
        enqueueMessage(jobId)
        outbox.delete(outboxId)
      } catch {
        return { created: true, jobId }
      }
      return { created: true, jobId }
    },

    async heartbeat(tenantId, heartbeat) {
      const parsed = WorkerHeartbeatSchema.parse(heartbeat)
      workers.set(workerKey(tenantId, parsed.deviceId), {
        tenantId,
        deviceId: parsed.deviceId,
        defaultHarness: parsed.defaultHarness,
        defaultModel: parsed.defaultModel,
        deviceName: parsed.deviceName,
        lastSeenAt: new Date(now()).toISOString(),
        version: parsed.version,
      })
    },

    async worker(tenantId, deviceId) {
      const worker = workers.get(workerKey(tenantId, deviceId)) ?? null
      return worker && Date.parse(worker.lastSeenAt) >= now() - 45_000
        ? worker
        : null
    },

    async activeWorker(tenantId) {
      let found: RelayWorkerRecord | null = null
      for (const worker of workers.values()) {
        if (worker.tenantId !== tenantId || Date.parse(worker.lastSeenAt) < now() - 45_000)
          continue
        if (!found || worker.lastSeenAt > found.lastSeenAt) found = worker
      }
      return found
    },

    async lease(input) {
      for (const jobId of queue) {
        const job = jobs.get(jobId)
        if (!job || job.payload.origin.tenantId !== input.tenantId) continue
        if (job.targetDeviceId && job.targetDeviceId !== input.deviceId) continue
        if (job.status === "delivered") {
          deleteMessage(jobId)
          continue
        }
        if (job.status === "completed" && job.completion)
          return {
            kind: "completed",
            completion: job.completion,
            lease: { messageId: job.messageId, popReceipt: job.popReceipt },
            payload: job.payload,
          }
        if (job.status !== "queued" || job.visibleAt > now()) continue
        const sameOriginRunning = [...jobs.entries()].some(
          ([candidateId, candidate]) =>
            candidateId !== jobId &&
            candidate.status === "claimed" &&
            originKey(candidate.payload.origin) === originKey(job.payload.origin)
        )
        if (sameOriginRunning) continue
        const mapping = threads.get(originKey(job.payload.origin)) ?? null
        job.payload = applyRelayThreadMapping(job.payload, mapping)
        job.status = "claimed"
        job.workerId = input.deviceId
        job.popReceipt = randomUUID()
        job.visibleAt = now() + input.visibilityTimeoutSeconds * 1_000
        return {
          kind: "work",
          lease: {
            jobId,
            messageId: job.messageId,
            payload: job.payload,
            popReceipt: job.popReceipt,
          },
        }
      }
      return { kind: "empty" }
    },

    async renew(input) {
      const job = ownedJob(input.jobId, input.deviceId)
      if (job.messageId !== input.messageId || job.popReceipt !== input.popReceipt)
        throw new Error("Relay lease receipt is stale")
      job.popReceipt = randomUUID()
      job.visibleAt = now() + input.visibilityTimeoutSeconds * 1_000
      return job.popReceipt
    },

    async recordCompletion(input) {
      const completion = RelayCompletionSchema.parse(input)
      const current = jobs.get(completion.jobId)
      if (
        current &&
        (current.status === "completed" || current.status === "delivered") &&
        current.workerId === completion.deviceId
      )
        return current.payload
      const job = ownedJob(completion.jobId, completion.deviceId)
      if (
        job.messageId !== completion.messageId ||
        job.popReceipt !== completion.popReceipt
      )
        throw new Error("Relay completion does not own the active lease")
      job.completion = completion
      job.status = "completed"
      return job.payload
    },

    async markDelivered({ completion, payload }) {
      const job = jobs.get(completion.jobId)
      if (!job || job.workerId !== completion.deviceId)
        throw new Error("Relay result is not ready for delivery")
      if (job.status === "delivered") return
      const mapping = relayThreadMappingFromCompletion(
        completion,
        new Date(now()).toISOString()
      )
      if (mapping) threads.set(originKey(payload.origin), mapping)
      job.status = "delivered"
      const outboxId = `delete:${completion.jobId}`
      outbox.set(outboxId, {
        kind: "delete",
        jobId: completion.jobId,
        tenantId: payload.origin.tenantId,
      })
      try {
        deleteMessage(completion.jobId)
        outbox.delete(outboxId)
      } catch {
        return
      }
    },

    async delivery(jobId) {
      const job = jobs.get(jobId)
      if (!job) throw new Error("Relay job was not found")
      return {
        payload: job.payload,
        status: job.status,
        streamClosed: job.streamClosed,
        streamTs: job.streamTs,
        streamedChars: job.streamedChars,
      }
    },

    async recordStream(input) {
      const job = ownedJob(input.jobId, input.deviceId)
      job.streamTs ??= input.streamTs
    },

    async recordStreamClosed(input) {
      const job = jobs.get(input.jobId)
      if (!job || job.workerId !== input.deviceId)
        throw new Error("Relay stream is not owned by this device")
      job.streamClosed = true
    },

    async progressTarget(input) {
      const progress = RelayLegacyProgressSchema.parse(input)
      const job = ownedJob(progress.jobId, progress.deviceId)
      return {
        accepted: progress.sequence > job.lastProgressSequence,
        payload: job.payload,
        status: job.status,
        streamClosed: job.streamClosed,
        streamTs: job.streamTs,
        streamedChars: job.streamedChars,
      }
    },

    async recordProgress(input) {
      const progress = RelayLegacyProgressSchema.parse(input)
      const job = ownedJob(progress.jobId, progress.deviceId)
      if (progress.sequence <= job.lastProgressSequence) return
      job.lastProgressSequence = progress.sequence
      job.streamedChars += progress.text.length
    },

    async appendEvents(input) {
      for (const event of input.map((value) => RelayEventEnvelopeSchema.parse(value)))
        events.set(event.eventId, event)
    },

    async eventsAfter(input) {
      return relayEventsAfter(
        [...events.values()].filter((event) => event.jobId === input.jobId),
        input.epoch ? { epoch: input.epoch, seq: input.seq ?? 0 } : undefined
      ).slice(0, input.limit ?? 100)
    },

    async queueStatus(origin) {
      let queued = 0
      let running = 0
      for (const job of jobs.values()) {
        if (originKey(job.payload.origin) !== originKey(origin)) continue
        if (job.status === "pending" || job.status === "queued") queued += 1
        if (job.status === "claimed") running += 1
      }
      return { queued, running }
    },

    async requestStop(origin) {
      let count = 0
      for (const job of jobs.values()) {
        if (
          job.status === "claimed" &&
          originKey(job.payload.origin) === originKey(origin)
        ) {
          job.control = { kind: "stop" }
          count += 1
        }
      }
      return count
    },

    async control(input) {
      const job = ownedJob(input.jobId, input.deviceId)
      const control = job.control
      job.control = null
      return control
    },

    async attachment(input) {
      const job = ownedJob(input.jobId, input.deviceId)
      if (!("attachments" in job.payload))
        throw new Error("Relay job has no attachments")
      const attachment = job.payload.attachments.find(
        (candidate) => candidate.id === input.attachmentId
      )
      if (!attachment) throw new Error("Relay attachment does not belong to this job")
      return attachment
    },

    async artifactTarget(input) {
      const job = ownedJob(input.jobId, input.deviceId)
      return {
        payload: job.payload,
        uploaded: job.uploadedArtifacts.has(input.artifactKey),
      }
    },

    async markArtifactUploaded(input) {
      ownedJob(input.jobId, input.deviceId).uploadedArtifacts.add(input.artifactKey)
    },

    async thread(origin) {
      return threads.get(originKey(origin)) ?? null
    },

    async reconcile(tenantId) {
      let processed = 0
      let failed = 0
      for (const [id, entry] of outbox) {
        if (entry.tenantId !== tenantId) continue
        try {
          if (entry.kind === "enqueue") enqueueMessage(entry.jobId)
          else deleteMessage(entry.jobId)
          outbox.delete(id)
          processed += 1
        } catch {
          failed += 1
        }
      }
      return { processed, failed }
    },
  }
  return store
}
