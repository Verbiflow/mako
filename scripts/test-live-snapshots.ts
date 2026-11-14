import "./lib/scratch-git.mjs"
import { Git } from "@mako/git"
import assert from "node:assert/strict"
import { execFileSync, type spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  rmSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { mock } from "node:test"
import { LiveConversations } from "@mako/host/conversations/live-conversations"
import { LiveJournal } from "@mako/host/conversations/live-journal"
import { WorkspaceSnapshots } from "@mako/host/workspaces/snapshots"
import { GitHelper } from "@mako/host/git/git-helper"
import { hostSpawn, closeHostChild } from "@mako/host/base/host-command"
import type { LiveSessionState } from "@mako/host/contracts/providers-acp"
import type { WorkspaceTracking } from "@mako/host/contracts/workspace-snapshots"
import type { LiveSnapshot } from "@mako/host/contracts/live-conversations"
import type { ProviderLiveDriver } from "@mako/host/harnesses/live-driver"
import { NO_NATIVE_EXCLUSION } from "@mako/host/contracts/execution-context"
import { NO_NATIVE_PROMPT_IDENTITY } from "@mako/host/contracts/native-prompt-identity"
import { fixtureResume, noCapabilities } from "./fixtures/driver-capabilities.ts"

const directGit: string[] = []
// SAFETY: forwards every overload unchanged, noting only the executable before calling the same host spawner.
const notingSpawn = ((...args: Parameters<typeof hostSpawn>) => {
  if (basename(args[0]) === "git") directGit.push(args[0])
  return hostSpawn(...args)
}) as typeof spawn
const helper = new GitHelper({
  spawn: notingSpawn,
  close: closeHostChild,
})
const gitRunner = new Git({ processes: helper.runner() })

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
const snapshots = new WorkspaceSnapshots(gitRunner, join(root, "snapshots"))
const states = new Map<string, LiveSessionState>()
const sent: string[] = []
const driver: ProviderLiveDriver = {
  ...noCapabilities,
  resume: fixtureResume(),
  approvalEvidence: { kind: "submission-only", reason: "Injected driver fixture" },
  nativeIdentity: { kind: "unavailable", reason: "Injected driver fixture" },
  nativeExclusion: NO_NATIVE_EXCLUSION,
  launchEnvironment: { kind: "unavailable", reason: "Injected driver fixture" },
  nativePromptIdentity: NO_NATIVE_PROMPT_IDENTITY,
  planning: { via: "setting", option: "plan", proposal: "Injected driver fixture", feedback: { kind: "next-message", reason: "Injected driver fixture" } },
  backgroundStop: { kind: "ends-with-turn", evidence: "Injected driver fixture" },
  turnRecovery: { kind: "manual", reason: "Injected driver fixture" },
  provider: "test",
  available: () => true,
  async start(directory, options) {
    const state: LiveSessionState = {
      id: options.conversationId,
      // As every real driver does: a resumed session names the source it reopened.
      nativePath: options.resume ? options.threadPath : undefined,
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
  async prompt(id, text, _attachments, _settings, dispatch) {
    dispatch.report({ kind: "submitted", source: "transport-call" })
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
const asked: { paths: string[]; since: number }[] = []
const dependencies = {
  root: join(root, "conversations"),
  appPath: root,
  workspaceSnapshots: snapshots,
  // The journal's answer for whose each file is: the person and another Thread both wrote the checkout's file.
  rewindWriters: (paths: readonly string[], since: number) => {
    asked.push({ paths: [...paths], since })
    return Object.fromEntries(paths.map((path) => [path, [{ kind: "thread" as const, thread: "other-thread", sure: true }, { kind: "person" as const }]]))
  },
  driver: () => driver,
  history: async () => null,
  emit: () => {},
}
let owner = new LiveConversations(dependencies)
async function until(predicate: () => boolean, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
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
  // Attribution pending must not remove the independent checkpoint opportunity.
  {
    owner.stop()
    owner = new LiveConversations({ ...dependencies, workspaceTracking: () => ({ kind: "pending", reason: "tracking is still opening" }) })
    const independentId = randomUUID(), independentRequest = randomUUID()
    await owner.start("test", cwd, { conversationId: independentId })
    const before = sent.length
    owner.submit(independentId, independentRequest, "checkpoint while attribution is pending")
    await until(() => sent.length === before + 1)
    await until(() => owner.snapshot(independentId)?.requests[0].snapshots?.before.kind === "ready", 500)
    assert.equal(owner.snapshot(independentId)?.requests[0].snapshots?.coverage?.kind, "unavailable")
    finish(independentId, "checkpoint is independent")
    await until(() => owner.snapshot(independentId)?.requests[0].snapshots?.after?.kind === "ready")
    owner.stop(); sent.length = 0
    owner = new LiveConversations(dependencies)
  }
  // A prepared checkpoint releases the send even if the old dispatch capture would never answer.
  {
    const seed = await snapshots.capture(cwd)
    const descriptor = Object.getOwnPropertyDescriptor(snapshots, "beginPreparedRun")
    Object.defineProperty(snapshots, "beginPreparedRun", { configurable: true, value: () => ({ kind: "ready", snapshot: seed, preparedAt: Date.now(), captureMs: 0 }) })
    let release = () => {}
    const held = new Promise<void>(resolve => { release = resolve })
    const capture = mock.method(snapshots, "beginRun", async () => { await held; return seed })
    try {
      owner.stop()
      owner = new LiveConversations({ ...dependencies, workspaceTracking: () => ({ kind: "tracked" }) })
      const readyId = randomUUID()
      await owner.start("test", cwd, { conversationId: readyId })
      const before = sent.length
      owner.submit(readyId, randomUUID(), "consume prepared state without a capture")
      await until(() => sent.length === before + 1, 500)
      assert.equal(capture.mock.callCount(), 0, "dispatch must not call the old capture API")
      finish(readyId, "prepared send")
    } finally {
      release(); capture.mock.restore()
      if (descriptor) Object.defineProperty(snapshots, "beginPreparedRun", descriptor)
      else Reflect.deleteProperty(snapshots, "beginPreparedRun")
      owner.stop(); sent.length = 0
      owner = new LiveConversations(dependencies)
    }
  }
  // Opening the Thread starts tracking even if the person has not sent a message.
  {
    owner.stop()
    const observed: string[] = []
    owner = new LiveConversations({ ...dependencies, observeWorkspace: (folder: string) => { observed.push(folder) } })
    await owner.start("test", cwd, { conversationId: randomUUID() })
    assert.ok(observed.includes(cwd), "tracking starts at Thread open, before a send")
    owner.stop()
    owner = new LiveConversations(dependencies)
  }
  const id = randomUUID(),
    first = randomUUID(),
    second = randomUUID()
  await owner.start("test", cwd, { conversationId: id })
  await snapshots.prepare(cwd)
  owner.submit(id, first, "first question")
  await until(() => sent.length === 1)
  assert.equal(owner.snapshot(id)?.requests[0].snapshots?.before.kind, "ready")
  writeFileSync(file, "first answer files")
  finish(id, "first answer")
  await until(() => owner.snapshot(id)?.requests[0].snapshots?.after?.kind === "ready")
  owner.submit(id, second, "second question")
  await until(() => sent.length === 2)
  const firstRequest = owner.snapshot(id)?.requests[0]
  assert.equal(firstRequest?.snapshots?.after?.kind, "ready")
  writeFileSync(file, "second answer files")
  finish(id, "second answer")
  await until(
    () => owner.snapshot(id)?.requests[1].snapshots?.after?.kind === "ready"
  )
  const preview = await owner.previewRewind(id, first)
  assert.deepEqual(preview.changedFiles, [basename(file)])
  assert.deepEqual(asked.at(-1)?.paths, [join(realpathSync(cwd), basename(file))], "the journal is asked about the files the rewind changes")
  assert.equal(asked.at(-1)?.since, preview.target.createdAt)
  assert.deepEqual(preview.writers?.[basename(file)], [{ kind: "thread", thread: "other-thread", sure: true }, { kind: "person" }], "the preview says whose each file is")
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
  assert.equal(rewound.base?.entries[1].type, "text")
  assert.equal(
    owner.snapshot(id)?.requests.length,
    2,
    "original conversation remains intact"
  )
  assert.equal(sent.length, 2)
  console.log(
    "PASS: prepared before/after checkpoints, coordinated idle fork, original history retained"
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
    function (this: LiveJournal, next: LiveSnapshot, previous?: LiveSnapshot) {
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

  const startingId = randomUUID(),
    startingRequest = randomUUID()
  await owner.start("test", cwd, { conversationId: startingId })
  owner.submit(startingId, startingRequest, "never send this")
  assert.equal(owner.snapshot(startingId)?.session.status, "starting")
  await owner.cancelRequest(startingId, startingRequest)
  await until(() => owner.snapshot(startingId)?.session.status === "ready")
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(sent.length, 2)
  assert.equal(owner.snapshot(startingId)?.requests[0].status, "interrupted")
  assert.equal(owner.snapshot(startingId)?.requests[0].snapshots, undefined)
  console.log(
    "PASS: cancellation while the provider starts never captures or dispatches"
  )

  const canceledId = randomUUID(),
    canceledRequest = randomUUID()
  await owner.start("test", cwd, { conversationId: canceledId })
  await until(() => owner.snapshot(canceledId)?.session.status === "ready")
  owner.submit(canceledId, canceledRequest, "never send this")
  assert.equal(
    owner.snapshot(canceledId)?.requests[0].status,
    "dispatching",
    "the cancel lands before the prepared send reaches the provider"
  )
  await owner.cancelRequest(canceledId, canceledRequest)
  await until(() => owner.workOf(canceledId) === undefined, 500)
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(sent.length, 2)
  assert.equal(owner.snapshot(canceledId)?.requests[0].status, "interrupted")
  console.log(
    "PASS: cancellation during baseline capture never dispatches the prompt"
  )

  // Pending or failed tracking never makes a send wait for the writer.
  for (const state of [
    { kind: "pending", reason: "Tracking has not answered" },
    { kind: "unavailable", reason: "The writer worker is in failed recovery" },
    { kind: "unavailable", reason: "track() timed out" },
    { kind: "incomplete", reason: "Discovery holds more than 12 repositories" },
  ] satisfies WorkspaceTracking[]) {
    owner.stop()
    let captures = 0
    owner = new LiveConversations({ ...dependencies, workspaceTracking: () => state })
    const timedId = randomUUID(), timedRequest = randomUUID()
    await owner.start("test", cwd, { conversationId: timedId })
    const original = snapshots.beginRun.bind(snapshots)
    const beginRun = mock.method(snapshots, "beginRun", (...args: Parameters<typeof original>) => { captures++; return original(...args) })
    const before = sent.length
    try {
      owner.submit(timedId, timedRequest, "send without waiting for attribution")
      await until(() => sent.length === before + 1, 500)
      const expected = state.kind === "incomplete" ? "incomplete" : "unavailable"
      assert.equal(owner.snapshot(timedId)?.requests[0].snapshots?.coverage?.kind, expected)
      const reopened = new LiveJournal(dependencies.root, timedId)
      try { assert.equal(reopened.read()?.requests[0].snapshots?.coverage?.kind, expected, "coverage survives the conversation journal") }
      finally { reopened.close() }
      await until(() => owner.snapshot(timedId)?.requests[0].snapshots?.before.kind === "ready")
      assert.equal(captures, 0, "dispatch uses the reserved-run API rather than the legacy capture API")
      const readyJournal = new LiveJournal(dependencies.root, timedId)
      try { assert.equal(readyJournal.read()?.requests[0].snapshots?.before.kind, "ready", "rewind survives reload while attribution is unavailable") } finally { readyJournal.close() }
      finish(timedId, "coverage was unavailable")
      await until(() => owner.snapshot(timedId)?.requests[0].snapshots?.after !== undefined)
    } finally { beginRun.mock.restore() }
  }
  console.log("PASS: pending, failed and limited tracking retain ready rewind checkpoints with persistent coverage reasons")

  {
    owner.stop()
    const acknowledgedAt = Date.now() - 11 * 60_000
    owner = new LiveConversations({ ...dependencies, workspaceTracking: () => ({ kind: "tracked", refreshing: true, preparation: { requestedAt: acknowledgedAt, acknowledgedAt, discoveryMs: 0, trackAckMs: 0 } }) })
    const staleId = randomUUID(), staleRequest = randomUUID()
    await owner.start("test", cwd, { conversationId: staleId })
    await snapshots.prepare(cwd)
    const before = sent.length
    owner.submit(staleId, staleRequest, "send eleven minutes after tracking")
    await until(() => sent.length === before + 1)
    await until(() => owner.snapshot(staleId)?.requests[0].snapshots?.before.kind === "ready")
    finish(staleId, "old acknowledgment still has a checkpoint")
    await until(() => owner.snapshot(staleId)?.requests[0].snapshots?.after !== undefined)
    console.log("PASS: a send with an eleven-minute-old tracking acknowledgment keeps its checkpoint")
  }

  // Already-dirty content is prepared before the send; dispatch performs no new capture.
  {
    owner.stop()
    writeFileSync(file, "already dirty before dispatch")
    snapshots.changed(cwd)
    owner = new LiveConversations({ ...dependencies, workspaceTracking: () => ({ kind: "tracked" }) })
    const trackedId = randomUUID(), trackedRequest = randomUUID()
    await owner.start("test", cwd, { conversationId: trackedId })
    await snapshots.prepare(cwd)
    const directBefore = directGit.length
    const original = snapshots.capture.bind(snapshots)
    const capture = mock.method(snapshots, "capture", original)
    const before = sent.length
    try {
      owner.submit(trackedId, trackedRequest, "first tool in a new checkout")
      await until(() => sent.length === before + 1, 500)
      assert.equal(capture.mock.callCount(), 0, "a prepared send starts no capture")
      const baseline = owner.snapshot(trackedId)?.requests[0].snapshots?.before
      assert.ok(baseline?.kind === "ready")
      assert.equal(owner.snapshot(trackedId)?.requests[0].snapshots?.coverage?.kind, "complete")
      writeFileSync(file, "first tool changed it")
      snapshots.changed(cwd)
      finish(trackedId, "tracked answer")
      await until(() => owner.snapshot(trackedId)?.requests[0].snapshots?.after?.kind === "ready")
      assert.equal(directGit.length - directBefore, 0, "preparation and capture use the Git helper")
      const after = owner.snapshot(trackedId)?.requests[0].snapshots?.after
      assert.ok(after?.kind === "ready")
      const comparison = snapshots.compare(snapshots.trees(baseline.snapshot.id, after.snapshot.id))
      try {
        const preview = await comparison.preview(basename(file))
        assert.ok(preview.kind === "files")
        assert.equal(preview.before, "already dirty before dispatch")
        assert.equal(preview.after, "first tool changed it")
      } finally { comparison.close() }
    } finally { capture.mock.restore() }
    console.log("PASS: a prepared baseline keeps already-dirty content with no foreground capture")
  }

  for (const failure of ["tracking", "baseline", "missing-baseline"] as const) {
    owner.stop()
    owner = new LiveConversations({ ...dependencies, workspaceSnapshots: failure === "missing-baseline" ? undefined : snapshots, workspaceTracking: () => failure === "tracking" ? { kind: "unavailable", reason: "tracking acknowledgement failed" } : { kind: "tracked" } })
    snapshots.changed(cwd)
    const capture = failure === "baseline" ? mock.method(snapshots, "capture", async () => { throw new Error("baseline failed") }) : undefined
    const failedId = randomUUID(), failedRequest = randomUUID()
    await owner.start("test", cwd, { conversationId: failedId })
    if (failure === "baseline") await snapshots.prepare(cwd)
    const before: number = sent.length
    try {
      owner.submit(failedId, failedRequest, "cannot start without coverage")
      await until(() => sent.length === before + 1)
      const coverage = owner.snapshot(failedId)?.requests[0].snapshots?.coverage
      assert.ok(coverage?.kind === (failure === "tracking" ? "unavailable" : "incomplete"))
      assert.match(coverage.reason, failure === "missing-baseline" ? /baseline service is unavailable/ : new RegExp(`${failure}.*failed`))
      finish(failedId, "incomplete coverage")
      await until(() => owner.snapshot(failedId)?.requests[0].snapshots?.after !== undefined || failure === "missing-baseline")
    } finally { capture?.mock.restore() }
  }
  console.log("PASS: tracking and baseline failures send with explicit incomplete coverage")

  {
    owner.stop()
    let release = () => {}, entered = false
    const held = new Promise<void>(resolve => { release = resolve })
    const pendingSnapshots = new WorkspaceSnapshots(gitRunner, join(root, "pending-snapshots"))
    const original = pendingSnapshots.capture.bind(pendingSnapshots)
    const capture = mock.method(pendingSnapshots, "capture", async (...args: Parameters<typeof original>) => { entered = true; await held; return original(...args) })
    pendingSnapshots.changed(cwd)
    owner = new LiveConversations({ ...dependencies, workspaceSnapshots: pendingSnapshots, checkpointWaitMs: 25, workspaceTracking: () => ({ kind: "tracked" }) })
    const pendingId = randomUUID(), pendingRequest = randomUUID()
    try {
      await owner.start("test", cwd, { conversationId: pendingId })
      await until(() => entered)
      const before = sent.length
      owner.submit(pendingId, pendingRequest, "send while background preparation is blocked")
      await until(() => sent.length === before + 1, 500)
      assert.equal(owner.snapshot(pendingId)?.requests[0].snapshots?.coverage?.kind, "incomplete")
      release()
      await new Promise(resolve => setTimeout(resolve, 40))
      assert.equal(owner.snapshot(pendingId)?.requests[0].snapshots?.before.kind, "unavailable", "late preparation cannot become this turn's before")
      finish(pendingId, "background was late")
      await until(() => owner.snapshot(pendingId)?.requests[0].snapshots?.after !== undefined)
    } finally { release(); capture.mock.restore(); pendingSnapshots.close() }
    console.log("PASS: a blocked baseline uses its bounded fallback and never supplies a false before")
  }

  {
    owner.stop()
    const stoppedSnapshots = new WorkspaceSnapshots(gitRunner, join(root, "stopped-snapshots"))
    owner = new LiveConversations({ ...dependencies, workspaceSnapshots: stoppedSnapshots, workspaceTracking: () => ({ kind: "unavailable", reason: "writer down" }) })
    const stopId = randomUUID(), stopRequest = randomUUID()
    await owner.start("test", cwd, { conversationId: stopId })
    await until(() => owner.snapshot(stopId)?.session.status === "ready")
    stoppedSnapshots.changed(cwd)
    let release = () => {}
    const held = new Promise<void>(resolve => { release = resolve })
    const original = stoppedSnapshots.captureRun.bind(stoppedSnapshots)
    const capture = mock.method(stoppedSnapshots, "captureRun", async (...args: Parameters<typeof original>) => { await held; return original(...args) })
    const before = sent.length
    try {
      owner.submit(stopId, stopRequest, "stop an independent capture while attribution is down")
      await until(() => capture.mock.callCount() === 1)
      await owner.cancelRequest(stopId, stopRequest)
      await until(() => owner.workOf(stopId) === undefined, 500)
      assert.equal(sent.length, before)
      release()
      await new Promise(resolve => setTimeout(resolve, 40))
      assert.equal(sent.length, before, "late independent capture cannot resurrect canceled input")
    } finally { release(); capture.mock.restore(); stoppedSnapshots.close() }
    console.log("PASS: Stop releases the independent capture immediately while attribution is unavailable")
  }

  {
    owner.stop()
    const frozenSnapshots = new WorkspaceSnapshots(gitRunner, join(root, "frozen-snapshots"))
    owner = new LiveConversations({ ...dependencies, workspaceSnapshots: frozenSnapshots, workspaceTracking: () => ({ kind: "unavailable", reason: "writer down" }) })
    const frozenId = randomUUID(), frozenRequest = randomUUID()
    await owner.start("test", cwd, { conversationId: frozenId })
    await until(() => owner.snapshot(frozenId)?.session.status === "ready")
    frozenSnapshots.changed(cwd)
    const content = readFileSync(file, "utf8")
    let release = () => {}
    const held = new Promise<void>(resolve => { release = resolve })
    const original = frozenSnapshots.captureRun.bind(frozenSnapshots)
    const capture = mock.method(frozenSnapshots, "captureRun", async (id: string, frozen?: () => void) => {
      const snapshot = await original(id)
      frozen?.()
      await held
      return snapshot
    })
    const before = sent.length
    try {
      owner.submit(frozenId, frozenRequest, "send after freeze while the save is held")
      await until(() => sent.length === before + 1)
      writeFileSync(file, "tool wrote after the freeze")
      frozenSnapshots.changed(cwd)
      release()
      await until(() => owner.snapshot(frozenId)?.requests[0].snapshots?.before.kind === "ready")
      assert.equal(owner.snapshot(frozenId)?.requests[0].snapshots?.coverage?.kind, "unavailable")
      finish(frozenId, "independent frozen checkpoint")
      await until(() => owner.snapshot(frozenId)?.requests[0].snapshots?.after?.kind === "ready")
      const boundaries = owner.snapshot(frozenId)?.requests[0].snapshots
      assert.ok(boundaries?.before.kind === "ready" && boundaries.after?.kind === "ready")
      const diff = frozenSnapshots.compare(frozenSnapshots.trees(boundaries.before.snapshot.id, boundaries.after.snapshot.id))
      try {
        const preview = await diff.preview(basename(file))
        assert.ok(preview.kind === "files")
        assert.equal(preview.before, content)
        assert.equal(preview.after, "tool wrote after the freeze")
      } finally { diff.close() }
    } finally {
      release(); capture.mock.restore(); frozenSnapshots.close()
      writeFileSync(file, content); snapshots.changed(cwd)
    }
    console.log("PASS: frozen content releases dispatch before saving and retains the turn diff while attribution is down")
  }

  {
    owner.stop()
    owner = new LiveConversations({ ...dependencies, workspaceTracking: () => ({ kind: "tracked" }) })
    const queuedId = randomUUID(), first = randomUUID(), next = randomUUID()
    await owner.start("test", cwd, { conversationId: queuedId })
    await snapshots.prepare(cwd)
    let release = () => {}, entered = false
    const held = new Promise<void>(resolve => { release = resolve })
    const original = snapshots.endRun.bind(snapshots)
    const end = mock.method(snapshots, "endRun", async (id: string) => { if (id === first) { entered = true; await held } return original(id) })
    const before = sent.length
    try {
      owner.submit(queuedId, first, "first queued answer")
      await until(() => sent.length === before + 1)
      owner.submit(queuedId, next, "send before the last after checkpoint")
      finish(queuedId, "first done")
      await until(() => entered)
      await until(() => sent.length === before + 2, 500)
      await until(() => owner.snapshot(queuedId)?.requests[1].snapshots?.before.kind === "ready")
      release()
      await until(() => owner.snapshot(queuedId)?.requests[0].snapshots?.after !== undefined)
      assert.equal(owner.snapshot(queuedId)?.requests[0].snapshots?.after?.kind, "unavailable", "an overlapping later turn is never accepted as the earlier after")
      finish(queuedId, "second done")
      await until(() => owner.snapshot(queuedId)?.requests[1].snapshots?.after !== undefined)
    } finally { release(); end.mock.restore() }
    console.log("PASS: a queued send never waits for the previous after checkpoint")
  }

} finally {
  owner.stop()
  await gitRunner.close()
  await helper.stop()
  snapshots.close()
  rmSync(root, { recursive: true, force: true })
}
