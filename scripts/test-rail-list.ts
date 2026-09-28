import assert from "node:assert/strict"
import type { ThreadRef } from "@mako/sessions"
import { THREAD_LIST_CAP, threadList, unlistedThreadSessions } from "../electron/contracts/thread-list.ts"
import { applyThreadRef, applyThreads, threadsStore } from "../src/state/threads.ts"

// A catalog larger than the rail's cap (the user's has 1,500 sessions). The
// catalog re-announcing old sessions must not grow the rail past what the
// next focus reload returns, or folder "More" counts jump on every focus.
const catalog: ThreadRef[] = Array.from({ length: 1500 }, (_, index) => ({
  harness: "codex",
  nativeId: `rail-${index}`,
  path: `/sessions/rail-${index}.jsonl`,
  cwd: index % 3 ? "/repo/flage" : "/repo/other",
  updatedAt: new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString(),
}))
const paths = () => threadsStore.get().threads.map((ref) => ref.path)
const reload = threadList(catalog).map((ref) => ref.path)
assert.equal(reload.length, THREAD_LIST_CAP)

applyThreads(threadList(catalog))
for (const ref of catalog.slice(0, 200)) applyThreadRef(ref)
assert.deepEqual(paths(), reload, "pushes of old sessions leave the rows a reload returns")

const fresh: ThreadRef = { ...catalog[0], nativeId: "rail-new", path: "/sessions/rail-new.jsonl", updatedAt: "2027-01-01T00:00:00.000Z" }
applyThreadRef(fresh)
assert.deepEqual(paths(), threadList([...catalog, fresh]).map((ref) => ref.path), "a new session displaces the oldest row, as a reload would")

const flage = () => threadsStore.get().threads.filter((ref) => ref.cwd === "/repo/flage").length
const before = flage()
applyThreads(threadList([...catalog, fresh]))
assert.equal(flage(), before, "a focus reload keeps the folder's count")

// A Thread whose first Session is older than the cap: its rows stay while any of them is within it.
const thread = "11111111-1111-4111-8111-111111111111"
const inThread = (ref: ThreadRef, session: string): ThreadRef => ({ ...ref, threadId: thread, sessionId: session })
const grouped = [...catalog.slice(1).map((ref) => ref), inThread(catalog[0], "old-session"), inThread({ ...catalog[1499], nativeId: "rail-newest", path: "/sessions/rail-newest.jsonl", updatedAt: "2027-02-01T00:00:00.000Z" }, "new-session")]
const listed = threadList(grouped).map((ref) => ref.path)
assert.equal(listed.length, THREAD_LIST_CAP + 1, "one row past the cap")
assert.ok(listed.includes("/sessions/rail-0.jsonl"), "the old Session of a listed Thread stays in the rail")
applyThreads(threadList(grouped))
applyThreadRef(inThread(catalog[0], "old-session"))
assert.deepEqual(paths(), listed, "and pushes keep it, as a reload would")
assert.ok(!threadList(grouped.filter((ref) => ref.path !== "/sessions/rail-newest.jsonl")).some((ref) => ref.path === "/sessions/rail-0.jsonl"), "a Thread with no row within the cap isn't pulled in")
const hostListed = threadList(grouped.map((ref) => (ref.path === "/sessions/rail-0.jsonl" ? { ...ref, threadId: undefined } : ref)))
assert.deepEqual([...unlistedThreadSessions(hostListed, [{ id: thread, sessions: [{ id: "old-session" }, { id: "new-session" }] }, { id: "other", sessions: [{ id: "elsewhere" }] }])], ["old-session"], "the host finds a listed Thread's Session that the cap cut before placement")
console.log("Rail list: pushes past the cap, a displacing new session and a focus reload agree on rows and folder counts; a listed Thread keeps its older Sessions, and the host finds them")
// The window's stores keep timers alive.
process.exit(0)
