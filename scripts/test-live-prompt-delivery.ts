import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LiveConversations } from "../electron/live-conversations.ts"
import { LiveJournal, LiveRequestSchema } from "../electron/live-journal.ts"
import {
  advancePromptDelivery,
  type PromptDeliveryEvidence,
} from "../electron/contracts/prompt-delivery.ts"
import type { ProviderLiveDriver } from "../electron/providers/live-driver.ts"
import {
  preparePrompt,
  type PromptDispatch,
} from "../electron/providers/prompt-dispatch.ts"
import type { LiveDriverEvent, LiveSessionState } from "../electron/shared.ts"

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
// Shared-policy conformance labels; real native adapter evidence is tested separately.
for (const provider of [
  "claude",
  "codex",
  "cursor",
  "grok",
  "devin",
  "opencode",
  "seventh-fixture",
]) {
  const root = mkdtempSync(join(tmpdir(), "mako-delivery-"))
  const id = randomUUID()
  let emit: (event: LiveDriverEvent) => void = () => {}
  let state: LiveSessionState
  const calls: PromptDispatch[] = []
  let fail = false
  let failStart = false
  const driver: ProviderLiveDriver = {
    approvalEvidence: { kind: "submission-only", reason: "Injected driver fixture" },
    provider,
    canResume: true,
    available: () => true,
    async start(cwd, options) {
      if (failStart) throw new Error("Fixture refuses the requested mode before dispatch")
      emit = options.emit ?? (() => {})
      state = {
        id: options.conversationId,
        nativeId: "fixture-native",
        harness: provider,
        cwd,
        status: "ready",
        connection: "connected",
        modes: [],
        currentMode: null,
        configOptions: [],
      }
      return state
    },
    async prompt(_id, _text, _attachments, _settings, dispatch) {
      calls.push(dispatch)
      // Inspect the real journal independently before the synthetic native action.
      const journal = new LiveJournal(root, id)
      const saved = journal
        .read()
        ?.requests.find((item) => item.id === dispatch.operationId)
      journal.close()
      assert.equal(saved?.nativeDelivery?.attemptId, dispatch.attemptId)
      assert.equal(saved?.nativeDelivery?.evidence.kind, "prepared")
      dispatch.report({ kind: "submitted", source: "transport-call" })
      emit({
        type: "live-session",
        session: {
          ...state,
          status: "running",
          nativeRunId: "local-correlation",
        },
      })
      if (fail) throw new Error("Reply lost after native write")
    },
    async permission() {},
    async cancel() {},
    close() {},
    async setMode() {},
  }
  const deps = {
    root,
    appPath: root,
    driver: () => driver,
    history: async () => null,
    emit() {},
  }
  const owner = new LiveConversations(deps)
  try {
    await owner.start(provider, root, { conversationId: id })
    await tick()
    const first = randomUUID()
    owner.submit(id, first, "first")
    assert.equal(calls.length, 1)
    assert.equal(calls[0].operationId, first)
    assert.equal(
      owner.snapshot(id)?.requests[0].nativeDelivery?.evidence.kind,
      "submitted",
      "running/local run ID is not receipt"
    )
    owner.submit(id, first, "first")
    assert.equal(calls.length, 1, "same accepted operation is not resent")
    calls[0].report({
      kind: "accepted",
      source: "native-response",
      referenceId: "native-first",
    })
    calls[0].report({ kind: "uncertain", reason: "late transport error" })
    assert.equal(
      owner.snapshot(id)?.requests[0].nativeDelivery?.evidence.kind,
      "accepted"
    )
    assert.equal(
      owner.snapshot(id)?.requests[0].status,
      "dispatching",
      "receipt is not completion"
    )
    emit({ type: "live-session", session: { ...state!, status: "ready" } })
    const second = randomUUID()
    owner.submit(id, second, "second")
    assert.equal(calls.length, 2)
    assert.notEqual(calls[0].attemptId, calls[1].attemptId)
    calls[0].report({
      kind: "accepted",
      source: "native-response",
      referenceId: "late-old-reply",
    })
    assert.equal(
      owner.snapshot(id)?.requests[1].nativeDelivery?.evidence.kind,
      "submitted",
      "old reply cannot acknowledge new run"
    )
    calls[1].report({ kind: "uncertain", reason: "lost reply" })
    calls[1].report({
      kind: "accepted",
      source: "native-echo",
      referenceId: "native-second",
    })
    emit({
      type: "live-session",
      session: {
        ...state!,
        status: "failed",
        error: "native execution failed",
      },
    })
    assert.equal(owner.snapshot(id)?.requests[1].status, "failed")
    assert.equal(
      owner.snapshot(id)?.requests[1].nativeDelivery?.evidence.kind,
      "accepted",
      "execution failure does not undo delivery"
    )
    fail = true
    const third = randomUUID()
    owner.submit(id, third, "third")
    await tick()
    assert.equal(
      owner.snapshot(id)?.requests[2].nativeDelivery?.evidence.kind,
      "uncertain"
    )
    owner.submit(id, third, "third")
    assert.equal(calls.length, 3)
    const journal = new LiveJournal(root, id)
    assert.equal(
      journal.read()?.requests[2].nativeDelivery?.evidence.kind,
      "uncertain"
    )
    journal.close()
    await owner.close(id)
    calls[2].report({
      kind: "accepted",
      source: "native-response",
      referenceId: "after-close",
    })
    assert.equal(
      owner.snapshot(id)?.requests[2].nativeDelivery?.evidence.kind,
      "uncertain",
      "retired controller callback ignored"
    )
    failStart = true
    const refusedId = randomUUID()
    await owner.start(provider, root, { conversationId: refusedId,
      initialRequest: { id: randomUUID(), text: "never dispatched", attachments: [] } })
    for (let i = 0; i < 100 && owner.snapshot(refusedId)?.session.status !== "failed"; i++) await tick()
    assert.equal(owner.snapshot(refusedId)?.requests[0]?.nativeDelivery?.evidence.kind, "not-accepted",
      "verified startup refusal records not sent for every harness")
    assert.equal(calls.length, 3, "startup refusal cannot reach native prompt dispatch")
    await owner.close(refusedId)
    if (provider === "seventh-fixture") {
      owner.stop()
      const legacyJournal = new LiveJournal(root, id)
      const saved = legacyJournal.read()
      assert.ok(saved)
      const legacySchema = LiveRequestSchema.omit({ nativeDelivery: true })
      legacyJournal.commit({
        ...saved,
        requests: saved.requests.map((request) => legacySchema.parse(request)),
      })
      legacyJournal.close()
      const reopened = new LiveConversations(deps)
      try {
        assert.equal(reopened.snapshot(id)?.requests.length, 3)
        assert.ok(
          reopened
            .snapshot(id)
            ?.requests.every((request) => request.nativeDelivery === undefined)
        )
        reopened.submit(id, third, "third")
        await tick()
        assert.equal(calls.length, 3, "legacy same-ID submission cannot resend")
      } finally {
        reopened.stop()
      }
    }
  } finally {
    owner.stop()
    rmSync(root, { recursive: true, force: true })
  }
}

const preflight: PromptDeliveryEvidence[] = []
assert.throws(
  () =>
    preparePrompt(
      {
        operationId: randomUUID(),
        attemptId: randomUUID(),
        report: (e) => preflight.push(e),
      },
      () => {
        throw new Error("Unsupported settings; no prompt sent")
      }
    ),
  /Unsupported settings/
)
assert.equal(preflight[0]?.kind, "not-accepted")
assert.equal(
  advancePromptDelivery(preflight[0], {
    kind: "accepted",
    source: "native-response",
  }).kind,
  "not-accepted"
)
const old = LiveRequestSchema.parse({
  id: randomUUID(),
  text: "old saved request",
  attachments: [],
  status: "completed",
})
assert.equal(
  old.nativeDelivery,
  undefined,
  "old completion is not backfilled as a native receipt"
)
console.log(
  "Prompt delivery: six shared-policy profiles plus a seventh provider, pre-dispatch journal, duplicate IDs, correlation versus receipt, failure after acceptance, lost reply, old-run/retired-controller callbacks and legacy requests passed"
)
