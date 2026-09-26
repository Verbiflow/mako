import type { SessionSettings } from "@mako/sessions/settings"
import assert from "node:assert/strict"
import { mock } from "node:test"
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { LiveConversations } from "../electron/live-conversations.js"
import { LiveJournal } from "../electron/live-journal.js"
import { SessionMemory } from "../electron/session-memory.js"
import { WorkspaceSnapshots } from "../electron/workspace-snapshots.js"
import { reduceLiveUpdates } from "../electron/contracts/live-content.js"
import { CONNECTION_LOST_STOP } from "../electron/contracts/providers-acp.js"
import type {
  LiveDriverEvent,
  LiveSessionState,
  HostEvent,
} from "../electron/shared.js"
import type { ProviderLiveDriver } from "../electron/providers/live-driver.js"
import { projectLive } from "../src/state/live-projection.js"

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
  const driver: ProviderLiveDriver = {
    approvalEvidence: { kind: "submission-only", reason: "Injected driver fixture" },
    canResume: true,
    provider: "test-provider",
    available: () => true,
    start: () => started.promise,
    prompt: async (_id, text, _attachments, tuning) => {
      sent.push(text)
      settings.push(tuning)
      const pending = deferred<void>()
      prompts.push(pending)
      await pending.promise
    },
    permission: async () => {},
    cancel: async () => {},
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
    cleanup: () => {
      owner.stop()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

async function hibernatesAndWakesExactlyOnce() {
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
  const workspaceSnapshots = new WorkspaceSnapshots(
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
    nativePath,
    harness: "test-provider",
    cwd: root,
    status: "ready",
    connection: "connected",
    modes: [{ id: "full", name: "Full" }],
    currentMode,
    configOptions: [],
  })
  const driver: ProviderLiveDriver = {
    approvalEvidence: { kind: "submission-only", reason: "Injected driver fixture" },
    canResume: true,
    provider: "test-provider",
    available: () => true,
    start: async (_cwd, options) => {
      starts++
      if (options.emit) emitters.push(options.emit)
      startModes.push(options.modeId)
      startTunings.push(options.tuning)
      return session(options.conversationId, options.modeId ?? null)
    },
    prompt: async (bindingId, text) => {
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
  const owner = new LiveConversations({
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
  })
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

async function boundsWarmProviders() {
  const root = mkdtempSync(join(tmpdir(), "mako-live-warm-pool-"))
  const ids = [randomUUID(), randomUUID(), randomUUID()]
  const closed: string[] = []
  let owner: LiveConversations
  const driver: ProviderLiveDriver = {
    approvalEvidence: { kind: "submission-only", reason: "Injected driver fixture" },
    canResume: true,
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
    prompt: async (id) => {
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
    approvalEvidence: { kind: "submission-only", reason: "Injected driver fixture" },
    canResume: true,
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
    prompt: async (id) => {
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
    approvalEvidence: { kind: "submission-only", reason: "Injected driver fixture" },
    provider: "test-provider",
    canResume: true,
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
    prompt: async () => {},
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
      assert.equal(found.requests[1]?.status, "queued")
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
      assert.equal(saved.requests[1]?.status, "queued")
      assert.equal(saved.requests[1]?.text, "waiting")
      assert.equal(
        JSON.stringify(saved.blocks),
        JSON.stringify(
          snapshot.blocks.concat([
            {
              type: "user",
              provider: "test-provider",
              requestId: saved.requests[0]?.id,
              contextFiles: [],
              text: "running",
              attachments: [],
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
    assert.equal(f.sent.at(-1), "the user's own follow-up")
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

await refusedStartup()
await settledVerdicts()
await autoContinuedTurn()
await coalescedToolBursts()
await failureIsolationAndAssets()

await queuedSettings()
await acceptanceAndRaces()
await closeDuringStartup()
await durabilityAndBatching()
await hibernatesAndWakesExactlyOnce()
await backgroundWorkKeepsProviderResident()
await boundsWarmProviders()
await failedCloseKeepsOwnership()
identityAndToolLifecycle()
console.log(
  "Live conversations: durable deduplicated acceptance, startup/terminal races, idle hibernation with one resume, recovery, batching, tool lifecycle, and 499/499 completed exchange identities passed"
)
