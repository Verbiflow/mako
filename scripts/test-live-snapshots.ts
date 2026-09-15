import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mock } from "node:test"
import { LiveConversations } from "../electron/live-conversations.js"
import { LiveJournal } from "../electron/live-journal.js"
import { WorkspaceSnapshots } from "../electron/workspace-snapshots.js"
import type { LiveSessionState } from "../electron/shared.js"
import type { ProviderLiveDriver } from "../electron/providers/live-driver.js"

const root = mkdtempSync(join(tmpdir(), "mako-live-snapshots-"))
const cwd = join(root, "workspace")
mkdirSync(cwd)
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
git("init", "-q")
git("config", "user.name", "Test")
git("config", "user.email", "test@localhost")
const file = join(cwd, "answer")
writeFileSync(file, "initial")
git("add", ".")
git("commit", "-qm", "initial")
const snapshots = new WorkspaceSnapshots(join(root, "snapshots"))
const states = new Map<string, LiveSessionState>()
const sent: string[] = []
const driver: ProviderLiveDriver = {
  provider: "test",
  canResume: true,
  available: () => true,
  async start(directory, options) {
    const state: LiveSessionState = {
      id: options.conversationId,
      harness: "test",
      cwd: directory,
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
    const state = states.get(id)
    assert.ok(state)
    sent.push(text)
    const running: LiveSessionState = { ...state, status: "running" }
    states.set(id, running)
    owner.observe({ type: "live-session", session: running })
  },
  permission: async () => {},
  cancel: async () => {},
  setMode: async () => {},
  close: () => {},
}
const dependencies = {
  root: join(root, "conversations"),
  appPath: root,
  workspaceSnapshots: snapshots,
  driver: () => driver,
  history: async () => null,
  emit: () => {},
}
let owner = new LiveConversations(dependencies)
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 15_000
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "timed out waiting for run/checkpoint")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
function finish(id: string, answer: string) {
  const state = states.get(id)
  assert.ok(state)
  owner.observe({
    type: "live-update",
    id,
    update: { kind: "text", text: answer },
  })
  const ready: LiveSessionState = { ...state, status: "ready" }
  states.set(id, ready)
  owner.observe({ type: "live-session", session: ready })
}
try {
  const id = randomUUID(),
    first = randomUUID(),
    second = randomUUID()
  await owner.start("test", cwd, { conversationId: id })
  owner.submit(id, first, "first question")
  await until(() => sent.length === 1)
  assert.equal(owner.snapshot(id)?.requests[0].snapshots?.before.kind, "ready")
  writeFileSync(file, "first answer files")
  owner.submit(id, second, "second question")
  finish(id, "first answer")
  assert.equal(
    sent.length,
    1,
    "queued provider cannot start ahead of final checkpoint"
  )
  await until(() => sent.length === 2)
  const firstRequest = owner.snapshot(id)?.requests[0]
  assert.equal(firstRequest?.snapshots?.after?.kind, "ready")
  writeFileSync(file, "second answer files")
  finish(id, "second answer")
  await until(
    () => owner.snapshot(id)?.requests[1].snapshots?.after?.kind === "ready"
  )
  const preview = await owner.previewRewind(id, first)
  const rewindId = randomUUID()
  const rewound = await owner.rewind(id, {
    id: rewindId,
    requestId: first,
    expectedId: preview.current.id,
  })
  assert.equal(readFileSync(file, "utf8"), "first answer files")
  assert.equal(
    rewound.session.connection,
    "disconnected",
    "rewind cannot spend a prompt or require provider startup"
  )
  assert.equal(rewound.control?.ancestry?.parentId, id)
  assert.equal(rewound.base?.entries.length, 2)
  assert.equal(rewound.base?.entries[1].kind, "assistant")
  assert.equal(
    owner.snapshot(id)?.requests.length,
    2,
    "original conversation remains intact"
  )
  assert.equal(sent.length, 2)
  console.log(
    "PASS: automatic before/after checkpoints, queue ordering, coordinated idle fork, original history retained"
  )

  writeFileSync(file, "user edit after successful rewind")
  await owner.rewind(id, {
    id: rewindId,
    requestId: first,
    expectedId: preview.current.id,
  })
  assert.equal(readFileSync(file, "utf8"), "user edit after successful rewind")
  const failurePreview = await owner.previewRewind(id, first)
  const failureId = randomUUID()
  const originalCommit = LiveJournal.prototype.commit
  const failure = mock.method(
    LiveJournal.prototype,
    "commit",
    function (next, previous) {
      if (next.session.id === failureId)
        throw new Error("simulated fork journal failure")
      return originalCommit.call(this, next, previous)
    }
  )
  await assert.rejects(
    owner.rewind(id, {
      id: failureId,
      requestId: first,
      expectedId: failurePreview.current.id,
    }),
    /simulated fork journal failure/
  )
  failure.mock.restore()
  assert.equal(readFileSync(file, "utf8"), "user edit after successful rewind")
  assert.equal(owner.snapshot(failureId), null)
  console.log(
    "PASS: repeated command receipt and real fork-journal failure preserve current files"
  )

  owner.stop()
  owner = new LiveConversations(dependencies)
  assert.equal(
    owner.snapshot(id)?.requests[0].snapshots?.after?.kind,
    "ready",
    "checkpoints survive journal reload"
  )
  const restartPreview = await owner.previewRewind(id, first)
  await owner.rewind(id, {
    id: randomUUID(),
    requestId: first,
    expectedId: restartPreview.current.id,
  })
  assert.equal(readFileSync(file, "utf8"), "first answer files")
  console.log("PASS: rewind after host restart without any provider connection")
  const initialPreview = await owner.previewRewind(id, first, "before")
  const initialFork = await owner.rewind(id, {
    id: randomUUID(),
    requestId: first,
    position: "before",
    expectedId: initialPreview.current.id,
  })
  assert.equal(readFileSync(file, "utf8"), "initial")
  assert.equal(initialFork.base?.entries.length, 0)
  assert.equal(initialFork.control?.ancestry?.nativeFork, undefined)
  console.log(
    "PASS: rewind before the first prompt restores the true baseline and excludes the prompt from history"
  )

  const canceledId = randomUUID(),
    canceledRequest = randomUUID()
  await owner.start("test", cwd, { conversationId: canceledId })
  owner.submit(canceledId, canceledRequest, "never send this")
  await owner.cancelRequest(canceledId, canceledRequest)
  await until(
    () =>
      owner.snapshot(canceledId)?.requests[0].snapshots?.before.kind === "ready"
  )
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(sent.length, 2)
  assert.equal(owner.snapshot(canceledId)?.requests[0].status, "interrupted")
  console.log(
    "PASS: cancellation during baseline capture never dispatches the prompt"
  )
} finally {
  owner.stop()
  snapshots.close()
  rmSync(root, { recursive: true, force: true })
}
