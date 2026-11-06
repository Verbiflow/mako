import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import type { ThreadRef } from "../src/lib/types"
import type { AcpPresence } from "../src/state/acp-presence"
import { fixtureHarnesses } from "../src/dev/harness-fixtures"

/**
 * A Thread is one conversation (`docs/one-conversation.md`): the strip holds what's open across Threads, and follows
 * the screen. Production modules and components, no host.
 */

const saved = new Map<string, string>()
const storage = {
  getItem: (key: string) => saved.get(key) ?? null,
  setItem: (key: string, value: string) => saved.set(key, value),
  removeItem: (key: string) => saved.delete(key),
}
Object.assign(globalThis, { localStorage: storage })

const { renderToStaticMarkup } = await import("react-dom/server")
const { closeEntries, draftBecameThread, entryKey, keepActiveTab, openNextInOwnTab, openTabsStore, showInTabs } = await import("../src/state/open-tabs")
const { openTabsOf, sessionTabTitle, tabThread, threadSessionTabs } = await import("../src/state/thread-sessions")
const { discardSessionDraft, leaveSessionDraft, putSessionDraft, sessionDraftKey, threadDraftsStore } = await import("../src/state/thread-drafts")
const { threadArchiveKey } = await import("@mako/host/contracts/thread-lifecycle")
const { rememberDraft } = await import("../src/state/drafts")
const { ThreadTabList } = await import("../src/components/stage/thread-tabs")
const { TooltipProvider } = await import("../src/components/ui/tooltip")
const { threadsStore } = await import("../src/state/thread-store")
threadsStore.set({ descriptors: fixtureHarnesses })

interface Conversation { thread: string; session: string }
const conversation = (): Conversation => ({ thread: randomUUID(), session: randomUUID() })

function ref(at: Conversation, path: string, harness = "claude", title?: string): ThreadRef {
  return { harness, nativeId: path, path, title, threadId: at.thread, sessionId: at.session }
}

function presence(at: Conversation, key: string, title: string): AcpPresence {
  return { key, harness: "codex", cwd: "/work", title, threadId: at.thread, sessionId: at.session, status: "running", createdAt: 1 }
}

const reset = () => openTabsStore.set({ entries: [], active: undefined })
const keys = () => openTabsStore.get().entries.map(entryKey)
const [a, b, c, d] = [conversation(), conversation(), conversation(), conversation()]

// Reading down the rail leaves one tab: a Thread only looked at gives way to the next.
reset()
showInTabs(a)
showInTabs(b)
showInTabs(c)
assert.deepEqual(keys(), [c.thread], "a Thread looked at takes the tab of the one before it")
assert.equal(openTabsStore.get().active, c.thread)

// Typed into, it stays, and the next one opens beside it.
keepActiveTab()
showInTabs(d)
assert.deepEqual(keys(), [c.thread, d.thread], "a tab typed into stays")
showInTabs(a)
assert.deepEqual(keys(), [c.thread, a.thread], "and the one beside it is still a preview")

// A Thread already open is focused, however it's opened.
keepActiveTab()
showInTabs(c)
assert.deepEqual(keys(), [c.thread, a.thread], "opening what's open focuses it")
assert.equal(openTabsStore.get().active, c.thread)

// Asked for its own tab: a fork, a Fin, a Cmd-click. Beside the tab on screen, not at the end.
openNextInOwnTab()
showInTabs(b)
assert.deepEqual(keys(), [c.thread, b.thread, a.thread], "a tab of its own opens beside the one on screen")
showInTabs(d)
assert.deepEqual(keys(), [c.thread, b.thread, d.thread, a.thread], "and stays when the next Thread is looked at")

// What a Thread shows can change without it being another Thread: a move's fork, a cloud Thread's other conversation.
const moved = randomUUID()
showInTabs({ thread: b.thread, session: moved })
assert.deepEqual(keys(), [c.thread, b.thread, d.thread, a.thread], "one tab per Thread")
assert.deepEqual(openTabsStore.get().entries.find((entry) => entryKey(entry) === b.thread), { kind: "thread", thread: b.thread, session: moved, kept: true })

// Nothing of a Thread's on screen: the strip stays as it was.
showInTabs({})
showInTabs({ thread: a.thread })
assert.equal(openTabsStore.get().active, b.thread, "only a Thread's conversation has a tab")

// Closing a tab names only the tab.
closeEntries(new Set([b.thread]))
assert.deepEqual(keys(), [c.thread, d.thread, a.thread])
assert.equal(openTabsStore.get().active, undefined)

// A new Thread: its tab comes first, and its first send turns that tab into the Thread, where it stood.
reset()
showInTabs(a)
keepActiveTab()
const draft = { id: randomUUID(), thread: a.thread, cwd: "/work", title: "Auth" }
putSessionDraft(draft, true)
showInTabs({ draft })
assert.deepEqual(keys(), [a.thread, `draft:${a.thread}`], "a new Thread opens beside the one it came from")
showInTabs(c)
assert.deepEqual(keys(), [a.thread, `draft:${a.thread}`, c.thread], "and a Thread looked at doesn't take its tab")
draftBecameThread(a.thread, b)
assert.deepEqual(keys(), [a.thread, b.thread, c.thread], "its first send turns the tab into the Thread")
draftBecameThread(a.thread, b)
assert.deepEqual(keys(), [a.thread, b.thread, c.thread], "a repeated send doesn't open it twice")
discardSessionDraft(a.thread)

// A new Thread left empty goes; one with text stays, its text under its own key.
putSessionDraft(draft, true)
leaveSessionDraft()
assert.equal(threadDraftsStore.get().drafts[a.thread], undefined, "an empty new Thread goes when you leave it")
putSessionDraft(draft, true)
rememberDraft(sessionDraftKey(draft)!, "Check the auth flow")
leaveSessionDraft()
assert.equal(threadDraftsStore.get().drafts[a.thread]?.id, draft.id, "one with text stays")
assert.equal(threadDraftsStore.get().open, null)
discardSessionDraft(a.thread)

// The list across a reload.
reset()
showInTabs(a)
keepActiveTab()
const persisted = JSON.parse(saved.get("mako.open-tabs.v1") ?? "[]")
assert.deepEqual(persisted, [{ kind: "thread", ...a, kept: true }], "what's open is kept for the next launch")

// A Thread's conversations: its own rows, oldest first, an archived one gone unless on screen. Left whole, a cloud
// Thread still has two.
const other = conversation()
const whole = { thread: a.thread, session: randomUUID() }
const refs = [
  { ...ref(whole, "/s/later"), startedAt: "2026-11-02T00:00:00.000Z" },
  { ...ref(a, "/s/first"), startedAt: "2026-11-01T00:00:00.000Z" },
  ref(other, "/s/other"),
]
assert.deepEqual(threadSessionTabs({ thread: a.thread, refs, presences: [] }).map((tab) => tab.id), [a.session, whole.session])
const archived = new Set([threadArchiveKey({ kind: "file", path: "/s/first" })])
assert.deepEqual(threadSessionTabs({ thread: a.thread, refs, presences: [], archived }).map((tab) => tab.id), [whole.session], "an archived one is left out")
assert.deepEqual(threadSessionTabs({ thread: a.thread, refs, presences: [], archived, shown: a.session }).map((tab) => tab.id), [a.session, whole.session], "unless it's on screen")

// The strip drawn: across Threads, in the person's order, each by its conversation.
const entries = [
  { kind: "thread" as const, ...other },
  { kind: "thread" as const, ...whole },
  { kind: "draft" as const, place: b.thread },
  { kind: "thread" as const, ...d },
  { kind: "thread" as const, ...c },
]
const drafts = { [b.thread]: { id: randomUUID(), thread: b.thread, cwd: "/work", title: "Billing" } }
const drawn = openTabsOf({ entries, refs, presences: [presence(d, "live-d", "Live one")], drafts })
assert.deepEqual(drawn.map((tab) => tab.kind === "draft" ? "draft" : tab.id), [other.session, whole.session, "draft", d.session], "a tab whose Thread isn't listed yet waits; the others hold their order")
assert.deepEqual(drawn.map(tabThread), [other.thread, a.thread, b.thread, d.thread])
assert.equal(openTabsOf({ entries: [{ kind: "thread", thread: a.thread, session: randomUUID() }], refs, presences: [], drafts: {} })[0]?.id, a.session, "a conversation gone from its Thread falls back to the Thread's first")

// A tab says the Thread's name, the same as its rail row.
assert.equal(sessionTabTitle({ kind: "session", id: a.session, ref: ref(a, "/s/named", "claude", "From its agent") }), "From its agent")
assert.equal(sessionTabTitle({ kind: "draft", id: "x", draft }), "New thread")

const markup = renderToStaticMarkup(
  <TooltipProvider>
    <ThreadTabList tabs={drawn} here={{ thread: other.thread, session: other.session }} paneId="main" agentActive />
  </TooltipProvider>
)
assert.equal(markup.match(/role="tab"/g)?.length, 4, "a tab for each thing open")
assert.match(markup, /aria-label="Close /, "every tab closes")
assert.match(markup, /aria-label="Close new thread"/)
assert.match(markup, /data-add-session="new"/, "and `+` starts a new Thread here")
assert.doesNotMatch(markup, /Session/, "a tab says nothing of Sessions")
const resting = renderToStaticMarkup(
  <TooltipProvider>
    <ThreadTabList tabs={drawn.slice(0, 1)} here={{ thread: other.thread, session: other.session }} paneId="other" agentActive add={false} />
  </TooltipProvider>
)
assert.doesNotMatch(resting, /data-add-session/, "a pane without focus has no `+` of its own")

console.log("ok: the strip holds what's open across Threads, follows the screen, keeps what was typed into, and a new Thread's tab becomes it")
