import { randomBytes } from "node:crypto"
import { type TableEntity } from "@azure/data-tables"
import { relayDeviceKey } from "@mako/relay"
import type { WorkerHeartbeat } from "./types"
import { relayClients, statusCode } from "./storage"

export interface RelayWorkerEntity extends TableEntity {
  defaultHarness: string
  defaultModel?: string
  deviceName: string
  lastSeenAt: string
  version: string
  /** `desktop` or `cloud`; absent from workers older than this field. */
  kind?: string
  /** Changes on every worker start; equal across heartbeats of one run. */
  generation?: string
  startedAt?: string
  /** `idle`, `busy` or `failing`, as the worker last reported. */
  activity?: string
  currentJobId?: string
  /** The project a new request would run in, by name. */
  workspace?: string
}

interface RelayRegistrationEntity extends TableEntity {
  deviceKey: string
  deviceName: string
  lastTokenNonce?: string
  lastTokenTimestamp?: number
  registeredAt: string
}

export async function registerRelayDevice({
  tenantId,
  deviceId,
  deviceName,
}: {
  tenantId: string
  deviceId: string
  deviceName: string
}): Promise<string> {
  const deviceSecret = randomBytes(48).toString("base64url")
  const entity: RelayRegistrationEntity = {
    partitionKey: `registrations:${tenantId}`,
    rowKey: deviceId,
    deviceKey: relayDeviceKey(deviceSecret).toString("base64url"),
    deviceName,
    registeredAt: new Date().toISOString(),
  }
  await relayClients().registrations.createEntity(entity)
  return deviceSecret
}

export async function relayDeviceKeyFor(
  tenantId: string,
  deviceId: string
): Promise<Buffer | null> {
  try {
    const entity = await relayClients().registrations.getEntity<RelayRegistrationEntity>(
      `registrations:${tenantId}`,
      deviceId
    )
    return Buffer.from(entity.deviceKey, "base64url")
  } catch (error) {
    if (error instanceof Error && statusCode(error) === 404) return null
    throw error
  }
}

export async function consumeRelayTokenRequest({
  tenantId,
  deviceId,
  nonce,
  timestamp,
}: {
  tenantId: string
  deviceId: string
  nonce: string
  timestamp: number
}): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const entity = await relayClients().registrations.getEntity<RelayRegistrationEntity>(
      `registrations:${tenantId}`,
      deviceId
    )
    if (timestamp <= (entity.lastTokenTimestamp ?? 0)) return false
    try {
      await relayClients().registrations.updateEntity(
        {
          partitionKey: `registrations:${tenantId}`,
          rowKey: deviceId,
          lastTokenNonce: nonce,
          lastTokenTimestamp: timestamp,
        },
        "Merge",
        { etag: entity.etag }
      )
      return true
    } catch (error) {
      if (!(error instanceof Error) || statusCode(error) !== 412 || attempt === 2)
        throw error
    }
  }
  return false
}

export async function heartbeatWorker({
  heartbeat,
  teamId,
}: {
  heartbeat: WorkerHeartbeat
  teamId: string
}): Promise<void> {
  const entity: RelayWorkerEntity = {
    partitionKey: `workers:${teamId}`,
    rowKey: heartbeat.deviceId,
    defaultHarness: heartbeat.defaultHarness,
    defaultModel: heartbeat.defaultModel,
    deviceName: heartbeat.deviceName,
    lastSeenAt: new Date().toISOString(),
    version: heartbeat.version,
    kind: heartbeat.kind,
    generation: heartbeat.generation,
    startedAt: heartbeat.startedAt,
    activity: heartbeat.activity,
    currentJobId: heartbeat.currentJobId,
    workspace: heartbeat.workspace,
  }
  await relayClients().workers.upsertEntity(entity, "Replace")
}

export const WORKER_ONLINE_WINDOW_MS = 45_000

/** A worker is online when it heartbeated within the last 45 seconds. */
export function workerIsOnline(worker: RelayWorkerEntity): boolean {
  return Date.parse(worker.lastSeenAt) >= Date.now() - WORKER_ONLINE_WINDOW_MS
}

/**
 * Remove workers that have not been seen for `olderThanMs` along with their
 * registrations, unless a thread is still pinned to them. Bounded to `limit`
 * removals per call; a device that comes back registers again on its own.
 */
export async function pruneStaleWorkers({
  teamId,
  olderThanMs,
  limit = 64,
  pinnedDeviceIds,
  now = Date.now(),
}: {
  teamId: string
  olderThanMs: number
  limit?: number
  pinnedDeviceIds: ReadonlySet<string>
  now?: number
}): Promise<{ removed: string[]; kept: number }> {
  const cutoff = now - olderThanMs
  const clients = relayClients()
  const removed: string[] = []
  let kept = 0
  for await (const worker of clients.workers.listEntities<RelayWorkerEntity>({
    queryOptions: { filter: `PartitionKey eq 'workers:${teamId}'` },
  })) {
    const stale = Date.parse(worker.lastSeenAt) < cutoff
    if (!stale || pinnedDeviceIds.has(worker.rowKey)) {
      kept += 1
      continue
    }
    if (removed.length >= limit) {
      kept += 1
      continue
    }
    await clients.workers.deleteEntity(worker.partitionKey, worker.rowKey)
    await clients.registrations
      .deleteEntity(`registrations:${teamId}`, worker.rowKey)
      .catch((error) => {
        if (error instanceof Error && statusCode(error) === 404) return
        throw error
      })
    removed.push(worker.rowKey)
  }
  return { removed, kept }
}

/** The worker's last known record, online or not; null when never seen. */
export async function workerRecord(
  teamId: string,
  deviceId: string
): Promise<RelayWorkerEntity | null> {
  try {
    return await relayClients().workers.getEntity<RelayWorkerEntity>(
      `workers:${teamId}`,
      deviceId
    )
  } catch (error) {
    if (error instanceof Error && statusCode(error) === 404) return null
    throw error
  }
}

export async function workerById(
  teamId: string,
  deviceId: string
): Promise<RelayWorkerEntity | null> {
  const worker = await workerRecord(teamId, deviceId)
  return worker && workerIsOnline(worker) ? worker : null
}

/**
 * The worker a new, unpinned request would most likely reach: an idle one
 * before a busy or failing one, then the most recently seen.
 */
export async function activeWorker(
  teamId: string
): Promise<RelayWorkerEntity | null> {
  let best: RelayWorkerEntity | null = null
  for await (const worker of relayClients().workers.listEntities<RelayWorkerEntity>({
    queryOptions: { filter: `PartitionKey eq 'workers:${teamId}'` },
  })) {
    if (!workerIsOnline(worker)) continue
    if (!best || workerRank(worker) > workerRank(best)) best = worker
    else if (
      workerRank(worker) === workerRank(best) &&
      worker.lastSeenAt > best.lastSeenAt
    )
      best = worker
  }
  return best
}

function workerRank(worker: RelayWorkerEntity): number {
  if (worker.activity === "failing") return 0
  if (worker.activity === "busy") return 1
  return 2
}
