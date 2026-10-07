import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CursorSdkAuth } from "../electron/providers/cursor/sdk/auth.ts"
import { CursorCredentialStore } from "../electron/providers/cursor/sdk/credentials.ts"
import { CursorSdkDisconnectedError, type CursorSdkExit } from "../electron/providers/cursor/sdk/client.ts"
import { cursorProfileLoaderWith } from "../electron/providers/cursor/profile.ts"
import { resolveHarnessTuning } from "../electron/harness-models.ts"
import type { LiveSessionState } from "../electron/shared.ts"
import {
  createCursorSdkDriver,
  type CursorSdkLiveClient,
} from "../electron/providers/cursor/sdk/driver.ts"
import type { PromptDeliveryEvidence } from "../electron/contracts/prompt-delivery.ts"
import type {
  SdkEvent,
  SdkMethod,
  SdkResult,
  SdkModelListItem,
} from "../electron/providers/cursor/sdk/wire.ts"

type FixtureAnswers = {
  [M in SdkMethod]?: () => SdkResult<M> | Promise<SdkResult<M>>
}

// The production adapter, with an injected child transport and no account/network access.
const root = mkdtempSync(join(tmpdir(), "mako-cursor-delivery-"))
let answer: (value: { runId: string }) => void = () => {}
let reject: (error: Error) => void = () => {}
let sends = 0
const client: CursorSdkLiveClient = {
  alive: true,
  exited: new Promise(() => {}),
  hello: async () => ({
    wire: 1,
    sdkVersion: "fixture",
    node: process.version,
  }),
  request: async <Method extends SdkMethod>(
    method: Method
  ): Promise<SdkResult<Method>> => {
    const answers: FixtureAnswers = {
      me: () => ({
        email: "fixture@example.test",
        apiKeyName: "fixture",
        createdAt: "2026-09-22",
      }),
      open: () => ({
        agentId: "fixture-agent",
        model: { id: "fixture-model" },
      }),
      active: () => ({}),
      send: () => {
        sends++
        return new Promise<{ runId: string }>((resolve, fail) => {
          answer = resolve
          reject = fail
        })
      },
    }
    const respond = answers[method]
    if (!respond) throw new Error(`Unexpected fixture method: ${method}`)
    return respond()
  },
  close: async () => {},
  kill() {},
}
const auth = new CursorSdkAuth({
  env: async () => ({ CURSOR_API_KEY: "key_fixture_0123456789abcdef" }),
  openUrl: async () => {
    throw new Error("Fixture must not sign in")
  },
  credentials: new CursorCredentialStore(join(root, "credential.bin"), {
    available: async () => false,
    encrypt: async () => Buffer.alloc(0),
    decrypt: async () => "",
  }),
  cliKey: async () => null,
  client: () => client,
})
const driver = createCursorSdkDriver({
  auth,
  stateRoot: () => root,
  home: root,
  client: () => client,
  models: async () => [{ id: "fixture-model", displayName: "Fixture" }],
})
const id = randomUUID()
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
const evidence: PromptDeliveryEvidence[] = []
const dispatch = () => ({
  operationId: randomUUID(),
  attemptId: randomUUID(),
  report: (e: PromptDeliveryEvidence) => evidence.push(e),
})
try {
  await auth.status()
  const identity = Promise.withResolvers<SdkResult<"me">>()
  const opened = Promise.withResolvers<void>()
  const delayedClient: CursorSdkLiveClient = {
    ...client,
    request: async (method, params) => {
      const answers: FixtureAnswers = {
        me: () => identity.promise,
        open: () => { opened.resolve(); return { agentId: "fixture-agent", model: { id: "fixture-model" }, imported: false, importSource: "/native/previous-import.db", importRevision: "verified-snapshot-head" } },
      }
      const respond = answers[method]
      return respond ? respond() : client.request(method, params)
    },
  }
  const delayed = createCursorSdkDriver({ auth, stateRoot: () => root, home: root, client: () => delayedClient, models: async () => [{ id: "fixture-model", displayName: "Fixture" }] })
  const delayedId = randomUUID()
  let ready = false
  const starting = delayed.start(root, { conversationId: delayedId, emit() {} }).then(state => { ready = true; return state })
  await opened.promise
  await tick()
  assert.equal(ready, false, "native open cannot admit input before effective identity settles")
  identity.resolve({ email: "effective@example.test", apiKeyName: "fixture", createdAt: "2026-10-03" })
  const identified = await starting
  assert.equal(identified.executionContext?.identity.kind, "reported")
  assert.equal(identified.executionContext?.sourceImport?.source, "/native/previous-import.db", "a previously indexed import retains native provenance even when no new copy occurred")
  assert.equal(identified.executionContext?.sourceImport?.revision, "verified-snapshot-head", "the parent retains the child snapshot revision")
  await delayed.close(delayedId)
  await driver.start(root, { conversationId: id, emit() {} })
  const pending = driver.prompt(id, "first", [], undefined, dispatch())
  await tick()
  assert.equal(sends, 1)
  assert.equal(
    evidence.at(-1)?.kind,
    "submitted",
    "enqueue/running is not native acceptance"
  )
  answer({ runId: "native-receipt" })
  await pending
  assert.deepEqual(evidence.at(-1), {
    kind: "accepted",
    source: "native-response",
    referenceId: "native-receipt",
  })
  await assert.rejects(
    driver.prompt(id, "busy", [], undefined, dispatch()),
    /already working/
  )
  assert.equal(evidence.at(-1)?.kind, "not-accepted")
  assert.equal(sends, 1, "preflight refusal cannot send")
  await driver.close(id)
  await driver.start(root, { conversationId: id, emit() {} })
  const lost = driver.prompt(id, "lost reply", [], undefined, dispatch())
  const rejected = assert.rejects(lost, /reply lost/)
  await tick()
  reject(new Error("reply lost after dispatch"))
  await rejected
  assert.equal(
    evidence.at(-1)?.kind,
    "submitted",
    "transport rejection is not proof of non-delivery; shared owner records uncertainty"
  )
  console.log(
    "Cursor delivery: production adapter preflight refusal, delayed native response and lost-reply evidence passed"
  )

  const states: LiveSessionState[] = []
  let closeRequested = false
  let exited = false
  let confirmExit: (exit: CursorSdkExit) => void = () => {}
  const unresponsive: CursorSdkLiveClient = {
    ...client,
    get alive() { return !exited },
    exited: new Promise((resolve) => { confirmExit = resolve }),
    request: async (method, params) => {
      if (method === "cancel") throw new CursorSdkDisconnectedError("The Cursor SDK did not answer cancel")
      return client.request(method, params)
    },
    close: async () => { closeRequested = true },
  }
  const stalled = createCursorSdkDriver({
    auth, stateRoot: () => root, home: root, client: () => unresponsive,
    models: async () => [{ id: "fixture-model", displayName: "Fixture" }],
  })
  const stalledId = randomUUID()
  await stalled.start(root, { conversationId: stalledId, emit(event) {
    if (event.type === "live-session") states.push(event.session)
  } })
  const nativeId = states.at(-1)?.nativeId
  assert.ok(nativeId)
  const running = stalled.prompt(stalledId, "work", [], undefined, dispatch())
  await tick()
  answer({ runId: "stalled-native-run" })
  await running
  const stopping = assert.rejects(stalled.cancel(stalledId), /did not answer cancel/)
  await tick()
  assert.equal(closeRequested, true, "Stop must close an unresponsive provider")
  assert.equal(states.at(-1)?.status, "running", "a timeout cannot report a still-live writer as ready")
  await assert.rejects(stalled.prompt(stalledId, "competing", [], undefined, dispatch()), /already working/)
  exited = true
  confirmExit({ code: null, signal: "SIGKILL", fatal: undefined })
  await stopping
  assert.equal(states.at(-1)?.connection, "disconnected")
  assert.equal(states.at(-1)?.status, "failed")
  assert.equal(states.at(-1)?.nativeId, nativeId, "process recovery preserves the native session")
  await stalled.close(stalledId)
  console.log("Cursor Stop: failed acknowledgement closes the process and waits for exit before allowing recovery")

  // The host lost track of a turn the child still runs, as when a send
  // reply was dropped. The next prompt shows that turn instead of failing
  // against it, and later lines for it keep reaching the transcript.
  let childEvent: (event: SdkEvent) => void = () => {}
  let childActive: SdkResult<"active"> = {}
  let orphanSends = 0
  const orphanClient: CursorSdkLiveClient = {
    ...client,
    request: async (method, params) => {
      const answers: FixtureAnswers = {
        active: () => {
          if (childActive.turn && !childActive.starting) childEvent(assistant(childActive.turn, "replayed work"))
          return childActive
        },
        send: () => {
          orphanSends++
          return { runId: "fresh-run" }
        },
      }
      const respond = answers[method]
      return respond ? respond() : client.request(method, params)
    },
  }
  const assistant = (turn: string, text: string): SdkEvent => ({
    event: "message",
    turn,
    message: {
      type: "assistant",
      agent_id: "fixture-agent",
      run_id: "orphan-run",
      message: { role: "assistant", content: [{ type: "text", text }] },
    },
  })
  const orphanStates: LiveSessionState[] = []
  const orphanUpdates: string[] = []
  const orphan = createCursorSdkDriver({
    auth, stateRoot: () => root, home: root,
    client: (options) => {
      childEvent = options.onEvent
      return orphanClient
    },
    models: async () => [{ id: "fixture-model", displayName: "Fixture" }],
  })
  const orphanId = randomUUID()
  await orphan.start(root, { conversationId: orphanId, emit(event) {
    if (event.type === "live-session") orphanStates.push(event.session)
    else orphanUpdates.push(JSON.stringify(event))
  } })

  childActive = { turn: "orphan", runId: "orphan-run" }
  const refusal: PromptDeliveryEvidence[] = []
  await assert.rejects(
    orphan.prompt(orphanId, "what happened?", [], undefined, {
      operationId: randomUUID(), attemptId: randomUUID(), report: (e) => refusal.push(e),
    }),
    /still running an earlier turn/
  )
  assert.equal(refusal.at(-1)?.kind, "not-accepted", "the follow-up was never sent, so the host may send it later")
  assert.equal(orphanSends, 0, "a prompt is never sent into a running turn")
  assert.equal(orphanStates.at(-1)?.status, "running", "the lost turn shows as working")
  assert.equal(orphanStates.at(-1)?.nativeRunId, "orphan-run")
  assert.ok(orphanUpdates.some((line) => line.includes("provider-turn")), "the transcript opens the adopted turn")
  assert.ok(orphanUpdates.some((line) => line.includes("replayed work")), "the child's replay reaches the transcript")

  childEvent(assistant("orphan", "live work"))
  assert.ok(orphanUpdates.some((line) => line.includes("live work")), "later lines for the adopted turn are shown live")
  childEvent({ event: "result", turn: "orphan", result: { runId: "orphan-run", status: "finished" } })
  assert.equal(orphanStates.at(-1)?.status, "ready", "the adopted turn ends like any other")

  const afterEnd = orphanUpdates.length
  childEvent(assistant("orphan", "late line"))
  assert.equal(orphanStates.at(-1)?.status, "ready", "a settled turn's late line cannot reopen it")
  assert.equal(orphanUpdates.length, afterEnd)

  childEvent(assistant("unseen", "spontaneous"))
  assert.equal(orphanStates.at(-1)?.status, "running", "a line for a turn the host never saw is adopted while idle")
  assert.ok(orphanUpdates.some((line) => line.includes("spontaneous")))
  childEvent({ event: "result", turn: "unseen", result: { runId: "orphan-run", status: "finished" } })
  assert.equal(orphanStates.at(-1)?.status, "ready")

  childActive = { turn: "starting", starting: true }
  await assert.rejects(
    orphan.prompt(orphanId, "too soon", [], undefined, dispatch()),
    /still ending the previous turn/
  )
  assert.equal(evidence.at(-1)?.kind, "not-accepted")

  childActive = {}
  await orphan.prompt(orphanId, "fresh", [], undefined, dispatch())
  assert.equal(orphanSends, 1, "with nothing running the prompt is sent")
  assert.equal(evidence.at(-1)?.kind, "accepted")
  await orphan.close(orphanId)
  console.log("Cursor lost turn: the next prompt shows it live without sending; settled turns stay closed")

  // Plan is the SDK's per-send mode: a planning turn asks for it beside the
  // model, and the model the run reports back does not turn it off.
  const sent: string[] = []
  const planModels: SdkModelListItem[] = [{
    id: "fixture-model", displayName: "Fixture",
    parameters: [{ id: "effort", values: [{ value: "high" }, { value: "low" }] }],
    variants: [
      { params: [{ id: "effort", value: "high" }], displayName: "High", isDefault: true },
      { params: [{ id: "effort", value: "low" }], displayName: "Low" },
    ],
  }]
  const planProfile = await cursorProfileLoaderWith(planModels).load({})
  let planEvent: (event: SdkEvent) => void = () => {}
  const planClient: CursorSdkLiveClient = {
    ...client,
    request: async (method, params) => {
      const answers: FixtureAnswers = {
        send: () => {
          sent.push(JSON.stringify(params))
          return { runId: `plan-run-${sent.length}` }
        },
      }
      const respond = answers[method]
      return respond ? respond() : client.request(method, params)
    },
  }
  const planStates: LiveSessionState[] = []
  const planned = createCursorSdkDriver({
    auth, stateRoot: () => root, home: root,
    client: (options) => {
      planEvent = options.onEvent
      return planClient
    },
    models: async () => planModels,
  })
  const planId = randomUUID()
  await planned.start(root, { conversationId: planId, emit(event) {
    if (event.type === "live-session") planStates.push(event.session)
  } })
  assert.ok(planStates.at(-1)?.configOptions.some((option) => option.id === "plan" && option.role === "plan"),
    "every Cursor model offers plan mode")
  const defaultTurn = dispatch()
  await planned.prompt(planId, "ordinary turn", [], resolveHarnessTuning(planProfile, { model: "fixture-model" }), defaultTurn)
  assert.equal(sent.at(-1), JSON.stringify({ turn: defaultTurn.attemptId, text: "ordinary turn", model: { id: "fixture-model", params: [{ id: "effort", value: "high" }] }, plan: false }))
  planEvent({ event: "result", turn: defaultTurn.attemptId, result: { runId: "plan-run-1", status: "finished", model: { id: "fixture-model" } } })
  const planTurn = dispatch()
  await planned.prompt(planId, "plan it", [], resolveHarnessTuning(planProfile, { model: "fixture-model", options: { plan: true } }), planTurn)
  assert.equal(sent.at(-1), JSON.stringify({ turn: planTurn.attemptId, text: "plan it", model: { id: "fixture-model", params: [{ id: "effort", value: "high" }] }, plan: true }))
  assert.equal(planStates.at(-1)?.settings?.options?.plan, true)
  planEvent({ event: "result", turn: planTurn.attemptId, result: { runId: "plan-run-2", status: "finished", model: { id: "fixture-model" } } })
  assert.equal(planStates.at(-1)?.settings?.options?.plan, true, "the run's reported model keeps the plan choice")
  assert.ok(planStates.at(-1)?.configOptions.some((option) => option.id === "plan" && option.kind === "boolean" && option.current === true))
  const buildTurn = dispatch()
  await planned.prompt(planId, "build it", [], resolveHarnessTuning(planProfile, { model: "fixture-model[effort=low]", options: { plan: false } }), buildTurn)
  assert.equal(sent.at(-1), JSON.stringify({ turn: buildTurn.attemptId, text: "build it", model: { id: "fixture-model", params: [{ id: "effort", value: "low" }] }, plan: false }))
  assert.ok(sent.at(-1)?.endsWith('"plan":false}'), "building sends Agent again")
  assert.equal(planStates.at(-1)?.settings?.options?.plan, false)
  await planned.close(planId)
  console.log("Cursor plan: a planning send asks for the SDK's plan mode and the session keeps reporting it")
} finally {
  await driver.close(id)
  rmSync(root, { recursive: true, force: true })
}
