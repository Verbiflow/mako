import "./lib/scratch-git.mjs"
import { Git, type RunOptions } from "@mako/git"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
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
import { followHostLog } from "@mako/host/base/host-log"
import { WorkspaceSnapshots } from "@mako/host/workspaces/snapshots"
import type { LiveSessionState } from "@mako/host/contracts/providers-acp"
import type { LiveSnapshot } from "@mako/host/contracts/live-conversations"
import type { ProviderLiveDriver } from "@mako/host/harnesses/live-driver"
import { NO_NATIVE_EXCLUSION } from "@mako/host/contracts/execution-context"
import { NO_NATIVE_PROMPT_IDENTITY } from "@mako/host/contracts/native-prompt-identity"
import { fixtureResume, noCapabilities } from "./fixtures/driver-capabilities.ts"

const gitRunner = new Git()

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
// A failed assertion can release a held pack while its capture is still publishing: join it before removing files.
const captures = new Set<Promise<unknown>>()
function tracked<T>(pending: Promise<T>): Promise<T> {
  captures.add(pending)
  void pending.then(() => captures.delete(pending), () => captures.delete(pending))
  return pending
}
const begin = snapshots.beginRun.bind(snapshots), end = snapshots.endRun.bind(snapshots)
mock.method(snapshots, "beginRun", (...args: Parameters<WorkspaceSnapshots["beginRun"]>) => tracked(begin(...args)))
mock.method(snapshots, "endRun", (...args: Parameters<WorkspaceSnapshots["endRun"]>) => tracked(end(...args)))
const states = new Map<string, LiveSessionState>()
const sent: string[] = []
const steered: string[] = []
const driver: ProviderLiveDriver = {
  ...noCapabilities,
  // Heard at once, into the turn it runs: what the person sends while a turn runs goes as a steer.
  steering: { kind: "supported", lands: "interrupt", landing: "native", via: "Injected driver fixture", steer: async (_id, input) => {
    steered.push(input.text)
    return { kind: "accepted" }
  } },
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
    // As a real driver says its turn's run, which a steer names.
    const running: LiveSessionState = { ...state, status: "running", nativeRunId: randomUUID() }
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
  // A fast turn can finish while its baseline is still packing. Its closing files must be read now,
  // while the next prompt dispatches before baseline publication, and neither side of the record is lost.
  const baselinePacking = Promise.withResolvers<void>(), releaseBaseline = Promise.withResolvers<void>()
  const closingPacking = Promise.withResolvers<void>(), releaseClosing = Promise.withResolvers<void>()
  const run = gitRunner.run.bind(gitRunner)
  let packs = 0
  const packing = mock.method(gitRunner, "run", async (input: RunOptions) => {
    if (input.args.includes("pack-objects")) {
      packs++
      if (packs === 1) { baselinePacking.resolve(); await releaseBaseline.promise }
      if (packs === 2) { closingPacking.resolve(); await releaseClosing.promise }
    }
    return run(input)
  })
  owner.submit(id, first, "first question")
  await until(() => sent.length === 1)
  await baselinePacking.promise
  writeFileSync(file, "first answer files")
  owner.submit(id, second, "second question")
  finish(id, "first answer")
  assert.equal(
    sent.length,
    1,
    "the queued provider still waits for its own before-point's read"
  )
  try {
    await closingPacking.promise
    await until(() => sent.length === 2)
    assert.equal(owner.snapshot(id)?.requests[0].snapshots, undefined, "the next prompt dispatches while both the baseline and a later pack are still held")
  } finally {
    releaseClosing.resolve()
    releaseBaseline.resolve()
    packing.mock.restore()
  }
  await until(() => owner.snapshot(id)?.requests[0].snapshots?.after?.kind === "ready")
  const firstRequest = owner.snapshot(id)?.requests[0]
  assert.equal(firstRequest?.snapshots?.before.kind, "ready")
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
    "PASS: automatic before/after checkpoints, sends do not wait for closing packs, coordinated idle fork, original history retained"
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

  await owner.stop()
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
    "the cancel lands while the baseline is captured"
  )
  assert.equal(owner.snapshot(canceledId)?.requests[0].snapshots, undefined)
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

  // The follow-up turn runs while the previous turn's closing checkpoint still publishes: it reads as running, the
  // person can stop it, and what they send into it goes as a steer, as the composer sends it (queued, then steered).
  {
    await owner.stop()
    owner = new LiveConversations(dependencies)
    const conversation = randomUUID(), previous = randomUUID(), next = randomUUID()
    await owner.start("test", cwd, { conversationId: conversation })
    const sentBefore = sent.length
    owner.submit(conversation, previous, "previous turn")
    await until(() => sent.length === sentBefore + 1 && owner.snapshot(conversation)?.requests[0].snapshots?.before.kind === "ready")
    writeFileSync(file, "the previous turn's edit")
    const packing = Promise.withResolvers<void>(), releasePack = Promise.withResolvers<void>()
    const original = gitRunner.run.bind(gitRunner)
    let held = false
    const pack = mock.method(gitRunner, "run", async (input: RunOptions) => {
      if (!held && input.args.includes("pack-objects")) {
        held = true
        packing.resolve()
        await releasePack.promise
      }
      return original(input)
    })
    try {
      owner.submit(conversation, next, "follow up")
      finish(conversation, "previous answer")
      await packing.promise
      await until(() => sent.length === sentBefore + 2 && owner.snapshot(conversation)?.requests[1].nativeRun !== undefined)
      assert.equal(owner.snapshot(conversation)?.requests[0].snapshots?.after, undefined, "the previous turn's closing checkpoint is still publishing")
      const work = owner.lifecycleWork().find((item) => item.id === conversation)
      assert.equal(work?.status, "running", "a turn beside a closing publication is running, not finishing")
      assert.equal(work?.stoppable, true, "and the person can stop it")
      const steer = randomUUID(), words = "keep the old parser too"
      owner.submit(conversation, steer, words)
      const receipt = await owner.act(conversation, { kind: "steer-queued", id: randomUUID(), requestId: next, queuedRequestId: steer, text: words, attachments: [] })
      assert.equal(receipt.state.kind, "accepted", "a steer into the follow-up turn is accepted while the previous closing checkpoint publishes")
      assert.equal(steered.at(-1), words, "the agent hears it as a steer")
      assert.equal(owner.snapshot(conversation)?.requests[0].snapshots?.after, undefined, "the closing publication was still held when the steer went")
    } finally {
      releasePack.resolve()
      pack.mock.restore()
    }
    await until(() => owner.snapshot(conversation)?.requests[0].snapshots?.after?.kind === "ready")
    finish(conversation, "next answer")
    await until(() => owner.snapshot(conversation)?.requests[1].snapshots?.after !== undefined)
    console.log("PASS: a turn beside a closing publication reads as running and takes the person's steer")
  }

  // A closing read may be wedged too: if the next turn's own deadline lets it go, the old after-point is unsafe.
  {
    await owner.stop()
    owner = new LiveConversations({ ...dependencies, checkpointWaitMs: 200 })
    const conversation = randomUUID(), previous = randomUUID(), next = randomUUID()
    // The checkpoint deadline is the test's from the start: the setup turn waits for its own freeze, however slow the
    // machine (a real 200 ms deadline let a loaded CI runner's setup turn go late, its before-point rightly unavailable).
    let expire: (() => void) | undefined
    const schedule = globalThis.setTimeout
    const timer = mock.method(globalThis, "setTimeout", (callback: (...args: unknown[]) => void, ms: number, ...args: unknown[]) => {
      if (ms !== 200) return schedule(callback, ms, ...args)
      expire = () => callback(...args)
      return schedule(() => {}, 60_000).unref()
    })
    await owner.start("test", cwd, { conversationId: conversation })
    const sentBefore = sent.length
    owner.submit(conversation, previous, "previous turn")
    await until(() => sent.length === sentBefore + 1 && owner.snapshot(conversation)?.requests[0].snapshots?.before.kind === "ready")
    // The deadline the follow-up's checkpoint asks for is the one the test expires below.
    expire = undefined
    writeFileSync(file, "the previous turn's last edit")
    const reading = Promise.withResolvers<void>(), releaseRead = Promise.withResolvers<void>()
    const original = gitRunner.run.bind(gitRunner)
    let paused = false
    const capture = mock.method(gitRunner, "run", async (input: RunOptions) => {
      if (!paused && input.args.includes("add") && input.args.includes("-A")) {
        paused = true
        reading.resolve()
        await releaseRead.promise
      }
      return original(input)
    })
    try {
      finish(conversation, "previous answer")
      await reading.promise
      await assert.rejects(owner.previewRewind(conversation, previous, "before"), /pending work/, "rewind still waits for the closing capture")
      owner.submit(conversation, next, "follow up")
      await until(() => expire !== undefined)
      assert.equal(sent.length, sentBefore + 1, "the next turn still waits for its own before-point")
      expire!()
      await until(() => sent.length === sentBefore + 2 && owner.snapshot(conversation)?.requests[1].nativeRun !== undefined)
      // The next turn runs while the previous closing capture still reads the live files: what the person sends into
      // it waits for that read (the composer queues it), and goes as a steer once the read is fixed.
      const steer = randomUUID(), words = "and keep the old parser"
      owner.submit(conversation, steer, words)
      const steerInto = () => owner.act(conversation, { kind: "steer-queued", id: randomUUID(), requestId: next, queuedRequestId: steer, text: words, attachments: [] })
      const steeredBefore = steered.length
      await assert.rejects(steerInto(), /finish its pending operation/, "a steer waits while a capture still reads the live files")
      assert.equal(steered.length, steeredBefore, "the agent hears nothing while the read runs")
      writeFileSync(file, "the next agent wrote while the previous closing read was held")
      releaseRead.resolve()
      // Both reads are fixed: the closing one, and the next turn's own late before-capture queued behind it.
      await until(() => owner.snapshot(conversation)?.requests[0].snapshots?.after !== undefined && owner.snapshot(conversation)?.requests[1].snapshots?.before !== undefined && /after the turn went/.test(JSON.stringify(owner.snapshot(conversation)?.requests[1].snapshots?.before)))
      const receipt = await steerInto()
      assert.equal(receipt.state.kind, "accepted", "once the read is fixed, the steer goes into the running turn")
      assert.equal(steered.at(-1), words)
      const after = owner.snapshot(conversation)?.requests[0].snapshots?.after
      assert.ok(after?.kind === "unavailable" && /next turn/.test(after.reason), "a late closing read cannot publish the next agent's edits as the previous turn's after-point")
      finish(conversation, "next answer")
      await until(() => owner.snapshot(conversation)?.requests[1].snapshots?.after !== undefined)
    } finally {
      releaseRead.resolve()
      timer.mock.restore()
      capture.mock.restore()
    }
    console.log("PASS: the next before-point deadline still applies; an overlapping closing read is unavailable, while rewind stays blocked")
  }

  // Expire the requested checkpoint timer explicitly: elapsed wall time is a diagnostic, not a timer guarantee.
  for (const failure of [false, true]) {
    await owner.stop()
    const timeouts: number[] = []
    owner = new LiveConversations({ ...dependencies, checkpointWaitMs: 200, checkpointTimedOut: (waitedMs) => {
      timeouts.push(waitedMs)
      if (failure) throw new Error("telemetry unavailable")
    } })
    const lateId = randomUUID(), lateRequest = randomUUID()
    await owner.start("test", cwd, { conversationId: lateId })
    await until(() => owner.snapshot(lateId)?.session.status === "ready")
    let release = () => {}
    const holding = new Promise<void>((resolve) => (release = resolve))
    const warned: unknown[] = []
    const unlog = followHostLog((line) => {
      if (line.scope === "checkpoints" && line.message === "a turn went before its checkpoint held the workspace" && line.fields?.conversation === lateId) warned.push(line.fields.waitedMs)
    })
    let expire: (() => void) | undefined, capturing = false
    const delays: number[] = []
    const schedule = globalThis.setTimeout
    const timer = mock.method(globalThis, "setTimeout", (callback: (...args: unknown[]) => void, ms: number, ...args: unknown[]) => {
      if (ms !== 200) return schedule(callback, ms, ...args)
      delays.push(ms)
      expire = () => callback(...args)
      return schedule(() => {}, 60_000).unref()
    })
    const original = snapshots.beginRun.bind(snapshots)
    const beginRun = mock.method(snapshots, "beginRun", async (id: string, folder: string, frozen?: () => void) => {
      capturing = true
      await holding
      if (failure) throw new Error("late checkpoint failed")
      return original(id, folder, frozen)
    })
    try {
      const sentBefore: number = sent.length
      owner.submit(lateId, lateRequest, "late checkpoint")
      await until(() => capturing && expire !== undefined)
      assert.deepEqual(delays, [200], "the checkpoint requests its configured wait exactly once")
      assert.equal(sent.length, sentBefore, "a held checkpoint does not dispatch before its deadline fires")
      assert.deepEqual(timeouts, [], "no timeout diagnostic before the deadline fires")
      assert.ok(expire)
      expire()
      await until(() => sent.length === sentBefore + 1)
      assert.equal(owner.snapshot(lateId)?.requests[0].snapshots?.before.kind, "unavailable", "the turn went without its checkpoint, and says so")
      const missed = owner.snapshot(lateId)?.requests[0].snapshots?.before
      assert.ok(missed?.kind === "unavailable")
      assert.equal(missed.timedOut, true, "the turn can say its checkpoint missed the dispatch deadline")
      assert.equal(timeouts.length, 1, "one timeout diagnostic per turn, even when telemetry throws")
      assert.ok(Number.isFinite(timeouts[0]) && timeouts[0]! >= 0, "the diagnostic measures elapsed time")
      assert.deepEqual(timeouts, warned, "telemetry receives the same measured elapsed time as the host warning")
      writeFileSync(file, "the agent wrote before the delayed capture held the workspace")
      release()
      // Held after the turn went, it may hold the turn's own edits: it never becomes the turn's `before`.
      const reasonOf = () => { const before = owner.snapshot(lateId)?.requests[0].snapshots?.before; return before?.kind === "unavailable" ? before.reason : "" }
      await until(() => failure ? reasonOf() === "late checkpoint failed" : /after the turn went/.test(reasonOf()))
      assert.equal(owner.snapshot(lateId)?.requests[0].snapshots?.before.kind, "unavailable", "a late checkpoint is never the turn's before")
      const late = owner.snapshot(lateId)?.requests[0].snapshots?.before
      assert.ok(late?.kind === "unavailable")
      assert.equal(late.timedOut, failure ? undefined : true, "a real capture failure keeps its own reason, while an unsafe late point retains the timeout notice")
      finish(lateId, "late answer")
      await until(() => owner.snapshot(lateId)?.requests[0].snapshots?.after?.kind === (failure ? "unavailable" : "ready"))
      await assert.rejects(owner.previewRewind(lateId, lateRequest, "before"), failure ? /late checkpoint failed/ : /no workspace checkpoint at that point: The checkpoint held the workspace .* after the turn went/, "a rewind to before it refuses, and says why")
    } finally {
      timer.mock.restore()
      unlog()
      beginRun.mock.restore()
      release()
    }
    console.log(failure ? "PASS: a failed late checkpoint replaces the timeout notice with its actual stored failure reason" : "PASS: a checkpoint held past the deadline lets the turn go; held late, it is never the turn's before, and a rewind to it refuses")
  }
} finally {
  await owner.stop()
  while (captures.size) await Promise.allSettled([...captures])
  snapshots.close()
  await gitRunner.close()
  rmSync(root, { recursive: true, force: true })
}
