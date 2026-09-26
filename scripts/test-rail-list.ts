import assert from "node:assert/strict"
import type { ThreadRef } from "@mako/sessions"
import { THREAD_LIST_CAP, threadList } from "../electron/contracts/thread-list.ts"
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
console.log("Rail list: pushes past the cap, a displacing new session and a focus reload agree on rows and folder counts")
