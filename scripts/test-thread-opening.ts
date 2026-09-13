import assert from "node:assert/strict"
import {
  createMakoBridge,
  type ThreadPage,
  type ThreadRef,
} from "../electron/shared.ts"
import {
  loadThreadBlock,
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
threadViewingActions.closeViewer()
console.log(
  "Thread opening: exact draft/provider ownership, out-of-order results, readable failure state, explicit close and in-place block loading verified"
)
