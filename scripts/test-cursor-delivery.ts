import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CursorSdkAuth } from "../electron/providers/cursor/sdk/auth.ts"
import { CursorCredentialStore } from "../electron/providers/cursor/sdk/credentials.ts"
import { CursorSdkDisconnectedError } from "../electron/providers/cursor/sdk/client.ts"
import type { LiveSessionState } from "../electron/shared.ts"
import {
  createCursorSdkDriver,
  type CursorSdkLiveClient,
} from "../electron/providers/cursor/sdk/driver.ts"
import type { PromptDeliveryEvidence } from "../electron/contracts/prompt-delivery.ts"
import type {
  SdkMethod,
  SdkResult,
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
  let confirmExit: (exit: { code: number | null; signal: NodeJS.Signals | null }) => void = () => {}
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
  confirmExit({ code: null, signal: "SIGKILL" })
  await stopping
  assert.equal(states.at(-1)?.connection, "disconnected")
  assert.equal(states.at(-1)?.status, "failed")
  assert.equal(states.at(-1)?.nativeId, nativeId, "process recovery preserves the native session")
  await stalled.close(stalledId)
  console.log("Cursor Stop: failed acknowledgement closes the process and waits for exit before allowing recovery")
} finally {
  await driver.close(id)
  rmSync(root, { recursive: true, force: true })
}
