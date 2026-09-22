import assert from "node:assert/strict"
import { renderToStaticMarkup } from "react-dom/server"
import { ThreadStatusMark } from "../src/components/rail/thread-status"
import { threadStatus } from "../src/state/thread-status"
import { threadsStore } from "../src/state/thread-store"

// A process probe must not turn Mako's own warm session into an external app.
for (const harness of ["codex", "claude", "cursor", "devin", "grok", "opencode"]) {
  const ref = { harness, nativeId: "peer-session", path: `/peer/${harness}`, heldBy: "Mako's dev3 host" }
  const state = { ...threadsStore.get(), working: {}, attention: {}, externalActivity: {
    [ref.path]: { provider: harness, status: "open" as const, since: 1 },
  } }
  assert.deepEqual(threadStatus(ref, state), { kind: "idle" }, `${harness}: a Mako owner has no external-app ring`)
  assert.deepEqual(threadStatus(ref, { ...state, externalActivity: { [ref.path]: { provider: harness, status: "active", since: 1 } } }), { kind: "working", since: 1 }, `${harness}: a running Mako owner is normal work`)
  assert.deepEqual(threadStatus({ ...ref, heldBy: undefined }, state), { kind: "external-open", app: harness }, `${harness}: an actual external owner retains the ring`)
}

const status = threadStatus({ harness: "codex", nativeId: "peer", path: "/peer", heldBy: "Mako's dev3 host" })
const markup = renderToStaticMarkup(<ThreadStatusMark status={status} updatedAt={new Date().toISOString()} />)
assert.doesNotMatch(markup, /Open in|ring-current/)
console.log("Shared thread UI: all six providers preserve real external ownership and omit the ring for Mako-owned sessions")

const outboxStorage = new Map<string, string>()
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  get length() { return outboxStorage.size }, key: (index: number) => [...outboxStorage.keys()][index] ?? null,
  getItem: (key: string) => outboxStorage.get(key) ?? null,
  setItem: (key: string, value: string) => { outboxStorage.set(key, value) },
  removeItem: (key: string) => { outboxStorage.delete(key) },
} })

// Exercise the real renderer actions with the full design-fixture bridge.
const { installMockBridge } = await import("../src/dev/mock-bridge")
const { acp } = await import("../src/state/acp")
const { acpStore } = await import("../src/state/acp-state")
const { threadContinuationActions } = await import("../src/state/thread-continuation")
const { hydrateLiveSummaries, applyLiveSnapshot } = await import("../src/state/live-recovery")
Object.defineProperty(globalThis, "window", { value: {}, configurable: true })
const fixture = installMockBridge()
const bridge = window.mako!
const snapshot: import("../electron/shared").LiveSnapshot = {
  session: { id: "019d0011-0000-4000-8000-000000000001", nativeId: "native-peer", harness: "codex", cwd: "/fixture", connection: "connected", status: "ready", modes: [], currentMode: null, configOptions: [] },
  threadPath: "/fixture/peer.jsonl", revision: 1, createdAt: 1, blocks: [], base: null, permissions: [], requests: [],
}
fixture.setLiveSnapshot(snapshot)
const ref = { harness: "codex", nativeId: "native-peer", cwd: "/fixture", path: snapshot.threadPath!, heldBy: "Mako's dev3 host" }
bridge.liveAttach = async () => snapshot
bridge.continuationPlan = async () => ({ transport: "attached", provider: "codex", conversationId: snapshot.session.id })
bridge.liveStart = async () => { throw new Error("Must not start a second agent") }
const sent: Array<{ id: string; requestId: string; text: string }> = []
bridge.livePrompt = async (id, requestId, text) => {
  sent.push({ id, requestId, text })
  return { id: requestId, text, status: "queued", attachments: [] }
}
acpStore.set({ activeKey: null, conversations: {} })
applyLiveSnapshot({ ...snapshot, session: { ...snapshot.session, id: "019d0011-0000-4000-8000-000000000002", connection: "disconnected", status: "closed" } })
assert.equal(await threadContinuationActions.reply(ref, "Continue from desktop"), true)
assert.equal(await acp.resumeAndSend(ref, "And another message"), true)
assert.deepEqual(sent.map((item) => [item.id, item.text]), [[snapshot.session.id, "Continue from desktop"], [snapshot.session.id, "And another message"]])
assert.notEqual(sent[0].requestId, sent[1].requestId)
assert.equal(acpStore.get().activeKey, snapshot.session.id)
acpStore.set({ activeKey: null, conversations: {} })
Object.defineProperty(globalThis, "sessionStorage", { value: { getItem: () => snapshot.session.id, removeItem: () => {} }, configurable: true })
hydrateLiveSummaries([])
for (let attempt = 0; attempt < 100 && !acpStore.get().conversations[snapshot.session.id]?.hydrated; attempt++)
  await new Promise((resolve) => setTimeout(resolve, 5))
assert.equal(acpStore.get().activeKey, snapshot.session.id)
assert.equal(acpStore.get().conversations[snapshot.session.id]?.hydrated, true, "UI reload restores a peer conversation absent from local boot summaries")
console.log("Shared thread actions: desktop sends both replies to the attached owner, starts no agent, and restores the same conversation after reload")

const { threadViewingActions } = await import("../src/state/thread-viewing")
const second = { ...snapshot, session: { ...snapshot.session, id: "019d0011-0000-4000-8000-000000000003", nativeId: "native-second" }, threadPath: "/fixture/second.jsonl" }
fixture.setLiveSnapshot(second)
const waiting = new Map<string, (snapshot: import("../electron/shared").LiveSnapshot) => void>()
bridge.liveAttach = (path) => new Promise((resolve) => { waiting.set(path, resolve) })
const firstView = threadViewingActions.view(ref)
while (!waiting.has(ref.path)) await new Promise((resolve) => setTimeout(resolve, 1))
const secondView = threadViewingActions.view({ ...ref, path: second.threadPath, nativeId: "native-second" })
while (!waiting.has(second.threadPath)) await new Promise((resolve) => setTimeout(resolve, 1))
waiting.get(second.threadPath)!(second)
await secondView
waiting.get(ref.path)!(snapshot)
await firstView
assert.equal(acpStore.get().activeKey, second.session.id, "a late peer snapshot cannot steal selection from a newer click")
console.log("Shared thread selection: a stale local binding cannot capture sends, and out-of-order owner replies preserve the selected thread")

const bindingId = "019d0011-0000-4000-8000-000000000004"
const activeBindingId = "019d0011-0000-4000-8000-000000000005"
const bound = { ...snapshot, revision: 3, session: { ...snapshot.session, harness: "claude" }, control: {
  activeBindingId, children: [], transfers: [], merges: [], bindings: [
    { id: bindingId, provider: "codex", nativeId: ref.nativeId, path: ref.path, tuning: { model: "codex-model" }, coveredBlocks: 0, includesBase: true },
    { id: activeBindingId, provider: "claude", nativeId: "claude-native", tuning: { model: "claude-model" }, coveredBlocks: 0, includesBase: true },
  ],
} }
let resolves = 0
bridge.resolveContinuation = async () => {
  resolves++
  return { transport: "attached", provider: "codex", conversationId: snapshot.session.id, bindingId, snapshot: bound }
}
bridge.liveAttach = async () => { throw new Error("Legacy attach must not be queried") }
bridge.continuationPlan = async () => { throw new Error("Legacy plan must not be queried") }
bridge.liveSnapshot = async () => bound
const targetSends: Array<{ binding: string; request: string; tuning: unknown }> = []
bridge.liveContinue = async (_id, binding, request, _text, _attachments, tuning) => {
  targetSends.push({ binding, request, tuning })
  return bound
}
assert.equal(await acp.openInteractive(ref), true)
assert.equal(resolves, 1, "opening uses one host resolution")
assert.equal(await acp.send("Continue the selected Codex session"), true)
assert.equal(targetSends[0].binding, bindingId)
assert.deepEqual(targetSends[0].tuning, { model: "codex-model" }, "historical continuation retains its own provider settings")
console.log("Selected native binding: one resolution, exact target and target settings survive interactive opening")

const { beginStart, launch } = await import("../src/state/acp-start")
const { RuntimeDisconnectedError } = await import("../electron/contracts/host-connection")
const { randomUUID } = await import("node:crypto")
const redirectedId = randomUUID()
const submittedStarts: import("../electron/shared").LiveStartOptions[] = []
bridge.liveSnapshot = async () => null
bridge.resolveContinuation = async () => ({ transport: "unavailable", reason: "Owner is restarting" })
bridge.liveStart = async (_provider, _cwd, input) => {
  submittedStarts.push(input)
  if (submittedStarts.length === 1) throw new RuntimeDisconnectedError(true, redirectedId)
  if (submittedStarts.length === 2) throw new Error("Owner temporarily unavailable")
  return { ...snapshot, control: bound.control, session: { ...snapshot.session, id: redirectedId }, requests: [
    { ...input.initialRequest!, status: "completed" },
  ] }
}
bridge.liveContinue = async (id, binding, requestId, text, _attachments, tuning) => {
  sent.push({ id, requestId, text })
  targetSends.push({ binding, request: requestId, tuning })
  return { ...bound, session: { ...bound.session, id } }
}
const starting = beginStart({ harness: "codex", cwd: "/fixture", threadPath: ref.path, blocks: [], hiddenUserPrompt: null })
assert.equal(await launch(starting, { resume: ref.nativeId }, "Racing first reply"), true)
assert.ok(acpStore.get().conversations[starting.key]?.kind === "starting", "uncertain redirected starts remain staged")
const followup = acp.send("Reply queued during owner recovery")
const deadline = Date.now() + 8_000
while (submittedStarts.length < 3 || acpStore.get().conversations[starting.key]) {
  assert.ok(Date.now() < deadline, "original start retries after owner recovery")
  await new Promise((resolve) => setTimeout(resolve, 10))
}
assert.equal(await followup, true)
assert.deepEqual(submittedStarts[0], submittedStarts[2], "recovery keeps the exact original start and request IDs")
assert.equal(acpStore.get().activeKey, redirectedId)
assert.equal(targetSends.at(-1)?.binding, bindingId, "redirected startup follow-up keeps the selected historical binding")
assert.equal(sent.at(-1)?.id, redirectedId, "messages queued during redirected startup follow the winning owner")
console.log("Redirected start: uncertain first delivery retries the same command; staged follow-up follows the winning owner")

const { sendTo, replayUnconfirmedPrompts, restorePendingMessages } = await import("../src/state/acp-queue")
const { pendingMessages } = await import("../src/state/message-outbox")
acpStore.set({ activeKey: snapshot.session.id, conversations: {} })
applyLiveSnapshot(snapshot)
let attempt = 0
const repeated: string[] = []
let accepted = false
bridge.liveSnapshot = async () => ({ ...snapshot, requests: accepted ? [{ id: repeated[0], text: "Durable reply", attachments: [], status: "queued" }] : [] })
bridge.livePrompt = async (_id, requestId, text) => {
  repeated.push(requestId)
  attempt++
  if (attempt === 1) throw new RuntimeDisconnectedError(true, snapshot.session.id)
  if (attempt === 2) throw new Error("Owner lookup temporarily failed")
  accepted = true
  return { id: requestId, text, attachments: [], status: "queued" }
}
assert.equal(await sendTo(snapshot.session.id, "Durable reply"), true)
assert.equal(pendingMessages().length, 1, "uncertain command remains durably stored")
await replayUnconfirmedPrompts([snapshot.session.id])
assert.equal(acpStore.get().conversations[snapshot.session.id]?.pendingPrompts?.[0]?.unconfirmed, true, "generic retry error cannot erase earlier uncertainty")
assert.equal(pendingMessages().length, 1)
// Simulate a fresh renderer: all conversation/prompt state disappears; storage remains.
acpStore.set({ activeKey: null, conversations: {} })
await restorePendingMessages()
assert.equal(attempt, 3)
assert.equal(new Set(repeated).size, 1, "reload uses the original request ID")
assert.equal(pendingMessages().length, 0, "receipt settles the durable command")

accepted = false
attempt = 0
repeated.length = 0
bridge.livePrompt = async (_id, requestId, text) => {
  repeated.push(requestId)
  attempt++
  if (attempt === 1) throw new RuntimeDisconnectedError(true, snapshot.session.id)
  accepted = true
  return { id: requestId, text, attachments: [], status: "queued" }
}
assert.equal(await sendTo(snapshot.session.id, "Recover without stream reconnect"), true)
const recoveryDeadline = Date.now() + 8_000
while (!accepted) {
  assert.ok(Date.now() < recoveryDeadline, "RPC-only failure recovers without a stream event")
  await new Promise((resolve) => setTimeout(resolve, 20))
}
assert.equal(new Set(repeated).size, 1)
assert.equal(pendingMessages().length, 0)
console.log("Durable delivery: ambiguity survives generic errors and reload; RPC-only recovery keeps one request ID without reconnect events")

const { saveMessage } = await import("../src/state/message-outbox")
const startId = randomUUID()
const startRequest = randomUUID()
const input = { conversationId: startId, initialRequest: { id: startRequest, text: "Restored initial message", attachments: [] } }
saveMessage({ kind: "start", args: ["codex", "/fixture", input], draftKey: startId })
applyLiveSnapshot({ ...snapshot, session: { ...snapshot.session, id: startId } })
let starts = 0
bridge.liveSnapshot = async () => { throw new RuntimeDisconnectedError(true) }
bridge.liveStart = async (_harness, _cwd, options) => {
  starts++
  if (starts === 1) throw new Error("Owner lookup unavailable")
  return { ...snapshot, session: { ...snapshot.session, id: startId }, requests: [{ ...options.initialRequest!, status: "queued" }] }
}
await restorePendingMessages()
assert.equal(acpStore.get().conversations[startId]?.kind, "live", "recovery preserves an existing live summary")
const startDeadline = Date.now() + 5_000
while (pendingMessages().some((command) => command.kind === "start")) {
  assert.ok(Date.now() < startDeadline, "restored starts retry independently of UI kind")
  await new Promise((resolve) => setTimeout(resolve, 20))
}
assert.equal(starts, 2)
console.log("Restored starts retry with a live boot summary; redirected follow-ups retain their exact native binding")

applyLiveSnapshot(snapshot)
let dispatched = 0
bridge.livePrompt = async (_id, requestId, text) => { dispatched++; return { id: requestId, text, attachments: [], status: "queued" } }
bridge.liveSnapshot = async () => snapshot
const originalStorageWrite = localStorage.setItem
localStorage.setItem = () => { throw new Error("Fixture storage quota exceeded") }
assert.equal(await sendTo(snapshot.session.id, "Must remain a draft"), false)
assert.equal(dispatched, 0, "storage failure must precede provider dispatch")
localStorage.setItem = originalStorageWrite
console.log("Storage failure refuses dispatch so composer recovery can retain the original draft")

const { settingsForSend } = await import("../src/state/composer-settings")
const { removeAcpConversation, updateAcpConversation } = await import("../src/state/acp-state")
const { providers } = await import("../src/state/providers")
await providers.load("codex", true, "/fixture")
const racingStart = beginStart({ harness: "codex", cwd: "/fixture", settingsTarget: { kind: "new", harness: "codex", cwd: "/fixture" }, blocks: [], hiddenUserPrompt: null })
const capturedSettings = await settingsForSend(racingStart.settingsTarget)
const settingsRace = acp.send("Follow-up during settings resolution")
applyLiveSnapshot(bound, bindingId)
updateAcpConversation(bound.session.id, (current) => ({ ...current, draftKey: racingStart.draftKey }))
removeAcpConversation(racingStart.key)
assert.equal(await settingsRace, true)
assert.equal(targetSends.at(-1)?.binding, bindingId)
assert.deepEqual(targetSends.at(-1)?.tuning, capturedSettings, "promotion during settings resolution retains the captured command settings")
assert.equal(pendingMessages().length, 0)
console.log("Startup/settings race: promoted target receives the follow-up with captured tuning")

// A same-ID promotion must enrich the existing staged follow-up, not only storage.
acpStore.set({ activeKey: null, conversations: {} })
const sameStart = beginStart({ harness: "codex", cwd: "/fixture", blocks: [], hiddenUserPrompt: null })
let releaseStart: ((value: import("../electron/shared").LiveSnapshot) => void) | undefined
let heldInput: import("../electron/shared").LiveStartOptions | undefined
bridge.liveStart = async (_h, _c, input) => {
  heldInput = input
  return new Promise((resolve) => { releaseStart = resolve })
}
const startingPromise = launch(sameStart, {}, "first")
while (!releaseStart) await new Promise((resolve) => setTimeout(resolve, 1))
const queuedPromise = acp.send("same id followup")
while (!pendingMessages().some((command) => command.kind === "queued")) await new Promise((resolve) => setTimeout(resolve, 1))
const sameSnapshot = { ...snapshot, session: { ...snapshot.session, id: sameStart.key },
  control: { ...bound.control, activeBindingId: sameStart.key, bindings: [{ ...bound.control.bindings[0], id: sameStart.key }] },
  requests: [{ ...heldInput!.initialRequest!, status: "completed" as const }] }
let sameCalls = 0
bridge.liveSnapshot = async () => sameSnapshot
bridge.liveContinue = async (_id, binding) => {
  assert.equal(binding, sameStart.key)
  if (++sameCalls === 1) throw new RuntimeDisconnectedError(true, sameStart.key)
  return sameSnapshot
}
// Another tab may resolve storage before this tab receives its start response.
const peerResolved = pendingMessages().find((command) => command.kind === "queued")!
assert.equal(peerResolved.kind, "queued")
if (peerResolved.kind === "queued") saveMessage({ kind: "prompt", conversationId: sameStart.key,
  requestId: peerResolved.requestId, text: peerResolved.text, attachments: peerResolved.attachments,
  tuning: peerResolved.tuning, bindingId: sameStart.key })
releaseStart(sameSnapshot)
await startingPromise
await queuedPromise
await replayUnconfirmedPrompts([sameStart.key])
assert.equal(sameCalls, 2, "ambiguous follow-up retries the exact binding instead of failing before RPC")
assert.equal(pendingMessages().length, 0)

// A different client can switch providers while the original startup reply is lost.
acpStore.set({ activeKey: null, conversations: {} })
const originalStartId = randomUUID()
const originalRequestId = randomUUID()
const queuedRequestId = randomUUID()
const switchedSnapshot = { ...bound, session: { ...bound.session, id: originalStartId },
  control: { ...bound.control, bindings: bound.control.bindings.map((binding) => binding.id === bindingId ? { ...binding, id: originalStartId } : binding) },
  requests: [{ id: originalRequestId, text: "original", attachments: [], status: "completed" as const }] }
applyLiveSnapshot(switchedSnapshot)
saveMessage({ kind: "start", args: ["codex", "/fixture", { conversationId: originalStartId, initialRequest: { id: originalRequestId, text: "original", attachments: [] } }], draftKey: originalStartId })
saveMessage({ kind: "queued", startId: originalStartId, requestId: queuedRequestId, text: "queued before startup reply", attachments: [] })
bridge.liveSnapshot = async () => switchedSnapshot
bridge.livePrompt = async () => { throw new Error("Must not send to the current Claude binding") }
let resumedTarget: string | undefined
bridge.liveContinue = async (_id, binding) => { resumedTarget = binding; return switchedSnapshot }
await restorePendingMessages()
assert.equal(resumedTarget, originalStartId)
assert.equal(pendingMessages().length, 0)
console.log("Startup recovery: same-ID ambiguous follow-ups retry; another client's provider switch cannot retarget them")

// Deliver the storage notification that another same-origin tab receives.
const { watchPendingMessages } = await import("../src/state/message-outbox")
const storageEvents = new EventTarget()
Object.assign(window, { addEventListener: storageEvents.addEventListener.bind(storageEvents), removeEventListener: storageEvents.removeEventListener.bind(storageEvents) })
let recoveredFromPeer = 0
bridge.liveContinue = async (_id, binding) => { assert.equal(binding, originalStartId); recoveredFromPeer++; return switchedSnapshot }
const stopWatching = watchPendingMessages(() => { void restorePendingMessages() })
const peerRequestId = randomUUID()
saveMessage({ kind: "prompt", conversationId: originalStartId, requestId: peerRequestId, text: "sender tab closed", attachments: [], bindingId: originalStartId })
const peerKey = [...outboxStorage.keys()].find((key) => key.endsWith(peerRequestId))!
const storageEvent = new Event("storage")
Object.assign(storageEvent, { key: peerKey, newValue: outboxStorage.get(peerKey) })
storageEvents.dispatchEvent(storageEvent)
const peerDeadline = Date.now() + 2_000
while (!recoveredFromPeer && Date.now() < peerDeadline) await new Promise((resolve) => setTimeout(resolve, 10))
stopWatching()
assert.equal(recoveredFromPeer, 1, "surviving tab recovers without reload or reconnect")
assert.equal(pendingMessages().length, 0)
console.log("Cross-tab recovery: a storage event recovers the abandoned command without reloading")
