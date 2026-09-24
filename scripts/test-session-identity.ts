import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LiveConversations } from "../electron/live-conversations.ts"
import { acpForThread, acpStore } from "../src/state/acp-state.ts"
import { applyLiveSnapshot, applyLiveBatch, hydrateLiveSummaries } from "../src/state/live-recovery.ts"
import { canonicalThreadRefs, selectAcpPresence } from "../src/state/acp-presence.ts"
import { threadStatus } from "../src/state/thread-status.ts"
import { threadsStore } from "../src/state/thread-store.ts"
import type { LiveSnapshot, ThreadRef } from "../electron/shared.ts"

const id = "11111111-1111-4111-8111-111111111111"
const nativeId = "22222222-2222-4222-8222-222222222222"
const original: ThreadRef = { harness: "claude", nativeId, path: "/account/project/session.jsonl" }
const alias: ThreadRef = { ...original, path: "/default/project/session.jsonl", active: true }
const snapshot: LiveSnapshot = {
  session: {
    id, nativeId, harness: "claude", cwd: "/project", status: "running",
    connection: "connected", modes: [], currentMode: null, configOptions: [],
  },
  threadPath: original.path,
  revision: 1, createdAt: 1, blocks: [], requests: [], permissions: [],
  control: {
    activeBindingId: id, children: [], merges: [], transfers: [],
    bindings: [{ id, provider: "claude", nativeId, path: original.path, coveredBlocks: 0, includesBase: true }],
  },
}
acpStore.set({ activeKey: id, conversations: {} })
threadsStore.set({ threads: [alias, original], working: {}, attention: {}, externalActivity: {} })
applyLiveSnapshot(snapshot)
assert.equal(acpForThread(acpStore.get(), alias)?.key, id, "Account-path aliases must reopen the existing conversation")
assert.equal(acpForThread(acpStore.get(), { ...alias, harness: "codex" }), null, "Native IDs are scoped to their provider")
assert.equal(acpForThread(acpStore.get(), { ...original, harness: "codex" }), null, "A matching path cannot override provider ownership")
assert.equal(threadStatus(alias).kind, "working")
applyLiveBatch({ id, revision: 2, updates: [], session: { ...snapshot.session, status: "ready", lastStop: "completed" } })
assert.equal(threadStatus(alias).kind, "idle", "A completed owned turn overrides stale external activity")
assert.deepEqual(canonicalThreadRefs([alias, original], selectAcpPresence(acpStore.get()), []), [original], "The rail shows one row per native session")
assert.deepEqual(canonicalThreadRefs([alias, original], selectAcpPresence(acpStore.get()), [alias.path]), [alias], "Pinned aliases remain usable without duplicate rows")
applyLiveBatch({ id, revision: 3, updates: [], threadPath: "/next/session.jsonl", session: { ...snapshot.session, nativeId: "next", status: "running" } })
assert.equal(threadsStore.get().working[original.path], undefined, "Moving a live binding retires the previous path's working flag")
assert.equal(acpForThread(acpStore.get(), { harness: "claude", nativeId: "next", path: "/next/session.jsonl" })?.key, id)
applyLiveBatch({ id, revision: 4, updates: [{ kind: "text", text: "streamed" }] })
assert.equal(acpForThread(acpStore.get(), { path: "/next/session.jsonl" }), acpStore.get().conversations[id], "An indexed lookup returns the current conversation, not its previous stream snapshot")
applyLiveBatch({ id, revision: 5, updates: [], session: { ...snapshot.session, status: "closed" } })
assert.equal(acpForThread(acpStore.get(), alias), null, "Closed indexed bindings are not activatable")
const questionControl = {...snapshot.control!,questions:[{id:randomUUID(),bindingId:id,native:{sessionId:nativeId,turnId:"turn",itemId:"item",questions:[{id:"q",header:"",question:"Still waiting?",isSecret:false,allowOther:true,options:[]}]}}]}
applyLiveSnapshot({...snapshot,revision:6,session:{...snapshot.session,status:"closed"},control:questionControl})
assert.equal(acpForThread(acpStore.get(),alias)?.key,id,"A closed native process cannot hide saved session questions")
acpStore.set({activeKey:null,conversations:{}})
hydrateLiveSummaries([{...snapshot,session:{...snapshot.session,status:"closed"},hasSessionQuestions:true}])
assert.equal(acpForThread(acpStore.get(),alias)?.key,id,"The lightweight restart summary must permit question hydration from the history row")
const root = await mkdtemp(join(tmpdir(), "mako-identity-"))
const owner = new LiveConversations({
  root, appPath: root, driver: () => undefined, emit: () => {},
  history: async (path) => ({ ref: { ...original, path }, entries: [], start: 0, total: 0, hasEarlier: false }),
})
try {
  const first = await owner.capture(randomUUID(), original.path)
  const second = await owner.capture(randomUUID(), alias.path)
  assert.equal(second.session.id, first.session.id, "Host capture cannot create a second journal for an account alias")
  assert.equal(owner.summaries().length, 1)
} finally {
  owner.stop()
  await rm(root, { recursive: true, force: true })
}
console.log("Session identity: account aliases, provider isolation, completed activity, one rail row, binding changes, and host capture verified")
