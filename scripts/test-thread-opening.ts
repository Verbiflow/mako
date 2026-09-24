import assert from "node:assert/strict"
import {
  createMakoBridge,
  type ThreadPage,
  type ThreadRef,
} from "../electron/shared.ts"
import {
  loadThreadBlock,
  recoverThreadReader,
  threadViewingActions,
} from "../src/state/thread-viewing.ts"
import { threadsStore } from "../src/state/thread-store.ts"
import { draftText, rememberDraft } from "../src/state/drafts.ts"

const pending = new Map<
  string,
  ReturnType<typeof Promise.withResolvers<ThreadPage | null>>
>()
const follows: string[] = []
const blockAsks: unknown[] = []
const bridge = createMakoBridge({
  invoke: async (channel, ...args) => {
    if (channel === "mako:thread-block") {
      blockAsks.push(args)
      await new Promise((resolve) => setTimeout(resolve, 5))
      return { type: "tool", name: "exec", input: "cat big", output: "whole" }
    }
    if (channel === "mako:thread-page") {
      const key = String(args[0])
      const request = Promise.withResolvers<ThreadPage | null>()
      pending.set(key, request)
      return request.promise
    }
    if (channel === "mako:thread-follow") follows.push(String(args[0]))
    return null
  },
  onEvent: () => () => {},
  onTerminalEvent: () => () => {},
  pathForFile: () => null,
})
Object.assign(globalThis, { window: { mako: bridge } })
const first: ThreadRef = { harness: "claude", nativeId: "one", path: "/one" }
const second: ThreadRef = { harness: "grok", nativeId: "two", path: "/two" }
const waitFor = async (path: string) => {
  for (let i = 0; i < 30 && !pending.has(path); i++)
    await new Promise((resolve) => setTimeout(resolve, 5))
  assert.ok(pending.has(path), "Page read must start")
}
const firstRead = threadViewingActions.view(first)
await waitFor(first.path)
assert.deepEqual(threadsStore.get().opening, { kind: "loading", ref: first })
assert.equal(threadsStore.get().composerHarness, "claude")
rememberDraft(first.path, "Keep this paragraph while the thread loads")
const secondRead = threadViewingActions.view(second)
await waitFor(second.path)
pending
  .get(first.path)
  ?.resolve({ ref: first, entries: [], start: 0, total: 0, hasEarlier: false })
await firstRead
assert.equal(
  threadsStore.get().opening?.ref.path,
  second.path,
  "A late first response cannot replace the selected conversation"
)
pending
  .get(second.path)
  ?.reject(new Error("Native store is temporarily unavailable"))
await secondRead
assert.deepEqual(threadsStore.get().opening, {
  kind: "failed",
  ref: second,
  error: "Native store is temporarily unavailable",
})
assert.equal(threadsStore.get().composerHarness, "grok")
assert.equal(
  draftText(first.path),
  "Keep this paragraph while the thread loads"
)
assert.deepEqual(
  follows,
  [],
  "Neither a superseded nor a failed read starts following"
)
pending.delete(second.path)
const retry = threadViewingActions.view(second)
await waitFor(second.path)
pending
  .get(second.path)
  ?.resolve({ ref: second, entries: [], start: 0, total: 0, hasEarlier: false })
await retry
assert.equal(threadsStore.get().opening, null)
assert.equal(threadsStore.get().viewing?.ref.path, second.path)
assert.deepEqual(
  follows,
  [second.path],
  "A successful retry follows exactly the requested session"
)
pending.delete(second.path)
await threadViewingActions.view(second)
await waitFor(second.path)
pending.get(second.path)?.resolve(null)
await new Promise((resolve) => setTimeout(resolve, 0))
assert.equal(
  threadsStore.get().opening?.kind,
  "failed",
  "A missing cached session must settle out of loading"
)
assert.equal(
  threadsStore.get().viewing?.ref.path,
  second.path,
  "Saved messages remain readable after refresh failure"
)
threadViewingActions.closeViewer()
assert.equal(threadsStore.get().opening, null)

// A page carries the head of a long tool output. Opening the row asks for
// the block once, by its address in the thread, and the whole block replaces
// the head in place; the projection restarts at that entry only.
const paged: ThreadRef = { harness: "codex", nativeId: "big", path: "/big" }
const head = {
  type: "tool" as const,
  name: "exec",
  input: "cat big",
  output: "head",
  outputLength: 41_394,
}
pending.delete(paged.path)
const pagedRead = threadViewingActions.view(paged)
await waitFor(paged.path)
pending.get(paged.path)?.resolve({
  ref: paged,
  entries: [
    { kind: "user", text: "read it" },
    { kind: "assistant", blocks: [{ type: "text", text: "Reading." }, head] },
  ],
  start: 40,
  total: 42,
  hasEarlier: true,
})
await pagedRead
const shown = threadsStore.get().viewing
assert.equal(shown?.pageStart, 40)
await Promise.all([
  loadThreadBlock(paged.path, { entry: 41, block: 1 }),
  loadThreadBlock(paged.path, { entry: 41, block: 1 }),
])
assert.deepEqual(blockAsks, [[paged.path, { entry: 41, block: 1 }]], "one ask per block")
const swapped = threadsStore.get().viewing
assert.ok(swapped && swapped.entries[1]?.kind === "assistant")
assert.deepEqual(swapped.entries[1].blocks[1], {
  type: "tool",
  name: "exec",
  input: "cat big",
  output: "whole",
})
assert.equal(swapped.entries[1].blocks[0], shown?.entries[1]?.kind === "assistant" ? shown.entries[1].blocks[0] : undefined, "other blocks keep identity")
assert.equal(swapped.entries[0], shown?.entries[0], "other entries keep identity")
assert.equal(swapped.streamReplaceFrom, 1, "the projection restarts at the entry that changed")
assert.equal(swapped.streamRevision, (shown?.streamRevision ?? 0) + 1)
// Every provider uses the same recovery path; earlier loaded pages and drafts survive.
for (const harness of ["claude", "codex", "cursor", "grok", "devin", "opencode"]) {
  const ref = { ...paged, harness, path: `/recovery/${harness}` }
  threadsStore.set({ viewing: { ref, entries: [{kind:"user",text:"old"}], pageStart: 40, totalEntries: 41, hasEarlier: true } })
  rememberDraft(ref.path, "Unsent recovery draft")
  pending.delete(ref.path)
  const recovered = recoverThreadReader(ref.path)
  await waitFor(ref.path)
  const recent = pending.get(ref.path)!
  pending.delete(ref.path)
  recent.resolve({ref,checkpoint:222,entries:[{kind:"user",text:"new during outage"}],start:42,total:43,hasEarlier:true})
  await waitFor(ref.path)
  pending.get(ref.path)!.resolve({ref,checkpoint:222,entries:[{kind:"user",text:"earlier"},{kind:"user",text:"old"}],start:40,total:43,hasEarlier:true})
  await recovered
  assert.deepEqual(threadsStore.get().viewing?.entries.map(e=>e.kind === "user" ? e.text : ""),["earlier","old","new during outage"])
  assert.equal(threadsStore.get().viewing?.pageStart,40)
  assert.equal(follows.at(-1),ref.path)
  assert.equal(draftText(ref.path),"Unsent recovery draft")
}
// A source rewritten between pages must not produce a mixed visible snapshot
// or an endless recovery loop. Keep the old readable history and expose retry.
const changingRef = threadsStore.get().viewing!.ref
const retained = threadsStore.get().viewing!
threadsStore.set({ viewing: { ...retained, loadingEarlier: true } })
pending.delete(changingRef.path)
const changing = recoverThreadReader(changingRef.path)
const followsBeforeChanging = follows.length
assert.equal(threadsStore.get().viewing?.loadingEarlier, false)
for (let attempt = 0; attempt < 3; attempt++) {
  await waitFor(changingRef.path)
  const tail = pending.get(changingRef.path)!
  pending.delete(changingRef.path)
  tail.resolve({ ref: changingRef, checkpoint: attempt, entries: [{ kind: "user", text: "unstable tail" }], start: 42, total: 43, hasEarlier: true })
  await waitFor(changingRef.path)
  const earlier = pending.get(changingRef.path)!
  pending.delete(changingRef.path)
  earlier.resolve({ ref: changingRef, checkpoint: attempt + 10, entries: [{ kind: "user", text: "different snapshot" }], start: 40, total: 43, hasEarlier: true })
}
await changing
assert.equal(threadsStore.get().viewing?.entries, retained.entries)
assert.equal(threadsStore.get().opening?.kind, "failed")
assert.equal(follows.length, followsBeforeChanging)
assert.equal(draftText(changingRef.path), "Unsent recovery draft")
const recoveryRef=threadsStore.get().viewing!.ref
pending.delete(recoveryRef.path)
const late = recoverThreadReader(recoveryRef.path)
await waitFor(recoveryRef.path)
threadViewingActions.closeViewer()
pending.get(recoveryRef.path)!.resolve({ref:recoveryRef,entries:[],start:0,total:0,hasEarlier:false})
const count=follows.length
await late
assert.equal(threadsStore.get().viewing,null)
assert.equal(follows.length,count,"a departed view never follows a late recovered snapshot")
threadViewingActions.closeViewer()
console.log(
  "Thread opening: exact draft/provider ownership, out-of-order results, readable failure state, explicit close and in-place block loading verified"
)
