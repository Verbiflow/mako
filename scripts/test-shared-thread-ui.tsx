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
