import assert from "node:assert/strict"
import { mock } from "node:test"
import type { ThreadPage, ThreadRef } from "@mako/sessions"
import type { LiveSnapshot } from "@mako/host/contracts/live-conversations"
import { auditSnapshot } from "./performance-audit-fixtures"

/**
 * A conversation moved to another harness stays there. Coming back to it
 * from its row, whichever of its native records the row shows (the first
 * harness's record keeps changing while its background work settles), opens
 * it on the harness it was moved to, sends there, and never reaches back to
 * the harness it left or opens another session with the whole conversation
 * replayed.
 */

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
const saved = new Map<string, string>()
Object.defineProperty(globalThis, "window", { value: {}, configurable: true })
Object.assign(globalThis, {
  localStorage: {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
    removeItem: (key: string) => saved.delete(key),
  },
})
const { installMockBridge } = await import("../src/dev/mock-bridge")
const { getMako } = await import("../src/lib/bridge")
const { applyThreads, threads, threadsStore } = await import("../src/state/threads")
const { acp, acpStore, acpForThread } = await import("../src/state/acp")
const { applyLiveSnapshot } = await import("../src/state/live-recovery")
const { replaceAcpConversation, removeAcpConversation } = await import("../src/state/acp-state")
const { fixtureHarnesses } = await import("../src/dev/harness-fixtures")
installMockBridge()
threadsStore.set({ descriptors: fixtureHarnesses })

const cwd = "/Users/you/shop"
const claudePath = "/Users/you/.claude/projects/-Users-you-shop/c1.jsonl"
const cursorPath = "/Users/you/.mako/cursor-sdk/agents/agent-k1/store.db"
const claudeRow: ThreadRef = { harness: "claude", nativeId: "c1", path: claudePath, cwd, title: "Shop", updatedAt: "2026-10-13T07:04:41.000Z", sessionId: "s1", threadId: "t1" }
const otherRow: ThreadRef = { harness: "codex", nativeId: "x1", path: "/Users/you/.codex/sessions/x1.jsonl", cwd, title: "Other", updatedAt: "2026-10-13T07:00:00.000Z" }
const page = (ref: ThreadRef): ThreadPage => ({ ref, entries: [{ kind: "user", text: "hello" }], start: 0, total: 1, hasEarlier: false, checkpoint: 1 })

const base = auditSnapshot(1, "cursor")
const claudeBinding = { id: "claude-binding", provider: "claude", nativeId: "c1", path: claudePath, coveredBlocks: 2, includesBase: true }
const cursorBinding = { id: "cursor-binding", provider: "cursor", nativeId: "k1", path: cursorPath, coveredBlocks: 0, includesBase: true }
const moved: LiveSnapshot = {
  ...base,
  threadPath: cursorPath,
  sessionId: "s1",
  threadId: "t1",
  session: { ...base.session, id: "conversation", harness: "cursor", nativeId: "k1", cwd, status: "ready" },
  requests: base.requests.map((request) => ({ ...request, status: "completed" as const })),
  control: { activeBindingId: cursorBinding.id, bindings: [claudeBinding, cursorBinding], transfers: [], merges: [] },
}

mock.method(getMako(), "pageThread", async (path: string) => (path === otherRow.path ? page(otherRow) : page(claudeRow)))
mock.method(getMako(), "previewThread", async () => null)
mock.method(getMako(), "followThread", async () => {})
mock.method(getMako(), "unfollowThread", async () => {})
mock.method(getMako(), "threadRun", async () => null)
mock.method(getMako(), "liveRead", async () => { throw new Error("Unknown Mako host method") })
mock.method(getMako(), "liveSnapshot", async () => moved)
// The host names the owner of the row's record and, as it always has, the binding that record is.
mock.method(getMako(), "resolveOwner", async (path: string) =>
  path === claudePath ? { transport: "attached", provider: "claude", conversationId: "conversation", snapshot: moved, bindingId: claudeBinding.id } : null)
const prompts = mock.method(getMako(), "livePrompt", async () => moved)
const continues = mock.method(getMako(), "liveContinue", async () => moved)
const transfers = mock.method(getMako(), "liveTransfer", async () => moved)

applyThreads([claudeRow, otherRow])

function reply() {
  const conversation = acpStore.get().conversations.conversation
  return conversation?.replyBindingId
}

async function openFromRow(label: string) {
  await threads.view(otherRow)
  await tick()
  await threads.view(claudeRow)
  await tick()
  await tick()
  assert.equal(acpStore.get().activeKey, "conversation", `${label}: the row opens its conversation`)
  assert.equal(threadsStore.get().composerHarness, "cursor", `${label}: the composer stays on the harness it was moved to`)
  assert.equal(reply(), undefined, `${label}: a reply goes where the conversation is, not to the record the row shows`)
  assert.equal(threadsStore.get().viewing, null, `${label}: the live conversation is on screen, not the first harness's record`)
}

// A conversation this renderer knows in full.
applyLiveSnapshot(moved)
await openFromRow("hydrated")
await openFromRow("opened again")

// After a restart the renderer knows it only by its summary: no bindings, its records' paths.
replaceAcpConversation("conversation", {
  kind: "live",
  key: "conversation",
  draftKey: "conversation",
  session: moved.session,
  harness: "cursor",
  cwd,
  title: "Shop",
  nativePaths: [claudePath, cursorPath],
  threadPath: cursorPath,
  hydrated: false,
  createdAt: 1,
  updatedAt: 1,
  blocks: [],
  queued: [],
  hiddenUserPrompt: null,
  permission: null,
  sending: false,
  canceling: false,
})
assert.equal(acpForThread(acpStore.get(), claudeRow)?.key, "conversation", "a summary is found by any of its records, whatever harness wrote it")
await openFromRow("after a restart")

// A conversation this window doesn't hold at all (another host's) is adopted through its owner.
removeAcpConversation("conversation")
await openFromRow("adopted from its owner")

// Sending goes to the active session as a plain prompt: no transfer, no reach back.
const before = { prompts: prompts.mock.callCount(), continues: continues.mock.callCount(), transfers: transfers.mock.callCount() }
assert.equal(await acp.send("Carry on"), true)
await tick()
assert.equal(prompts.mock.callCount(), before.prompts + 1, "the message is a prompt to the active session")
assert.equal(continues.mock.callCount(), before.continues, "it never targets the harness the conversation left")
assert.equal(transfers.mock.callCount(), before.transfers, "and never opens another session")

// A reply chosen for an earlier record holds until it is the active one, then lapses.
applyLiveSnapshot(moved, claudeBinding.id)
assert.equal(reply(), claudeBinding.id, "replying from the first harness's history targets its session")
applyLiveSnapshot({ ...moved, revision: moved.revision + 1, control: { ...moved.control!, activeBindingId: claudeBinding.id } })
assert.equal(reply(), undefined, "once that session is active the target has nothing left to say")
// And one left behind by a move elsewhere never pulls the conversation back.
applyLiveSnapshot({ ...moved, revision: moved.revision + 2, control: { ...moved.control!, activeBindingId: claudeBinding.id } }, claudeBinding.id)
applyLiveSnapshot({ ...moved, revision: moved.revision + 3 })
assert.equal(reply(), undefined, "a move to another binding drops a target carried from before it")

// A move from the viewer to the harness the conversation is already on is a reply, not a switch.
mock.method(getMako(), "liveCapture", async () => ({ ...moved, revision: moved.revision + 4 }))
const movesBefore = { prompts: prompts.mock.callCount(), transfers: transfers.mock.callCount() }
assert.equal(await threads.moveAndSend(claudeRow, "cursor", "Keep going"), true)
await tick()
assert.equal(transfers.mock.callCount(), movesBefore.transfers, "no session is opened on the harness it is already on")
assert.equal(prompts.mock.callCount(), movesBefore.prompts + 1, "the message goes on in its session")

console.log("Harness switch return: a moved conversation reopens from any of its records on the harness it moved to, after a restart too; replies go to its active session; a chosen earlier record lapses once reached or left; a move to its own harness is a reply")
