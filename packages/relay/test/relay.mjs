import assert from "node:assert/strict"
import {
  HeadlessRelayWorker,
  RELAY_ACTIVE_POLL_MS,
  RELAY_ACTIVE_WINDOW_MS,
  RELAY_IDLE_POLL_MAX_MS,
  RelayCompletionSchema,
  RelayEventBatchSchema,
  RelayEventSequencer,
  RelayRenewalSchema,
  applyRelayThreadMapping,
  createMemoryRelayStore,
  parseRelayJobPayload,
  relayDeviceKey,
  relayEventsAfter,
  relayIdleDelay,
  relayThreadMappingFromCompletion,
  signRelayToken,
  signRelayTokenRequest,
  verifyRelayToken,
  verifyRelayTokenRequest,
} from "../dist/index.js"

const origin = {
  provider: "slack",
  tenantId: "TTEST",
  conversationId: "CTEST",
  threadId: "123.456",
  eventId: "event-1",
  userId: "UTEST",
}
const deviceSecret = "device-secret".padEnd(64, "x")
const tokenSecret = "token-secret".padEnd(64, "x")
const tokenRequest = {
  tenantId: origin.tenantId,
  deviceId: crypto.randomUUID(),
  nonce: crypto.randomUUID(),
  timestamp: Date.now(),
}
const requestWithSignature = {
  ...tokenRequest,
  signature: signRelayTokenRequest(tokenRequest, deviceSecret),
}
assert.equal(verifyRelayTokenRequest(requestWithSignature, deviceSecret), true)
assert.equal(
  verifyRelayTokenRequest(
    { ...requestWithSignature, signature: requestWithSignature.signature.slice(1) },
    deviceSecret
  ),
  false
)
const nowSeconds = Math.floor(Date.now() / 1_000)
const relayToken = signRelayToken(
  {
    version: 1,
    tenantId: origin.tenantId,
    deviceId: tokenRequest.deviceId,
    scopes: ["relay:read", "relay:write"],
    issuedAt: nowSeconds,
    expiresAt: nowSeconds + 300,
  },
  tokenSecret
)
assert.equal(verifyRelayToken(relayToken, tokenSecret)?.deviceId, tokenRequest.deviceId)
assert.equal(verifyRelayToken(`${relayToken}x`, tokenSecret), null)

const payload = parseRelayJobPayload({
  kind: "new",
  forceNew: false,
  origin,
  selection: { harness: "codex" },
  text: "Inspect",
})
assert.equal(payload.origin.conversationId, "CTEST")
assert.throws(() =>
  parseRelayJobPayload({
    ...payload,
    origin: { ...origin, conversationId: "channel' or 1 eq 1" },
  })
)
const workerId = crypto.randomUUID()
const epoch = crypto.randomUUID()
const jobId = crypto.randomUUID()
const sequencer = new RelayEventSequencer(workerId, epoch)
const first = sequencer.next(jobId, { kind: "lifecycle", status: "starting" })
const second = sequencer.next(jobId, {
  kind: "tool",
  id: "tool-1",
  title: "Read file",
  status: "in_progress",
})
assert.equal(first.jobSeq, 1)
assert.equal(second.jobSeq, 2)
assert.deepEqual(relayEventsAfter([second, first], first.cursor), [second])
assert.throws(() =>
  RelayEventBatchSchema.parse({
    deviceId: workerId,
    jobId,
    cursor: second.cursor,
    events: [{ ...second, jobId: crypto.randomUUID() }],
  })
)

const lease = {
  jobId,
  messageId: "message-1",
  payload,
  popReceipt: "receipt-1",
}
const batches = []
const completions = []
const worker = new HeadlessRelayWorker(
  {
    async lease() {
      return lease
    },
    async renew(current) {
      return current.popReceipt
    },
    async sendEvents(batch) {
      batches.push(batch)
    },
    async control() {
      return null
    },
    async complete(completion) {
      completions.push(completion)
    },
  },
  {
    async execute(_lease, context) {
      context.emit({ kind: "reasoning", id: "reasoning", status: "in_progress" })
      context.emit({
        kind: "tool",
        id: "tool-1",
        title: "Read file",
        status: "completed",
      })
      context.emit({ kind: "text", text: "Done" })
      return {
        harness: "codex",
        result: "Done",
        status: "done",
        threadPath: "/thread",
      }
    },
  },
  {
    heartbeat: () => ({
      defaultHarness: "codex",
      deviceId: workerId,
      deviceName: "test-worker",
      version: "test",
    }),
    eventFlushMs: 0,
  }
)
assert.equal(await worker.runOnce(), true)
assert.equal(completions.length, 1)
assert.equal(completions[0].status, "done")
assert.deepEqual(
  batches.flatMap((batch) => batch.events).map((entry) => entry.event.kind),
  ["lifecycle", "reasoning", "tool", "text", "lifecycle"]
)

const failedWorker = new HeadlessRelayWorker(worker.transport, {
  async execute() { throw new Error("provider refused startup") },
}, worker.options)
assert.equal(await failedWorker.runOnce(), true)
assert.equal(completions.at(-1).status, "failed")
assert.equal(completions.at(-1).result, "provider refused startup")

// Heartbeats carry the worker's own state: a host-supplied function for the
// moving parts (workspace), the worker's generation, and busy/idle activity.
// Renewals carry the same heartbeat so a long job never looks offline.
{
  let workspace = "pi-ui"
  const renewals = []
  const leases = []
  const busyWorker = new HeadlessRelayWorker(
    {
      ...worker.transport,
      async lease(request) {
        leases.push(request)
        return lease
      },
      async renew(current, request) {
        renewals.push(request)
        return current.popReceipt
      },
    },
    {
      async execute() {
        await new Promise((resolve) => setTimeout(resolve, 30))
        return { harness: "codex", result: "ok", status: "done" }
      },
    },
    {
      heartbeat: () => ({
        defaultHarness: "codex",
        deviceId: workerId,
        deviceName: "test-worker",
        version: "test",
        kind: "desktop",
        workspace,
      }),
      eventFlushMs: 0,
      renewIntervalMs: 5,
    }
  )
  const before = busyWorker.heartbeat()
  assert.equal(before.activity, "idle")
  assert.equal(before.workspace, "pi-ui")
  assert.match(before.generation, /^[0-9a-f-]{36}$/)
  workspace = "other"
  assert.equal(await busyWorker.runOnce(), true)
  assert.equal(leases[0].workspace, "other")
  assert.equal(leases[0].kind, "desktop")
  assert.ok(renewals.length >= 1, "a renewal ran during the job")
  assert.equal(renewals[0].activity, "busy")
  assert.equal(renewals[0].currentJobId, lease.jobId)
  assert.equal(renewals[0].generation, before.generation)
  assert.ok(RelayRenewalSchema.safeParse({
    deviceId: workerId,
    jobId: lease.jobId,
    messageId: lease.messageId,
    popReceipt: lease.popReceipt,
    heartbeat: renewals[0],
  }).success)
  const after = busyWorker.heartbeat()
  assert.equal(after.activity, "idle")
  assert.equal(after.currentJobId, undefined)
  assert.equal(after.generation, before.generation)
}

const memory = createMemoryRelayStore({ failEnqueue: 1 })
const memoryDevice = crypto.randomUUID()
const registeredSecret = await memory.registerDevice({
  tenantId: origin.tenantId,
  deviceId: memoryDevice,
  deviceName: "memory-worker",
})
assert.deepEqual(
  await memory.deviceKey(origin.tenantId, memoryDevice),
  relayDeviceKey(registeredSecret)
)
const tokenTimestamp = Date.now()
assert.equal(
  await memory.consumeTokenRequest({
    tenantId: origin.tenantId,
    deviceId: memoryDevice,
    nonce: crypto.randomUUID(),
    timestamp: tokenTimestamp,
  }),
  true
)
assert.equal(
  await memory.consumeTokenRequest({
    tenantId: origin.tenantId,
    deviceId: memoryDevice,
    nonce: crypto.randomUUID(),
    timestamp: tokenTimestamp,
  }),
  false
)
await memory.heartbeat(origin.tenantId, {
  defaultHarness: "codex",
  deviceId: memoryDevice,
  deviceName: "memory-worker",
  version: "test",
})
const firstQueued = await memory.enqueue({
  ...payload,
  origin: { ...origin, eventId: "memory-first" },
})
assert.equal((await memory.lease({
  tenantId: origin.tenantId,
  deviceId: memoryDevice,
  visibilityTimeoutSeconds: 60,
})).kind, "empty")
assert.deepEqual(await memory.reconcile(origin.tenantId), {
  processed: 1,
  failed: 0,
})
const firstLease = await memory.lease({
  tenantId: origin.tenantId,
  deviceId: memoryDevice,
  visibilityTimeoutSeconds: 60,
})
assert.equal(firstLease.kind, "work")
if (firstLease.kind !== "work") throw new Error("first memory lease missing")
assert.equal(
  await memory.requestStop({ ...origin, eventId: "memory-first" }),
  1
)
assert.deepEqual(
  await memory.control({ deviceId: memoryDevice, jobId: firstQueued.jobId }),
  { kind: "stop" }
)
assert.equal(
  await memory.control({ deviceId: memoryDevice, jobId: firstQueued.jobId }),
  null
)
const secondQueued = await memory.enqueue({
  ...payload,
  origin: { ...origin, eventId: "memory-second" },
})
assert.equal((await memory.lease({
  tenantId: origin.tenantId,
  deviceId: crypto.randomUUID(),
  visibilityTimeoutSeconds: 60,
})).kind, "empty")
const firstCompletion = {
  deviceId: memoryDevice,
  harness: "codex",
  jobId: firstQueued.jobId,
  messageId: firstLease.lease.messageId,
  popReceipt: firstLease.lease.popReceipt,
  progressFailed: false,
  result: "first done",
  status: "done",
  threadPath: "/native/thread",
}
const firstPayload = await memory.recordCompletion(firstCompletion)
await memory.markDelivered({ completion: firstCompletion, payload: firstPayload })
const secondLease = await memory.lease({
  tenantId: origin.tenantId,
  deviceId: memoryDevice,
  visibilityTimeoutSeconds: 60,
})
assert.equal(secondLease.kind, "work")
if (secondLease.kind !== "work") throw new Error("second memory lease missing")
assert.equal(secondLease.lease.jobId, secondQueued.jobId)
assert.equal(secondLease.lease.payload.kind, "resume")
if (secondLease.lease.payload.kind === "resume")
  assert.equal(secondLease.lease.payload.threadPath, "/native/thread")

// Projects: the payload, the presentation, and a mapping that names only a
// project (no session yet) still shapes the next `new` request.
const inspectProjects = parseRelayJobPayload({
  kind: "inspect-projects",
  origin,
  query: "ui",
  selection: { harness: "codex" },
})
assert.equal(inspectProjects.kind, "inspect-projects")
assert.equal(
  RelayCompletionSchema.parse({
    cwd: "/Users/me/pi-ui",
    deviceId: memoryDevice,
    harness: "codex",
    jobId: crypto.randomUUID(),
    messageId: "m",
    popReceipt: "p",
    presentation: {
      kind: "projects",
      items: [{ name: "pi-ui", path: "/Users/me/pi-ui" }],
    },
    result: "ok",
    status: "done",
  }).presentation.kind,
  "projects"
)
const projectOnly = relayThreadMappingFromCompletion(
  {
    cwd: "/Users/me/pi-ui",
    deviceId: memoryDevice,
    harness: "codex",
    jobId: crypto.randomUUID(),
    messageId: "m",
    model: "gpt-5.6",
    popReceipt: "p",
    result: "ok",
    status: "done",
  },
  "2026-09-11T00:00:00.000Z"
)
assert.deepEqual(projectOnly, {
  cwd: "/Users/me/pi-ui",
  deviceId: memoryDevice,
  effort: undefined,
  fast: undefined,
  harness: "codex",
  model: "gpt-5.6",
  threadPath: undefined,
  updatedAt: "2026-09-11T00:00:00.000Z",
})
assert.equal(
  relayThreadMappingFromCompletion(
    {
      deviceId: memoryDevice,
      harness: "codex",
      jobId: crypto.randomUUID(),
      messageId: "m",
      popReceipt: "p",
      result: "listing",
      status: "done",
    },
    "2026-09-11T00:00:00.000Z"
  ),
  null,
  "a listing teaches the thread nothing"
)
const carried = applyRelayThreadMapping(
  { kind: "new", forceNew: false, attachments: [], origin, selection: {}, text: "go" },
  projectOnly
)
assert.equal(carried.kind, "new", "no session to resume")
assert.equal(carried.selection.cwd, "/Users/me/pi-ui")
assert.equal(carried.selection.model, "gpt-5.6")
const explicitCwd = applyRelayThreadMapping(
  {
    kind: "new",
    forceNew: true,
    attachments: [],
    origin,
    selection: { cwd: "/Users/me/other" },
    text: "go",
  },
  { ...projectOnly, threadPath: "/native/thread" }
)
assert.equal(explicitCwd.kind, "new")
assert.equal(explicitCwd.selection.cwd, "/Users/me/other", "an explicit cwd wins")

// Idle polling backs off; activity brings it back to one second.
assert.equal(relayIdleDelay(0, 0), RELAY_ACTIVE_POLL_MS)
assert.equal(relayIdleDelay(50, RELAY_ACTIVE_WINDOW_MS - 1), RELAY_ACTIVE_POLL_MS)
assert.equal(relayIdleDelay(50, RELAY_ACTIVE_WINDOW_MS * 10), RELAY_IDLE_POLL_MAX_MS)
assert.ok(
  relayIdleDelay(1, RELAY_ACTIVE_WINDOW_MS * 10) <
    relayIdleDelay(4, RELAY_ACTIVE_WINDOW_MS * 10)
)

// A lease failure is reported and backed off, never swallowed.
{
  const failures = []
  const statuses = []
  let attempts = 0
  const failing = new HeadlessRelayWorker(
    {
      lease: async () => {
        attempts += 1
        throw new Error("lease returned 401")
      },
      renew: async () => {},
      recordEvents: async () => ({ accepted: 0 }),
      control: async () => null,
      complete: async () => {},
      heartbeat: async () => {},
    },
    { control: async () => {}, execute: async () => ({ harness: "codex", result: "" }) },
    {
      heartbeat: () => ({ defaultHarness: "codex", deviceId: memoryDevice, deviceName: "test", version: "0" }),
      idleDelay: () => 1,
      onFailure: (failure) => failures.push(failure),
      onStatus: (status) => statuses.push(status),
    }
  )
  failing.start()
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(failing.status().phase, "backoff")
  await failing.stop()
  assert.equal(attempts, 1, "a failing lease waits out its backoff")
  assert.equal(failures.length, 1)
  assert.equal(failures[0].phase, "lease")
  assert.equal(failures[0].message, "lease returned 401")
  assert.equal(failing.status().consecutiveFailures, 1)
  assert.equal(failing.status().lastFailure.phase, "lease")
  assert.ok(statuses.some((status) => status.phase === "backoff"))
  assert.equal(failing.status().phase, "stopped", "stop resolves after the loop exits")
}

console.log("relay schemas, auth, cursors, worker, memory store, projects, status, and reconciliation passed")
