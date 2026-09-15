import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LiveConversations } from "../electron/live-conversations.ts"
import { RelayConversations } from "../electron/relay-conversations.ts"
import type { ProviderLiveDriver } from "../electron/providers/live-driver.ts"
import type { LiveSessionState } from "../electron/shared.ts"
import type { RelayCanonicalEvent } from "@mako/relay"

const root = await mkdtemp(join(tmpdir(), "mako-relay-conversations-"))
const sessions = new Map<string, LiveSessionState>()
const dispatches: string[] = []
const permissions: string[] = []
const cancellations: string[] = []
function driver(provider: string): ProviderLiveDriver {
  return {
    provider,
    canResume: false,
    available: () => true,
    async start(cwd, options) {
      const session: LiveSessionState = {
        id: options.conversationId,
        harness: provider,
        nativeId: randomUUID(),
        cwd,
        status: "ready",
        connection: "connected",
        modes: [],
        currentMode: null,
        configOptions: [],
      }
      sessions.set(session.id, session)
      return session
    },
    async prompt(id) {
      const session = sessions.get(id)
      assert.ok(session)
      dispatches.push(id)
      owner.observe({
        type: "live-session",
        session: { ...session, status: "running" },
      })
    },
    async permission(_id, requestId) {
      permissions.push(requestId)
    },
    async cancel(id) {
      cancellations.push(id)
      finish(id)
    },
    close() {},
    async setMode() {},
  }
}
const drivers = new Map(
  [driver("alpha"), driver("beta")].map((driver) => [driver.provider, driver])
)
const owner = new LiveConversations({
  root,
  appPath: root,
  driver: (provider) => drivers.get(provider),
  history: async () => null,
  emit() {},
})
const relay = new RelayConversations(owner, join(root, "remote-assets"))
const events: RelayCanonicalEvent[] = []
const signal = new AbortController().signal
async function until(predicate: () => boolean) {
  const end = Date.now() + 5_000
  while (!predicate()) {
    if (Date.now() > end) throw new Error("Fixture deadline exceeded")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
function finish(id: string, text = "completed fixture") {
  const session = sessions.get(id)
  assert.ok(session)
  owner.observe({
    type: "live-update",
    id,
    update: { kind: "text", id: randomUUID(), text },
  })
  owner.observe({
    type: "live-session",
    session: { ...session, status: "ready" },
  })
}
try {
  const jobId = randomUUID()
  const first = {
    jobId,
    provider: "alpha",
    cwd: root,
    text: "First remote request",
    attachments: [],
    tuning: {},
    signal,
    emit: (event: RelayCanonicalEvent) => events.push(event),
  }
  const pending = relay.execute(first)
  await until(() => dispatches.length === 1)
  owner.observe({
    type: "live-permission",
    request: {
      id: "permission",
      sessionId: jobId,
      title: "Fixture permission",
      options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }],
    },
  })
  await until(() => events.some((event) => event.kind === "permission"))
  await relay.control(randomUUID(), {
    kind: "permission",
    requestId: "permission",
    optionId: "allow",
  })
  assert.deepEqual(permissions, [])
  await relay.control(jobId, {
    kind: "permission",
    requestId: "permission",
    optionId: "allow",
  })
  assert.deepEqual(permissions, ["permission"])
  owner.observe({
    type: "live-update",
    id: jobId,
    update: { kind: "thinking", id: "thought", text: "Check the fixture" },
  })
  owner.observe({
    type: "live-update",
    id: jobId,
    update: {
      kind: "plan",
      entries: [
        { content: "Check the fixture", priority: "high", status: "completed" },
      ],
    },
  })
  finish(jobId, "first remote proof")
  const completed = await pending
  assert.equal(completed.status, "done")
  assert.ok(
    events.some(
      (event) => event.kind === "reasoning" && event.status === "completed"
    )
  )
  assert.ok(events.some((event) => event.kind === "plan"))
  assert.equal(completed.result, "first remote proof")
  assert.equal(relay.ref(completed.threadPath!)?.harness, "alpha")
  assert.equal((await relay.execute(first)).result, completed.result)
  assert.equal(
    dispatches.length,
    1,
    "completed remote receipts never execute again"
  )
  const secondId = randomUUID()
  const second = relay.execute({
    ...first,
    jobId: secondId,
    sourcePath: completed.threadPath,
    provider: "beta",
    text: "Switch remotely",
  })
  await until(() => dispatches.length === 2)
  finish(dispatches[1]!, "second remote proof")
  assert.equal((await second).threadPath, completed.threadPath)
  assert.equal(owner.snapshot(jobId)?.session.harness, "beta")
  const localId = randomUUID()
  owner.submit(jobId, localId, "Local task remains active")
  await until(() => dispatches.length === 3)
  const queuedId = randomUUID()
  const controller = new AbortController()
  const queued = relay.execute({
    ...first,
    jobId: queuedId,
    sourcePath: completed.threadPath,
    provider: "alpha",
    signal: controller.signal,
  })
  await until(
    () =>
      owner
        .snapshot(jobId)
        ?.control?.transfers.some(
          (transfer) => transfer.input.id === queuedId
        ) ?? false
  )
  controller.abort()
  assert.equal((await queued).status, "stopped")
  assert.deepEqual(
    cancellations,
    [],
    "canceling a queued remote job must not interrupt the active local task"
  )
  assert.equal(
    owner.snapshot(jobId)?.requests.find((request) => request.id === localId)
      ?.status,
    "dispatching"
  )
  finish(dispatches[2]!)
  assert.equal(dispatches.length, 3)
  console.log(
    "Remote conversations: shared identity, exact receipts, provider switch, scoped permissions, and cancellation without interrupting another request"
  )
} finally {
  owner.stop()
  await rm(root, { recursive: true, force: true })
}
