import { registeredHarnessIds } from "./registered-harnesses.ts"
import assert from "node:assert/strict"
import { createMakoBridge } from "@mako/host/contracts/renderer-bridge"
import { type ThreadPage, type ThreadRef } from "@mako/host/contracts/conversation-session"
import {
  freshViewedRef,
  loadThreadEntry,
  openingHoldsSend,
  recoverThreadReader,
  rereadFailedOpening,
  threadViewingActions,
} from "../src/state/thread-viewing.ts"
import { threadsStore } from "../src/state/thread-store.ts"
import { draftText, rememberDraft } from "../src/state/drafts.ts"

const pending = new Map<
  string,
  ReturnType<typeof Promise.withResolvers<ThreadPage | null>>
>()
const follows: string[] = []
const entryAsks: unknown[] = []
/** Replies reach the bridge decoded from JSON, as the web transport's do, typed only by the bridge method that asked. */
const overWire = <Value>(value: Value) => JSON.parse(JSON.stringify(value))
const bridge = createMakoBridge({
  invoke: async (channel, ...args) => {
    if (channel === "mako:thread-entry") {
      entryAsks.push(args)
      await new Promise((resolve) => setTimeout(resolve, 5))
      return overWire({ type: "tool", id: "call-big", name: "exec", status: "completed", input: "cat big", output: "whole" })
    }
    if (channel === "mako:thread-page") {
      const key = String(args[0])
      const request = Promise.withResolvers<ThreadPage | null>()
      pending.set(key, request)
      return overWire(await request.promise)
    }
    if (channel === "mako:thread-follow") follows.push(String(args[0]))
    return overWire(null)
  },
  onEvent: () => () => {},
  onTerminalEvent: () => () => {},
  pathForFile: () => null,
  resolveFileUrl: (url) => url,
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
// the entry once, by its id, and the whole entry replaces the head in place;
// the projection restarts at that entry only.
const paged: ThreadRef = { harness: "codex", nativeId: "big", path: "/big" }
const head = {
  type: "tool" as const,
  id: "call-big",
  name: "exec",
  status: "completed",
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
    { type: "user", id: "u40", text: "read it" },
    { type: "text", id: "a41", text: "Reading." },
    head,
  ],
  start: 40,
  total: 43,
  hasEarlier: true,
})
await pagedRead
const shown = threadsStore.get().viewing
assert.equal(shown?.pageStart, 40)
await Promise.all([
  loadThreadEntry(paged.path, "call-big"),
  loadThreadEntry(paged.path, "call-big"),
])
assert.deepEqual(entryAsks, [[paged.path, "call-big"]], "one ask per entry")
const swapped = threadsStore.get().viewing
assert.ok(swapped)
assert.deepEqual(swapped.entries[2], { type: "tool", id: "call-big", name: "exec", status: "completed", input: "cat big", output: "whole" })
assert.equal(swapped.entries[1], shown?.entries[1], "other entries keep identity")
assert.equal(swapped.entries[0], shown?.entries[0])
assert.equal(swapped.streamReplaceFrom, 2, "the projection restarts at the entry that changed")
assert.equal(swapped.streamRevision, (shown?.streamRevision ?? 0) + 1)
// Every provider uses the same recovery path; earlier loaded pages and drafts survive.
for (const harness of registeredHarnessIds()) {
  const ref = { ...paged, harness, path: `/recovery/${harness}` }
  threadsStore.set({ viewing: { ref, entries: [{type:"user",id:"old",text:"old"}], pageStart: 40, totalEntries: 41, hasEarlier: true } })
  rememberDraft(ref.path, "Unsent recovery draft")
  pending.delete(ref.path)
  const recovered = recoverThreadReader(ref.path)
  await waitFor(ref.path)
  const recent = pending.get(ref.path)!
  pending.delete(ref.path)
  recent.resolve({ref,checkpoint:222,entries:[{type:"user",id:"new",text:"new during outage"}],start:42,total:43,hasEarlier:true})
  await waitFor(ref.path)
  pending.get(ref.path)!.resolve({ref,checkpoint:222,entries:[{type:"user",id:"earlier",text:"earlier"},{type:"user",id:"old",text:"old"}],start:40,total:43,hasEarlier:true})
  await recovered
  assert.deepEqual(threadsStore.get().viewing?.entries.map(e=>e.type === "user" ? e.text : ""),["earlier","old","new during outage"])
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
  tail.resolve({ ref: changingRef, checkpoint: attempt, entries: [{ type: "user", id: "tail", text: "unstable tail" }], start: 42, total: 43, hasEarlier: true })
  await waitFor(changingRef.path)
  const earlier = pending.get(changingRef.path)!
  pending.delete(changingRef.path)
  earlier.resolve({ ref: changingRef, checkpoint: attempt + 10, entries: [{ type: "user", id: "different", text: "different snapshot" }], start: 40, total: 43, hasEarlier: true })
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

// A conversation on screen takes a send while its fresh read lands: the last
// read painted from the cache is the target. Only nothing on screen yet, or
// a read that failed, holds a send, and a failed read is read again once the
// host is back.
{
  const held: ThreadRef = { harness: "claude", nativeId: "held", path: "/held" }
  pending.delete(held.path)
  const firstOpen = threadViewingActions.view(held)
  await waitFor(held.path)
  assert.equal(openingHoldsSend(threadsStore.get())?.kind, "loading", "nothing of it is on screen yet")
  pending.get(held.path)!.resolve({ ref: held, entries: [{ type: "user", id: "u", text: "hello" }], start: 0, total: 1, hasEarlier: false })
  await firstOpen
  threadViewingActions.closeViewer()

  pending.delete(held.path)
  await threadViewingActions.view(held)
  await waitFor(held.path)
  assert.equal(threadsStore.get().opening?.kind, "loading", "the fresh read is still under way")
  assert.equal(threadsStore.get().viewing?.ref.path, held.path, "the last read is on screen")
  assert.equal(openingHoldsSend(threadsStore.get()), null, "and it takes a send now")
  const confirmed = freshViewedRef(held.path, 5_000)
  const fresh = { ...held, copyOnly: true as const }
  pending.get(held.path)!.resolve({ ref: fresh, entries: [{ type: "user", id: "u", text: "hello" }], start: 0, total: 1, hasEarlier: false })
  assert.deepEqual(await confirmed, fresh, "a send that waits gets the ref the fresh read brought")
  assert.equal(await freshViewedRef(held.path, 5_000), threadsStore.get().viewing?.ref, "a settled view answers at once")
  assert.equal(await freshViewedRef("/elsewhere", 5_000), null, "another conversation's view answers nothing")

  pending.delete(held.path)
  await threadViewingActions.view(held)
  await waitFor(held.path)
  const failing = freshViewedRef(held.path, 5_000)
  pending.get(held.path)!.reject(new Error("The host stopped answering"))
  assert.equal(await failing, null, "a failed read gives a waiting send nothing to go by")
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(openingHoldsSend(threadsStore.get()), { kind: "failed", ref: held, error: "The host stopped answering" }, "a failed read holds a send with its reason")

  pending.delete(held.path)
  rereadFailedOpening()
  await waitFor(held.path)
  pending.get(held.path)!.resolve({ ref: held, entries: [{ type: "user", id: "u", text: "hello" }], start: 0, total: 1, hasEarlier: false })
  for (let i = 0; i < 30 && threadsStore.get().opening; i++) await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(threadsStore.get().opening, null, "after a reconnect the failed read is read again and the view settles")
  pending.delete(held.path)
  rereadFailedOpening()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(pending.has(held.path), false, "a settled view is not read again")
  threadViewingActions.closeViewer()
}
console.log(
  "Thread opening: exact draft/provider ownership, out-of-order results, readable failure state, explicit close, in-place entry loading, sends to a conversation on screen while it refreshes and a failed read read again on reconnect verified"
)
