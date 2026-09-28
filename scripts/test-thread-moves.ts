import assert from "node:assert/strict"
import { mock } from "node:test"
import type { ThreadPage, ThreadRef } from "@mako/sessions"
import { auditSnapshot } from "./performance-audit-fixtures"

/**
 * A session whose record moves while it runs (Claude Code entering a
 * worktree files it under the worktree's project directory) stays the same
 * session on screen: the open view, its tab, its title and pin, its run, a
 * transcript tab and a live conversation all follow it to the new record,
 * whichever order the catalog reports the new record and the old one's
 * removal in.
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
const { applyThreadRef, applyThreadRemoved, applyThreads, threads, threadsStore } = await import("../src/state/threads")
const { acp, acpStore } = await import("../src/state/acp")
const { applyLiveSnapshot } = await import("../src/state/live-recovery")
const { threadTabsStore } = await import("../src/state/thread-tabs")
const { prefsStore, setPref } = await import("../src/state/prefs")
const { viewer, viewerStore } = await import("../src/state/viewer")
const { threadMoves } = await import("../src/state/thread-moves")
installMockBridge()

const shop = "/Users/you/shop"
const slug = "/Users/you/.claude/projects/-Users-you-shop"
const worktreeSlug = (name: string) => `${slug}--claude-worktrees-${name}`
const at = (second: number) => new Date(Date.UTC(2026, 8, 28, 3, 0, second)).toISOString()
const claude = (nativeId: string, path: string, second: number, extra: Partial<ThreadRef> = {}): ThreadRef => ({ harness: "claude", nativeId, path, cwd: shop, title: `Session ${nativeId}`, updatedAt: at(second), bytes: second * 100, ...extra })
const page = (ref: ThreadRef, texts: string[]): ThreadPage => ({ ref, entries: texts.map((text) => ({ kind: "user", text })), start: 0, total: texts.length, hasEarlier: false, checkpoint: ref.bytes })

const records = new Map<string, ThreadPage>()
const pageReads = mock.method(getMako(), "pageThread", async (path: string) => records.get(path) ?? null)
const follows = mock.method(getMako(), "followThread", async () => {})
mock.method(getMako(), "previewThread", async () => null)
mock.method(getMako(), "resolveOwner", async () => null)
mock.method(getMako(), "threadRun", async () => null)
mock.method(getMako(), "transcriptDocument", async () => ({ markdown: "# t", title: "t", harness: "claude" }))

// Nothing moves on a relist.
const quiet = [claude("q1", `${slug}/q1.jsonl`, 1), claude("q2", `${slug}/q2.jsonl`, 2)]
assert.deepEqual(threadMoves(quiet, quiet.map((ref) => ({ ...ref, bytes: 999 }))), [], "a relist moves nothing")
assert.deepEqual(threadMoves([], quiet), [], "a first list moves nothing")

// Two stores under one native id are two sessions (a Cursor chat continued by the CLI into chats/).
const store = { harness: "cursor", nativeId: "c1", path: "/Users/you/.cursor/projects/x/agent-transcripts/c1.jsonl", updatedAt: at(3) }
const chats = { ...store, path: "/Users/you/.cursor/chats/h/c1/store.db", identity: "chats:c1", updatedAt: at(4) }
assert.deepEqual(threadMoves([store], [store, chats]), [], "a second store under the same id is not a move")

async function watchMove(nativeId: string, order: "added-first" | "removed-first") {
  const from = claude(nativeId, `${slug}/${nativeId}.jsonl`, 10)
  applyThreads([...threadsStore.get().threads, from])
  records.set(from.path, page(from, ["fix the flaky test"]))
  await threads.view(from)
  assert.equal(threadsStore.get().viewing?.ref.path, from.path)
  setPref("titleOverrides", { ...prefsStore.get().titleOverrides, [from.path]: `Renamed ${nativeId}` })
  setPref("pinnedThreads", [from.path, ...prefsStore.get().pinnedThreads])
  await viewer.openTranscript({ path: from.path }, "Transcript")

  const to = claude(nativeId, `${worktreeSlug(nativeId)}/${nativeId}.jsonl`, 20, { currentCwd: `${shop}/.claude/worktrees/${nativeId}` })
  records.delete(from.path)
  records.set(to.path, page(to, ["fix the flaky test", "entered the worktree"]))
  const readsBefore = pageReads.mock.callCount()
  if (order === "added-first") {
    applyThreadRef(to)
    applyThreadRemoved(from.path)
  } else {
    applyThreadRemoved(from.path)
    assert.equal(threadsStore.get().viewing?.ref.path, from.path, "the removal alone leaves the view where it is")
    applyThreads([...threadsStore.get().threads, claude("other", `${slug}/other-${nativeId}.jsonl`, 12)])
    applyThreadRef(to)
  }
  await tick()
  await tick()

  const state = threadsStore.get()
  assert.deepEqual(state.threads.filter((ref) => ref.nativeId === nativeId).map((ref) => ref.path), [to.path], `${order}: one row, at the new record`)
  assert.equal(state.viewing?.ref.path, to.path, `${order}: the open view follows the session`)
  assert.deepEqual(state.viewing?.entries.map((entry) => entry.kind === "user" ? entry.text : ""), ["fix the flaky test", "entered the worktree"], `${order}: and reads it where it now lives`)
  assert.equal(state.opening, null)
  assert.ok(pageReads.mock.calls.slice(readsBefore).every((call) => call.arguments[0] === to.path), `${order}: the old record is not read again`)
  assert.equal(follows.mock.calls.at(-1)?.arguments[0], to.path, `${order}: new entries are followed from the new record`)
  assert.equal(follows.mock.calls.at(-1)?.arguments[1], to.bytes)
  assert.ok(threadTabsStore.get().tabs.includes(to.path) && !threadTabsStore.get().tabs.includes(from.path), `${order}: the tab follows`)
  assert.equal(prefsStore.get().titleOverrides[to.path], `Renamed ${nativeId}`, `${order}: the rename follows`)
  assert.equal(prefsStore.get().titleOverrides[from.path], undefined)
  assert.equal(prefsStore.get().pinnedThreads[0], to.path, `${order}: the pin follows, in its place`)
  assert.ok(!prefsStore.get().pinnedThreads.includes(from.path))
  const transcript = Object.values(viewerStore.get().documents).find((document) => document.kind === "transcript" && document.title !== undefined && document.transcript?.path !== undefined && document.transcript.path.includes(nativeId))
  assert.equal(transcript?.transcript?.path, to.path, `${order}: the transcript tab follows`)
}

await watchMove("s1", "added-first")
await watchMove("s2", "removed-first")

// A Session whose read failed is still described by its newest row: the composer reads where it works from it.
const failed = claude("s6", `${slug}/s6.jsonl`, 50)
applyThreads([...threadsStore.get().threads, failed])
threadsStore.set({ viewing: null, opening: { kind: "failed", ref: failed, error: "unreadable" } })
applyThreadRef({ ...failed, updatedAt: at(51), currentCwd: `${shop}/.claude/worktrees/s6` })
assert.equal(threadsStore.get().opening?.ref.currentCwd, `${shop}/.claude/worktrees/s6`, "a failed open takes the newest row")
assert.equal(threadsStore.get().opening?.kind, "failed")
threadsStore.set({ opening: null })

// A live conversation Mako drives follows its record, so the composer sees the
// worktree it entered and a later resume names a file that exists.
const liveSnapshots = new Map<string, ReturnType<typeof auditSnapshot>>()
const binds = mock.method(getMako(), "liveBind", async (id: string, path: string) => ({ ...liveSnapshots.get(id)!, threadPath: path }))
async function driveMove(nativeId: string, order: "added-first" | "removed-first") {
  const livePath = `${slug}/${nativeId}.jsonl`
  const base = auditSnapshot(1, "claude")
  const snapshot = { ...base, threadPath: livePath, session: { ...base.session, id: `live-${nativeId}`, nativeId, status: "running" as const } }
  liveSnapshots.set(snapshot.session.id, snapshot)
  applyThreads([...threadsStore.get().threads, claude(nativeId, livePath, 40)])
  applyLiveSnapshot(snapshot)
  const key = snapshot.session.id
  const bindsBefore = binds.mock.callCount()
  acp.bindThreads(threadsStore.get().threads)
  assert.equal(binds.mock.callCount(), bindsBefore, `${order}: a bound conversation whose record is listed stays bound`)
  const moved = claude(nativeId, `${worktreeSlug(nativeId)}/${nativeId}.jsonl`, 41, { currentCwd: `${shop}/.claude/worktrees/${nativeId}` })
  if (order === "added-first") {
    applyThreadRef(moved)
    acp.bindThreads([moved])
    applyThreadRemoved(livePath)
    acp.bindThreads(threadsStore.get().threads)
  } else {
    applyThreadRemoved(livePath)
    acp.bindThreads(threadsStore.get().threads)
    applyThreadRef(moved)
    acp.bindThreads([moved])
  }
  await tick()
  assert.deepEqual(binds.mock.calls.slice(bindsBefore).map((call) => call.arguments), [[key, moved.path]], `${order}: the conversation rebinds to the moved record once`)
  const conversation = acpStore.get().conversations[key]
  assert.equal(conversation?.kind === "live" ? conversation.threadPath : undefined, moved.path)
  assert.ok(threadsStore.get().working[moved.path], `${order}: its row shows it working`)
}
await driveMove("s4", "added-first")
await driveMove("s5", "removed-first")

// It never jumps to a second store that shares its native id.
const cursorBase = auditSnapshot(1, "cursor")
const cursorLive = { ...cursorBase, threadPath: store.path, session: { ...cursorBase.session, id: "cursor-live", nativeId: "c1", status: "ready" as const } }
liveSnapshots.set(cursorLive.session.id, cursorLive)
applyThreads([...threadsStore.get().threads, store])
applyLiveSnapshot(cursorLive)
const bindsBefore = binds.mock.callCount()
applyThreadRef(chats)
acp.bindThreads([chats])
await tick()
assert.equal(binds.mock.callCount(), bindsBefore, "a conversation bound to a listed store keeps it")

console.log("Thread moves: the open view, tab, title, pin, transcript tab and a live conversation's binding follow a moved record in either event order; relists and sibling stores move nothing")
