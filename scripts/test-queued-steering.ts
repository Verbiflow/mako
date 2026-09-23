import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mock } from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { LiveConversations } from "../electron/live-conversations.js"
import { LiveJournal } from "../electron/live-journal.js"
import type { LiveActionInput } from "../electron/contracts/live-actions.js"
import type { LiveSessionState } from "../electron/shared.js"
import type { ProviderLiveDriver, ProviderSteerResult } from "../electron/providers/live-driver.js"

const root = mkdtempSync(join(tmpdir(), "mako-queued-steering-"))
try {
  for (const provider of ["claude", "codex", "cursor", "grok", "devin", "opencode", "future"]) {
    for (const outcome of ["accepted", "refused", "held-refused", "lost-reply", "restart", "storage-failure"] as const) {
      const id = randomUUID(), first = randomUUID(), queuedId = randomUUID()
      const directory = join(root, provider, outcome)
      const sent: string[] = []
      let calls = 0
      let state: LiveSessionState
      let owner: LiveConversations
      const response = Promise.withResolvers<ProviderSteerResult>()
      const driver: ProviderLiveDriver = {
        provider, canResume: true, steering: "step", available: () => true,
        async start(cwd, options) {
          state = { id: options.conversationId, harness: provider, cwd, nativeId: "fixture", status: "ready", connection: "connected", modes: [], currentMode: null, configOptions: [] }
          return state
        },
        async prompt(_id, text) {
          sent.push(text)
          state = { ...state, status: "running", nativeRunId: randomUUID() }
          owner.observe({ type: "live-session", session: state })
        },
        async steer(_id, input) {
          calls++
          assert.equal(input.expectedRunId, state.nativeRunId)
          const journal = new LiveJournal(directory, id)
          const snapshot = journal.read()
          journal.close()
          assert.equal(snapshot?.requests.find(r => r.id === queuedId)?.status, "canceled", "Provider write sees durable queue ownership already transferred")
          assert.equal(snapshot?.control?.actions?.at(-1)?.state.kind, "dispatching")
          return response.promise
        },
        async permission() {}, async cancel() {}, async setMode() {}, close() {},
      }
      const dependencies = { root: directory, appPath: root, driver: () => driver, history: async () => null, emit: () => {} }
      owner = new LiveConversations(dependencies)
      try {
        await owner.start(provider, root, { conversationId: id })
        for (let i = 0; owner.snapshot(id)?.session.connection !== "connected" && i < 100; i++) await delay(5)
        owner.submit(id, first, "first")
        owner.submit(id, queuedId, "move this message")
        if (outcome === "held-refused") owner.editQueued(id, { requestId: queuedId, expectedText: "move this message", change: { kind: "pause" } })
        const input: LiveActionInput = { kind: "steer-queued", id: randomUUID(), requestId: first, queuedRequestId: queuedId, text: "move this message", attachments: [] }
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
        assert.throws(owner.editQueued.bind(owner, id, { requestId: queuedId, expectedText: "move this message", change: { kind: "edit", text: "too late" } }), /already started/)
        if (outcome === "accepted" || outcome === "lost-reply") {
          state = { ...state!, status: "ready" }
          owner.observe({ type: "live-session", session: state })
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
        assert.deepEqual(sent, ["first"], "Steered input cannot also drain as a normal prompt")
      } finally { response.resolve({ kind: "accepted" }); owner.stop() }
    }
  }
  console.log("PASS: six harness profiles plus future adapter; atomic intent/queue ownership, completion race, refusals, held queue, stale edits, lost reply, owner restart, duplicate ID and disk failure")
} finally { rmSync(root, { recursive: true, force: true }) }
