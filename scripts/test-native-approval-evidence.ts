import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { LiveConversations } from "../electron/live-conversations.js"
import { LiveJournal } from "../electron/live-journal.js"
import { approvalAnswerDigest } from "../electron/providers/approval-evidence.js"
import { ApprovalResponseSchema, describeApprovalResponse, type NativeApprovalIdentity } from "../electron/contracts/approval-response.js"
import type { LiveDriverEvent, LiveSessionState } from "../electron/shared.js"
import type { ProviderLiveDriver } from "../electron/providers/live-driver.js"

const root = mkdtempSync(join(tmpdir(), "mako-native-approval-evidence-"))
try {
  for (const provider of ["claude", "codex", "cursor", "grok", "devin", "opencode", "future"]) {
    const id = randomUUID(), journalRoot = join(root, provider)
    let emit!: (event: LiveDriverEvent) => void
    let calls = 0
    let settle = Promise.withResolvers<void>()
    let report = true
    let rejectAnswer = false
    const driver: ProviderLiveDriver = {
      approvalEvidence: { kind: "native-decisions", recovery: "retained-observer", coverage: "Injected native evidence fixture" },
      provider, canResume: true, available: () => true,
      async start(cwd, options) {
        emit = options.emit!
        return { id, nativeId: "native-session", cwd, harness: provider, status: "ready", connection: "connected", modes: [], currentMode: null, configOptions: [] } satisfies LiveSessionState
      },
      async prompt() {}, async cancel() {}, close() {}, async setMode() {},
      async permission(_id, _request, _answer, dispatch) {
        dispatch.assertCurrent(); calls++
        await settle.promise
        if (rejectAnswer) dispatch.report({ kind: "not-submitted", pending: true, reason: "invalid-answer" })
        else if (report) dispatch.report({ kind: "submitted", source: "callback" })
      },
    }
    const dependencies = { root: journalRoot, appPath: root, driver: () => driver, history: async () => null,
      nativePath: () => join(root, "native-history"),
      resumeVerdict: async () => ({ kind: "resumable" as const, record: "same" as const }), emit() {} }
    let owner = new LiveConversations(dependencies)
    try {
      await owner.start(provider, root, { conversationId: id })
      for (let i = 0; i < 100 && owner.snapshot(id)?.session.connection !== "connected"; i++) await delay(5)
      const ask = (native: NativeApprovalIdentity) => {
        emit({ type: "live-permission", request: { id: "reused-callback", observationId: randomUUID(), native, sessionId: id, title: "Allow test?", options: [{ optionId: "once", name: "Allow once", kind: "allow_once" }] } })
        return owner.snapshot(id)!.permissions.at(-1)?.id
      }
      const decision = (identity: NativeApprovalIdentity, optionId = "once") => emit({ type: "live-approval-decision", id,
        decision: { identity, answerDigest: approvalAnswerDigest({ kind: "choice", optionId }), observedAt: 1234 } })
      const native = { scope: randomUUID(), sessionId: "native-session", requestId: "native-permission" }
      const first = ask(native)
      assert.ok(first)
      const answering = owner.permission(id, first, { kind: "choice", optionId: "once" })
      ask(native)
      assert.equal(owner.snapshot(id)?.permissions.length, 1,
        "re-observing the same native approval after saving an answer cannot offer a second answer")
      assert.equal(owner.snapshot(id)?.permissions[0]?.id, first)
      for (const kind of ["request-lifecycle", "submission-only", "no-interactive-requests"] as const) {
        driver.approvalEvidence = { kind, reason: "Native decisions are not implemented by this adapter" }
        decision(native)
        assert.equal(owner.snapshot(id)?.control?.approvalResponses?.at(-1)?.nativeDecision, undefined,
          `${kind} cannot upgrade a receipt to native confirmation`)
        assert.equal(owner.snapshot(id)?.permissions[0]?.id, first)
      }
      driver.approvalEvidence = { kind: "native-decisions", recovery: "retained-observer", coverage: "Injected native evidence fixture" }
      decision({ ...native, scope: randomUUID() })
      decision({ ...native, sessionId: "wrong-session" })
      assert.equal(owner.snapshot(id)?.control?.approvalResponses?.at(-1)?.nativeDecision, undefined)
      assert.equal(owner.snapshot(id)?.permissions[0]?.id, first)
      decision(native)
      assert.equal(owner.snapshot(id)?.permissions.length, 0, "exact native decision clears its stale question")
      const nextNative = { ...native, scope: randomUUID() }
      const newer = ask(nextNative)
      assert.ok(newer)
      decision(native)
      assert.equal(owner.snapshot(id)?.permissions[0]?.id, newer, "old decision cannot clear reused IDs in a new native scope")
      settle.resolve(); await answering
      const firstReceipt = owner.snapshot(id)!.control!.approvalResponses!.find(r => r.id === first)!
      assert.equal(firstReceipt.state.kind, "submitted")
      assert.equal(firstReceipt.nativeDecision?.answerDigest, firstReceipt.digest, "submission must preserve concurrent native confirmation")
      assert.equal(describeApprovalResponse(firstReceipt).title, "Agent recorded your answer")
      assert.equal(ApprovalResponseSchema.safeParse({ ...firstReceipt, nativeDecision: { ...firstReceipt.nativeDecision, identity: nextNative } }).success, false,
        "journal parsing cannot attach another occurrence's native decision")
      ask(native)
      assert.equal(owner.snapshot(id)?.permissions.length, 1, "confirmed native questions cannot reappear through a fresh callback")
      assert.equal(owner.snapshot(id)?.permissions[0]?.id, newer)
      await owner.permission(id, first, { kind: "choice", optionId: "once" })
      assert.equal(calls, 1)
      settle = Promise.withResolvers<void>(); report = false
      const lost = owner.permission(id, newer, { kind: "choice", optionId: "once" })
      settle.resolve()
      await assert.rejects(lost, /did not confirm/)
      await assert.rejects(owner.permission(id, newer, { kind: "choice", optionId: "once" }), /already saved/)
      decision(nextNative, "reject")
      const different = owner.snapshot(id)!.control!.approvalResponses!.at(-1)!
      assert.equal(different.state.kind, "uncertain", "native verdict is separate from transport outcome")
      assert.equal(describeApprovalResponse(different).title, "Agent recorded a different decision")
      assert.equal(owner.snapshot(id)?.permissions.length, 0)
      const journal = new LiveJournal(journalRoot, id)
      try { assert.deepEqual(journal.read()?.control?.approvalResponses, JSON.parse(JSON.stringify(owner.snapshot(id)?.control?.approvalResponses))) }
      finally { journal.close() }
      owner.stop(); owner = new LiveConversations(dependencies)
      await owner.permission(id, newer, { kind: "choice", optionId: "once" })
      assert.equal(calls, 2, "lost replies, native decisions and journal reopen never replay an answer")
      const transferId = randomUUID()
      owner.transfer(id, { id: transferId, provider, text: "Continue", attachments: [] })
      for (let i = 0; i < 200 && owner.snapshot(id)?.control?.transfers.at(-1)?.state.kind !== "accepted"; i++) await delay(5)
      assert.equal(owner.snapshot(id)?.control?.transfers.at(-1)?.state.kind, "accepted", "fixture reconnect must complete")
      ask(native); ask(nextNative)
      assert.equal(owner.snapshot(id)?.permissions.length, 0, "journal receipts suppress re-observation on a replacement connection")
      const unansweredNative = { ...native, requestId: "new-permission" }
      const unanswered = ask(unansweredNative)
      assert.ok(unanswered)
      assert.equal(ask(unansweredNative), unanswered, "an unanswered native question keeps one visible occurrence")
      assert.equal(owner.snapshot(id)?.permissions.length, 1)
      rejectAnswer = true
      await owner.permission(id, unanswered, { kind: "choice", optionId: "once" })
      const correction = owner.snapshot(id)?.permissions[0]?.id
      assert.ok(correction)
      assert.notEqual(correction, unanswered)
      assert.equal(ask(unansweredNative), correction, "proven invalid answers preserve the native question for correction")
      rejectAnswer = false; report = true
      await owner.permission(id, correction, { kind: "choice", optionId: "once" })
      ask(unansweredNative)
      assert.equal(owner.snapshot(id)?.permissions.length, 0, "the corrected answer cannot be sent through another callback")
      assert.equal(calls, 4, "only original answers and the proven-not-submitted correction dispatch")
      console.log(`PASS ${provider}: exact evidence, fresh callbacks, replacement connection, journal reopen, no replay, unanswered deduplication and correction`)
    } finally { settle.resolve(); owner.stop() }
  }
} finally { rmSync(root, { recursive: true, force: true }) }
