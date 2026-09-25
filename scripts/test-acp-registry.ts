import assert from "node:assert/strict"
import { acpLiveDriver } from "../electron/providers/acp-live-driver.js"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  HostEvent,
  LiveSessionState,
  LiveStartOptions,
  PromptAttachment,
} from "../src/lib/types.ts"
import { LiveConversations } from "../electron/live-conversations.ts"
import type { ProviderLiveDriver } from "../electron/providers/live-driver.ts"
import { elicitationQuestion, elicitationContent } from "../electron/acp-elicitation.ts"

// Native enum titles may be blank. Display the value without changing its wire identity.
for (const type of ["string", "array"] as const) {
  const options = [{ const: "first", title: "" }, { const: "second", title: "  " }, { const: "third", title: "Third choice" }]
  const question = elicitationQuestion("choice", type === "string"
    ? { type, oneOf: options }
    : { type, items: { anyOf: options } }, true)
  assert.ok(question)
  assert.deepEqual(question.options.map(option => option.label), ["first", "second", "Third choice"])
  assert.deepEqual(elicitationContent([question], {choice: ["second"]}), {choice: type === "string" ? "second" : ["second"]})
}

// An ACP provider contributes encoding through the same capability as a direct SDK driver.
const nativeEncoding = () => "a".repeat(64)
assert.equal(acpLiveDriver({
  provider: "future", approvalEvidence: { kind: "submission-only", reason: "Fixture" },
  approvalAnswerDigest: nativeEncoding, canResume: false, available: () => true, launch: async () => null,
}).approvalAnswerDigest, nativeEncoding)

const root = mkdtempSync(join(tmpdir(), "mako-live-registry-"))
const sent: Array<{ id: string; text: string }> = []
const sessions = new Map<string, LiveSessionState>()
let receive: (event: HostEvent) => void = () => {}
const driver: ProviderLiveDriver = {
  approvalEvidence: { kind: "submission-only", reason: "Injected driver fixture" },
  canResume: true,
  provider: "test",
  available: () => true,
  start: async (cwd, options) => {
    const state: LiveSessionState = {
      id: options.conversationId,
      harness: "test",
      cwd,
      status: "ready",
      connection: "connected",
      modes: [],
      currentMode: null,
      configOptions: [],
    }
    sessions.set(state.id, state)
    return state
  },
  prompt: async (id, text) => {
    sent.push({ id, text })
    const session = sessions.get(id)
    if (!session) throw new Error("Missing test session")
    owner.observe({
      type: "live-session",
      session: { ...session, status: "running" },
    })
  },
  cancel: async () => {},
  close: () => {},
  permission: async () => {},
  setMode: async () => {},
}
const owner = new LiveConversations({
  appPath: root,
  root,
  driver: () => driver,
  history: async () => null,
  emit: (event) => receive(event),
})
let loseStartReply = false
const storage = new Map<string, string>()
Object.assign(globalThis, {
  localStorage: {
    get length() { return storage.size },
    key: (index: number) => [...storage.keys()][index] ?? null,
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value) },
    removeItem: (key: string) => { storage.delete(key) },
  },
  window: {
    mako: {
      onEvent: (callback: (event: HostEvent) => void) => {
        receive = callback
        return () => {}
      },
      daemonStatus: async () => null,
      harnessProfiles: async () => [],
      harnessUpdates: async () => ({}),
      harnessTuning: async (id: string) => ({ id, label: id, available: true, transport: "acp", models: [], capabilities: [] }),
      boot: async () => {
        throw new Error("Fixture stops boot after subscribing")
      },
      liveStart: async (
        provider: string,
        cwd: string,
        options: LiveStartOptions
      ) => {
        const session = await owner.start(provider, cwd, options)
        if (loseStartReply)
          throw new Error("Start reply lost after durable acceptance")
        return owner.snapshot(session.id)
      },
      livePrompt: async (
        id: string,
        requestId: string,
        text: string,
        attachments: PromptAttachment[]
      ) => owner.submit(id, requestId, text, attachments),
      liveContinue: async (id: string, bindingId: string, requestId: string, text: string, attachments: PromptAttachment[]) =>
        owner.continueBinding(id, bindingId, requestId, text, attachments),
      liveSnapshot: async (id: string) => owner.snapshot(id),
      liveClose: async (id: string) => owner.close(id),
      liveCancel: async (id: string) => owner.cancel(id),
    },
  },
})
const { actions } = await import("../src/state/session.ts")
const { acp, acpStore, activeLiveAcp } = await import("../src/state/acp.ts")
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
try {
  await actions.boot()
  assert.equal(
    await acp.startFresh("test", "/a", "first A", [], "first A"),
    true
  )
  await tick()
  const a = activeLiveAcp(acpStore.get())!
  assert.equal(
    await acp.startFresh("test", "/b", "first B", [], "first B"),
    true
  )
  await tick()
  const b = activeLiveAcp(acpStore.get())!
  assert.notEqual(a.key, b.key)
  assert.deepEqual(
    sent.map((request) => request.text),
    ["first A", "first B"]
  )
  const stableB = acpStore.get().conversations[b.key]
  owner.observe({
    type: "live-update",
    id: a.key,
    update: { kind: "text", text: "background A" },
  })
  owner.snapshot(a.key)
  assert.equal(acpStore.get().conversations[b.key], stableB)
  assert.equal(acpStore.get().conversations[a.key]?.blocks.at(-1)?.type, "text")
  owner.observe({
    type: "live-permission",
    request: {
      id: "permission-a",
      sessionId: a.key,
      title: "Read a file",
      options: [{ optionId: "allow", name: "Allow" }],
    },
  })
  assert.equal(
    acpStore.get().conversations[a.key]?.kind === "live" &&
      acpStore.get().conversations[a.key]?.permission?.origin?.nativeRequestId,
    "permission-a"
  )
  assert.equal(await acp.send("queued B"), true)
  assert.equal(activeLiveAcp(acpStore.get())?.queued[0]?.text, "queued B")
  assert.equal(sent.length, 2)
  owner.observe({ type: "live-session", session: sessions.get(b.key)! })
  await tick()
  assert.equal(sent.at(-1)?.text, "queued B")
  assert.equal(activeLiveAcp(acpStore.get())?.queued.length, 0)
  acpStore.set({
    conversations: {
      ...acpStore.get().conversations,
      [b.key]: {
        ...activeLiveAcp(acpStore.get())!,
        sending: true,
        canceling: true,
      },
    },
  })
  owner.observe({ type: "live-session", session: sessions.get(b.key)! })
  assert.equal(activeLiveAcp(acpStore.get())?.sending, false)
  assert.equal(activeLiveAcp(acpStore.get())?.canceling, false)
  loseStartReply = true
  assert.equal(
    await acp.startFresh("test", "/c", "accepted C", [], "accepted C"),
    true
  )
  await tick()
  assert.equal(
    sent.filter((request) => request.text === "accepted C").length,
    1
  )
  assert.equal(activeLiveAcp(acpStore.get())?.requests?.[0]?.text, "accepted C")
  console.log(
    "Live bridge delivery, concurrent isolation, host queueing, permissions, lifecycle, and lost-start-reply recovery passed"
  )
} finally {
  await owner.stop()
  rmSync(root, { recursive: true, force: true })
}
