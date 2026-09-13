import type { SessionSettings } from "@mako/sessions/settings"
import assert from "node:assert/strict"
import { mock } from "node:test"
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { LiveConversations } from "../electron/live-conversations.js"
import { LiveJournal } from "../electron/live-journal.js"
import { reduceLiveUpdates } from "../electron/contracts/live-content.js"
import type { LiveSessionState, HostEvent } from "../electron/shared.js"
import type { ProviderLiveDriver } from "../electron/providers/live-driver.js"
import { projectLive } from "../src/state/live-projection.js"

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
function deferred<Value>() {
  let resolve!: (value: Value) => void
  let reject!: (error: Error) => void
  const promise = new Promise<Value>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function fixture() {
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
    f.started.resolve(f.state)
    await tick()
    f.owner.submit(f.id, request, "same prompt", [], first)
    f.owner.observe({
      type: "acp-session",
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
    f.owner.observe({ type: "acp-session", session: f.state })
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
      type: "acp-session",
      session: { ...f.state, status: "running" },
    })
    const second = randomUUID()
    f.owner.submit(f.id, second, "second")
    f.owner.observe({
      type: "acp-update",
      id: f.id,
      update: { kind: "text", id: "item", text: "par" },
    })
    f.owner.observe({
      type: "acp-update",
      id: f.id,
      update: { kind: "text", id: "item", text: "corrected", replace: true },
    })
    f.owner.observe({ type: "acp-session", session: f.state })
    assert.deepEqual(f.sent, ["first", "second"])
    f.owner.observe({
      type: "acp-session",
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
        type: "acp-update",
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
      type: "acp-session",
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
    f.owner.observe({ type: "acp-session", session: { ...f.state } })
    assert.deepEqual(f.sent, [], "rejected acceptance cannot execute later")
    const long = "abcdefgh".repeat(50_000)
    f.owner.observe({
      type: "acp-update",
      id: f.id,
      update: { kind: "text", text: long, id: "large-answer" },
    })
    f.owner.observe({
      type: "acp-update",
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
      type: "acp-update",
      id: f.id,
      update: { kind: "tool", id: "input", title: "Write", status: "running" },
    })
    f.owner.snapshot(f.id)
    f.events.length = 0
    for (let index = 1; index <= 64; index++)
      f.owner.observe({
        type: "acp-update",
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
    f.owner.observe({ type: "acp-session", session: { ...f.state, status: "running" } })
    f.owner.observe({
      type: "acp-session",
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
    f.owner.observe({ type: "acp-session", session: { ...f.state, status: "running" } })
    f.owner.observe({
      type: "acp-session",
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
    f.owner.observe({ type: "acp-session", session: { ...f.state, status: "failed", error: "late stderr noise" } })
    assert.equal(f.owner.snapshot(f.id)?.session.error, "Selected model is unavailable")
    assert.deepEqual(f.sent, [])
  } finally { f.cleanup() }
}

await refusedStartup()
await settledVerdicts()
await coalescedToolBursts()
await failureIsolationAndAssets()

await queuedSettings()
await acceptanceAndRaces()
await closeDuringStartup()
await durabilityAndBatching()
identityAndToolLifecycle()
console.log(
  "Live conversations: durable deduplicated acceptance, startup/terminal races, recovery, batching, tool lifecycle, and 499/499 completed exchange identities passed"
)
