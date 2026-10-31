import type { SessionSettings } from "@mako/sessions/settings"
import { Git } from "@mako/git"
import assert from "node:assert/strict"
import { mock } from "node:test"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { z } from "zod"
import { randomUUID } from "node:crypto"
import { LiveConversations } from "@mako/host/conversations/live-conversations"
import { JournalWriteError, LiveJournal } from "@mako/host/conversations/live-journal"
import { followHostLog, type HostLogLine } from "@mako/host/base/host-log"
import { SessionMemory } from "@mako/host/threads/session-memory"
import { WorkspaceSnapshots } from "@mako/host/workspaces/snapshots"
import { reduceLiveUpdates, type LiveUpdate } from "@mako/sessions/live-content"
import { CONNECTION_LOST_STOP, RETRIES_EXHAUSTED_STOP } from "@mako/host/contracts/providers-acp"
import { LIVE_FRAME_MS, type LiveDriverEvent } from "@mako/host/contracts/live-conversations"
import type { LiveSessionState } from "@mako/host/contracts/providers-acp"
import type { HostEvent } from "@mako/host/contracts/host-events-boot"
import type { ProviderLiveDriver } from "@mako/host/harnesses/live-driver"
import { preparePrompt, TurnInProgressError } from "@mako/host/harnesses/prompt-dispatch"
import { NO_NATIVE_EXCLUSION } from "@mako/host/contracts/execution-context"
import { NO_NATIVE_PROMPT_IDENTITY } from "@mako/host/contracts/native-prompt-identity"
import { projectLive } from "../src/state/live-projection.js"
import { compactionAvailable } from "@mako/host/contracts/recovery"
import { continueTurnPrompt, savedContinuation } from "@mako/host/contracts/turn-continuation"
import { fixtureResume, noCapabilities } from "./fixtures/driver-capabilities.ts"
import { namedWork } from "@mako/host/base/event-loop"
import { BULK_LOADS } from "@mako/host/conversations/live-records"
import { ownedSessions } from "@mako/host/conversations/session-report"
import { ThreadArchives } from "@mako/host/threads/archives"
import { ThreadLifecycle } from "@mako/host/threads/lifecycle"
import { OlderRequestSchema } from "./fixtures/older-request-schema.ts"

const gitRunner = new Git()

const fixtureCapabilities = {
  ...noCapabilities,
  approvalEvidence: { kind: "submission-only", reason: "Injected driver fixture" },
  launchEnvironment: { kind: "unavailable", reason: "Injected driver fixture" },
  nativeIdentity: { kind: "unavailable", reason: "Injected driver fixture" },
  nativeExclusion: NO_NATIVE_EXCLUSION,
  nativePromptIdentity: NO_NATIVE_PROMPT_IDENTITY,
  planning: { via: "setting", option: "plan", proposal: "Injected driver fixture", feedback: { kind: "next-message", reason: "Injected driver fixture" } },
  backgroundStop: { kind: "ends-with-turn", evidence: "Injected driver fixture" },
  turnRecovery: { kind: "manual", reason: "Injected driver fixture" },
} satisfies Partial<ProviderLiveDriver>

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
const waitFor = async (predicate: () => boolean, message: string) => {
  const timeout = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() >= timeout) throw new Error(message)
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
}
function deferred<Value>() {
  let resolve!: (value: Value) => void
  let reject!: (error: Error) => void
  const promise = new Promise<Value>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function fixture(options: { autoContinueDelayMs?: number } = {}) {
  /** A conversation Mako couldn't save is tried again this soon (`SAVE_AGAIN_MS`). */
  const saveAgainMs = 20
  const root = mkdtempSync(join(tmpdir(), "mako-live-test-"))
  const id = randomUUID()
  const state: LiveSessionState = {
    id,
    nativeId: "native-1",
    harness: "test-provider",
    cwd: "/tmp",
    status: "ready",
    connection: "connected",
    modes: [],
    currentMode: null,
    configOptions: [],
  }
  const started = deferred<LiveSessionState>()
  const sent: string[] = []
  const settings: (SessionSettings | undefined)[] = []
  const prompts: ReturnType<typeof deferred<void>>[] = []
  const events: HostEvent[] = []
  let closed = 0
  let cancels = 0
  const driver: ProviderLiveDriver = {
    ...fixtureCapabilities,
    resume: fixtureResume(),
    provider: "test-provider",
    available: () => true,
    start: () => started.promise,
    prompt: async (_id, text, _attachments, tuning, dispatch) => {
      // Sent, as every driver reports it: a turn that ends from here on is this message's.
      dispatch.report({ kind: "submitted", source: "transport-call" })
      sent.push(text)
      settings.push(tuning)
      const pending = deferred<void>()
      prompts.push(pending)
      await pending.promise
    },
    permission: async () => {},
    cancel: async () => {
      cancels++
    },
    close: () => {
      closed++
    },
    setMode: async () => {},
  }
  const dependencies = {
    appPath: root,
    root,
    driver: () => driver,
    history: async () => null,
    emit: (event: HostEvent) => events.push(event),
    autoContinueDelayMs: options.autoContinueDelayMs,
    saveAgainMs,
  }
  const owner = new LiveConversations(dependencies)
  return {
    root,
    id,
    state,
    started,
    sent,
    settings,
    prompts,
    events,
    owner,
    dependencies,
    closed: () => closed,
    cancels: () => cancels,
    cleanup: () => {
      owner.stop()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

/**
 * What the account's list reads of a conversation is said as it changes. A new one is said once it's written, before
 * its harness starts and its first batch comes (`opened`). A turn's end is said by a batch: the "after" checkpoint it
 * waits for is over by the last batch it sends, so whatever reads the conversation's work as that batch comes
 * (`SessionPublisher.own`) reads it at rest, not still finishing with nothing after to say it stopped.
 */
async function turnEndBatchSaysItsWorkEnded() {
  const root = mkdtempSync(join(tmpdir(), "mako-live-turn-end-"))
  const id = randomUUID()
  const emitters: Array<(event: LiveDriverEvent) => void> = []
  const session = (bindingId: string, status: LiveSessionState["status"] = "ready"): LiveSessionState => ({
    id: bindingId, nativeId: "native-turn-end", nativePath: join(root, "native"), harness: "test-provider", cwd: root,
    status, connection: "connected", modes: [], currentMode: null, configOptions: [],
  })
  const driver: ProviderLiveDriver = {
    ...fixtureCapabilities,
    resume: fixtureResume(),
    provider: "test-provider",
    available: () => true,
    start: async (_cwd, options) => {
      if (options.emit) emitters.push(options.emit)
      return session(options.conversationId)
    },
    prompt: async (bindingId, _text, _attachments, _settings, dispatch) => {
      dispatch.report({ kind: "submitted", source: "transport-call" })
      emitters.at(-1)?.({ type: "live-session", session: session(bindingId, "running") })
      emitters.at(-1)?.({ type: "live-session", session: session(bindingId) })
    },
    permission: async () => {},
    cancel: async () => {},
    close: async () => {},
    setMode: async () => {},
  }
  // What the conversation was working on as each of its batches came, and how many had come when it was said opened.
  const workAtBatch: Array<string | undefined> = []
  const openedAfter: Array<[string, number]> = []
  const owner: LiveConversations = new LiveConversations({
    appPath: root, root: join(root, "journals"), driver: () => driver, history: async () => null,
    emit: (event) => {
      if (event.type === "live-batch" && event.batch.id === id) workAtBatch.push(owner.workOf(id)?.status)
    },
    opened: (conversation) => void openedAfter.push([conversation, workAtBatch.length]),
    providerIdleMs: 60_000,
    workspaceSnapshots: new WorkspaceSnapshots(gitRunner, join(root, "workspace-snapshots")),
  })
  try {
    await owner.start("test-provider", root, { conversationId: id })
    assert.deepEqual(openedAfter, [[id, 0]], "a new conversation is said once it's written, before its first batch")
    owner.submit(id, randomUUID(), "a turn")
    await waitFor(() => owner.snapshot(id)?.requests[0]?.snapshots?.after !== undefined, "the turn's after checkpoint")
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(owner.workOf(id), undefined, "nothing works once the turn is over")
    assert.equal(workAtBatch.at(-1), undefined, "and its last batch said so, not that it was still finishing")
    console.log("PASS: a new conversation is said before its harness starts, and a turn's last batch, after its checkpoint, says its work is over")
  } finally {
    owner.stop()
    rmSync(root, { recursive: true, force: true })
  }
}

/** Compaction is offered on an idle conversation, so asking for it reconnects first, as a follow-up would. */
async function compactsAfterHibernation() {
  const root = mkdtempSync(join(tmpdir(), "mako-live-compact-idle-"))
  const memory = new SessionMemory(join(root, "session-memory.sqlite"), { pid: 11_101, startedAt: Date.now(), label: "the compaction test host" }, { alive: () => true })
  const id = randomUUID()
  const nativePath = join(root, "native-session")
  const emitters: Array<(event: LiveDriverEvent) => void> = []
  const compacted: string[] = []
  let starts = 0
  const session = (bindingId: string, status: LiveSessionState["status"] = "ready"): LiveSessionState => ({
    id: bindingId, nativeId: "native-compact", nativePath, harness: "test-provider", cwd: root,
    status, connection: "connected", modes: [], currentMode: null, configOptions: [],
  })
  const driver: ProviderLiveDriver = {
    ...fixtureCapabilities,
    resume: fixtureResume(),
    provider: "test-provider",
    available: () => true,
    start: async (_cwd, options) => {
      starts++
      if (options.emit) emitters.push(options.emit)
      return session(options.conversationId)
    },
    prompt: async (bindingId, _text, _attachments, _settings, dispatch) => {
      dispatch.report({ kind: "submitted", source: "transport-call" })
      emitters.at(-1)?.({ type: "live-session", session: session(bindingId, "running") })
      emitters.at(-1)?.({ type: "live-session", session: session(bindingId) })
    },
    permission: async () => {},
    cancel: async () => {},
    close: async () => {},
    setMode: async () => {},
    compaction: { kind: "supported", start: async (bindingId) => { compacted.push(bindingId) } },
  }
  const owner = new LiveConversations({
    appPath: root, root: join(root, "journals"), driver: () => driver, history: async () => null, emit: () => {},
    memory, providerIdleMs: 15, providerWarmLimit: 2,
    resumeVerdict: async () => ({ kind: "resumable", record: "same" }),
    workspaceSnapshots: new WorkspaceSnapshots(gitRunner, join(root, "workspace-snapshots")),
  })
  try {
    await owner.start("test-provider", root, { conversationId: id })
    owner.submit(id, randomUUID(), "seed")
    await waitFor(() => owner.snapshot(id)?.session.connection === "hibernated", "the idle provider did not hibernate")
    const snapshot = owner.snapshot(id)!
    assert.ok(compactionAvailable(snapshot.session, snapshot.control?.actions ?? [], false), "the window offers compaction on a hibernated conversation")
    const action = await owner.act(id, { kind: "compact", id: randomUUID() })
    assert.equal(action.state.kind, "accepted")
    assert.equal(starts, 2, "compaction resumes the native session once")
    assert.deepEqual(compacted, [owner.snapshot(id)?.control?.activeBindingId], "compaction runs on the resumed binding")
    console.log("PASS: compacting a hibernated conversation resumes it once, then compacts")
  } finally {
    owner.stop()
    memory.close()
    rmSync(root, { recursive: true, force: true })
  }
}

/**
 * The host quit inside a first turn whose native record was never reported:
 * after a restart the mode can still be chosen, and the follow-up resumes the
 * same native session from the record the driver finds by its ID.
 */
async function resumesAfterQuitInFirstTurn() {
  const root = mkdtempSync(join(tmpdir(), "mako-live-unlocated-"))
  const nativePath = join(root, "native-unlocated.jsonl")
  const id = randomUUID()
  const starts: Array<{ resume?: string; modeId?: string }> = []
  const prompts: string[] = []
  const emitters: Array<(event: LiveDriverEvent) => void> = []
  const session = (bindingId: string, patch: Partial<LiveSessionState> = {}): LiveSessionState => ({
    id: bindingId, nativeId: "native-unlocated", harness: "test-provider", cwd: root, status: "ready", connection: "connected",
    modes: [{ id: "plan", name: "Plan" }, { id: "full", name: "Full" }], currentMode: "full", configOptions: [], ...patch,
  })
  const driver: ProviderLiveDriver = {
    ...fixtureCapabilities,
    resume: fixtureResume({ locate: async (binding) => binding.nativeId === "native-unlocated" ? nativePath : undefined }),
    provider: "test-provider",
    available: () => true,
    start: async (_cwd, options) => {
      starts.push({ resume: options.resume, modeId: options.modeId })
      if (options.emit) emitters.push(options.emit)
      return session(options.conversationId, { currentMode: options.modeId ?? "full", nativePath: options.resume ? nativePath : undefined })
    },
    prompt: async (bindingId, text, _attachments, _settings, dispatch) => {
      dispatch.report({ kind: "submitted", source: "transport-call" })
      prompts.push(text)
      emitters.at(-1)?.({ type: "live-session", session: session(bindingId, { status: "running", nativePath: starts.length > 1 ? nativePath : undefined }) })
      if (starts.length > 1) emitters.at(-1)?.({ type: "live-session", session: session(bindingId, { nativePath }) })
    },
    permission: async () => {},
    cancel: async () => {},
    close: async () => {},
    setMode: async () => {},
  }
  const dependencies = (memory: SessionMemory): ConstructorParameters<typeof LiveConversations>[0] => ({
    appPath: root, root: join(root, "journals"), driver: () => driver, history: async () => null, emit: () => {}, memory,
    resumeVerdict: async (binding) => binding.path ? { kind: "resumable", record: "same" } : { kind: "unavailable", reason: "The native session identity or source has not been located." },
    workspaceSnapshots: new WorkspaceSnapshots(gitRunner, join(root, "workspace-snapshots")),
  })
  const firstMemory = new SessionMemory(join(root, "memory.sqlite"), { pid: 11_201, startedAt: Date.now(), label: "the host that quits" }, { alive: () => true })
  const first = new LiveConversations(dependencies(firstMemory))
  await first.start("test-provider", root, { conversationId: id })
  first.submit(id, randomUUID(), "Ask me a question")
  await waitFor(() => first.snapshot(id)?.session.status === "running", "the first turn did not start")
  await first.stop()
  firstMemory.close()
  const memory = new SessionMemory(join(root, "memory.sqlite"), { pid: 11_202, startedAt: Date.now(), label: "the restarted host" }, { alive: () => true })
  const owner = new LiveConversations(dependencies(memory))
  try {
    const reopened = owner.snapshot(id)
    assert.ok(reopened)
    assert.equal(reopened.control?.bindings[0]?.path, undefined, "the quit host never learned the record's path")
    await owner.setMode(id, "plan")
    assert.equal(owner.snapshot(id)?.session.currentMode, "plan", "a mode chosen after the restart is kept for the reopen")
    owner.submit(id, randomUUID(), "Reply with only OK")
    await waitFor(() => prompts.length === 2, "the follow-up after the restart was never sent")
    assert.deepEqual(starts.at(-1), { resume: "native-unlocated", modeId: "plan" }, "the follow-up resumes the same native session in the chosen mode")
    assert.equal(owner.snapshot(id)?.control?.bindings.find((binding) => binding.id === owner.snapshot(id)?.control?.activeBindingId)?.path, nativePath)
    console.log("PASS: a session the host quit inside its first turn resumes after a restart, in the mode chosen meanwhile")
  } finally {
    await owner.stop()
    memory.close()
    rmSync(root, { recursive: true, force: true })
  }
}

/**
 * A conversation that resumed a native session with records (a Thread arriving from another device) can close its
 * provider before its first turn here, since the same session opens again from them; one that started fresh can't
 * until a turn wrote its record.
 */
async function resumedHibernatesBeforeATurn() {
  const root = mkdtempSync(join(tmpdir(), "mako-live-resumed-hibernate-"))
  let closes = 0
  const driver: ProviderLiveDriver = {
    ...fixtureCapabilities,
    resume: fixtureResume(),
    provider: "test-provider",
    available: () => true,
    start: async (_cwd, options) => ({
      id: options.conversationId, nativeId: options.resume ?? `fresh-${options.conversationId}`, nativePath: join(root, "native-session"),
      harness: "test-provider", cwd: root, status: "ready", connection: "connected", modes: [], currentMode: null, configOptions: [],
    }),
    prompt: async (_id, _text, _attachments, _settings, dispatch) => {
      dispatch.report({ kind: "submitted", source: "transport-call" })
    },
    permission: async () => {},
    cancel: async () => {},
    close: async () => void closes++,
    setMode: async () => {},
  }
  const owner = new LiveConversations({ appPath: root, root: join(root, "journals"), driver: () => driver, history: async () => null, emit: () => {}, providerIdleMs: 15, providerWarmLimit: 2, resumeVerdict: async () => ({ kind: "resumable", record: "same" }) })
  try {
    const fresh = randomUUID()
    const resumed = randomUUID()
    await owner.start("test-provider", root, { conversationId: fresh })
    await owner.start("test-provider", root, { conversationId: resumed, resume: "native-arrived" })
    await waitFor(() => owner.snapshot(resumed)?.session.connection === "hibernated", "the resumed provider did not hibernate")
    assert.equal(owner.snapshot(resumed)?.control?.bindings[0]?.resumed, true, "its binding says it opened a session with records")
    assert.equal(owner.snapshot(fresh)?.session.connection, "connected", "a fresh one waits for a turn's record")
    assert.equal(closes, 1)
    console.log("PASS: a resumed session can close before its first turn here; a fresh one waits for a turn")
  } finally {
    owner.stop()
    rmSync(root, { recursive: true, force: true })
  }
}

async function hibernatesAndWakesExactlyOnce(missingAssessment: boolean | "close-during-preparation" | "changed-store" = false) {
  const root = mkdtempSync(join(tmpdir(), "mako-live-hibernate-"))
  const memoryPath = join(root, "session-memory.sqlite")
  const memory = new SessionMemory(memoryPath, {
    pid: 11_001,
    startedAt: Date.now(),
    label: "the first test host",
  }, { alive: () => true })
  const observer = new SessionMemory(
    memoryPath,
    {
      pid: 11_002,
      startedAt: Date.now(),
      label: "the second test host",
    },
    { alive: () => true }
  )
  const workspaceSnapshots = new WorkspaceSnapshots(gitRunner, 
    join(root, "workspace-snapshots")
  )
  const id = randomUUID()
  const nativePath = join(root, "native-session")
  let starts = 0
  let closes = 0
  let releaseFirstClose: (() => void) | undefined
  let firstClosePending = true
  const prompts: string[] = []
  const emitters: Array<(event: LiveDriverEvent) => void> = []
  const startModes: Array<string | undefined> = []
  const startTunings: Array<SessionSettings | undefined> = []
  const session = (
    bindingId: string,
    currentMode: string | null = null
  ): LiveSessionState => ({
    id: bindingId,
    nativeId: "native-hibernate",
    nativePath: missingAssessment === "changed-store" && starts > 1 ? join(root, "another-account-store") : nativePath,
    harness: "test-provider",
    cwd: root,
    status: "ready",
    connection: "connected",
    modes: [{ id: "full", name: "Full" }],
    currentMode,
    configOptions: [],
  })
  const driver: ProviderLiveDriver = {
    ...fixtureCapabilities,
    resume: fixtureResume(),
    provider: "test-provider",
    available: () => true,
    start: async (_cwd, options) => {
      starts++
      if (options.emit) emitters.push(options.emit)
      startModes.push(options.modeId)
      startTunings.push(options.tuning)
      const opened = session(options.conversationId, options.modeId ?? null)
      if (missingAssessment === "changed-store" && starts > 1)
        options.emit?.({ type: "live-session", session: opened })
      return opened
    },
    prompt: async (bindingId, text, _attachments, _settings, dispatch) => {
      dispatch.report({ kind: "submitted", source: "transport-call" })
      prompts.push(text)
      emitters.at(-1)?.({
        type: "live-session",
        session: {
          ...session(bindingId, startModes.at(-1) ?? null),
          status: "running",
        },
      })
      emitters.at(-1)?.({
        type: "live-session",
        session: session(bindingId, startModes.at(-1) ?? null),
      })
    },
    permission: async () => {},
    cancel: async () => {},
    close: async () => {
      closes++
      if (firstClosePending) {
        firstClosePending = false
        await new Promise<void>((resolve) => {
          releaseFirstClose = resolve
        })
      }
    },
    setMode: async () => {},
  }
  const dependencies: ConstructorParameters<typeof LiveConversations>[0] = {
    appPath: root,
    root: join(root, "journals"),
    driver: () => driver,
    history: async () => null,
    emit: () => {},
    memory,
    providerIdleMs: 15,
    providerWarmLimit: 2,
    resumeVerdict: async () => ({ kind: "resumable", record: "same" }),
    workspaceSnapshots,
  }
  const owner = new LiveConversations(dependencies)
  try {
    await owner.start("test-provider", root, { conversationId: id })
    await new Promise<void>((resolve) => setTimeout(resolve, 30))
    assert.equal(
      owner.snapshot(id)?.session.connection,
      "connected",
      "a provider with no completed turn is not yet safe to resume"
    )
    owner.submit(id, randomUUID(), "seed before hibernation")
    await waitFor(
      () => owner.snapshot(id)?.requests[0]?.status === "completed",
      "the seed turn did not complete"
    )
    await waitFor(
      () => closes === 1,
      "the idle provider did not begin closing"
    )
    assert.equal(
      owner.snapshot(id)?.session.connection,
      "connected",
      "hibernation is not published before provider exit"
    )
    assert.equal(
      observer.heldBy("test-provider", "native-hibernate")?.conversationId,
      id,
      "the native hold remains until provider exit"
    )
    releaseFirstClose?.()
    await waitFor(
      () => owner.snapshot(id)?.session.connection === "hibernated",
      "the idle provider did not finish hibernating"
    )
    assert.equal(starts, 1)
    assert.equal(closes, 1)
    assert.equal(
      observer.heldBy("test-provider", "native-hibernate"),
      null,
      "hibernation releases exclusive native ownership"
    )
    await owner.setMode(id, "full")
    assert.equal(starts, 1, "changing a hibernated mode does not wake a process")

    if (missingAssessment === "close-during-preparation") {
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      dependencies.tools = async () => { entered.resolve(); await release.promise; return undefined }
      owner.submit(id, randomUUID(), "close during wake preparation")
      await entered.promise
      const closing = owner.close(id)
      release.resolve()
      await closing
      assert.equal(starts, 1, "closing during async wake preparation never spawns a replacement provider")
      assert.equal(prompts.length, 1, "the queued prompt cannot dispatch after close")
      assert.equal(observer.heldBy("test-provider", "native-hibernate"), null)
      return
    }
    if (missingAssessment === "changed-store") {
      owner.submit(id, randomUUID(), "must not send to another store")
      await waitFor(() => owner.snapshot(id)?.requests[1]?.status === "failed", "a changed native source did not refuse wake")
      assert.equal(starts, 2, "the native runtime reported its actual reopened source")
      assert.equal(prompts.length, 1, "no queued prompt reaches a different account's store")
      assert.equal(owner.snapshot(id)?.control?.bindings[0]?.path, nativePath, "a refused wake preserves its admitted binding")
      assert.equal(closes, 2, "the incompatible native session closes once")
      assert.equal(observer.heldBy("test-provider", "native-hibernate"), null)
      return
    }
    if (missingAssessment) {
      delete dependencies.resumeVerdict
      const refused = randomUUID()
      owner.submit(id, refused, "must not wake without evidence")
      await waitFor(() => owner.snapshot(id)?.requests.find(request => request.id === refused)?.status === "failed", "missing recovery evidence did not refuse wake")
      assert.equal(starts, 1, "no provider spawn without an assessment")
      assert.equal(prompts.length, 1, "no prompt replay or duplicate dispatch")
      assert.equal(observer.heldBy("test-provider", "native-hibernate"), null)
      return
    }

    owner.submit(id, randomUUID(), "first after wake", [], {
      model: "new-model",
    })
    owner.submit(id, randomUUID(), "second after wake")
    await waitFor(
      () => prompts.length === 3,
      "queued prompts did not drain after waking"
    )
    assert.equal(starts, 2, "concurrent prompts share one provider wake")
    assert.equal(startModes[1], "full", "the saved mode applies at wake")
    assert.deepEqual(
      startTunings[1],
      { model: "new-model" },
      "the first queued turn's settings apply at wake"
    )
    assert.deepEqual(prompts, [
      "seed before hibernation",
      "first after wake",
      "second after wake",
    ])
    assert.equal(owner.snapshot(id)?.session.connection, "connected")
    assert.equal(
      observer.heldBy("test-provider", "native-hibernate")?.conversationId,
      id,
      "wake reacquires native ownership before dispatch"
    )
    emitters[0]?.({
      type: "live-session",
      session: {
        ...session(id, "full"),
        status: "closed",
        connection: "disconnected",
      },
    })
    assert.equal(
      owner.snapshot(id)?.session.connection,
      "connected",
      "a late event from the retired generation cannot disconnect the wake"
    )

    await waitFor(
      () => owner.snapshot(id)?.session.connection === "hibernated",
      "the woken provider did not become idle again"
    )
    const persisted = new LiveJournal(join(root, "journals"), id)
    assert.equal(
      persisted.read()?.session.connection,
      "hibernated",
      "a hibernated session survives journal validation and reopen"
    )
    persisted.close()
    observer.hold("test-provider", "native-hibernate", "other-conversation")
    const refused = randomUUID()
    owner.submit(id, refused, "must not double-open")
    await waitFor(
      () =>
        owner.snapshot(id)?.requests.find((request) => request.id === refused)
          ?.status === "failed",
      "a competing host hold did not refuse the wake"
    )
    assert.equal(starts, 2, "ownership refusal happens before provider spawn")
    assert.equal(owner.snapshot(id)?.session.connection, "disconnected")
    observer.release(
      "test-provider",
      "native-hibernate",
      "other-conversation"
    )
  } finally {
    owner.stop()
    workspaceSnapshots.close()
    observer.close()
    memory.close()
    rmSync(root, { recursive: true, force: true })
  }
}

async function closeBeforeNativeSpawn() {
  for (const phase of ["tools", "environment"] as const) {
    const f = fixture()
    const entered = deferred<void>()
    const released = deferred<void>()
    let starts = 0
    const driver: ProviderLiveDriver = { ...f.dependencies.driver(), start: async () => { starts++; return f.state } }
    const prepare = async () => { entered.resolve(); await released.promise; return undefined }
    const owner = new LiveConversations({ ...f.dependencies, driver: () => driver,
      tools: phase === "tools" ? prepare : undefined,
      threadEnvironment: phase === "environment" ? prepare : undefined,
    })
    try {
      await owner.start(driver.provider, f.state.cwd, { conversationId: f.id })
      owner.submit(f.id, randomUUID(), "must remain unsent")
      await entered.promise
      const closing = owner.close(f.id)
      released.resolve()
      await closing
      assert.equal(starts, 0, `Close during ${phase} preparation prevents a native spawn`)
      assert.equal(f.sent.length, 0)
      assert.equal(owner.snapshot(f.id)!.session.status, "closed")
    } finally {
      released.resolve()
      await owner.stop()
      f.cleanup()
    }
  }
}

async function boundsWarmProviders() {
  const root = mkdtempSync(join(tmpdir(), "mako-live-warm-pool-"))
  const ids = [randomUUID(), randomUUID(), randomUUID()]
  const closed: string[] = []
  let owner: LiveConversations
  const driver: ProviderLiveDriver = {
    ...fixtureCapabilities,
    resume: fixtureResume(),
    provider: "test-provider",
    available: () => true,
    start: async (_cwd, options) => ({
      id: options.conversationId,
      nativeId: options.conversationId,
      nativePath: join(root, options.conversationId),
      harness: "test-provider",
      cwd: root,
      status: "ready",
      connection: "connected",
      modes: [],
      currentMode: null,
      configOptions: [],
    }),
    prompt: async (id, _text, _attachments, _settings, dispatch) => {
      dispatch.report({ kind: "submitted", source: "transport-call" })
      const current = owner.snapshot(id)?.session
      assert.ok(current)
      owner.observe({
        type: "live-session",
        session: { ...current, status: "running" },
      })
      owner.observe({
        type: "live-session",
        session: { ...current, status: "ready" },
      })
    },
    permission: async () => {},
    cancel: async () => {},
    close: (id) => {
      closed.push(id)
    },
    setMode: async () => {},
  }
  owner = new LiveConversations({
    appPath: root,
    root: join(root, "journals"),
    driver: () => driver,
    history: async () => null,
    emit: () => {},
    providerIdleMs: 60_000,
    providerWarmLimit: 2,
    resumeVerdict: async () => ({ kind: "resumable", record: "same" }),
  })
  try {
    for (const id of ids) {
      await owner.start("test-provider", root, { conversationId: id })
      const requestId = randomUUID()
      owner.submit(id, requestId, "seed")
      await waitFor(
        () =>
          owner
            .snapshot(id)
            ?.requests.some(
              (request) =>
                request.id === requestId && request.status === "completed"
            ) === true,
        "a warm-pool seed turn did not complete"
      )
    }
    await waitFor(
      () => owner.snapshot(ids[0])?.session.connection === "hibernated",
      "the warm pool did not retire its oldest provider"
    )
    assert.deepEqual(closed, [ids[0]])
    assert.equal(owner.snapshot(ids[1])?.session.connection, "connected")
    assert.equal(owner.snapshot(ids[2])?.session.connection, "connected")
    assert.deepEqual(
      {
        active: owner.residency().active,
        warm: owner.residency().warm,
        hibernated: owner.residency().hibernated,
      },
      { active: 0, warm: 2, hibernated: 1 },
      "Diagnostics distinguishes work from retained and hibernated processes"
    )
  } finally {
    owner.stop()
    rmSync(root, { recursive: true, force: true })
  }
}

/**
 * The Sessions report and the Thread lifecycle read the listing, never a journal: with every conversation out of
 * memory, a report and an archive check load none. And a reader that does load in bulk is named in the log and in
 * the memory readout, by the work it ran as.
 */
async function bulkLoadsAreNamed() {
  const root = mkdtempSync(join(tmpdir(), "mako-live-bulk-"))
  const work = namedWork()
  const ids = Array.from({ length: BULK_LOADS + 1 }, () => randomUUID())
  let owner: LiveConversations
  const driver: ProviderLiveDriver = {
    ...fixtureCapabilities,
    resume: fixtureResume(),
    provider: "test-provider",
    available: () => true,
    start: async (_cwd, options) => ({
      id: options.conversationId,
      nativeId: options.conversationId,
      nativePath: join(root, options.conversationId),
      harness: "test-provider",
      cwd: root,
      status: "ready",
      connection: "connected",
      modes: [],
      currentMode: null,
      configOptions: [],
    }),
    prompt: async (prompted, _text, _attachments, _settings, dispatch) => {
      dispatch.report({ kind: "submitted", source: "transport-call" })
      const current = owner.snapshot(prompted)?.session
      assert.ok(current)
      owner.observe({ type: "live-update", id: prompted, update: { kind: "text", text: "kept" } })
      owner.observe({ type: "live-session", session: { ...current, status: "running" } })
      owner.observe({ type: "live-session", session: { ...current, status: "ready" } })
    },
    permission: async () => {},
    cancel: async () => {},
    close: () => {},
    setMode: async () => {},
  }
  owner = new LiveConversations({
    appPath: root,
    root: join(root, "journals"),
    driver: () => driver,
    history: async () => null,
    emit: () => {},
    work,
    providerIdleMs: 50,
    providerWarmLimit: 1,
    conversationMemory: { bytes: 0, recent: 0, sweepMs: 0 },
    resumeVerdict: async () => ({ kind: "resumable", record: "same" }),
  })
  const warned: HostLogLine[] = []
  const stopHearing = followHostLog((line) => { if (line.scope === "residency" && line.level === "warn") warned.push(line) })
  try {
    for (const id of ids) {
      await owner.start("test-provider", root, { conversationId: id })
      owner.submit(id, randomUUID(), "seed")
    }
    await waitFor(() => owner.residency().memory.unloaded === ids.length, "the idle conversations were not all unloaded")

    // The report, over every conversation of the host, loads none: it's a function of the listing.
    const archives = new ThreadArchives(join(root, "archives.sqlite"))
    const lifecycle = new ThreadLifecycle({ live: owner, archives, native: { list: () => [], editQueued: () => [] }, threads: () => [], nativeToken: () => null, abortNative: () => {}, external: () => false })
    const sources = {
      summaries: () => owner.summaries(),
      native: () => [],
      activity: () => undefined,
      work: () => [],
      waitingOn: (id: string) => owner.waitingOn(id),
      hidden: () => new Set(archives.snapshot().keys),
      lastMoved: (id: string, revision: number) => owner.lastMoved(id, revision),
      // SAFETY: test IDs in the Thread store's shapes, which brand plain UUIDs.
      placement: (id: string) => ({ thread: id, session: id }) as never,
      executions: () => new Map(),
      titles: () => new Map(),
      now: Date.now,
    }
    const rows = work.run("tell the account this host's Sessions", () => ownedSessions(sources))
    assert.equal(rows.length, ids.length, "every conversation is listed")
    for (const id of ids) assert.equal(work.run("archive check", () => lifecycle.archived({ kind: "live", id })), false)
    lifecycle.archive({ id: randomUUID(), target: { kind: "live", id: ids[0]! }, archived: true })
    assert.equal(ownedSessions(sources).length, ids.length - 1, "an archived conversation leaves the list, by its listing's keys")
    assert.equal(owner.residency().memory.loaded, 0, "neither the report nor the lifecycle read a journal in")
    assert.equal(warned.length, 0, "and nothing was named for loading in bulk")

    // A reader that does load in bulk is named: once in the log, and in the readout by what it loaded.
    work.run("a list reading journals", () => { for (const id of ids) owner.snapshot(id) })
    assert.equal(warned.length, 1, "one line names the reader, however many it loads past the bound")
    assert.equal(warned[0]?.message, "one reader is loading conversations in bulk")
    assert.deepEqual([warned[0]?.fields?.by, warned[0]?.fields?.loads], ["a list reading journals", BULK_LOADS])
    const memory = owner.residency().memory
    assert.deepEqual(memory.loads, [{ by: "a list reading journals", count: ids.length }])
    assert.ok(memory.held.length > 0 && memory.held.every((held) => held.by === "a list reading journals"), "each conversation in memory says who read it in")
    archives.close()
    console.log("PASS: the report and the lifecycle load no journal; a reader loading in bulk is named")
  } finally {
    stopHearing()
    await owner.stop()
    rmSync(root, { recursive: true, force: true })
  }
}

async function unloadsHibernatedConversations() {
  const root = mkdtempSync(join(tmpdir(), "mako-live-unload-"))
  const id = randomUUID()
  let starts = 0
  let owner: LiveConversations
  const driver: ProviderLiveDriver = {
    ...fixtureCapabilities,
    resume: fixtureResume(),
    provider: "test-provider",
    available: () => true,
    start: async (_cwd, options) => {
      starts++
      return {
        id: options.conversationId,
        nativeId: options.conversationId,
        nativePath: join(root, options.conversationId),
        harness: "test-provider",
        cwd: root,
        status: "ready",
        connection: "connected",
        modes: [],
        currentMode: null,
        configOptions: [],
      }
    },
    prompt: async (prompted, _text, _attachments, _settings, dispatch) => {
      dispatch.report({ kind: "submitted", source: "transport-call" })
      const current = owner.snapshot(prompted)?.session
      assert.ok(current)
      owner.observe({ type: "live-update", id: prompted, update: { kind: "text", text: "kept" } })
      owner.observe({ type: "live-session", session: { ...current, status: "running" } })
      owner.observe({ type: "live-session", session: { ...current, status: "ready" } })
    },
    permission: async () => {},
    cancel: async () => {},
    close: () => {},
    setMode: async () => {},
  }
  owner = new LiveConversations({
    appPath: root,
    root: join(root, "journals"),
    driver: () => driver,
    history: async () => null,
    emit: () => {},
    providerIdleMs: 100,
    providerWarmLimit: 2,
    conversationMemory: { bytes: 0, recent: 0, sweepMs: 0 },
    resumeVerdict: async () => ({ kind: "resumable", record: "same" }),
  })
  try {
    await owner.start("test-provider", root, { conversationId: id })
    owner.submit(id, randomUUID(), "seed")
    assert.equal(owner.residency().memory.unloaded, 0, "a connected conversation stays in memory over budget")
    await waitFor(() => owner.residency().memory.unloaded === 1, "the hibernated conversation was not unloaded")
    const back = owner.snapshot(id)
    assert.equal(back?.session.connection, "hibernated", "it reloads as it was, not as a restart would leave it")
    assert.equal(back?.session.error, undefined)
    assert.ok(back?.blocks.some((block) => block.type === "text" && block.text === "kept"))
    assert.equal(owner.prewarm(id), "waking", "typing into an unloaded conversation still wakes it")
    await waitFor(() => owner.snapshot(id)?.session.connection === "connected", "the reloaded conversation did not wake")
    assert.equal(starts, 2)
    console.log("PASS: a hibernated conversation leaves memory over budget, reloads exactly, and wakes")
  } finally {
    owner.stop()
    rmSync(root, { recursive: true, force: true })
  }
}

async function prewarmOverlapsTyping() {
  const root = mkdtempSync(join(tmpdir(), "mako-live-prewarm-"))
  const id = randomUUID()
  let starts = 0
  let owner: LiveConversations
  const driver: ProviderLiveDriver = {
    ...fixtureCapabilities,
    resume: fixtureResume(),
    provider: "test-provider",
    available: () => true,
    start: async (_cwd, options) => {
      starts++
      return {
        id: options.conversationId,
        nativeId: options.conversationId,
        nativePath: join(root, options.conversationId),
        harness: "test-provider",
        cwd: root,
        status: "ready",
        connection: "connected",
        modes: [],
        currentMode: null,
        configOptions: [],
      }
    },
    prompt: async (prompted, _text, _attachments, _settings, dispatch) => {
      dispatch.report({ kind: "submitted", source: "transport-call" })
      const current = owner.snapshot(prompted)?.session
      assert.ok(current)
      owner.observe({ type: "live-session", session: { ...current, status: "running" } })
      owner.observe({ type: "live-session", session: { ...current, status: "ready" } })
    },
    permission: async () => {},
    cancel: async () => {},
    close: () => {},
    setMode: async () => {},
  }
  const idleMs = 400
  owner = new LiveConversations({
    appPath: root,
    root: join(root, "journals"),
    driver: () => driver,
    history: async () => null,
    emit: () => {},
    providerIdleMs: idleMs,
    providerWarmLimit: 2,
    resumeVerdict: async () => ({ kind: "resumable", record: "same" }),
  })
  const connection = () => owner.snapshot(id)?.session.connection
  try {
    assert.equal(owner.prewarm(id), "unchanged", "an unknown conversation is left alone")
    await owner.start("test-provider", root, { conversationId: id })
    owner.submit(id, randomUUID(), "seed")
    await waitFor(() => connection() === "hibernated", "the idle provider did not hibernate")
    assert.equal(starts, 1)

    assert.equal(owner.prewarm(id), "waking", "typing wakes a hibernated conversation")
    assert.equal(owner.prewarm(id), "waking", "a second keystroke joins the same wake")
    await waitFor(() => connection() === "connected", "the prewarmed provider did not connect")
    assert.equal(starts, 2, "one wake starts one process")
    assert.equal(owner.snapshot(id)?.requests.length, 1, "prewarming sends nothing")

    await new Promise((resolve) => setTimeout(resolve, idleMs * 0.75))
    assert.equal(owner.prewarm(id), "kept-warm", "typing into a warm conversation restarts its idle window")
    await new Promise((resolve) => setTimeout(resolve, idleMs * 0.75))
    assert.equal(connection(), "connected", "a draft in progress keeps its provider past the old deadline")
    await waitFor(() => connection() === "hibernated", "an abandoned draft still lets the provider hibernate")
    assert.equal(starts, 2)

    await owner.close(id)
    assert.equal(owner.prewarm(id), "unchanged", "a closed conversation never wakes")
    assert.equal(starts, 2)
    console.log("PASS: typing wakes a hibernated provider once, keeps a warm one past its deadline, and a closed one stays down")
  } finally {
    owner.stop()
    rmSync(root, { recursive: true, force: true })
  }
}

async function backgroundWorkKeepsProviderResident() {
  const root = mkdtempSync(join(tmpdir(), "mako-live-background-"))
  const ids = [randomUUID(), randomUUID()]
  const closed: string[] = []
  let owner: LiveConversations
  const report = (id: string, backgroundTasks: number) => {
    const current = owner.snapshot(id)?.session
    assert.ok(current)
    owner.observe({ type: "live-session", session: { ...current, backgroundTasks } })
  }
  const driver: ProviderLiveDriver = {
    ...fixtureCapabilities,
    resume: fixtureResume(),
    provider: "test-provider",
    available: () => true,
    start: async (_cwd, options) => ({
      id: options.conversationId,
      nativeId: options.conversationId,
      nativePath: join(root, options.conversationId),
      harness: "test-provider",
      cwd: root,
      status: "ready",
      connection: "connected",
      modes: [],
      currentMode: null,
      configOptions: [],
    }),
    prompt: async (id, _text, _attachments, _settings, dispatch) => {
      dispatch.report({ kind: "submitted", source: "transport-call" })
      const current = owner.snapshot(id)?.session
      assert.ok(current)
      owner.observe({ type: "live-session", session: { ...current, status: "running" } })
      owner.observe({ type: "live-session", session: { ...current, status: "ready", backgroundTasks: id === ids[0] ? 1 : 0 } })
    },
    permission: async () => {},
    cancel: async () => {},
    close: (id) => {
      closed.push(id)
    },
    setMode: async () => {},
  }
  owner = new LiveConversations({
    appPath: root,
    root: join(root, "journals"),
    driver: () => driver,
    history: async () => null,
    emit: () => {},
    providerIdleMs: 15,
    providerWarmLimit: 1,
    resumeVerdict: async () => ({ kind: "resumable", record: "same" }),
  })
  try {
    for (const id of ids) {
      await owner.start("test-provider", root, { conversationId: id })
      const requestId = randomUUID()
      owner.submit(id, requestId, "seed")
      await waitFor(
        () => owner.snapshot(id)?.requests.some((request) => request.id === requestId && request.status === "completed") === true,
        "a background seed turn did not complete"
      )
    }
    await waitFor(() => closed.includes(ids[1]), "the idle provider without background work did not hibernate")
    await new Promise<void>((resolve) => setTimeout(resolve, 60))
    assert.deepEqual(closed, [ids[1]], "neither the idle timer nor warm-pool pressure retires a provider running background work")
    assert.equal(owner.snapshot(ids[0])?.session.connection, "connected")
    assert.equal(owner.residency().active, 1, "background work counts as active residency")
    assert.deepEqual(
      owner.lifecycleWork().map((work) => [work.id, work.status]),
      [[ids[0], "running"]],
      "an update waits for background work like a running turn"
    )
    report(ids[0], 0)
    await waitFor(() => closed.includes(ids[0]), "the provider did not hibernate once its background work ended")
    assert.deepEqual(owner.lifecycleWork(), [])
  } finally {
    owner.stop()
    rmSync(root, { recursive: true, force: true })
  }
}

async function failedCloseKeepsOwnership() {
  const root = mkdtempSync(join(tmpdir(), "mako-close-ownership-"))
  const memoryPath = join(root, "session-memory.sqlite")
  const memory = new SessionMemory(
    memoryPath,
    { pid: 21_001, startedAt: 1, label: "closing host" },
    { alive: () => true }
  )
  const observer = new SessionMemory(
    memoryPath,
    { pid: 21_002, startedAt: 2, label: "observer host" },
    { alive: () => true }
  )
  const id = randomUUID()
  let closes = 0
  let revocations = 0
  const driver: ProviderLiveDriver = {
    ...fixtureCapabilities,
    provider: "test-provider",
    resume: fixtureResume(),
    available: () => true,
    start: async (cwd, options) => ({
      id: options.conversationId,
      nativeId: "native-close-failure",
      nativePath: join(root, "native-close-failure"),
      harness: "test-provider",
      cwd,
      status: "ready",
      connection: "connected",
      modes: [],
      currentMode: null,
      configOptions: [],
    }),
    prompt: async (_id, _text, _attachments, _settings, dispatch) => {
      dispatch.report({ kind: "submitted", source: "transport-call" })
    },
    permission: async () => {},
    cancel: async () => {},
    setMode: async () => {},
    close: async () => {
      closes++
      throw new Error("process still alive")
    },
  }
  const owner = new LiveConversations({
    root: join(root, "journals"),
    appPath: root,
    driver: () => driver,
    history: async () => null,
    emit: () => {},
    memory,
    revokeTools: () => {
      revocations++
    },
  })
  try {
    await owner.start("test-provider", root, { conversationId: id })
    await waitFor(
      () => owner.snapshot(id)?.session.status === "ready",
      "the close ownership fixture did not start"
    )
    const firstClose = owner.close(id)
    const concurrentClose = owner.close(id)
    await assert.rejects(firstClose, /did not close/)
    await assert.rejects(concurrentClose, /did not close/)
    assert.equal(closes, 1, "concurrent close shares one provider shutdown")
    await assert.rejects(owner.close(id), /did not close/)
    assert.equal(closes, 2, "a failed provider shutdown can be retried")
    assert.equal(
      revocations,
      2,
      "each provider shutdown attempt revokes its credentials"
    )
    assert.equal(
      observer.heldBy(
        "test-provider",
        "native-close-failure"
      )?.conversationId,
      id,
      "a failed close retains native ownership"
    )
  } finally {
    owner.stop()
    observer.close()
    memory.close()
    rmSync(root, { recursive: true, force: true })
  }
}

async function queuedSettings() {
  const f = fixture()
  try {
    const first = {
      model: "one",
      options: { effort: "high", serviceTier: "fast" },
    }
    const second = {
      model: "two",
      options: { effort: "low", serviceTier: "default" },
    }
    const request = randomUUID()
    await f.owner.start("test-provider", "/tmp", {
      conversationId: f.id,
      tuning: first,
    })
    assert.deepEqual(
      f.owner.snapshot(f.id)?.session.settings,
      first,
      "the provisional session keeps the settings shown when the user sent"
    )
    f.started.resolve(f.state)
    await tick()
    f.owner.submit(f.id, request, "same prompt", [], first)
    f.owner.observe({
      type: "live-session",
      session: { ...f.state, status: "running" },
    })
    const next = randomUUID()
    f.owner.submit(f.id, next, "next", [], second)
    assert.throws(
      () => f.owner.submit(f.id, request, "same prompt", [], second),
      /different content/
    )
    assert.deepEqual(
      f.owner.snapshot(f.id)?.requests.map((item) => item.tuning),
      [first, second]
    )
    const journal = new LiveJournal(f.root, f.id)
    const persisted = journal.read()
    journal.close()
    assert.deepEqual(
      persisted?.requests.map((item) => item.tuning),
      [first, second]
    )
    f.owner.observe({ type: "live-session", session: f.state })
    assert.deepEqual(f.settings, [first, second])
  } finally {
    f.cleanup()
  }
}

async function acceptanceAndRaces() {
  const f = fixture()
  try {
    const requestId = randomUUID()
    await f.owner.start("test-provider", "/tmp", {
      conversationId: f.id,
      initialRequest: { id: requestId, text: "first", attachments: [] },
    })
    assert.equal(f.owner.snapshot(f.id)?.requests[0]?.status, "queued")
    assert.deepEqual(f.sent, [])
    f.owner.submit(f.id, requestId, "first")
    assert.throws(
      () => f.owner.submit(f.id, requestId, "different"),
      /different content/
    )
    f.started.resolve(f.state)
    await tick()
    assert.deepEqual(f.sent, ["first"])
    f.owner.observe({
      type: "live-session",
      session: { ...f.state, status: "running" },
    })
    const second = randomUUID()
    f.owner.submit(f.id, second, "second")
    f.owner.observe({
      type: "live-update",
      id: f.id,
      update: { kind: "text", id: "item", text: "par" },
    })
    f.owner.observe({
      type: "live-update",
      id: f.id,
      update: { kind: "text", id: "item", text: "corrected", replace: true },
    })
    f.owner.observe({ type: "live-session", session: f.state })
    assert.deepEqual(f.sent, ["first", "second"])
    f.owner.observe({
      type: "live-session",
      session: { ...f.state, status: "running" },
    })
    f.prompts[0]!.reject(new Error("late first response"))
    await tick()
    assert.equal(f.owner.snapshot(f.id)?.session.status, "running")
    assert.equal(f.owner.snapshot(f.id)?.requests[1]?.status, "dispatching")
    assert.equal(
      f.owner.snapshot(f.id)?.blocks.find((block) => block.type === "text")
        ?.text,
      "corrected"
    )
    f.owner.submit(f.id, second, "second")
    assert.equal(f.sent.length, 2)
  } finally {
    f.cleanup()
  }
}

/**
 * A harness that refuses a message for a turn of its own, one that can begin and end while the message is prepared
 * (Claude Code's notice of background work it found stopped, as a handed-off session reopens): the message waits,
 * never fails, and goes once that turn is over. A harness that keeps refusing is sent again at once only a few times;
 * then the end of its turn sends it.
 */
async function turnOfItsOwn() {
  const f = fixture()
  try {
    const driver = f.dependencies.driver()
    const send = driver.prompt
    let refuse = 1
    let refusals = 0
    driver.prompt = async (id, text, attachments, tuning, dispatch) => {
      if (refusals >= refuse) return send(id, text, attachments, tuning, dispatch)
      refusals++
      // Its own turn began, and ended, while the message was prepared.
      f.owner.observe({ type: "live-session", session: { ...f.state, status: "running" } })
      f.owner.observe({ type: "live-session", session: f.state })
      return preparePrompt(dispatch, () => {
        throw new TurnInProgressError("Test")
      })
    }
    const first = randomUUID()
    await f.owner.start("test-provider", "/tmp", { conversationId: f.id, initialRequest: { id: first, text: "continue", attachments: [] } })
    f.started.resolve(f.state)
    for (let step = 0; step < 6; step++) await tick()
    assert.equal(refusals, 1, "refused once")
    assert.deepEqual(f.sent, ["continue"], "then sent, once its turn was over")
    assert.equal(f.owner.snapshot(f.id)?.requests[0]?.status, "dispatching", "waiting, never failed")
    f.prompts[0]!.resolve()
    f.owner.observe({ type: "live-session", session: { ...f.state, status: "running" } })
    f.owner.observe({ type: "live-session", session: f.state })
    for (let step = 0; step < 3; step++) await tick()
    assert.equal(f.owner.snapshot(f.id)?.requests[0]?.status, "completed", "its own turn, once sent, settles it")

    // Refusing every time: sent again at once three times, then left queued for its turn's end.
    refuse = refusals + 10
    const second = randomUUID()
    f.owner.submit(f.id, second, "and then")
    for (let step = 0; step < 20; step++) await tick()
    assert.equal(refusals, 1 + 4, "the first refusal, then three at once, then it waits")
    assert.equal(f.owner.snapshot(f.id)?.requests.find((request) => request.id === second)?.status, "queued", "queued, not failed")
    refuse = refusals
    f.owner.observe({ type: "live-session", session: { ...f.state, status: "running" } })
    f.owner.observe({ type: "live-session", session: f.state })
    for (let step = 0; step < 6; step++) await tick()
    assert.deepEqual(f.sent, ["continue", "and then"], "its turn's end sends it")
  } finally {
    f.cleanup()
  }
}

/** A harness started ahead of its first message takes it from the start that brings it, once, with its title. */
async function startedAheadTakesFirstMessage() {
  const f = fixture()
  try {
    await f.owner.start("test-provider", "/tmp", { conversationId: f.id })
    f.started.resolve(f.state)
    await tick()
    assert.deepEqual(f.owner.snapshot(f.id)?.requests, [], "started ahead: nothing to send yet")
    const first = { id: randomUUID(), text: "the first message", attachments: [] }
    const bring = () => f.owner.start("test-provider", "/tmp", { conversationId: f.id, title: "The first message", initialRequest: first })
    await bring()
    await tick()
    assert.deepEqual(f.sent, ["the first message"], "the start that brings it sends it to the harness already running")
    assert.equal(f.owner.snapshot(f.id)?.session.title, "The first message")
    await bring()
    await tick()
    assert.deepEqual(f.sent, ["the first message"], "a repeated start sends it once")
    await f.owner.start("test-provider", "/tmp", { conversationId: f.id, initialRequest: { id: randomUUID(), text: "another", attachments: [] } })
    await tick()
    assert.equal(f.owner.snapshot(f.id)?.requests.length, 1, "a conversation with requests keeps its own")
  } finally {
    f.cleanup()
  }
}

async function closeDuringStartup() {
  const f = fixture()
  try {
    await f.owner.start("test-provider", "/tmp", { conversationId: f.id })
    f.owner.close(f.id)
    f.started.resolve(f.state)
    await tick()
    assert.equal(f.owner.snapshot(f.id)?.session.status, "closed")
    assert.ok(f.closed() >= 1)
  } finally {
    f.cleanup()
  }
}

async function durabilityAndBatching() {
  const f = fixture()
  try {
    await f.owner.start("test-provider", "/tmp", { conversationId: f.id })
    f.started.resolve(f.state)
    await tick()
    f.events.length = 0
    for (let index = 0; index < 1000; index++)
      f.owner.observe({
        type: "live-update",
        id: f.id,
        update: { kind: "text", text: "ha" },
      })
    const fault = mock.method(LiveJournal.prototype, "commit", () => {
      throw new Error("disk unavailable")
    })
    assert.throws(() => f.owner.snapshot(f.id), /disk unavailable/)
    fault.mock.restore()
    const snapshot = f.owner.snapshot(f.id)!
    assert.equal(
      snapshot.blocks[0]?.type === "text" ? snapshot.blocks[0].text : "",
      "ha".repeat(1000)
    )
    const batches = f.events.filter((event) => event.type === "live-batch")
    assert.ok(batches.length <= 9, `${batches.length} batches for 1,000 chunks`)
    assert.ok(batches.every((event) => event.batch.updates.length <= 128))
    f.owner.submit(f.id, randomUUID(), "running")
    f.owner.observe({
      type: "live-session",
      session: { ...f.state, status: "running" },
    })
    f.owner.observe({ type: "live-update", id: f.id, update: { kind: "tool", id: "build", title: "Build", status: "running" } })
    f.owner.submit(f.id, randomUUID(), "waiting")
    // A host that dies mid-turn never reaches stop(): the next host finds the
    // request still dispatching in the journal and cannot say whether the
    // provider finished it. That is recorded as a crash, not as a Stop.
    const afterCrash = new LiveConversations(f.dependencies)
    try {
      const found = afterCrash.snapshot(f.id)!
      assert.equal(found.requests[0]?.status, "uncertain")
      assert.equal(found.requests[0]?.interruption?.reason, "host-crashed")
      assert.ok(found.requests[0]?.interruption?.at)
      assert.deepEqual(found.requests[0]?.interruption?.calls, [{ id: "build", title: "Build", result: "none" }])
      const build = found.blocks.find((block) => block.type === "tool" && block.id === "build")
      assert.ok(build?.type === "tool" && build.status === "failed" && build.unfinished, "the dead host's open call is closed")
      assert.equal(build.output, undefined, "the row keeps what the call had produced, here nothing")
      assert.deepEqual(found.requests[0]?.interruption?.closed, ["build"], "the request says which calls Mako closed")
      // What waited behind it is paused, as a quit pauses it, and the queue offers Resume: queued behind a turn that
      // will never end, nothing would send it.
      assert.equal(found.requests[1]?.status, "held")
    } finally {
      afterCrash.stop()
    }
    f.owner.stop()
    const recovered = new LiveConversations(f.dependencies)
    try {
      const saved = recovered.snapshot(f.id)!
      // The owning host closed on purpose with the turn running: the turn was
      // interrupted by Mako, and the journal says so with the reason.
      assert.equal(saved.requests[0]?.status, "interrupted")
      assert.equal(saved.requests[0]?.interruption?.reason, "host-quit")
      assert.match(saved.requests[0]?.error ?? "", /Mako closed/)
      assert.deepEqual(saved.requests[0]?.interruption?.calls, [{ id: "build", title: "Build", result: "none" }])
      assert.equal(saved.requests[1]?.status, "held")
      assert.equal(saved.requests[1]?.text, "waiting")
      assert.equal(
        JSON.stringify(saved.blocks),
        JSON.stringify(
          snapshot.blocks.concat([
            {
              type: "user",
              provider: "test-provider",
              requestId: saved.requests[0]?.id,
              // When the host sent it, stamped at dispatch.
              at: saved.blocks.flatMap((block) => (block.type === "user" && block.requestId === saved.requests[0]?.id && block.at !== undefined ? [block.at] : []))[0],
              contextFiles: [],
              text: "running",
              attachments: [],
            },
            {
              type: "tool",
              id: "build",
              title: "Build",
              status: "failed",
              unfinished: true,
            },
          ])
        )
      )
      assert.equal(f.sent.length, 1)
    } finally {
      recovered.stop()
    }
  } finally {
    f.cleanup()
  }
}

function identityAndToolLifecycle() {
  const f = fixture()
  try {
    let blocks = reduceLiveUpdates(
      [],
      [
        { kind: "user", text: "same" },
        {
          kind: "tool",
          id: "tool",
          title: "Read",
          status: "completed",
          output: "first",
        },
        { kind: "user", text: "same" },
        {
          kind: "tool",
          id: "tool",
          title: "Read",
          status: "in_progress",
          output: "partial",
        },
        {
          kind: "tool-update",
          id: "tool",
          output: "more",
          status: "in_progress",
        },
      ]
    )
    assert.equal(blocks[1]?.type === "tool" ? blocks[1].output : "", "first")
    const tools = projectLive({ session: f.state, blocks, base: null })
      .messages.flatMap((message) => message.blocks)
      .filter((block) => block.type === "toolResult")
    assert.equal(tools[1]?.streaming, true)
    blocks = []
    for (let index = 0; index < 500; index++)
      blocks = reduceLiveUpdates(blocks, [
        { kind: "user", text: `${index}` },
        { kind: "text", text: "answer" },
      ])
    const first = projectLive({ session: f.state, blocks, base: null })
    const next = projectLive(
      {
        session: f.state,
        blocks: reduceLiveUpdates(blocks, [{ kind: "text", text: "!" }]),
        base: null,
      },
      first
    )
    assert.equal(
      next.exchanges.filter(
        (exchange, index) => exchange === first.exchanges[index]
      ).length,
      499
    )
  } finally {
    f.cleanup()
  }
}

async function failureIsolationAndAssets() {
  const f = fixture()
  try {
    await f.owner.start("test-provider", "/tmp", { conversationId: f.id })
    f.started.resolve(f.state)
    await tick()
    const fault = mock.method(LiveJournal.prototype, "commit", () => {
      throw new Error("disk unavailable")
    })
    assert.throws(
      () => f.owner.submit(f.id, randomUUID(), "rejected"),
      /disk unavailable/
    )
    fault.mock.restore()
    f.owner.observe({ type: "live-session", session: { ...f.state } })
    assert.deepEqual(f.sent, [], "rejected acceptance cannot execute later")
    const long = "abcdefgh".repeat(50_000)
    f.owner.observe({
      type: "live-update",
      id: f.id,
      update: { kind: "text", text: long, id: "large-answer" },
    })
    f.owner.observe({
      type: "live-update",
      id: f.id,
      update: {
        kind: "tool",
        id: "large-tool",
        title: "Read",
        status: "completed",
        output: long,
      },
    })
    const snapshot = f.owner.snapshot(f.id)!
    assert.equal(
      snapshot.blocks.find((block) => block.type === "text")?.text,
      long
    )
    const tool = snapshot.blocks.find((block) => block.type === "tool")
    const source = tool?.attachments?.[0]?.source
    assert.ok(source?.kind === "file")
    assert.equal(readFileSync(source.path, "utf8"), long)
    assert.ok((tool?.output?.length ?? Infinity) < 65_000)
    assert.ok(
      f.events
        .filter((event) => event.type === "live-batch")
        .every((event) => JSON.stringify(event.batch.updates).length < 256_000)
    )
    f.owner.stop()
    writeFileSync(join(f.root, `${randomUUID()}.sqlite`), "corrupt journal")
    const recovered = new LiveConversations(f.dependencies)
    try {
      assert.equal(recovered.snapshot(f.id)?.blocks.length, 2)
      assert.ok(
        f.events.some(
          (event) =>
            event.type === "notice" &&
            event.message.includes("preserved for recovery")
        )
      )
    } finally {
      recovered.stop()
    }
  } finally {
    f.cleanup()
  }
}

/**
 * Mako stops a provider's turn only for a reason it says in the host log. A file an agent names that Mako can't read
 * is no such reason: a Codex code cell's `view_image` once named its image by a `file://` URL, the copy failed, the
 * failure read as a conversation Mako couldn't save, and Mako sent Codex `turn/interrupt` with nothing in the log.
 */
async function makoStopsAreSaid() {
  const f = fixture()
  const said: HostLogLine[] = []
  const stopHearing = followHostLog((line) => { if (line.message === "Mako stops the provider's turn") said.push(line) })
  try {
    await f.owner.start("test-provider", "/tmp", { conversationId: f.id })
    f.started.resolve(f.state)
    await tick()
    const request = randomUUID()
    f.owner.submit(f.id, request, "make the page and its screenshot")
    await waitFor(() => f.sent.length === 1, "the prompt was not sent")
    f.owner.observe({ type: "live-session", session: { ...f.state, status: "running" } })
    const gone = join(f.root, "gone", "tide-report.png")
    f.owner.observe({
      type: "live-update",
      id: f.id,
      update: {
        kind: "tool", id: "view-1", title: "View tide-report.png", name: "view_image", status: "completed", output: "",
        attachments: [{ type: "attachment", name: "tide-report.png", mimeType: "image/png", source: { kind: "file", path: gone } }],
      },
    })
    await tick()
    assert.equal(f.cancels(), 0, "a file the agent named that can't be read doesn't stop its turn")
    assert.equal(f.owner.snapshot(f.id)?.session.status, "running")
    assert.ok(!f.events.some((event) => event.type === "notice" && event.message.includes("could not be saved")))
    const source = f.owner.snapshot(f.id)?.blocks.find((block) => block.type === "tool")?.attachments?.[0]?.source
    assert.equal(source?.kind, "unavailable", "the attachment says it can't be read")
    assert.match(source?.kind === "unavailable" ? source.reason : "", /tide-report\.png could not be read \(ENOENT\)/)
    assert.equal(said.length, 0, "nothing was stopped")

    // The person's Stop is said as theirs.
    await f.owner.cancel(f.id)
    assert.equal(f.cancels(), 1)
    assert.deepEqual(said.map((line) => [line.level, line.fields?.why, line.fields?.provider, line.fields?.request]), [["info", "person", "test-provider", request]])
  } finally {
    stopHearing()
    f.cleanup()
  }
  console.log("PASS: Mako stops a turn only for a reason its log names; a file the agent named that can't be read is an unavailable attachment, not a stop")
}

/** SQLite's own error for a full disk, as node:sqlite reports it. */
function diskFull(): Error {
  return Object.assign(new Error("database or disk is full"), { code: "ERR_SQLITE_ERROR", errcode: 13, errstr: "database or disk is full" })
}

/** A full disk under every journal while `full` is set: each commit fails as LiveJournal reports SQLite's refusal. */
function fillDisk() {
  const commit = LiveJournal.prototype.commit
  const disk = { full: true, restore: () => fault.mock.restore() }
  const fault = mock.method(LiveJournal.prototype, "commit", function (this: LiveJournal, ...args: Parameters<LiveJournal["commit"]>) {
    if (disk.full) throw new JournalWriteError(diskFull())
    return commit.apply(this, args)
  })
  return disk
}

/**
 * A journal that can't be written is the one save failure that stops a turn, and the turn says it was Mako's:
 * `not-saved`, with what failed, live once Mako can write again and reopened, never the person's "Stopped". A Stop the
 * person presses after doesn't make it theirs. On disk the reason is one every build reads (`stopped`) with the exact
 * one beside it, so a build before this one, which refuses a journal with a reason it doesn't know, still opens it.
 */
async function unsavedTurnIsMakos() {
  const f = fixture()
  const said: HostLogLine[] = []
  const stopHearing = followHostLog((line) => { if (line.message === "Mako stops the provider's turn") said.push(line) })
  let disk: ReturnType<typeof fillDisk> | undefined
  try {
    await f.owner.start("test-provider", "/tmp", { conversationId: f.id })
    f.started.resolve(f.state)
    await tick()
    const request = randomUUID()
    f.owner.submit(f.id, request, "make the page")
    await waitFor(() => f.sent.length === 1, "the prompt was not sent")
    f.owner.observe({ type: "live-session", session: { ...f.state, status: "running" } })
    f.owner.observe({ type: "live-update", id: f.id, update: { kind: "text", id: "a1", text: "Writing the page" } })
    await waitFor(() => f.events.some((event) => event.type === "live-batch" && event.batch.updates.some((update) => update.kind === "text")), "the answer was not saved")
    disk = fillDisk()
    f.owner.observe({ type: "live-update", id: f.id, update: { kind: "text", id: "a1", text: " and its styles" } })
    await waitFor(() => f.cancels() === 1, "the unsaved conversation's turn was not stopped")
    assert.deepEqual(said.map((line) => [line.level, line.fields?.why, line.fields?.request, line.fields?.error]), [["warn", "not-saved", request, "database or disk is full"]])
    const notice = f.events.find((event) => event.type === "notice")
    assert.match(notice?.type === "notice" ? notice.message : "", /^Mako couldn't save this conversation, so it stopped the agent's turn\. .*database or disk is full$/)
    // The person presses Stop too, which can't be saved yet either; the provider reports the end while the disk is full.
    await assert.rejects(f.owner.cancel(f.id), /database or disk is full/)
    f.owner.observe({ type: "live-session", session: { ...f.state, status: "ready", lastStop: "cancelled" } })
    await new Promise((resolve) => setTimeout(resolve, 40))
    const told = () => f.events.flatMap((event) => event.type === "live-batch" ? [...event.batch.requests ?? [], ...event.batch.requestChanges ?? []] : []).findLast((each) => each.id === request)
    assert.equal(told()?.status, "dispatching", "nothing unsaved reaches a window")
    // Space comes back, and nothing else happens: Mako saves it on its own and every window is told.
    disk.full = false
    await waitFor(() => told()?.status === "interrupted", "the stopped turn was not saved once space came back")
    assert.equal(told()?.interruption?.reason, "not-saved", "the turn is Mako's, not the person's Stop")
    assert.equal(told()?.error, "database or disk is full", "the turn keeps what failed")

    // A Stop the person presses once Mako can save again, before the provider reports the end, doesn't make it theirs.
    const second = randomUUID()
    f.owner.submit(f.id, second, "now the footer")
    await waitFor(() => f.sent.length === 2, "the second prompt was not sent")
    f.owner.observe({ type: "live-session", session: { ...f.state, status: "running" } })
    disk.full = true
    f.owner.observe({ type: "live-update", id: f.id, update: { kind: "text", id: "a2", text: "Adding the footer" } })
    await waitFor(() => f.cancels() === 2, "the second unsaved turn was not stopped")
    disk.full = false
    await f.owner.cancel(f.id)
    f.owner.observe({ type: "live-session", session: { ...f.state, status: "ready", lastStop: "cancelled" } })
    assert.equal(f.owner.snapshot(f.id)?.requests.find((each) => each.id === second)?.interruption?.reason, "not-saved")

    // On disk, older builds read it as the Stop every build before this one recorded; this build reads it exactly.
    const db = new DatabaseSync(join(f.root, `${f.id}.sqlite`), { readOnly: true })
    const row = JSON.parse(z.object({ value: z.string() }).parse(db.prepare("SELECT value FROM requests WHERE id=?").get(request)).value)
    db.close()
    assert.deepEqual([row.interruption.reason, row.interruption.exactReason], ["stopped", "not-saved"])
    assert.equal(OlderRequestSchema.parse(row).interruption?.reason, "stopped", "a build before not-saved opens the journal")
    await f.owner.stop()
    const reopened = new LiveConversations(f.dependencies)
    try {
      const saved = reopened.snapshot(f.id)?.requests.find((each) => each.id === request)
      assert.equal(saved?.interruption?.reason, "not-saved", "reopened, the turn still says Mako stopped it")
      assert.equal(saved?.error, "database or disk is full")
    } finally {
      await reopened.stop()
    }
  } finally {
    disk?.restore()
    stopHearing()
    f.cleanup()
  }
  console.log("PASS: a journal Mako can't write stops the turn as Mako's (not-saved), live and reopened, and older builds still open it")
}

/**
 * Only a journal write is a save that stops a turn. Mako's copy of a long output it can't write keeps the output as
 * the agent gave it, which the journal saves; an event Mako can't read is said in the host log and left out. Neither
 * stops the turn, and the turn's next words are saved.
 */
async function otherFailuresDontStop() {
  const f = fixture()
  const warned: HostLogLine[] = []
  const stopHearing = followHostLog((line) => { if (line.level === "warn" && line.scope === "live") warned.push(line) })
  const assets = join(f.root, "assets")
  try {
    await f.owner.start("test-provider", "/tmp", { conversationId: f.id })
    f.started.resolve(f.state)
    await tick()
    f.owner.submit(f.id, randomUUID(), "read the log")
    await waitFor(() => f.sent.length === 1, "the prompt was not sent")
    f.owner.observe({ type: "live-session", session: { ...f.state, status: "running" } })

    // Mako's store can't be written: a long output stays whole in the update.
    mkdirSync(assets, { recursive: true })
    chmodSync(assets, 0o500)
    const long = "line of the build log\n".repeat(4_000)
    f.owner.observe({ type: "live-update", id: f.id, update: { kind: "tool", id: "log-1", title: "Read build.log", status: "completed", output: long } })
    chmodSync(assets, 0o700)
    // A roster entry no schema reads: the decoder's fault, not a save.
    // SAFETY: deliberately malformed, as a decoder bug would send it; the host must parse and refuse it.
    f.owner.observe({ type: "live-agent", id: f.id, agent: { nativeId: 7 } as never })
    f.owner.observe({ type: "live-update", id: f.id, update: { kind: "text", id: "a1", text: "The build failed on a missing import." } })
    await tick()
    assert.equal(f.cancels(), 0, "neither failure stops the turn")
    assert.ok(!f.events.some((event) => event.type === "notice"), "nothing says the conversation wasn't saved")
    assert.deepEqual(warned.map((line) => [line.message, line.fields?.kind ?? line.fields?.event]), [
      ["an update's file or long output couldn't be copied into Mako's store; kept as the agent gave it", "tool"],
      ["an event from the provider couldn't be taken in", "live-agent"],
    ])
    assert.match(String(warned[0]?.fields?.error), /EACCES/)
    await f.owner.stop()
    const reopened = new LiveConversations(f.dependencies)
    try {
      const blocks = reopened.snapshot(f.id)?.blocks ?? []
      assert.equal(blocks.find((block) => block.type === "tool")?.output, long, "the journal kept the whole output")
      assert.equal(blocks.find((block) => block.type === "text")?.text, "The build failed on a missing import.", "the next words were saved")
    } finally {
      await reopened.stop()
    }
  } finally {
    chmodSync(assets, 0o700)
    stopHearing()
    f.cleanup()
  }
  console.log("PASS: a store copy Mako can't write and an event it can't read don't stop the turn; the journal keeps the output whole")
}

/** Mako stopping with a conversation it can't save still stops, and says which; the others are left as they were. */
async function unsavedConversationDoesntBlockStop() {
  const f = fixture()
  const warned: HostLogLine[] = []
  const stopHearing = followHostLog((line) => { if (line.message === "a conversation couldn't be saved as Mako stopped") warned.push(line) })
  let disk: ReturnType<typeof fillDisk> | undefined
  try {
    await f.owner.start("test-provider", "/tmp", { conversationId: f.id })
    f.started.resolve(f.state)
    await tick()
    f.owner.submit(f.id, randomUUID(), "make the page")
    await waitFor(() => f.sent.length === 1, "the prompt was not sent")
    f.owner.observe({ type: "live-session", session: { ...f.state, status: "running" } })
    disk = fillDisk()
    await f.owner.stop()
    assert.deepEqual(warned.map((line) => [line.fields?.conversation, line.fields?.error]), [[f.id, "database or disk is full"]])
  } finally {
    disk?.restore()
    stopHearing()
    f.cleanup()
  }
}

async function quietTurnsCarryLastActivity() {
  const f = fixture()
  const clock = mock.method(Date, "now", () => 1_000)
  try {
    await f.owner.start("test-provider", "/tmp", { conversationId: f.id })
    f.started.resolve(f.state)
    await tick()
    f.owner.snapshot(f.id)
    f.events.length = 0
    const batchActivity = () => f.events.flatMap((event) =>
      event.type === "live-batch" && event.batch.activityAt !== undefined ? [event.batch.activityAt] : [])

    clock.mock.mockImplementation(() => 2_000)
    f.owner.submit(f.id, randomUUID(), "long build")
    f.owner.observe({ type: "live-session", session: { ...f.state, status: "running" } })
    assert.equal(f.owner.snapshot(f.id)?.activityAt, 2_000, "a turn starting is activity")

    clock.mock.mockImplementation(() => 5_000)
    f.owner.observe({ type: "live-update", id: f.id, update: { kind: "tool", id: "build", title: "npm run build", status: "pending" } })
    assert.equal(f.owner.snapshot(f.id)?.activityAt, 5_000)

    clock.mock.mockImplementation(() => 9_000)
    f.owner.observe({ type: "live-session", session: { ...f.state, status: "running", usage: { used: 10, size: 100 } } })
    f.owner.observe({ type: "live-updates", id: f.id, updates: [] })
    assert.equal(f.owner.snapshot(f.id)?.activityAt, 5_000, "usage and empty batches are not output")

    clock.mock.mockImplementation(() => 12_000)
    f.owner.observe({ type: "live-update", id: f.id, update: { kind: "tool-update", id: "build", output: "compiled 3 files" } })
    const snapshot = f.owner.snapshot(f.id)
    assert.equal(snapshot?.activityAt, 12_000, "tool output counts")
    assert.deepEqual(batchActivity(), [2_000, 5_000, 12_000], "batches carry the time only when it moves")
    // Within the same second it moves again: the host holds it, and batches say it once it's in another second.
    clock.mock.mockImplementation(() => 12_400)
    f.owner.observe({ type: "live-update", id: f.id, update: { kind: "tool-update", id: "build", outputAppend: "\ncompiled 4 files" } })
    assert.equal(f.owner.snapshot(f.id)?.activityAt, 12_400)
    clock.mock.mockImplementation(() => 13_100)
    f.owner.observe({ type: "live-update", id: f.id, update: { kind: "tool-update", id: "build", outputAppend: "\ncompiled 5 files" } })
    assert.equal(f.owner.snapshot(f.id)?.activityAt, 13_100)
    assert.deepEqual(batchActivity(), [2_000, 5_000, 12_000, 13_100], "at most once a second")

    const journal = new DatabaseSync(join(f.root, `${f.id}.sqlite`), { readOnly: true })
    try {
      const metadata = z.object({ value: z.string() }).parse(journal.prepare("SELECT value FROM metadata").get()).value
      assert.doesNotMatch(metadata, /activityAt/, "the journal does not keep it")
    } finally {
      journal.close()
    }
    assert.equal(snapshot?.session.status, "running", "a quiet turn is not ended")
  } finally {
    clock.mock.restore()
    f.cleanup()
  }
}

async function nativeActivityLastsItsTurn() {
  const f = fixture()
  const clock = mock.method(Date, "now", () => 1_000)
  try {
    await f.owner.start("test-provider", "/tmp", { conversationId: f.id })
    f.started.resolve(f.state)
    await tick()
    f.owner.snapshot(f.id)
    const activity = () => f.owner.snapshot(f.id)?.nativeActivity
    const published = () => f.events.flatMap((event) =>
      event.type === "live-batch" && event.batch.nativeActivity !== undefined ? [event.batch.nativeActivity] : [])

    f.owner.observe({ type: "live-activity", id: f.id, activity: { kind: "compacting" } })
    assert.equal(activity(), undefined, "a settled conversation has nothing running to describe")

    f.owner.submit(f.id, randomUUID(), "long task")
    f.owner.observe({ type: "live-session", session: { ...f.state, status: "running" } })
    f.events.length = 0
    clock.mock.mockImplementation(() => 2_000)
    f.owner.observe({ type: "live-activity", id: f.id, activity: { kind: "compacting" } })
    assert.deepEqual(activity(), { kind: "compacting", since: 2_000 })
    assert.equal(f.owner.snapshot(f.id)?.activityAt, 2_000, "native activity is activity")
    clock.mock.mockImplementation(() => 3_000)
    f.owner.observe({ type: "live-activity", id: f.id, activity: { kind: "compacting" } })
    assert.equal(published().length, 1, "a repeated report publishes nothing")

    f.owner.observe({ type: "live-update", id: f.id, update: { kind: "event", label: "Context compacted" } })
    f.owner.observe({ type: "live-activity", id: f.id, activity: null })
    assert.equal(activity(), undefined)
    assert.deepEqual(f.owner.snapshot(f.id)?.blocks.at(-1), { type: "event", source: undefined, label: "Context compacted", detail: undefined, body: undefined, tone: undefined })

    clock.mock.mockImplementation(() => 4_000)
    f.owner.observe({ type: "live-activity", id: f.id, activity: { kind: "retrying", attempt: 1, reason: "Overloaded" } })
    f.owner.observe({ type: "live-activity", id: f.id, activity: { kind: "retrying", attempt: 2, reason: "Overloaded" } })
    assert.deepEqual(activity(), { kind: "retrying", attempt: 2, reason: "Overloaded", since: 4_000 }, "the retry's start stays its start")
    f.owner.observe({ type: "live-update", id: f.id, update: { kind: "text", text: "answer" } })
    assert.equal(activity(), undefined, "the model answering ends the retry")

    f.owner.observe({ type: "live-activity", id: f.id, activity: { kind: "compacting" } })
    const journal = new DatabaseSync(join(f.root, `${f.id}.sqlite`), { readOnly: true })
    try {
      const metadata = z.object({ value: z.string() }).parse(journal.prepare("SELECT value FROM metadata").get()).value
      assert.doesNotMatch(metadata, /nativeActivity/, "the journal does not keep it")
    } finally {
      journal.close()
    }
    f.owner.observe({ type: "live-session", session: { ...f.state, status: "ready" } })
    assert.equal(activity(), undefined, "a turn's end ends whatever it was doing")
    assert.equal(published().at(-1), null, "and the renderer hears it end")
  } finally {
    clock.mock.restore()
    f.cleanup()
  }
}

/** A stream's first change goes out at once, and the rest one batch a frame (`LIVE_FRAME_MS`) at most, whatever the pace of its tokens. */
async function batchesLeadThenPace() {
  const f = fixture()
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    await f.owner.start("test-provider", "/tmp", { conversationId: f.id })
    f.started.resolve(f.state)
    await tick()
    f.owner.snapshot(f.id)
    await sleep(50)
    f.events.length = 0
    const batches = () => f.events.filter((event) => event.type === "live-batch").length
    const say = (text: string) => f.owner.observe({ type: "live-update", id: f.id, update: { kind: "text", text } })
    const started = performance.now()
    say("The")
    await sleep(5)
    assert.equal(batches(), 1, "the first token of a burst isn't held for a frame")
    for (let word = 0; word < 80; word++) {
      say(` w${word}`)
      await sleep(2)
    }
    await sleep(50)
    const elapsed = performance.now() - started
    const count = batches()
    assert.ok(count >= 3 && count <= Math.ceil(elapsed / LIVE_FRAME_MS) + 2, `${count} batches in ${Math.round(elapsed)} ms`)
    const text = f.events.flatMap((event) => (event.type === "live-batch" ? event.batch.updates : [])).map((update) => (update.kind === "text" ? update.text : "")).join("")
    assert.ok(text.startsWith("The w0 w1") && text.endsWith(" w79"), "every word, in order")
  } finally {
    f.cleanup()
  }
}

async function coalescedToolBursts() {
  const f = fixture()
  try {
    await f.owner.start("test-provider", "/tmp", { conversationId: f.id })
    f.started.resolve(f.state)
    await tick()
    f.owner.observe({
      type: "live-update",
      id: f.id,
      update: { kind: "tool", id: "input", title: "Write", status: "running" },
    })
    f.owner.snapshot(f.id)
    f.events.length = 0
    for (let index = 1; index <= 64; index++)
      f.owner.observe({
        type: "live-update",
        id: f.id,
        update: {
          kind: "tool-update",
          id: "input",
          input: "x".repeat(index * 256),
        },
      })
    const snapshot = f.owner.snapshot(f.id)
    const updates = f.events.flatMap((event) =>
      event.type === "live-batch" ? event.batch.updates : []
    )
    assert.equal(
      updates.length,
      1,
      "One frame must not contain every accumulated tool prefix"
    )
    assert.equal(
      snapshot?.blocks.find((block) => block.type === "tool")?.input?.length,
      16_384
    )
  } finally {
    f.cleanup()
  }
}

/**
 * A turn's verdict travels with its request: a Stop is recorded as the user's
 * interruption, and a failure carries the kind the provider's text classifies
 * as, decided once on the host.
 */
async function settledVerdicts() {
  const f = fixture()
  try {
    await f.owner.start("test-provider", "/tmp", { conversationId: f.id })
    f.started.resolve(f.state)
    await tick()
    const first = randomUUID()
    f.owner.submit(f.id, first, "first")
    await tick()
    f.owner.observe({ type: "live-session", session: { ...f.state, status: "running" } })
    f.owner.observe({
      type: "live-session",
      session: { ...f.state, status: "ready", lastStop: "cancelled" },
    })
    f.prompts[0]?.resolve()
    await tick()
    let requests = f.owner.snapshot(f.id)!.requests
    assert.equal(requests[0]?.status, "interrupted")
    assert.equal(requests[0]?.interruption?.reason, "stopped")
    assert.equal(requests[0]?.failure, undefined)

    const second = randomUUID()
    f.owner.submit(f.id, second, "second")
    await tick()
    f.owner.observe({ type: "live-session", session: { ...f.state, status: "running" } })
    f.owner.observe({
      type: "live-session",
      session: {
        ...f.state,
        status: "failed",
        error:
          'Failed to run prompt: {"type":"invalid_request_error","message":"Item \'rs_0a1b\' of type \'reasoning\' was provided without its required following item."} (reasoning encrypted_content was not issued to this caller)',
      },
    })
    f.prompts[1]?.resolve()
    await tick()
    requests = f.owner.snapshot(f.id)!.requests
    assert.equal(requests[1]?.status, "failed")
    assert.equal(requests[1]?.failure, "transcript-rejected")
    assert.equal(requests[1]?.interruption, undefined)

    // A turn the provider ended on its own dropped connection: the work
    // stands, so the request is interrupted and continuable, and still says
    // which connection dropped.
    const third = randomUUID()
    f.owner.submit(f.id, third, "third")
    await tick()
    f.owner.observe({ type: "live-session", session: { ...f.state, status: "running" } })
    f.owner.observe({
      type: "live-session",
      session: {
        ...f.state,
        status: "failed",
        lastStop: CONNECTION_LOST_STOP,
        error: "RetriableError: [canceled] http/2 stream closed with error code CANCEL (0x8)",
      },
    })
    f.prompts[2]?.resolve()
    await tick()
    requests = f.owner.snapshot(f.id)!.requests
    assert.equal(requests[2]?.status, "interrupted")
    assert.equal(requests[2]?.interruption?.reason, "connection-lost")
    assert.equal(requests[2]?.failure, "network")
    assert.match(requests[2]?.error ?? "", /http\/2 stream closed/)
    assert.ok(requests[2]?.interruption?.autoContinue, "Mako schedules its own continuation of a dropped turn")
    const reopened = new LiveJournal(f.root, f.id)
    try {
      assert.equal(reopened.read()?.requests[2]?.interruption?.reason, "connection-lost", "the reason survives the journal")
    } finally {
      reopened.close()
    }
  } finally {
    f.cleanup()
  }
}

async function refusedStartup() {
  const f = fixture()
  try {
    const requestId = randomUUID()
    await f.owner.start("test-provider", "/tmp", { conversationId: f.id, initialRequest: { id: requestId, text: "Retain this prompt", attachments: [] } })
    f.started.reject(new Error("Selected model is unavailable"))
    await tick()
    const failed = f.owner.snapshot(f.id)
    assert.equal(failed?.session.connection, "disconnected")
    assert.equal(failed?.session.error, "Selected model is unavailable")
    assert.equal(failed?.requests[0]?.status, "failed")
    f.owner.observe({ type: "live-session", session: { ...f.state, status: "failed", error: "late stderr noise" } })
    assert.equal(f.owner.snapshot(f.id)?.session.error, "Selected model is unavailable")
    assert.deepEqual(f.sent, [])
  } finally { f.cleanup() }
}

/**
 * Mako continues a turn that ended on the provider's dropped connection by
 * itself, once: the interrupted request is stamped while the send is pending,
 * the continuation carries the source's settings and names the turn it picks
 * up, a second drop is left to the user, and the user's own prompt, Stop, or
 * the host leaving in the window cancels the send.
 */
async function autoContinuedTurn() {
  const dropped: Partial<LiveSessionState> = {
    status: "failed",
    lastStop: CONNECTION_LOST_STOP,
    error: "RetriableError: [canceled] http/2 stream closed with error code CANCEL (0x8)",
  }
  const tuning = { model: "model-a", options: { effort: "high" } }
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
  const dropTurn = async (f: ReturnType<typeof fixture>, index: number) => {
    f.owner.observe({ type: "live-session", session: { ...f.state, status: "running" } })
    f.owner.observe({ type: "live-session", session: { ...f.state, ...dropped } })
    f.prompts[index]?.resolve()
    await tick()
  }

  // The continuation is sent, once.
  let f = fixture({ autoContinueDelayMs: 20 })
  try {
    await f.owner.start("test-provider", "/tmp", { conversationId: f.id })
    f.started.resolve(f.state)
    await tick()
    const first = randomUUID()
    f.owner.submit(f.id, first, "first", [], tuning)
    await tick()
    await dropTurn(f, 0)
    let requests = f.owner.snapshot(f.id)!.requests
    assert.equal(requests.length, 1)
    assert.ok(requests[0]?.interruption?.autoContinue, "stamped while the send is pending")
    assert.ok((requests[0]?.interruption?.autoContinue?.at ?? 0) > Date.now(), "the stamp says when")
    await sleep(60)
    requests = f.owner.snapshot(f.id)!.requests
    assert.equal(requests.length, 2, "Mako sent the continuation")
    assert.equal(requests[0]?.interruption?.autoContinue, undefined, "the stamp is gone once it is sent")
    const continuation = requests[1]!
    assert.deepEqual(continuation.continues, { requestId: first, reason: "connection-lost", auto: true })
    assert.equal(continuation.status, "dispatching")
    assert.deepEqual(continuation.tuning, tuning, "the continuation runs under the interrupted turn's settings")
    assert.match(continuation.text, /connection dropped/)
    assert.equal(f.sent.at(-1), continuation.text)
    const reopened = new LiveJournal(f.root, f.id)
    try {
      assert.deepEqual(reopened.read()?.requests[1]?.continues, continuation.continues, "the continuation survives the journal")
    } finally {
      reopened.close()
    }
    // The continuation drops too: one attempt per turn, so this one is the user's.
    await dropTurn(f, 1)
    requests = f.owner.snapshot(f.id)!.requests
    assert.equal(requests[1]?.interruption?.reason, "connection-lost")
    assert.equal(requests[1]?.interruption?.autoContinue, undefined, "a continuation that drops is not continued again")
    await sleep(60)
    assert.equal(f.owner.snapshot(f.id)!.requests.length, 2, "nothing more was sent")
  } finally {
    f.cleanup()
  }

  // The user's own prompt in the window supersedes the continuation.
  f = fixture({ autoContinueDelayMs: 20 })
  try {
    await f.owner.start("test-provider", "/tmp", { conversationId: f.id })
    f.started.resolve(f.state)
    await tick()
    f.owner.submit(f.id, randomUUID(), "first")
    await tick()
    await dropTurn(f, 0)
    assert.ok(f.owner.snapshot(f.id)!.requests[0]?.interruption?.autoContinue)
    f.owner.submit(f.id, randomUUID(), "the user's own follow-up")
    await tick()
    await sleep(60)
    const requests = f.owner.snapshot(f.id)!.requests
    assert.equal(requests.length, 2)
    assert.equal(requests[0]?.interruption?.autoContinue, undefined, "the user's prompt clears the stamp")
    assert.equal(requests[1]?.continues, undefined)
    assert.match(
      f.sent.at(-1) ?? "",
      /^<mako-local-control>\nYour previous turn was cut short at [^\n]+\n<\/mako-local-control>\n\nthe user's own follow-up$/,
      "the user's prompt tells the agent its turn was cut short"
    )
  } finally {
    f.cleanup()
  }

  // Stop in the window is the user's answer: the turn stays where it stopped.
  f = fixture({ autoContinueDelayMs: 20 })
  try {
    await f.owner.start("test-provider", "/tmp", { conversationId: f.id })
    f.started.resolve(f.state)
    await tick()
    f.owner.submit(f.id, randomUUID(), "first")
    await tick()
    await dropTurn(f, 0)
    await f.owner.cancel(f.id)
    assert.equal(f.owner.snapshot(f.id)!.requests[0]?.interruption?.autoContinue, undefined)
    await sleep(60)
    assert.equal(f.owner.snapshot(f.id)!.requests.length, 1, "Stop declined the continuation")
    assert.deepEqual(f.sent, ["first"])
  } finally {
    f.cleanup()
  }

  // The host leaving in the window takes the promise with it: the journal
  // the next host reads carries the manual offer, not a pending send.
  f = fixture({ autoContinueDelayMs: 20 })
  try {
    await f.owner.start("test-provider", "/tmp", { conversationId: f.id })
    f.started.resolve(f.state)
    await tick()
    f.owner.submit(f.id, randomUUID(), "first")
    await tick()
    await dropTurn(f, 0)
    f.owner.stop()
    await sleep(60)
    const reopened = new LiveJournal(f.root, f.id)
    try {
      const persisted = reopened.read()?.requests ?? []
      assert.equal(persisted.length, 1, "the stopped host sent nothing")
      assert.equal(persisted[0]?.interruption?.reason, "connection-lost")
      assert.equal(persisted[0]?.interruption?.autoContinue, undefined)
    } finally {
      reopened.close()
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
}

/**
 * A provider process that dies under a turn it accepted is reopened on its
 * native session and the turn continued, once, for any harness. A process
 * that dies before the provider accepted the prompt leaves an unknown
 * outcome to the user, a turn that fails on a dropped connection continues
 * in the same process, and any other failure stays a failure.
 */
/**
 * With "Continue interrupted turns after Mako restarts" on, a turn Mako's own
 * exit cut short goes on once the next host starts: its session reopens on
 * its native id and Mako sends the continuation, naming the background work
 * the exit stopped, which the request keeps for the window. A continuation
 * cut by the next restart goes on too, three times in five minutes; the
 * fourth is the person's. Off, the turn waits for Continue turn.
 */
async function restartContinued() {
  const root = mkdtempSync(join(tmpdir(), "mako-live-restart-"))
  const id = randomUUID()
  const starts: Array<string | undefined> = []
  const prompts: string[] = []
  const events: HostEvent[] = []
  const emitters: Array<{ binding: string; emit: (event: LiveDriverEvent) => void }> = []
  const session = (bindingId: string, patch: Partial<LiveSessionState> = {}): LiveSessionState => ({
    id: bindingId, nativeId: "native-restart", nativePath: join(root, "native-restart"), harness: "test-provider", cwd: root,
    status: "ready", connection: "connected", modes: [], currentMode: null, configOptions: [], ...patch,
  })
  const driver: ProviderLiveDriver = {
    ...fixtureCapabilities,
    resume: fixtureResume(),
    provider: "test-provider",
    available: () => true,
    start: async (_cwd, options) => {
      starts.push(options.resume)
      if (options.emit) emitters.push({ binding: options.conversationId, emit: options.emit })
      return session(options.conversationId)
    },
    prompt: async (bindingId, text, _attachments, _settings, dispatch) => {
      prompts.push(text)
      dispatch.report({ kind: "submitted", source: "transport-call" })
      emitters.at(-1)?.emit({ type: "live-session", session: session(bindingId, { status: "running" }) })
      dispatch.report({ kind: "accepted", source: "native-echo" })
    },
    permission: async () => {},
    cancel: async () => {},
    close: async () => {},
    setMode: async () => {},
  }
  const open = () => new LiveConversations({
    appPath: root, root: join(root, "journals"), driver: () => driver, history: async () => null,
    emit: (event) => events.push(event), autoContinueDelayMs: 20,
    resumeVerdict: async () => ({ kind: "resumable", record: "moved" }),
  })
  const dispatched = (owner: LiveConversations, index: number) =>
    waitFor(() => owner.snapshot(id)?.requests[index]?.status === "dispatching", `request ${index} was not dispatched`)
  const server = { nativeId: "dev-server", title: "Dev server", work: "command" as const, detail: "npm run dev", background: true, state: { kind: "working" as const } }
  let owner = open()
  try {
    assert.deepEqual(owner.conversationSettings(), { continueAfterRestart: false }, "off unless the person turns it on")
    assert.deepEqual(owner.setConversationSettings({ continueAfterRestart: true }), { continueAfterRestart: true })
    assert.deepEqual(events.at(-1), { type: "conversation-settings", settings: { continueAfterRestart: true } }, "every window hears the choice")
    await owner.start("test-provider", root, { conversationId: id })
    const first = randomUUID()
    owner.submit(id, first, "first")
    await dispatched(owner, 0)
    const binding = emitters.at(-1)!
    binding.emit({ type: "live-agent", id: binding.binding, agent: server })
    await waitFor(() => owner.snapshot(id)?.nativeAgents?.agents.length === 1, "the dev server was not on the roster")
    owner.stop()

    owner = open()
    assert.deepEqual(owner.conversationSettings(), { continueAfterRestart: true }, "the choice outlives the host")
    let requests = owner.snapshot(id)!.requests
    assert.equal(requests[0]?.interruption?.reason, "host-quit")
    assert.deepEqual(requests[0]?.interruption?.stopped, ["npm run dev"], "the request keeps the background work the exit stopped, for the window")
    owner.continueRestarted()
    assert.ok(owner.snapshot(id)!.requests[0]?.interruption?.autoContinue, "the footer says Mako is continuing it")
    await waitFor(() => prompts.length === 2, "the continuation was not sent after the restart")
    assert.deepEqual(starts, [undefined, "native-restart"], "the session reopened on its native id")
    requests = owner.snapshot(id)!.requests
    assert.deepEqual(requests[1]?.continues, { requestId: first, reason: "host-quit", auto: true })
    assert.deepEqual(requests[1]?.actor, { kind: "service", name: "auto-continue" })
    assert.equal(requests[1]?.text, continueTurnPrompt("host-quit", "mako", ["npm run dev"]), "the agent is told what the exit stopped, in the request's own list")
    assert.deepEqual(savedContinuation(requests[1]!.text), { reason: "host-quit", sender: "mako" })

    // Restarted again and again: Mako's continuations go on three times in a row, then the turn is the person's.
    for (const index of [1, 2, 3]) {
      await dispatched(owner, index)
      owner.stop()
      owner = open()
      owner.continueRestarted()
      if (index < 3) await waitFor(() => prompts.length === index + 2, `continuation ${index + 1} was not sent`)
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 60))
    requests = owner.snapshot(id)!.requests
    assert.equal(prompts.length, 4, "the loop guard: three continuations in a row within five minutes, then none")
    assert.equal(requests.at(-1)?.interruption?.reason, "host-quit")
    assert.equal(requests.at(-1)?.interruption?.autoContinue, undefined, "the last cut turn waits for Continue turn")

    // Off, Mako's exit leaves the turn to the person.
    owner.setConversationSettings({ continueAfterRestart: false })
    owner.submit(id, randomUUID(), "again")
    await dispatched(owner, requests.length)
    owner.stop()
    owner = open()
    owner.continueRestarted()
    await new Promise<void>((resolve) => setTimeout(resolve, 60))
    assert.equal(prompts.length, 5, "nothing is continued with the choice off")
    assert.equal(owner.snapshot(id)!.requests.at(-1)?.interruption?.autoContinue, undefined)

    // A handoff stops the turn and what it left running; the request keeps the same list the move's continuation names.
    owner.submit(id, randomUUID(), "handed")
    await dispatched(owner, owner.snapshot(id)!.requests.length - 1)
    const handing = emitters.at(-1)!
    handing.emit({ type: "live-agent", id: handing.binding, agent: server })
    const paused = await owner.handOff(id)
    assert.deepEqual(paused?.stopped, ["npm run dev"])
    handing.emit({ type: "live-session", session: session(handing.binding, { status: "ready", lastStop: "cancelled" }) })
    await waitFor(() => owner.snapshot(id)?.requests.at(-1)?.status === "interrupted", "the handed-off turn did not settle")
    const handed = owner.snapshot(id)!.requests.at(-1)?.interruption
    assert.equal(handed?.reason, "handed-off")
    assert.deepEqual(handed?.stopped, paused?.stopped, "one list: what the request keeps is what the continuation names")
  } finally {
    owner.stop()
    rmSync(root, { recursive: true, force: true })
  }
  console.log("PASS: after Mako restarts, a turn its exit cut short continues if the person chose so, naming what stopped, at most three times in five minutes; a handoff keeps the same list")
}

/** What the fixture driver does when the host cancels or closes it, set per case. */
interface DriverHooks {
  cancel?: () => void
  close?: () => void
}

async function providerExitContinued() {
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
  const run = async (accepts: boolean, check: (context: {
    owner: LiveConversations
    id: string
    starts: Array<string | undefined>
    prompts: string[]
    end: (patch: Partial<LiveSessionState>) => void
    update: (update: LiveUpdate) => void
    hooks: DriverHooks
    root: string
    /** The connection a window reads, folded from the batches the host emitted, as the renderer folds them. */
    heard: () => string | undefined
  }) => Promise<void>) => {
    const root = mkdtempSync(join(tmpdir(), "mako-live-provider-exit-"))
    const id = randomUUID()
    const starts: Array<string | undefined> = []
    const prompts: string[] = []
    const emitters: Array<(event: LiveDriverEvent) => void> = []
    const bindings: string[] = []
    const hooks: DriverHooks = {}
    let heard: string | undefined = "connected"
    const session = (bindingId: string, patch: Partial<LiveSessionState> = {}): LiveSessionState => ({
      id: bindingId,
      nativeId: "native-exit",
      nativePath: join(root, "native-exit"),
      harness: "test-provider",
      cwd: root,
      status: "ready",
      connection: "connected",
      modes: [],
      currentMode: null,
      configOptions: [],
      ...patch,
    })
    const driver: ProviderLiveDriver = {
      ...fixtureCapabilities,
      turnRecovery: {
        kind: "continues",
        accepted: "prompt reports accepted when the fixture echoes it",
        exit: "the fixture session reports failed and disconnected",
        tests: ["scripts/test-live-conversations.ts"],
      },
      resume: fixtureResume(),
      provider: "test-provider",
      available: () => true,
      start: async (_cwd, options) => {
        starts.push(options.resume)
        bindings.push(options.conversationId)
        if (options.emit) emitters.push(options.emit)
        return session(options.conversationId)
      },
      prompt: async (bindingId, text, _attachments, _settings, dispatch) => {
        prompts.push(text)
        dispatch.report({ kind: "submitted", source: "transport-call" })
        emitters.at(-1)?.({ type: "live-session", session: session(bindingId, { status: "running" }) })
        if (accepts) dispatch.report({ kind: "accepted", source: "native-echo" })
      },
      permission: async () => {},
      cancel: async () => { hooks.cancel?.() },
      close: async () => { hooks.close?.() },
      setMode: async () => {},
    }
    const owner = new LiveConversations({
      appPath: root,
      root: join(root, "journals"),
      driver: () => driver,
      history: async () => null,
      emit: (event) => {
        if (event.type === "live-batch" && event.batch.sessionChanges?.connection) heard = event.batch.sessionChanges.connection
      },
      autoContinueDelayMs: 20,
      resumeVerdict: async () => ({ kind: "resumable", record: "moved" }),
    })
    try {
      await owner.start("test-provider", root, { conversationId: id })
      await check({
        owner,
        id,
        starts,
        prompts,
        end: (patch) => emitters.at(-1)?.({ type: "live-session", session: session(bindings.at(-1) ?? id, patch) }),
        update: (update) => emitters.at(-1)?.({ type: "live-update", id: bindings.at(-1) ?? id, update }),
        hooks,
        root,
        heard: () => heard,
      })
    } finally {
      owner.stop()
      rmSync(root, { recursive: true, force: true })
    }
  }
  const exited = { status: "failed", connection: "disconnected", error: "The agent process exited with code 70" } as const
  const dispatched = (owner: LiveConversations, id: string, index: number) =>
    waitFor(() => owner.snapshot(id)?.requests[index]?.status === "dispatching", `request ${index} was not dispatched`)

  await run(true, async ({ owner, id, starts, prompts, end, heard }) => {
    const first = randomUUID()
    owner.submit(id, first, "first")
    await dispatched(owner, id, 0)
    end(exited)
    let requests = owner.snapshot(id)!.requests
    assert.equal(requests[0]?.status, "interrupted", "an accepted turn whose process died is continuable, not failed")
    assert.equal(requests[0]?.interruption?.reason, "provider-exited")
    assert.ok(requests[0]?.interruption?.autoContinue, "Mako schedules the continuation even with the process gone")
    await waitFor(() => prompts.length === 2, "the continuation was not sent")
    assert.deepEqual(starts, [undefined, "native-exit"], "the provider was reopened on its native session")
    requests = owner.snapshot(id)!.requests
    assert.deepEqual(requests[1]?.continues, { requestId: first, reason: "provider-exited", auto: true })
    assert.deepEqual(requests[1]?.actor, { kind: "service", name: "auto-continue" })
    assert.match(prompts[1] ?? "", /process stopped/)
    // The reopened process is what the windows hear of, not the one that exited: a window that kept `disconnected`
    // took a question the running agent was still waiting on for one nothing could answer.
    assert.equal(owner.snapshot(id)!.session.connection, "connected")
    assert.equal(heard(), "connected", "the switch to the new process reached the windows")
    await dispatched(owner, id, 1)
    end(exited)
    await sleep(60)
    requests = owner.snapshot(id)!.requests
    assert.equal(requests[1]?.interruption?.reason, "provider-exited")
    assert.equal(requests[1]?.interruption?.autoContinue, undefined, "a continuation whose process dies again is the user's")
    assert.equal(prompts.length, 2, "one attempt per turn")
    assert.equal(starts.length, 2)
  })

  await run(false, async ({ owner, id, starts, prompts, end }) => {
    owner.submit(id, randomUUID(), "first")
    await dispatched(owner, id, 0)
    end(exited)
    await sleep(60)
    const request = owner.snapshot(id)!.requests[0]
    assert.equal(request?.status, "failed", "without a receipt the outcome is unknown")
    assert.equal(request?.interruption, undefined)
    assert.equal(prompts.length, 1, "an unknown outcome is never sent or continued automatically")
    assert.equal(starts.length, 1)
  })

  // The continuation says what the agent does not know: which calls never
  // returned, and which returned after its last step, with their results.
  const parallelCalls = (update: (update: LiveUpdate) => void) => {
    update({ kind: "text", text: "Starting three researchers." })
    update({ kind: "tool", id: "done-early", title: "Research Capy", status: "running" })
    update({ kind: "tool", id: "done-late", title: "Research Tembo", status: "running" })
    update({ kind: "tool", id: "open", title: "Research Replicas", status: "running" })
    update({ kind: "tool-update", id: "done-early", status: "completed", output: "Capy keeps setup in the app." })
    update({ kind: "tool-update", id: "done-late", status: "completed", output: "Tembo keeps setup in the app." })
  }
  await run(true, async ({ owner, id, prompts, end, update }) => {
    const first = randomUUID()
    owner.submit(id, first, "first")
    await dispatched(owner, id, 0)
    update({ kind: "tool", id: "seen", title: "Read notes", status: "running" })
    update({ kind: "tool-update", id: "seen", status: "completed", output: "notes" })
    parallelCalls(update)
    end(exited)
    const interrupted = owner.snapshot(id)!.requests[0]!
    assert.deepEqual(
      interrupted.interruption?.calls?.map((call) => [call.title, call.result]),
      [["Research Capy", "unseen"], ["Research Tembo", "unseen"], ["Research Replicas", "none"]],
      "a result the agent read before its next step is not reported"
    )
    const open = owner.snapshot(id)!.blocks.find((block) => block.type === "tool" && block.id === "open")
    assert.ok(open?.type === "tool" && open.status === "failed" && open.unfinished, "the row nothing will report on is closed")
    assert.equal(open.output, undefined, "the row keeps what the call had produced; the turn's own notice says why it ended")
    assert.deepEqual(interrupted.interruption?.closed, ["open"])
    await waitFor(() => prompts.length === 2, "the continuation was not sent")
    const note = prompts[1]!
    assert.match(note, /^<mako-local-control>\nYour previous turn was cut short at \d\d:\d\d:\d\d: The agent process exited with code 70\./)
    assert.match(note, /never returned a result[^\n]*\n- Research Replicas\n/)
    const saved = interrupted.interruption!.calls![1]!.file!
    assert.ok(note.includes(`- Research Tembo: the full result is saved at ${saved}`))
    assert.match(readFileSync(saved, "utf8"), /Tembo keeps setup in the app\./)
    assert.match(note, /that is wrong: the user did not stop it\.\n<\/mako-local-control>\n\nContinue where you left off/)
    assert.ok(owner.snapshot(id)!.requests[0]?.interruption?.told, "the account is marked told")
    end({ status: "ready" })
    owner.submit(id, randomUUID(), "next")
    await waitFor(() => prompts.length === 3, "the next prompt was not sent")
    assert.ok(!prompts[2]!.includes("cut short"), "the account is told once")
  })

  await run(true, async ({ owner, id, prompts, end, update }) => {
    owner.submit(id, randomUUID(), "first")
    await dispatched(owner, id, 0)
    parallelCalls(update)
    end(exited)
    owner.submit(id, randomUUID(), "what happened?")
    await waitFor(() => prompts.length === 2, "the user's prompt was not sent")
    assert.match(prompts[1]!, /Your previous turn was cut short[\s\S]*- Research Replicas[\s\S]*what happened\?$/, "the user's own send carries the account when it comes first")
    await sleep(60)
    assert.equal(prompts.length, 2, "and replaces the continuation")
  })

  await run(true, async ({ owner, id, starts, prompts, end }) => {
    owner.submit(id, randomUUID(), "first")
    await dispatched(owner, id, 0)
    end({ status: "failed", error: "stream disconnected before completion: error sending request" })
    const request = owner.snapshot(id)!.requests[0]
    assert.equal(request?.interruption?.reason, "connection-lost", "a turn that failed on a dropped connection is continued")
    await waitFor(() => prompts.length === 2, "the continuation was not sent")
    assert.equal(starts.length, 1, "a live process is continued in place")
  })

  await run(true, async ({ owner, id, prompts, end }) => {
    owner.submit(id, randomUUID(), "first")
    await dispatched(owner, id, 0)
    end({ status: "failed", lastStop: RETRIES_EXHAUSTED_STOP, error: "Connection failed repeatedly" })
    await sleep(60)
    const request = owner.snapshot(id)!.requests[0]
    assert.equal(request?.status, "failed", "a turn whose transport exhausted its own retries is never re-run by Mako, though its words read as a dropped connection")
    assert.equal(request?.interruption, undefined)
    assert.equal(request?.failure, "network")
    assert.equal(prompts.length, 1)
  })

  await run(true, async ({ owner, id, prompts, end }) => {
    owner.submit(id, randomUUID(), "first")
    await dispatched(owner, id, 0)
    end({ status: "failed", error: "429 Too Many Requests: rate limit exceeded" })
    await sleep(60)
    const request = owner.snapshot(id)!.requests[0]
    assert.equal(request?.status, "failed", "a provider's refusal is a failure, not a continuation")
    assert.equal(request?.failure, "rate-limited")
    assert.equal(prompts.length, 1)
  })

  // Stop is the user's answer however the driver ends the turn: Cursor's
  // unacknowledged cancel closes the process, Claude's interrupt can settle
  // as a failed result first.
  for (const ending of [exited, { status: "failed", error: "stream disconnected before completion" }] as const)
    await run(true, async ({ owner, id, starts, prompts, end, update, hooks }) => {
      const first = randomUUID()
      owner.submit(id, first, "first")
      await dispatched(owner, id, 0)
      update({ kind: "tool", id: "sleep", title: "sleep 90", status: "running" })
      hooks.cancel = () => end(ending)
      assert.equal(await owner.stopRequest(id, first), true)
      await sleep(60)
      const request = owner.snapshot(id)!.requests[0]
      assert.equal(request?.status, "interrupted")
      assert.equal(request?.interruption?.reason, "stopped", `a stopped turn that ended ${ending.error} reads as stopped`)
      const call = owner.snapshot(id)!.blocks.find((block) => block.type === "tool" && block.id === "sleep")
      assert.equal(call?.type === "tool" ? call.status : undefined, "canceled", "a call the stopped process never reported is closed, not left running")
      assert.equal(request?.interruption?.calls, undefined, "a stopped turn records nothing for the next prompt to explain")
      assert.equal(prompts.length, 1, "a stopped turn is never continued")
      assert.equal(starts.length, 1, "a stopped turn never restarts the provider")
    })

  // A turn that finishes as Stop reaches it keeps its answer.
  await run(true, async ({ owner, id, prompts, end, hooks }) => {
    const first = randomUUID()
    owner.submit(id, first, "first")
    await dispatched(owner, id, 0)
    hooks.cancel = () => end({ status: "ready", lastStop: "end_turn" })
    await owner.stopRequest(id, first)
    await sleep(60)
    assert.equal(owner.snapshot(id)!.requests[0]?.status, "completed", "Stop does not relabel a turn that finished")
    assert.equal(prompts.length, 1)
  })

  // Closing the conversation mid-turn ends it on purpose.
  await run(true, async ({ owner, id, starts, prompts, end, hooks }) => {
    owner.submit(id, randomUUID(), "first")
    await dispatched(owner, id, 0)
    hooks.close = () => end(exited)
    await owner.close(id)
    await sleep(60)
    assert.notEqual(owner.snapshot(id)?.requests[0]?.interruption?.reason, "provider-exited")
    assert.equal(prompts.length, 1, "a closed conversation is never continued")
    assert.equal(starts.length, 1)
  })

  // A driver that reports its session closed was ended on purpose.
  await run(true, async ({ owner, id, prompts, end }) => {
    owner.submit(id, randomUUID(), "first")
    await dispatched(owner, id, 0)
    end({ status: "closed", connection: "disconnected" })
    const request = owner.snapshot(id)!.requests[0]
    assert.equal(request?.interruption?.autoContinue, undefined, "a closed session is never scheduled")
    assert.notEqual(request?.interruption?.reason, "provider-exited", "a closed session did not stop unexpectedly")
    await sleep(60)
    assert.equal(prompts.length, 1, "a closed session is never continued")
  })

  // A continuation the user declined stays declined: a later turn the
  // provider starts on its own, or a compaction, ending does not revive it.
  await run(true, async ({ owner, id, prompts, end }) => {
    owner.submit(id, randomUUID(), "first")
    await dispatched(owner, id, 0)
    end({ status: "failed", error: "stream disconnected before completion" })
    assert.ok(owner.snapshot(id)!.requests[0]?.interruption?.autoContinue)
    await owner.cancel(id)
    end({ status: "running" })
    end({ status: "ready" })
    end({ status: "running" })
    end({ status: "failed", error: "stream disconnected before completion" })
    await sleep(60)
    assert.equal(owner.snapshot(id)!.requests[0]?.interruption?.autoContinue, undefined)
    assert.equal(prompts.length, 1, "a declined continuation is never sent later")
  })
}

/**
 * A failed message the person asked to send at a usage limit's reset waits
 * held with its time, survives a restart in the journal, and goes once the
 * held-wakes job finds its time has come; Resume sends it at once.
 */
async function heldUntilReset() {
  const f = fixture()
  try {
    const first = randomUUID()
    await f.owner.start("test-provider", "/tmp", { conversationId: f.id, initialRequest: { id: first, text: "limited", attachments: [] } })
    f.started.resolve(f.state)
    await tick()
    f.prompts[0]!.reject(new Error("429 Too Many Requests: usage limit reached"))
    await waitFor(() => f.owner.snapshot(f.id)?.requests[0]?.status === "failed", "the first message fails")
    assert.equal(f.owner.snapshot(f.id)?.requests[0]?.failure, "rate-limited")
    const at = Date.now() + 60_000
    const later = randomUUID()
    const held = f.owner.holdUntil(f.id, later, { after: first, at })
    assert.equal(held.status, "held")
    assert.deepEqual(held.wake, { at, after: first })
    assert.equal(held.text, "limited")
    assert.equal(f.owner.holdUntil(f.id, later, { after: first, at }).id, later, "a repeated id answers with the first acceptance")
    assert.throws(() => f.owner.holdUntil(f.id, randomUUID(), { after: later, at }), /no longer waiting/)
    assert.equal(f.owner.summaries().find((summary) => summary.session.id === f.id)?.wakeAt, at)
    assert.deepEqual(f.owner.wakeDue(at - 1), [], "nothing goes before its time")
    assert.equal(f.sent.length, 1)

    // A new host finds the wait in the journal, without opening the conversation.
    f.owner.stop()
    const recovered = new LiveConversations(f.dependencies)
    try {
      assert.equal(recovered.summaries().find((summary) => summary.session.id === f.id)?.wakeAt, at)
      assert.deepEqual(recovered.wakeDue(at), [f.id])
      const released = recovered.snapshot(f.id)?.requests.find((request) => request.id === later)
      assert.equal(released?.wake, undefined)
      assert.notEqual(released?.status, "held", "its time came, so it is no longer held")
      assert.equal(recovered.summaries().find((summary) => summary.session.id === f.id)?.wakeAt, undefined)
    } finally {
      recovered.stop()
    }
  } finally {
    f.cleanup()
  }
}

/** Resume on a timed hold sends it now and clears the time; removing it cancels the wait. */
async function heldWakeResumes() {
  const f = fixture()
  try {
    const first = randomUUID()
    await f.owner.start("test-provider", "/tmp", { conversationId: f.id, initialRequest: { id: first, text: "limited", attachments: [] } })
    f.started.resolve(f.state)
    await tick()
    f.prompts[0]!.reject(new Error("429 rate limit"))
    await waitFor(() => f.owner.snapshot(f.id)?.requests[0]?.status === "failed", "the first message fails")
    f.owner.observe({ type: "live-session", session: { ...f.state, status: "ready" } })
    const later = randomUUID()
    f.owner.holdUntil(f.id, later, { after: first, at: Date.now() + 3_600_000 })
    f.owner.editQueued(f.id, { requestId: later, expectedText: "limited", change: { kind: "resume" } })
    await tick()
    const resumed = f.owner.snapshot(f.id)?.requests.find((request) => request.id === later)
    assert.equal(resumed?.wake, undefined)
    assert.deepEqual(f.sent, ["limited", "limited"], "Resume sends the held message now")
    const another = randomUUID()
    f.prompts[1]!.resolve()
    await tick()
    f.owner.observe({ type: "live-session", session: { ...f.state, status: "ready" } })
    f.owner.holdUntil(f.id, another, { after: first, at: Date.now() + 3_600_000 })
    f.owner.editQueued(f.id, { requestId: another, expectedText: "limited", change: { kind: "remove" } })
    assert.equal(f.owner.snapshot(f.id)?.requests.find((request) => request.id === another)?.status, "canceled")
    assert.deepEqual(f.owner.wakeDue(Date.now() + 7_200_000), [], "a canceled wait never wakes")
  } finally {
    f.cleanup()
  }
}

/**
 * A request the agent asked and nobody answered, when its process exits, is
 * kept and marked gone rather than offered; Stop puts it away and so does
 * the next message.
 */
async function approvalOfAGoneProcess() {
  const f = fixture()
  try {
    const first = randomUUID()
    await f.owner.start("test-provider", "/tmp", { conversationId: f.id, initialRequest: { id: first, text: "first", attachments: [] } })
    f.started.resolve(f.state)
    await tick()
    f.owner.observe({ type: "live-session", session: { ...f.state, status: "running" } })
    f.prompts[0]!.resolve()
    f.owner.observe({ type: "live-session", session: { ...f.state, status: "ready" } })
    await tick()
    assert.equal(f.owner.snapshot(f.id)?.requests[0]?.status, "completed")
    // Asked between turns (a background task's request): no turn settles when its process goes.
    f.owner.observe({ type: "live-permission", request: { id: "ask", sessionId: f.id, title: "npm test", options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] } })
    assert.equal(f.owner.snapshot(f.id)?.permissions.length, 1)
    assert.equal(f.owner.snapshot(f.id)?.permissions[0]?.gone, undefined)
    f.owner.observe({ type: "live-session", session: { ...f.state, status: "ready", connection: "disconnected" } })
    assert.equal(f.owner.snapshot(f.id)?.permissions[0]?.gone, true, "the process that asked has gone")
    await f.owner.cancel(f.id)
    assert.deepEqual(f.owner.snapshot(f.id)?.permissions, [], "Stop puts the unanswerable request away")
  } finally {
    f.cleanup()
  }
}

await refusedStartup()
await settledVerdicts()
await autoContinuedTurn()
await providerExitContinued()
await restartContinued()
await coalescedToolBursts()
await batchesLeadThenPace()
await quietTurnsCarryLastActivity()
await nativeActivityLastsItsTurn()
await failureIsolationAndAssets()
await makoStopsAreSaid()
await unsavedTurnIsMakos()
await otherFailuresDontStop()
await unsavedConversationDoesntBlockStop()

await queuedSettings()
await acceptanceAndRaces()
await turnOfItsOwn()
await startedAheadTakesFirstMessage()
await closeDuringStartup()
await closeBeforeNativeSpawn()
await durabilityAndBatching()
await resumedHibernatesBeforeATurn()
await hibernatesAndWakesExactlyOnce()
await hibernatesAndWakesExactlyOnce(true)
await hibernatesAndWakesExactlyOnce("close-during-preparation")
await hibernatesAndWakesExactlyOnce("changed-store")
await compactsAfterHibernation()
await turnEndBatchSaysItsWorkEnded()
await resumesAfterQuitInFirstTurn()
await backgroundWorkKeepsProviderResident()
await boundsWarmProviders()
await prewarmOverlapsTyping()
await unloadsHibernatedConversations()
await bulkLoadsAreNamed()
await failedCloseKeepsOwnership()
await heldUntilReset()
await heldWakeResumes()
await approvalOfAGoneProcess()
identityAndToolLifecycle()
console.log(
  "Live conversations: durable deduplicated acceptance, a harness started ahead taking its first message, startup/terminal races, idle hibernation with one resume, recovery, batching, tool lifecycle, and 499/499 completed exchange identities passed"
)
