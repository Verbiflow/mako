import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import type { ThreadGroup } from "../electron/contracts/thread-groups"
import { SessionIdSchema, ThreadIdSchema } from "../electron/contracts/thread-identity"
import type { ThreadRef } from "../src/lib/types"

/**
 * Two chats side by side: which Session each pane shows, where focus and the
 * composer go, and what closing a pane leaves. Production stores, no host;
 * the test stands in for a transcript landing by setting what is viewed.
 */

const saved = new Map<string, string>()
Object.assign(globalThis, {
  localStorage: {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
    removeItem: (key: string) => saved.delete(key),
  },
})

const { threadsStore } = await import("../src/state/thread-store")
const { threadGroupsStore } = await import("../src/state/thread-groups")
const { viewer, viewerStore } = await import("../src/state/viewer")
const { closeWorkbenchPane, engageWorkbenchPane, focusWorkbenchPane, openInPane, openTabInPane, takeComposerFocus, watchSessionPanes } = await import("../src/state/session-panes")
const { currentThreadTabs } = await import("../src/state/thread-sessions")

const thread = randomUUID()
const sessions = [randomUUID(), randomUUID(), randomUUID()]
const [first, second, third] = sessions
const refs: ThreadRef[] = sessions.map((sessionId, index) => ({
  harness: index === 1 ? "codex" : "claude",
  nativeId: `n${index}`,
  path: `/native/${index}.jsonl`,
  threadId: thread,
  sessionId,
}))
const group: ThreadGroup = {
  id: ThreadIdSchema.parse(thread),
  sessions: sessions.map((id) => ({ id: SessionIdSchema.parse(id), origin: "native", started: true })),
}
threadGroupsStore.set({ groups: { [thread]: group }, threadOf: Object.fromEntries(sessions.map((id) => [id, thread])) })
threadsStore.set({ threads: refs })
const stop = watchSessionPanes()

/** The host's transcript for `session` arriving: it is now what the window views. */
function lands(session: string) {
  const ref = refs.find((candidate) => candidate.sessionId === session)
  assert.ok(ref)
  threadsStore.set({ viewing: { ref, entries: [], pageStart: 0, totalEntries: 0, hasEarlier: false }, opening: null })
}

function layout() {
  const state = viewerStore.get()
  return state.panes.map((pane) => ({ id: pane.id, shows: pane.session?.tab ?? "active", focused: pane.id === state.focusedPaneId }))
}

function tab(session: string) {
  const found = currentThreadTabs(thread).find((candidate) => candidate.id === session)
  assert.ok(found, `tab ${session}`)
  return found
}

lands(first)

// The tab on screen dragged right: it moves there with focus, and the pane
// it left shows its neighbour.
assert.equal(openInPane(tab(first), thread, "right"), true)
assert.deepEqual(layout(), [
  { id: "primary", shows: second, focused: false },
  { id: "secondary", shows: "active", focused: true },
], "the dragged tab takes the new pane and focus")
assert.equal(viewerStore.get().split, "right")

// Pressing in the other pane moves focus there. Until its transcript is the
// active one, it keeps showing it from its binding, and the pane it left
// holds on to what it showed.
focusWorkbenchPane("primary")
assert.deepEqual(layout(), [
  { id: "primary", shows: second, focused: true },
  { id: "secondary", shows: first, focused: false },
], "focus moves; both panes keep their Sessions")
lands(second)
assert.deepEqual(layout(), [
  { id: "primary", shows: "active", focused: true },
  { id: "secondary", shows: first, focused: false },
], "the binding goes once the active conversation catches up")

// A tab clicked in the focused pane of two opens there.
openTabInPane("primary", thread, tab(third))
assert.deepEqual(layout()[0], { id: "primary", shows: third, focused: true })
lands(third)
assert.deepEqual(layout()[0], { id: "primary", shows: "active", focused: true })

// A press on a resting composer asks for the caret once, for the composer that mounts next.
assert.equal(takeComposerFocus(), false)
engageWorkbenchPane("primary")
assert.equal(takeComposerFocus(), true)
assert.equal(takeComposerFocus(), false, "a later composer doesn't steal the caret")

// A rail click while a switch is still on its way wins over the switch.
focusWorkbenchPane("secondary")
assert.deepEqual(layout()[1], { id: "secondary", shows: first, focused: true })
lands(second)
assert.deepEqual(layout()[1], { id: "secondary", shows: "active", focused: true }, "you went elsewhere: the focused pane follows")

// With two panes, dropping on one shows the tab there. Dropping the Session
// the other pane shows swaps them.
viewer.bindPanes({ primary: { thread, tab: third } }, "secondary")
openInPane(tab(second), thread, "left")
assert.deepEqual(layout(), [
  { id: "primary", shows: "active", focused: true },
  { id: "secondary", shows: third, focused: false },
], "dropping the other pane's Session swaps the two; it is already the active one")

// Closing the focused pane leaves the other showing what it showed.
closeWorkbenchPane("primary")
assert.deepEqual(layout(), [{ id: "secondary", shows: third, focused: true }])
lands(third)
assert.deepEqual(layout(), [{ id: "secondary", shows: "active", focused: true }], "one pane again, following the rail")

// A lone Session can't be split beside itself.
const lone = randomUUID()
const loneThread = randomUUID()
refs.push({ harness: "grok", nativeId: "lone", path: "/native/lone.jsonl", threadId: loneThread, sessionId: lone })
threadGroupsStore.set({
  groups: { ...threadGroupsStore.get().groups, [loneThread]: { id: ThreadIdSchema.parse(loneThread), sessions: [{ id: SessionIdSchema.parse(lone), origin: "native", started: true }] } },
  threadOf: { ...threadGroupsStore.get().threadOf, [lone]: loneThread },
})
threadsStore.set({ threads: [...refs] })
lands(lone)
const loneTab = currentThreadTabs(loneThread).find((candidate) => candidate.id === lone)
assert.ok(loneTab)
assert.equal(openInPane(loneTab, loneThread, "right"), false, "nothing to leave behind")
assert.equal(viewerStore.get().panes.length, 1)

stop()
console.log("session panes: drag out, focus, caret, catch-up, rail click, swap, close, lone session")
