import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mock } from "node:test"
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
let answer: () => Promise<ProviderSteerResult> = async () => ({
  kind: "accepted",
})
const driver: ProviderLiveDriver = {
  provider: "fixture",
  canResume: true,
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
  async compact(id) {
    compactionCalls++
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
  const compact: LiveActionInput = { kind: "compact", id: randomUUID() }
  assert.equal((await owner.act(id, compact)).state.kind, "accepted")
  const before = sent.length
  owner.submit(id, randomUUID(), "after compaction")
  assert.equal(sent.length, before)
  finish()
  assert.equal(
    owner.snapshot(id)?.control?.actions?.at(-1)?.state.kind,
    "completed"
  )
  assert.equal(sent.at(-1), "after compaction")
  assert.equal((await owner.act(id, compact)).state.kind, "completed")
  assert.equal(compactionCalls, 1)
  console.log(
    "PASS: compaction waits for provider completion before draining and never repeats on retry"
  )

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
