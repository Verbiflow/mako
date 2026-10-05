import { registeredHarnessIds } from "./registered-harnesses.ts"
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
import { NO_NATIVE_EXCLUSION } from "../electron/contracts/execution-context.ts"
import { NO_NATIVE_PROMPT_IDENTITY } from "../electron/contracts/native-prompt-identity.ts"
import {
  preparePrompt,
  type PromptDispatch,
} from "../electron/providers/prompt-dispatch.ts"
import type { LiveDriverEvent, LiveSessionState } from "../electron/shared.ts"
import type { LiveBatch } from "../electron/contracts/live-conversations.ts"

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
// Shared-policy conformance labels; real native adapter evidence is tested separately.
for (const provider of [...registeredHarnessIds(), "seventh-fixture"]) {
  const root = mkdtempSync(join(tmpdir(), "mako-delivery-"))
  const id = randomUUID()
  let emit: (event: LiveDriverEvent) => void = () => {}
  let state: LiveSessionState
  const calls: PromptDispatch[] = []
  let fail = false
  let failStart = false
  const driver: ProviderLiveDriver = {
    launchEnvironment: { kind: "unavailable", reason: "Injected driver fixture" },
    nativeIdentity: { kind: "unavailable", reason: "Injected driver fixture" },
    nativeExclusion: NO_NATIVE_EXCLUSION,
    nativePromptIdentity: { kind: "accepted-message-id", evidence: "Injected shared-policy fixture; not native adapter acceptance" },
    approvalEvidence: { kind: "submission-only", reason: "Injected driver fixture" },
    planning: { via: "setting", option: "plan", proposal: "Injected driver fixture" },
    backgroundStop: { kind: "ends-with-turn", evidence: "Injected driver fixture" },
    turnRecovery: { kind: "manual", reason: "Injected driver fixture" },
    provider,
    canResume: true,
    available: () => true,
    async start(cwd, options) {
      if (failStart) throw new Error("Fixture refuses the requested mode before dispatch")
      emit = options.emit ?? (() => {})
      state = {
        id: options.conversationId,
        nativeId: "fixture-native",
        nativePath: join(root, "native-history"),
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
  const batches: LiveBatch[] = []
  const deps = {
    root,
    appPath: root,
    driver: () => driver,
    history: async () => null,
    emit(event: { type: string; batch?: LiveBatch }) {
      if (event.type === "live-batch" && event.batch) batches.push(event.batch)
    },
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
    const firstReference = owner.snapshot(id)?.requests[0].nativePrompt
    assert.equal(firstReference?.messageId, "native-first")
    assert.equal(firstReference?.attemptId, calls[0].attemptId)
    assert.equal(firstReference?.provider, provider)
    assert.equal(firstReference?.path, join(root, "native-history"))
    const receiptJournal = new LiveJournal(root, id)
    assert.deepEqual(receiptJournal.read()?.requests[0].nativePrompt, firstReference,
      "native correspondence is durable before completion/history takeover")
    receiptJournal.close()
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
    assert.deepEqual(owner.snapshot(id)?.requests[0].nativePrompt, firstReference,
      "late accepted replies cannot replace the original receipt")
    assert.equal(owner.snapshot(id)?.requests[1].nativePrompt, undefined,
      "an older reply cannot link a new native turn")
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
    // Renderers draw no stand-in for a dispatched prompt; the batch that
    // dispatches it must carry its user turn.
    const dispatched = new Set<string>()
    for (const batch of batches) {
      for (const request of batch.requests ?? batch.requestChanges ?? []) {
        if (request.status !== "dispatching" || dispatched.has(request.id)) continue
        dispatched.add(request.id)
        assert.ok(
          batch.updates.some((update) => update.kind === "user" && update.requestId === request.id && !update.steeringFor),
          `${provider}: dispatching ${request.text} ships with its user turn`
        )
      }
    }
    assert.equal(dispatched.size, 3, `${provider}: every dispatched prompt was checked`)
    if (provider === "seventh-fixture") {
      owner.stop()
      const legacyJournal = new LiveJournal(root, id)
      const saved = legacyJournal.read()
      assert.ok(saved)
      const legacySchema = LiveRequestSchema.omit({ nativeDelivery: true, nativePrompt: true })
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

// A driver that keeps its turn running after a throw still owns that turn,
// and one that refuses because the provider was running a turn it had lost
// shows that turn: neither message fails, and neither is shown twice.
{
  const root = mkdtempSync(join(tmpdir(), "mako-delivery-running-"))
  const id = randomUUID()
  let emit: (event: LiveDriverEvent) => void = () => {}
  let state: LiveSessionState
  const calls: PromptDispatch[] = []
  let behaviour: "throw-running" | "refuse-running" | "accept" = "throw-running"
  const driver: ProviderLiveDriver = {
    launchEnvironment: { kind: "unavailable", reason: "Injected driver fixture" },
    nativeIdentity: { kind: "unavailable", reason: "Injected driver fixture" },
    nativeExclusion: NO_NATIVE_EXCLUSION,
    nativePromptIdentity: NO_NATIVE_PROMPT_IDENTITY,
    approvalEvidence: { kind: "submission-only", reason: "Injected driver fixture" },
    planning: { via: "setting", option: "plan", proposal: "Injected driver fixture" },
    backgroundStop: { kind: "ends-with-turn", evidence: "Injected driver fixture" },
    turnRecovery: { kind: "manual", reason: "Injected driver fixture" },
    provider: "cursor",
    canResume: true,
    available: () => true,
    async start(cwd, options) {
      emit = options.emit ?? (() => {})
      state = {
        id: options.conversationId,
        nativeId: "fixture-native",
        harness: "cursor",
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
      const running = () => emit({ type: "live-session", session: { ...state, status: "running" } })
      if (behaviour === "refuse-running") {
        preparePrompt(dispatch, () => {
          running()
          throw new Error("The provider was still running an earlier turn")
        })
      }
      dispatch.report({ kind: "submitted", source: "transport-call" })
      running()
      if (behaviour === "throw-running") throw new Error("The reply was lost; the turn runs on")
    },
    async permission() {},
    async cancel() {},
    close() {},
    async setMode() {},
  }
  const batches: LiveBatch[] = []
  const owner = new LiveConversations({
    root,
    appPath: root,
    driver: () => driver,
    history: async () => null,
    emit(event: { type: string; batch?: LiveBatch }) {
      if (event.type === "live-batch" && event.batch) batches.push(event.batch)
    },
  })
  const request = (requestId: string) => owner.snapshot(id)?.requests.find((item) => item.id === requestId)
  const bubbles = (requestId: string) => batches.flatMap((batch) => batch.updates)
    .filter((update) => update.kind === "user" && update.requestId === requestId && !update.steeringFor).length
  try {
    await owner.start("cursor", root, { conversationId: id })
    await tick()

    const lost = randomUUID()
    owner.submit(id, lost, "lost reply")
    await tick()
    assert.equal(request(lost)?.status, "dispatching", "a throw while the turn runs is not a failed message")
    assert.equal(request(lost)?.nativeDelivery?.evidence.kind, "uncertain")
    assert.equal(owner.snapshot(id)?.session.status, "running", "the session keeps showing the turn")
    emit({ type: "live-session", session: { ...state!, status: "ready" } })
    await tick()
    assert.equal(request(lost)?.status, "completed", "the message settles when its turn ends")
    assert.equal(calls.length, 1, "an unknown outcome is never sent again")

    behaviour = "refuse-running"
    const waiting = randomUUID()
    owner.submit(id, waiting, "what happened?")
    await tick()
    assert.equal(request(waiting)?.status, "queued", "a refusal behind a running turn waits for it")
    assert.equal(request(waiting)?.nativeDelivery?.evidence.kind, "not-accepted")
    assert.equal(owner.snapshot(id)?.session.status, "running")
    assert.equal(bubbles(waiting), 1)

    behaviour = "accept"
    emit({ type: "live-session", session: { ...state!, status: "ready" } })
    await tick()
    assert.equal(calls.length, 3, "the waiting message is sent once the turn ends")
    assert.notEqual(calls[2].attemptId, calls[1].attemptId)
    assert.equal(request(waiting)?.status, "dispatching")
    assert.equal(bubbles(waiting), 1, "the waiting message is not shown twice")
    emit({ type: "live-session", session: { ...state!, status: "ready" } })
    await tick()
    assert.equal(request(waiting)?.status, "completed")
  } finally {
    owner.stop()
    rmSync(root, { recursive: true, force: true })
  }
  console.log("Prompt delivery: a lost reply during a running turn settles with it; a refusal behind a running turn waits and is shown once")
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
