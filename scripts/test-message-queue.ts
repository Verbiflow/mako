import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mock } from "node:test"
import { LiveConversations } from "../electron/live-conversations.js"
import { LiveJournal } from "../electron/live-journal.js"
import { NativeRequests } from "../electron/native-requests.js"
import type { ProviderLiveDriver } from "../electron/providers/live-driver.js"
import type { LiveSessionState } from "../electron/shared.js"
import type { ThreadRef } from "@mako/sessions"

const root = mkdtempSync(join(tmpdir(), "mako-message-queue-"))
const sent: string[] = []
let session: LiveSessionState
const driver: ProviderLiveDriver = {
  provider: "test",
  canResume: true,
  available: () => true,
  async start(cwd, options) {
    session = {
      id: options.conversationId,
      harness: "test",
      cwd,
      status: "ready",
      connection: "connected",
      modes: [],
      currentMode: null,
      configOptions: [],
    }
    return session
  },
  async prompt(_id, text) {
    sent.push(text)
    session = { ...session, status: "running" }
    owner.observe({ type: "live-session", session })
  },
  permission: async () => {},
  cancel: async () => {},
  setMode: async () => {},
  close: () => {},
}
const owner = new LiveConversations({
  root: join(root, "live"),
  appPath: root,
  driver: () => driver,
  history: async () => null,
  emit: () => {},
})
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
try {
  const started = await owner.start("test", root, {
    conversationId: randomUUID(),
  })
  const id = started.id
  const first = randomUUID()
  const second = randomUUID()
  const third = randomUUID()
  owner.submit(id, first, "First")
  await tick()
  owner.submit(id, second, "Original follow-up")
  owner.submit(id, third, "Third")
  assert.equal(
    owner.snapshot(id)?.requests.find((request) => request.id === second)
      ?.status,
    "queued"
  )
  owner.editQueued(id, {
    requestId: second,
    expectedText: "Original follow-up",
    change: { kind: "pause" },
  })
  session = { ...session!, status: "ready" }
  owner.observe({ type: "live-session", session })
  await tick()
  assert.deepEqual(
    sent,
    ["First"],
    "Editing holds the queue even after the active answer completes"
  )
  owner.editQueued(id, {
    requestId: second,
    expectedText: "Original follow-up",
    change: { kind: "edit", text: "Edited follow-up" },
  })
  await tick()
  assert.deepEqual(sent, ["First", "Edited follow-up"])
  assert.throws(
    () =>
      owner.editQueued(id, {
        requestId: second,
        expectedText: "Edited follow-up",
        change: { kind: "remove" },
      }),
    /already started/
  )
  const thirdInput = {
    requestId: third,
    expectedText: "Third",
    change: { kind: "remove" as const },
  }
  const failure = mock.method(LiveJournal.prototype, "commit", () => {
    throw new Error("disk full")
  })
  assert.throws(() => owner.editQueued(id, thirdInput), /disk full/)
  failure.mock.restore()
  assert.equal(
    owner.snapshot(id)?.requests.find((request) => request.id === third)
      ?.status,
    "queued",
    "Rejected removal leaves the queued message intact"
  )
  owner.editQueued(id, thirdInput)
  owner.editQueued(id, thirdInput)
  assert.equal(
    owner.snapshot(id)?.requests.find((request) => request.id === third)
      ?.status,
    "canceled"
  )
  const fourth = randomUUID()
  owner.submit(id, fourth, "Fourth")
  owner.editQueued(id, {
    requestId: fourth,
    expectedText: "Fourth",
    change: { kind: "edit", text: "Fourth revised" },
  })
  assert.throws(
    () =>
      owner.editQueued(id, {
        requestId: fourth,
        expectedText: "Fourth",
        change: { kind: "edit", text: "Stale edit" },
      }),
    /changed/
  )
  owner.submit(id, fourth, "Fourth")
  assert.equal(
    owner.snapshot(id)?.requests.find((request) => request.id === fourth)?.text,
    "Fourth revised",
    "An original submission retry cannot overwrite a queued edit"
  )
  owner.editQueued(id, {
    requestId: fourth,
    expectedText: "Fourth revised",
    change: { kind: "pause" },
  })
  const journal = new LiveJournal(join(root, "live"), id)
  assert.equal(
    journal.read()?.requests.find((request) => request.id === fourth)?.status,
    "held"
  )
  journal.close()
  console.log(
    "Live queue: pause across completion, edited dispatch, stale-edit and dispatch races, durable removal and journal rollback passed"
  )
} finally {
  owner.stop()
}

let externallyBusy = true
const nativeSent: string[] = []
const ref: ThreadRef = {
  harness: "test",
  path: join(root, "native-thread"),
  nativeId: "test-thread",
  cwd: root,
  updatedAt: new Date(0).toISOString(),
  bytes: 0,
}
const native = new NativeRequests(join(root, "native"), {
  read: async () => ref,
  running: () => externallyBusy,
  execute: async (_ref, text) => {
    nativeSent.push(text)
  },
  changed: () => {},
  failed: (message) => assert.fail(message),
})
try {
  const id = randomUUID()
  await native.submit({
    id,
    path: ref.path,
    text: "Native original",
    attachments: [],
  })
  native.editQueued({
    requestId: id,
    expectedText: "Native original",
    change: { kind: "pause" },
  })
  externallyBusy = false
  native.ready(ref.path)
  await tick()
  assert.equal(nativeSent.length, 0)
  native.editQueued({
    requestId: id,
    expectedText: "Native original",
    change: { kind: "edit", text: "Native revised" },
  })
  await tick()
  assert.equal(nativeSent.length, 1)
  assert.ok(nativeSent[0]?.startsWith("Native revised"))
  assert.throws(
    () =>
      native.editQueued({
        requestId: id,
        expectedText: "Native revised",
        change: { kind: "pause" },
      }),
    /already started/
  )
  console.log(
    "Native queue: same paused editing and single dispatch semantics passed"
  )
} finally {
  native.stop()
  rmSync(root, { recursive: true, force: true })
}
