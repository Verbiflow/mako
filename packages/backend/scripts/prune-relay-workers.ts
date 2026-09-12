/**
 * Remove relay workers (and their registrations) that have not heartbeated
 * for a while. Development and test profiles used to register a fresh device
 * on every launch; they no longer do, but the rows they left behind make the
 * fleet unreadable.
 *
 * Dry run by default. Never removes a device a thread is still pinned to, or
 * one seen inside the window. Bounded to `--limit` removals per run.
 *
 *   node --env-file=.env.local --import tsx scripts/prune-relay-workers.ts
 *     [--tenant=<team id>] [--older-than=7d] [--limit=64] [--delete]
 */
import { parseArgs } from "node:util"
import { relayClients } from "../src/relay/storage"
import { pruneStaleWorkers, type RelayWorkerEntity } from "../src/relay/storage-presence"

const { values } = parseArgs({
  options: {
    tenant: { type: "string" },
    "older-than": { type: "string", default: "7d" },
    limit: { type: "string", default: "64" },
    delete: { type: "boolean", default: false },
  },
})

const tenantId = values.tenant ?? process.env.SLACK_TEAM_ID
if (!tenantId) {
  console.error("Pass --tenant=<team id> or set SLACK_TEAM_ID.")
  process.exit(2)
}
const olderThanMs = parseDuration(values["older-than"])
const limit = Number.parseInt(values.limit, 10)
if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
  console.error("--limit must be between 1 and 500.")
  process.exit(2)
}

const pinned = new Set<string>()
for await (const thread of relayClients().threads.listEntities<{ deviceId?: string }>()) {
  if (thread.deviceId) pinned.add(thread.deviceId)
}

const workers: RelayWorkerEntity[] = []
for await (const worker of relayClients().workers.listEntities<RelayWorkerEntity>({
  queryOptions: { filter: `PartitionKey eq 'workers:${tenantId}'` },
})) {
  workers.push(worker)
}
const cutoff = Date.now() - olderThanMs
const stale = workers.filter(
  (worker) => Date.parse(worker.lastSeenAt) < cutoff && !pinned.has(worker.rowKey)
)
console.log(
  `${workers.length} workers for ${tenantId}; ${stale.length} not seen for ${values["older-than"]} and not pinned by a thread; ${pinned.size} device(s) pinned.`
)
for (const worker of stale.slice(0, limit)) {
  console.log(
    `  ${values.delete ? "remove" : "would remove"} ${worker.rowKey} ${worker.deviceName} (last seen ${worker.lastSeenAt}, ${worker.version})`
  )
}
if (stale.length > limit) console.log(`  …and ${stale.length - limit} more beyond --limit=${limit}`)

if (!values.delete) {
  console.log("Dry run. Pass --delete to remove them.")
} else {
  const result = await pruneStaleWorkers({
    teamId: tenantId,
    olderThanMs,
    limit,
    pinnedDeviceIds: pinned,
  })
  console.log(`Removed ${result.removed.length} worker(s); ${result.kept} kept.`)
}

const DURATION_UNITS = new Map([
  ["s", 1_000],
  ["m", 60_000],
  ["h", 3_600_000],
  ["d", 86_400_000],
])

function parseDuration(text: string): number {
  const match = /^(\d+)([smhd])$/.exec(text)
  const unit = match ? DURATION_UNITS.get(match[2] ?? "") : undefined
  if (!match || unit === undefined) {
    console.error(`--older-than must look like 30m, 6h or 7d; got ${text}`)
    process.exit(2)
  }
  return Number(match[1]) * unit
}
