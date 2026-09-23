import type { ApprovalSubmission } from "../electron/contracts/approval-response.js"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mock } from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { LiveConversations } from "../electron/live-conversations.js"
import { LiveJournal } from "../electron/live-journal.js"
import type { LivePermissionResponse, LiveSessionState } from "../electron/shared.js"
import type { ProviderLiveDriver } from "../electron/providers/live-driver.js"

const root = mkdtempSync(join(tmpdir(), "mako-approval-receipts-"))
try {
  for (const provider of ["claude", "codex", "cursor", "grok", "devin", "opencode", "future"]) {
    let id = randomUUID()
    const journalRoot = join(root, provider)
    let calls = 0
    let answer = async () => {}
    let preflight: Promise<void> | undefined
    let submission: ApprovalSubmission | undefined = { kind: "submitted", source: "callback" }
    let state: LiveSessionState = { id, harness: provider, cwd: root, status: "running", connection: "connected", nativeRunId: "run-1", modes: [], currentMode: null, configOptions: [] }
    const driver: ProviderLiveDriver = {
      approvalEvidence: { kind: "submission-only", reason: "Injected driver fixture" },
      provider, canResume: true, available: () => true,
      start: async () => state,
      prompt: async () => {}, close() {}, cancel: async () => {}, setMode: async () => {},
      async permission(bindingId, nativeId, _response, dispatch) {
        if (preflight) await preflight
        dispatch.assertCurrent()
        calls++
        assert.equal(bindingId, id)
        assert.equal(nativeId, "native-request")
        const journal = new LiveJournal(journalRoot, id)
        try {
          const saved = journal.read()?.control?.approvalResponses?.at(-1)
          assert.equal(saved?.state.kind, "dispatching", "intent is durable before native call")
          assert.notEqual(saved?.id, nativeId, "public occurrence ID differs from native ID")
        } finally { journal.close() }
        await answer()
        if (submission) dispatch.report(submission)
      },
    }
    const dependencies = { root: journalRoot, appPath: root, driver: () => driver, history: async () => null, emit: () => {} }
    let owner = new LiveConversations(dependencies)
    try {
      await owner.start(provider, root, { conversationId: id })
      for (let i = 0; i < 100 && owner.snapshot(id)?.session.connection !== "connected"; i++) await delay(5)
      const ask = () => {
        owner.observe({ type: "live-permission", request: { id: "native-request", sessionId: id, title: `Allow operation in ${state.nativeRunId}?`, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }] } })
        return owner.snapshot(id)?.permissions.at(-1)?.id
      }
      const first = ask()
      assert.ok(first)
      assert.equal(ask(), first, "duplicate native observation keeps the same occurrence")
      const before = owner.snapshot(id)
      await assert.rejects(owner.permission(id, first, { kind: "choice", optionId: "invalid" }), /unavailable/)
      assert.equal(calls, 0)
      const response: LivePermissionResponse = { kind: "choice", optionId: "allow" }
      const gate = Promise.withResolvers<void>()
      answer = () => gate.promise
      const pending = owner.permission(id, first, response)
      await assert.rejects(owner.permission(id, first, response), /already saved/)
      await assert.rejects(owner.permission(id, first, { kind: "choice", optionId: "deny" }), /different saved answer/)
      assert.equal(calls, 1)
      // Native IDs may be reused by the next turn while the prior callback is pending.
      state = { ...state, nativeRunId: "run-2" }
      owner.observe({ type: "live-session", session: state })
      const newer = ask()
      assert.ok(newer && newer !== first)
      gate.resolve()
      await pending
      assert.deepEqual(owner.snapshot(id)?.permissions.map(request => request.id), [newer], "old reply cannot remove a newer approval")
      await owner.permission(id, first, response)
      assert.equal(calls, 1, "successful duplicate does not redispatch")
      if (process.env.MAKO_APPROVAL_FIXTURES) {
        mkdirSync(process.env.MAKO_APPROVAL_FIXTURES, { recursive: true })
        writeFileSync(join(process.env.MAKO_APPROVAL_FIXTURES, `${provider}.json`), JSON.stringify({ before, after: owner.snapshot(id), first, newer }))
      }
      const disk = mock.method(LiveJournal.prototype, "commit", () => { throw new Error("disk full") })
      await assert.rejects(owner.permission(id, newer, response), /disk full/)
      disk.mock.restore()
      assert.equal(calls, 1, "failed intent persistence cannot send an approval")
      owner.stop()
      owner = new LiveConversations(dependencies)
      await owner.permission(id, first, response)
      assert.equal(calls, 1, "completed receipt remains idempotent after reopening")
      await assert.rejects(owner.permission(id, newer, response), /no longer pending/)
      id = randomUUID()
      state = { ...state, id }
      await owner.start(provider, root, { conversationId: id })
      for (let i = 0; i < 100 && owner.snapshot(id)?.session.connection !== "connected"; i++) await delay(5)
      const fresh = ask()
      assert.ok(fresh && fresh !== newer)
      answer = async () => { throw new Error("transport lost with secret answer text") }
      await assert.rejects(owner.permission(id, fresh, response), /did not confirm submission/)
      const lostCalls = calls
      await assert.rejects(owner.permission(id, fresh, response), /already saved/)
      assert.equal(calls, lostCalls, "unknown delivery is never replayed")
      const uncertain = owner.snapshot(id)?.control?.approvalResponses?.at(-1)
      assert.equal(uncertain?.state.kind, "uncertain")
      assert.ok(!JSON.stringify(uncertain).includes("secret answer text"))
      // An adapter await must recheck ownership immediately before the native write.
      state = { ...state, nativeRunId: "run-before-await" }
      owner.observe({ type: "live-session", session: state })
      const waiting = ask()
      assert.ok(waiting)
      const preflightGate = Promise.withResolvers<void>()
      preflight = preflightGate.promise
      const waitingResponse = owner.permission(id, waiting, response)
      state = { ...state, nativeRunId: "run-after-await" }
      owner.observe({ type: "live-session", session: state })
      ask()
      preflightGate.resolve()
      await assert.rejects(waitingResponse, /did not confirm submission/)
      assert.equal(calls, lostCalls, "adapter preflight prevents a stale native write after its await")
      preflight = undefined
      // Retire this owner while its next approval response is in flight.
      state = { ...state, nativeRunId: "run-3" }
      owner.observe({ type: "live-session", session: state })
      const stranded = ask()
      assert.ok(stranded)
      const late = Promise.withResolvers<void>()
      answer = () => late.promise
      const oldOwnerResponse = owner.permission(id, stranded, response)
      owner.stop()
      owner = new LiveConversations(dependencies)
      assert.equal(owner.snapshot(id)?.control?.approvalResponses?.at(-1)?.state.kind, "uncertain")
      late.resolve()
      await assert.rejects(oldOwnerResponse, /owner changed/)
      await assert.rejects(owner.permission(id, stranded, response), /already saved/)
      assert.equal(calls, lostCalls + 1)
      // A saved intent survives failure to commit the result, without storing answer text.
      id = randomUUID()
      state = { ...state, id, nativeRunId: "secret-question" }
      await owner.start(provider, root, { conversationId: id })
      for (let i = 0; i < 100 && owner.snapshot(id)?.session.connection !== "connected"; i++) await delay(5)
      owner.observe({ type: "live-permission", request: {
        id: "native-request", sessionId: id, title: "Secret fixture question", options: [],
        questions: [{ id: "secret", header: "Secret", question: "Fixture value", isSecret: true, allowOther: true, options: [] }],
      } })
      const secretId = owner.snapshot(id)?.permissions[0]?.id
      assert.ok(secretId)
      answer = async () => {}
      const originalCommit = LiveJournal.prototype.commit
      let commits = 0
      const failedReceipt = mock.method(LiveJournal.prototype, "commit", function(this: LiveJournal, ...args: Parameters<LiveJournal["commit"]>) {
        if (++commits === 2) throw new Error("receipt disk full")
        return originalCommit.apply(this, args)
      })
      const secretAnswer: LivePermissionResponse = { kind: "answers", answers: { secret: ["secret-fixture-answer"] } }
      await assert.rejects(owner.permission(id, secretId, secretAnswer), /receipt disk full/)
      failedReceipt.mock.restore()
      const afterFailure = owner.snapshot(id)?.control?.approvalResponses?.at(-1)
      assert.equal(afterFailure?.state.kind, "dispatching")
      assert.ok(!JSON.stringify(afterFailure).includes("secret-fixture-answer"))
      const afterFailureCalls = calls
      owner.stop()
      owner = new LiveConversations(dependencies)
      assert.equal(owner.snapshot(id)?.control?.approvalResponses?.at(-1)?.state.kind, "uncertain")
      await assert.rejects(owner.permission(id, secretId, secretAnswer), /already saved/)
      assert.equal(calls, afterFailureCalls, "failed result persistence cannot authorize a replay")
      for (const result of [
        { kind: "not-submitted", pending: true, reason: "invalid-answer" },
        { kind: "not-submitted", pending: false, reason: "request-ended" },
        undefined,
      ] satisfies Array<ApprovalSubmission | undefined>) {
        id = randomUUID()
        state = { ...state, id, nativeRunId: "submission-evidence" }
        await owner.start(provider, root, { conversationId: id })
        for (let i = 0; i < 100 && owner.snapshot(id)?.session.connection !== "connected"; i++) await delay(5)
        const target = ask()
        assert.ok(target)
        submission = result
        if (result) await owner.permission(id, target, response)
        else await assert.rejects(owner.permission(id, target, response), /did not confirm submission/)
        assert.equal(owner.snapshot(id)?.control?.approvalResponses?.at(-1)?.state.kind, result?.kind ?? "uncertain")
        const after = owner.snapshot(id)?.permissions.at(-1)
        if (result?.kind === "not-submitted" && result.pending) {
          assert.ok(after && after.id !== target, "refusal preserves question with a fresh explicit answer occurrence")
          const callsBefore = calls
          await owner.permission(id, target, response)
          assert.equal(calls, callsBefore, "retry of the refused occurrence cannot silently dispatch a new answer")
          submission = { kind: "submitted", source: "callback" }
          await owner.permission(id, after.id, response)
          assert.equal(calls, callsBefore + 1)
          assert.equal(owner.snapshot(id)?.permissions.length, 0)
        } else if (result) assert.equal(after, undefined)
        else assert.equal(after?.id, target, "no evidence must remain unknown even if the adapter returns")
      }
      for (const ending of ["turn", "connection"]) {
        id = randomUUID()
        state = { ...state, id, status: "running", nativeRunId: "ending-approval" }
        await owner.start(provider, root, { conversationId: id })
        for (let i = 0; i < 100 && owner.snapshot(id)?.session.connection !== "connected"; i++) await delay(5)
        const target = ask()
        assert.ok(target)
        const endGate = Promise.withResolvers<void>()
        answer = () => endGate.promise
        submission = undefined
        const pendingEnd = owner.permission(id, target, response)
        if (ending === "turn") owner.observe({ type: "live-session", session: { ...state, status: "ready" } })
        else await owner.close(id)
        assert.equal(owner.snapshot(id)?.control?.approvalResponses?.at(-1)?.state.kind, "uncertain",
          "ending an unanswered turn/connection must settle its Sending status")
        endGate.resolve()
        await assert.rejects(pendingEnd, /owner changed|did not confirm submission/)
      }
      console.log(`PASS ${provider}: durable intent, duplicate/conflicting answers, native-ID reuse, storage failure, lost reply, reopen and retired-owner fence`)
    } finally { owner.stop() }
  }
} finally { rmSync(root, { recursive: true, force: true }) }
