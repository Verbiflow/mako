import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mock } from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { nativeCheckpoint } from "../electron/native-continuation.ts"
import { LiveConversations } from "../electron/live-conversations.js"
import { LiveJournal } from "../electron/live-journal.js"
import { reduceLiveUpdates } from "../electron/contracts/live-content.js"
import type { LiveActionInput } from "../electron/contracts/live-actions.js"
import type { LiveSessionState } from "../electron/shared.js"
import type {
  ProviderLiveDriver,
  ProviderSteerResult,
} from "../electron/providers/live-driver.js"

const root = mkdtempSync(join(tmpdir(), "mako-live-actions-"))
const states = new Map<string, LiveSessionState>()
const sent: string[] = []
let steeringCalls = 0
let compactionCalls = 0
let compactionId: string | undefined
let answer: () => Promise<ProviderSteerResult> = async () => ({
  kind: "accepted",
})
const driver: ProviderLiveDriver = {
  provider: "fixture",
  canResume: true,
  steering: "step",
  available: () => true,
  async start(cwd, options) {
    const state: LiveSessionState = {
      id: options.conversationId,
      nativeId: "native-fixture",
      harness: "fixture",
      cwd,
      status: "ready",
      connection: "connected",
      modes: [],
      currentMode: null,
      configOptions: [],
    }
    states.set(state.id, state)
    return state
  },
  async prompt(id, text) {
    sent.push(text)
    const state = states.get(id)
    assert.ok(state)
    const running: LiveSessionState = {
      ...state,
      status: "running",
      nativeRunId: randomUUID(),
    }
    states.set(id, running)
    owner.observe({ type: "live-session", session: running })
  },
  async steer(id, input) {
    steeringCalls++
    assert.equal(input.expectedRunId, states.get(id)?.nativeRunId)
    return answer()
  },
  compaction: { kind: "supported", async start(id, actionId) {
    compactionCalls++
    compactionId = actionId
    const state = states.get(id)
    assert.ok(state)
    const running: LiveSessionState = {
      ...state,
      status: "running",
      nativeRunId: randomUUID(),
    }
    states.set(id, running)
    owner.observe({ type: "live-session", session: running })
  } },
  async permission() {},
  async cancel() {},
  async setMode() {},
  close() {},
}
const dependencies = {
  root: join(root, "journals"),
  appPath: root,
  driver: () => driver,
  history: async () => null,
  emit: () => {},
}
let owner = new LiveConversations(dependencies)
const id = randomUUID()
async function connected(conversationId: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (owner.snapshot(conversationId)?.session.connection === "connected") return
    await delay(10)
  }
  assert.fail("Fixture provider did not connect")
}
function finish() {
  const state = states.get(id)
  assert.ok(state)
  const ready: LiveSessionState = { ...state, status: "ready" }
  states.set(id, ready)
  owner.observe({ type: "live-session", session: ready })
}
function steering(requestId: string): LiveActionInput {
  return {
    kind: "steer",
    id: randomUUID(),
    requestId,
    text: "Keep the existing API",
    attachments: [],
  }
}
try {
  await owner.start("fixture", root, { conversationId: id })
  await connected(id)
  const first = randomUUID()
  owner.submit(id, first, "first")
  const receipt = Promise.withResolvers<ProviderSteerResult>()
  answer = () => receipt.promise
  const input = steering(first)
  const pending = owner.act(id, input)
  assert.equal(steeringCalls, 1)
  assert.equal((await owner.act(id, input)).state.kind, "dispatching")
  assert.equal(steeringCalls, 1, "double-click never writes twice")
  await assert.rejects(
    owner.act(id, { ...input, kind: "compact" }),
    /different input/
  )
  const second = randomUUID()
  owner.submit(id, second, "second")
  finish()
  assert.deepEqual(
    sent,
    ["first"],
    "terminal event cannot drain a queue ahead of the steering receipt"
  )
  receipt.resolve({ kind: "accepted" })
  assert.equal((await pending).state.kind, "accepted")
  assert.deepEqual(sent, ["first", "second"])
  assert.equal(
    owner
      .snapshot(id)
      ?.blocks.filter(
        (block) => block.type === "user" && block.steeringFor === first
      ).length,
    1
  )
  assert.equal((await owner.act(id, input)).state.kind, "accepted")
  assert.equal(steeringCalls, 1)
  console.log(
    "PASS: exact active turn, durable duplicate receipt, changed-ID rejection, and queue/receipt ordering"
  )

  const failed = steering(second)
  const commit = mock.method(LiveJournal.prototype, "commit", () => {
    throw new Error("disk full")
  })
  await assert.rejects(owner.act(id, failed), /disk full/)
  commit.mock.restore()
  assert.equal(steeringCalls, 1, "a failed intent save never dispatches")
  answer = async () => {
    throw new Error("response lost after write")
  }
  const uncertain = steering(second)
  assert.equal((await owner.act(id, uncertain)).state.kind, "uncertain")
  assert.equal(steeringCalls, 2)
  owner.stop()
  owner = new LiveConversations(dependencies)
  assert.equal((await owner.act(id, uncertain)).state.kind, "uncertain")
  assert.equal(steeringCalls, 2, "restart cannot resend an uncertain action")
  await owner.acknowledgeAction(id, uncertain.id)
  assert.equal(
    owner.snapshot(id)?.control?.actions?.at(-1)?.state.kind,
    "acknowledged"
  )
  console.log(
    "PASS: pre-dispatch storage failure and restart preserve uncertain steering without replay"
  )

  const compactOwner = new LiveConversations({
    ...dependencies,
    root: join(root, "compact-journals"),
  })
  owner.stop()
  owner = compactOwner
  await owner.start("fixture", root, { conversationId: id })
  await connected(id)
  const failedRequest = randomUUID()
  owner.submit(id, failedRequest, "Exceeds the context window")
  await assert.rejects(
    owner.act(id, { kind: "compact", id: randomUUID() }),
    /Wait for the conversation/
  )
  const failedState = states.get(id)
  assert.ok(failedState)
  const contextFailure: LiveSessionState = {
    ...failedState,
    status: "failed",
    error: "Context window exceeded",
  }
  states.set(id, contextFailure)
  owner.observe({ type: "live-session", session: contextFailure })
  assert.equal(
    owner.snapshot(id)?.requests.find((request) => request.id === failedRequest)?.status,
    "failed"
  )
  const compact: LiveActionInput = { kind: "compact", id: randomUUID() }
  assert.equal((await owner.act(id, compact)).state.kind, "accepted")
  const before = sent.length
  owner.submit(id, randomUUID(), "after compaction")
  assert.equal(sent.length, before)
  finish()
  assert.equal(sent.length, before, "idle is not evidence that compaction finished")
  owner.observe({ type: "live-action-result", id, actionId: randomUUID(), result: { kind: "completed" } })
  assert.equal(sent.length, before, "an unrelated action cannot release the queue")
  assert.ok(compactionId)
  owner.observe({ type: "live-action-result", id, actionId: compactionId, result: { kind: "completed" } })
  assert.equal(
    owner.snapshot(id)?.control?.actions?.at(-1)?.state.kind,
    "completed"
  )
  assert.equal(sent.at(-1), "after compaction")
  assert.equal((await owner.act(id, compact)).state.kind, "completed")
  assert.equal(compactionCalls, 1)
  console.log(
    "PASS: compaction recovers a failed session, waits for completion before draining, and never repeats on retry"
  )
  finish()
  const failedCompact: LiveActionInput = { kind: "compact", id: randomUUID() }
  await owner.act(id, failedCompact)
  const heldRequest = randomUUID()
  owner.submit(id, heldRequest, "Do not run after failed compaction")
  const compactState = states.get(id)
  assert.ok(compactState)
  owner.observe({ type: "live-session", session: { ...compactState, status: "failed", error: "Compaction failed" } })
  owner.observe({ type: "live-action-result", id, actionId: failedCompact.id, result: { kind: "failed", reason: "Compaction failed" } })
  assert.equal(owner.snapshot(id)?.requests.find((request) => request.id === heldRequest)?.status, "held")
  assert.equal(owner.snapshot(id)?.control?.actions?.at(-1)?.state.kind, "failed")
  const interruptedCompact: LiveActionInput = { kind: "compact", id: randomUUID() }
  await owner.act(id, interruptedCompact)
  const dispatched = compactionCalls
  owner.stop()
  owner = new LiveConversations({ ...dependencies, root: join(root, "compact-journals") })
  assert.equal((await owner.act(id, interruptedCompact)).state.kind, "uncertain")
  assert.equal(compactionCalls, dispatched, "restart cannot repeat compaction")
  console.log("PASS: failed compaction holds queued work; restart preserves an unknown outcome without replay")

  for (const ended of [
    { status: "ready", connection: "connected", lastStop: "cancelled" },
    { status: "failed", connection: "connected", error: "Provider failed" },
    { status: "ready", connection: "disconnected" },
  ] as const) {
    owner.stop()
    owner = new LiveConversations({ ...dependencies, root: join(root, randomUUID()) })
    await owner.start("fixture", root, { conversationId: id })
    await connected(id)
    const requestId = randomUUID()
    owner.submit(id, requestId, "turn that will end without a steering receipt")
    const late = Promise.withResolvers<ProviderSteerResult>()
    answer = () => late.promise
    const action = steering(requestId)
    const pendingAction = owner.act(id, action)
    const queuedId = randomUUID()
    owner.submit(id, queuedId, "preserve this follow-up")
    const before = sent.length
    const state = states.get(id)
    assert.ok(state)
    owner.observe({ type: "live-session", session: { ...state, ...ended } })
    assert.equal(owner.snapshot(id)?.control?.actions?.at(-1)?.state.kind, "uncertain")
    assert.equal(owner.snapshot(id)?.requests.find(request => request.id === queuedId)?.status, "held")
    assert.deepEqual(owner.lifecycleWork(), [], "An ended turn and paused queue do not prevent restart")
    assert.equal(sent.length, before, "Settling an unknown steer must not replay queued work")
    late.resolve({ kind: "accepted" })
    assert.equal((await pendingAction).state.kind, "uncertain", "A late receipt cannot release an interrupted queue")
    assert.equal(sent.length, before)
    await owner.acknowledgeAction(id, action.id)
    assert.equal(sent.length, before, "Acknowledgement preserves the paused queue")
  }
  console.log("PASS: cancelled, failed and disconnected turns settle unconfirmed steering, retain queued input and release lifecycle work")

  const blocks = reduceLiveUpdates(
    [],
    [
      { kind: "user", requestId: first, text: "initial" },
      { kind: "tool", id: "tool", title: "Edit", status: "running" },
      { kind: "text", id: "answer", text: "before " },
      {
        kind: "user",
        requestId: input.id,
        steeringFor: first,
        text: "steering",
      },
      { kind: "tool-update", id: "tool", status: "completed", output: "saved" },
      { kind: "text", id: "answer", text: "after" },
    ]
  )
  assert.ok(
    blocks.some(
      (block) =>
        block.type === "tool" &&
        block.output === "saved" &&
        block.status === "completed"
    )
  )
  assert.equal(blocks.filter((block) => block.type === "text").length, 1)
  assert.ok(
    blocks.some(
      (block) => block.type === "text" && block.text === "before after"
    )
  )
  console.log(
    "PASS: steering preserves in-flight tool results and streamed message identity"
  )
  owner.stop()
  const nativePath = join(root, "native.jsonl")
  writeFileSync(nativePath, "before shutdown")
  const exit = Promise.withResolvers<void>()
  let discoveredPath: string | undefined
  const closingDriver: ProviderLiveDriver = {
    ...driver,
    close: async () => {
      await exit.promise
      writeFileSync(nativePath, "shutdown metadata")
    },
  }
  owner = new LiveConversations({
    ...dependencies,
    driver: () => closingDriver,
    checkpoint: nativeCheckpoint,
    nativePath: () => discoveredPath,
    history: async () => ({
      ref: { harness: "fixture", nativeId: "native-fixture", path: nativePath },
      entries: [],
      start: 0,
      total: 0,
      hasEarlier: false,
    }),
  })
  const closingId = randomUUID()
  await owner.start("fixture", root, { conversationId: closingId })
  await connected(closingId)
  assert.equal(owner.snapshot(closingId)?.threadPath, undefined)
  discoveredPath = nativePath
  owner.discoverNativePaths()
  assert.equal(owner.snapshot(closingId)?.threadPath, nativePath)
  assert.equal(
    owner.snapshot(closingId)?.control?.bindings.at(-1)?.path,
    nativePath
  )
  const revision = owner.snapshot(closingId)?.revision
  owner.discoverNativePaths()
  assert.equal(owner.snapshot(closingId)?.revision, revision)
  const closing = owner.close(closingId)
  exit.resolve()
  await closing
  assert.equal(owner.snapshot(closingId)?.session.connection, "disconnected")
  assert.equal(
    owner.snapshot(closingId)?.control?.bindings.at(-1)?.checkpoint,
    await nativeCheckpoint(nativePath)
  )
  console.log(
    "PASS: owned shutdown waits for process exit before fingerprinting native resume"
  )
} finally {
  owner.stop()
  rmSync(root, { recursive: true, force: true })
}
