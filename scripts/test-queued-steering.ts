import { registeredHarnessIds } from "./registered-harnesses.ts"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mock } from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { LiveConversations } from "@mako/host/conversations/live-conversations"
import { LiveJournal } from "@mako/host/conversations/live-journal"
import type { LiveActionInput } from "@mako/host/contracts/live-actions"
import type { LiveSessionState } from "@mako/host/contracts/providers-acp"
import type { ProviderLiveDriver, ProviderSteerResult } from "@mako/host/harnesses/live-driver"
import { NO_NATIVE_EXCLUSION } from "@mako/host/contracts/execution-context"
import { NO_NATIVE_PROMPT_IDENTITY } from "@mako/host/contracts/native-prompt-identity"
import { fixtureResume, noCapabilities } from "./fixtures/driver-capabilities.ts"

const root = mkdtempSync(join(tmpdir(), "mako-queued-steering-"))
try {
  for (const provider of [...registeredHarnessIds(), "future"]) {
    for (const outcome of ["accepted", "refused", "held-refused", "lost-reply", "restart", "storage-failure", "receipt-storage-failure"] as const) {
      const id = randomUUID(), first = randomUUID(), queuedId = randomUUID()
      const directory = join(root, provider, outcome)
      const sent: string[] = []
      let calls = 0
      let state: LiveSessionState
      let owner: LiveConversations
      const response = Promise.withResolvers<ProviderSteerResult>()
      const driver: ProviderLiveDriver = {
        ...noCapabilities,
        resume: fixtureResume(),
        steering: { kind: "supported", lands: "step", via: "Injected driver fixture", steer: async (_id, input) => {
          calls++
          assert.equal(input.expectedRunId, state.nativeRunId)
          if (outcome === "accepted") {
            assert.equal(input.attachments?.length, 1)
            assert.ok(input.attachments?.[0]?.path)
            assert.equal(readFileSync(input.attachments[0].path, "utf8"), "x")
          }
          const journal = new LiveJournal(directory, id)
          const snapshot = journal.read()
          journal.close()
          assert.equal(snapshot?.requests.find(r => r.id === queuedId)?.status, "canceled", "Provider write sees durable queue ownership already transferred")
          assert.equal(snapshot?.control?.actions?.at(-1)?.state.kind, "dispatching")
          return response.promise
        } },
        approvalEvidence: { kind: "submission-only", reason: "Injected driver fixture" },
        launchEnvironment: { kind: "unavailable", reason: "Injected driver fixture" },
        nativeIdentity: { kind: "unavailable", reason: "Injected driver fixture" },
        nativeExclusion: NO_NATIVE_EXCLUSION,
        nativePromptIdentity: NO_NATIVE_PROMPT_IDENTITY,
        planning: { via: "setting", option: "plan", proposal: "Injected driver fixture", feedback: { kind: "next-message", reason: "Injected driver fixture" } },
        backgroundStop: { kind: "ends-with-turn", evidence: "Injected driver fixture" },
        turnRecovery: { kind: "manual", reason: "Injected driver fixture" },
        provider, available: () => true,
        async start(cwd, options) {
          state = { id: options.conversationId, harness: provider, cwd, nativeId: "fixture", status: "ready", connection: "connected", modes: [], currentMode: null, configOptions: [] }
          return state
        },
        async prompt(_id, text, _attachments, _settings, dispatch) {
          dispatch.report({ kind: "submitted", source: "transport-call" })
          sent.push(text)
          state = { ...state, status: "running", nativeRunId: randomUUID() }
          owner.observe({ type: "live-session", session: state })
        },
        async permission() {}, async cancel() {}, async setMode() {}, close() {},
      }
      const dependencies = { root: directory, appPath: root, driver: () => driver, history: async () => null, emit: () => {} }
      owner = new LiveConversations(dependencies)
      try {
        await owner.start(provider, root, { conversationId: id })
        for (let i = 0; owner.snapshot(id)?.session.connection !== "connected" && i < 100; i++) await delay(5)
        owner.submit(id, first, "first")
        owner.submit(id, queuedId, "move this message", outcome === "accepted" ? [{ name: "context.txt", mimeType: "text/plain", size: 1, data: "eA==" }] : [])
        if (outcome === "held-refused") owner.editQueued(id, { requestId: queuedId, expectedText: "move this message", change: { kind: "pause" } })
        const input: LiveActionInput = { kind: "steer-queued", id: randomUUID(), requestId: first, queuedRequestId: queuedId, text: "move this message", attachments: owner.snapshot(id)!.requests.find(r => r.id === queuedId)!.attachments }
        await assert.rejects(owner.act(id, { ...input, requestId: randomUUID() }), /no longer running/)
        await assert.rejects(owner.act(id, { ...input, text: "stale edit" }), /changed/)
        await assert.rejects(owner.act(id, { ...input, attachments: [{name:"extra",mimeType:"text/plain",size:1,data:"eA=="}] }), /changed/)
        assert.equal(calls, 0)
        if (outcome === "storage-failure") {
          const commit = mock.method(LiveJournal.prototype, "commit", () => { throw Error("disk full") })
          try { await assert.rejects(owner.act(id, input), /disk full/) } finally { commit.mock.restore() }
          assert.equal(calls, 0)
          assert.equal(owner.snapshot(id)?.requests.find(r => r.id === queuedId)?.status, "queued")
          assert.equal(owner.snapshot(id)?.control?.actions?.length ?? 0, 0)
          continue
        }
        const pending = owner.act(id, input)
        assert.equal(calls, 1)
        assert.equal((await owner.act(id, input)).state.kind, "dispatching")
        assert.equal(calls, 1)
        await assert.rejects(owner.act(id, { ...input, text: "different input" }), /different input/)
        await assert.rejects(owner.act(id, { ...input, id: randomUUID() }), /previous provider action/)
        assert.throws(owner.editQueued.bind(owner, id, { requestId: queuedId, expectedText: "move this message", change: { kind: "edit", text: "too late" } }), /already started/)
        if (outcome === "accepted" || outcome === "lost-reply") {
          state = { ...state!, status: "ready" }
          owner.observe({ type: "live-session", session: state })
        }
        if (outcome === "receipt-storage-failure") {
          const commit = mock.method(LiveJournal.prototype, "commit", () => { throw Error("receipt disk full") })
          response.resolve({ kind: "accepted" })
          try { await assert.rejects(pending, /receipt disk full/) } finally { commit.mock.restore() }
          const journal = new LiveJournal(directory, id)
          const durable = journal.read()
          journal.close()
          assert.equal(durable?.control?.actions?.at(-1)?.state.kind, "dispatching", "Failed receipt write leaves the durable intent")
          assert.equal(durable?.requests.find(r => r.id === queuedId)?.status, "canceled")
          owner.stop() // Disk works again; graceful shutdown can now retain acceptance.
          owner = new LiveConversations(dependencies)
          assert.equal(owner.snapshot(id)?.requests.find(r => r.id === queuedId)?.status, "canceled")
          assert.equal((await owner.act(id, input)).state.kind, "accepted")
          assert.equal(calls, 1)
          assert.deepEqual(sent, ["first"])
          continue
        }
        if (outcome === "restart") {
          owner.stop()
          owner = new LiveConversations(dependencies)
          assert.equal(owner.snapshot(id)?.requests.find(r => r.id === queuedId)?.status, "canceled")
          assert.equal((await owner.act(id, input)).state.kind, "uncertain")
          response.resolve({ kind: "accepted" })
          await assert.rejects(pending, /owner changed/)
          assert.equal((await owner.act(id, input)).state.kind, "uncertain", "Old controller cannot settle reopened action")
        } else {
          if (outcome === "lost-reply") response.reject(Error("Native reply lost after write"))
          else response.resolve(outcome === "refused" || outcome === "held-refused" ? { kind: "not-accepted", reason: "Turn changed" } : { kind: "accepted" })
          const receipt = await pending
          assert.equal(receipt.state.kind, outcome === "lost-reply" ? "uncertain" : outcome === "accepted" ? "accepted" : "not-accepted")
          const expected = outcome === "refused" ? "queued" : outcome === "held-refused" ? "held" : "canceled"
          assert.equal(owner.snapshot(id)?.requests.find(r => r.id === queuedId)?.status, expected)
          assert.equal((await owner.act(id, input)).state.kind, receipt.state.kind)
          if (outcome === "accepted" || outcome === "lost-reply") {
            owner.stop()
            owner = new LiveConversations(dependencies)
            assert.equal(owner.snapshot(id)?.requests.find(r => r.id === queuedId)?.status, "canceled")
            assert.equal((await owner.act(id, input)).state.kind, receipt.state.kind)
          }
        }
        assert.equal(calls, 1)
        if (outcome === "refused" || outcome === "held-refused") {
          state = { ...state!, status: "ready" }
          owner.observe({ type: "live-session", session: state })
        }
        assert.deepEqual(sent, outcome === "refused" ? ["first", "move this message"] : ["first"],
          "Only an authoritative refusal may return the message to normal queue execution")
      } finally { response.resolve({ kind: "accepted" }); owner.stop() }
    }
  }
  console.log("PASS: six harness profiles plus future adapter; atomic intent/queue ownership, completion race, refusals, held queue, stale edits, lost reply, owner restart, duplicate ID and disk failure")

  // 2026-10-31: a Cursor run held a steered queued message while its subagents worked, the person stopped the turn,
  // and only then did the SDK answer that the run never took it. A harness that answers every steer it holds when its
  // turn ends (`answersOnEnd`) keeps the words: they go as the next message. One that may never answer leaves them
  // unknown, the queue held, as before.
  for (const answersOnEnd of [true, false]) {
    const id = randomUUID(), first = randomUUID(), queuedId = randomUUID()
    const directory = join(root, "stopped-while-held", String(answersOnEnd))
    const sent: string[] = []
    let state: LiveSessionState
    let owner: LiveConversations
    const response = Promise.withResolvers<ProviderSteerResult>()
    const driver: ProviderLiveDriver = {
      ...noCapabilities,
      resume: fixtureResume(),
      steering: { kind: "supported", lands: "interrupt", ...answersOnEnd && { answersOnEnd: true as const }, via: "Injected driver fixture", steer: () => response.promise },
      approvalEvidence: { kind: "submission-only", reason: "Injected driver fixture" },
      launchEnvironment: { kind: "unavailable", reason: "Injected driver fixture" },
      nativeIdentity: { kind: "unavailable", reason: "Injected driver fixture" },
      nativeExclusion: NO_NATIVE_EXCLUSION,
      nativePromptIdentity: NO_NATIVE_PROMPT_IDENTITY,
      planning: { via: "setting", option: "plan", proposal: "Injected driver fixture", feedback: { kind: "next-message", reason: "Injected driver fixture" } },
      backgroundStop: { kind: "ends-with-turn", evidence: "Injected driver fixture" },
      turnRecovery: { kind: "manual", reason: "Injected driver fixture" },
      provider: "cursor", available: () => true,
      async start(cwd, options) {
        state = { id: options.conversationId, harness: "cursor", cwd, nativeId: "fixture", status: "ready", connection: "connected", modes: [], currentMode: null, configOptions: [] }
        return state
      },
      async prompt(_id, text, _attachments, _settings, dispatch) {
        dispatch.report({ kind: "submitted", source: "transport-call" })
        sent.push(text)
        state = { ...state, status: "running", nativeRunId: randomUUID() }
        owner.observe({ type: "live-session", session: state })
      },
      async permission() {}, async cancel() {}, async setMode() {}, close() {},
    }
    owner = new LiveConversations({ root: directory, appPath: root, driver: () => driver, history: async () => null, emit: () => {} })
    try {
      await owner.start("cursor", root, { conversationId: id })
      for (let i = 0; owner.snapshot(id)?.session.connection !== "connected" && i < 100; i++) await delay(5)
      owner.submit(id, first, "first")
      owner.submit(id, queuedId, "the code is the truth")
      const pending = owner.act(id, { kind: "steer-queued", id: randomUUID(), requestId: first, queuedRequestId: queuedId, text: "the code is the truth", attachments: [] })
      await delay(5)
      state = { ...state!, status: "ready", lastStop: "cancelled" }
      owner.observe({ type: "live-session", session: state })
      const held = owner.snapshot(id)?.control?.actions?.at(-1)?.state.kind
      assert.equal(held, answersOnEnd ? "dispatching" : "uncertain", "a stopped turn leaves a steer its harness will still answer waiting for that answer")
      response.resolve({ kind: "not-accepted", reason: "Cursor didn't take it into this turn, so it goes as the next message." })
      const receipt = await pending
      assert.equal(receipt.state.kind, answersOnEnd ? "not-accepted" : "uncertain")
      for (let i = 0; answersOnEnd && sent.length < 2 && i < 100; i++) await delay(5)
      assert.deepEqual(sent, answersOnEnd ? ["first", "the code is the truth"] : ["first"],
        answersOnEnd ? "the words go as the next message" : "a harness that may never answer keeps them unknown")
      assert.equal(owner.snapshot(id)?.requests.find((request) => request.id === queuedId)?.status, answersOnEnd ? "dispatching" : "canceled")
    } finally { response.resolve({ kind: "accepted" }); owner.stop() }
  }
  console.log("PASS: a steer held when its turn is stopped goes as the next message once its harness answers it")
} finally { rmSync(root, { recursive: true, force: true }) }
