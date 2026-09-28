import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import type { ThreadGroup } from "../electron/contracts/thread-groups"
import { SessionIdSchema, ThreadIdSchema } from "../electron/contracts/thread-identity"
import type { ThreadRef } from "../src/lib/types"
import type { AcpPresence } from "../src/state/acp-presence"
import type { FoldRow } from "../src/lib/thread-fold"

/**
 * A Thread with several Sessions: one rail row, tabs in the workbench, and
 * a new tab that exists only while it holds something. Production modules
 * and components, no host.
 */

const saved = new Map<string, string>()
Object.assign(globalThis, {
  localStorage: {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
    removeItem: (key: string) => saved.delete(key),
  },
})

const { renderToStaticMarkup } = await import("react-dom/server")
const { EMPTY_FOLD, foldThreads, foldedThreadStatus, presenceThreadStatus } = await import("../src/lib/thread-fold")
const { sessionTabTitle, threadSessionTabs } = await import("../src/state/thread-sessions")
const { discardSessionDraft, leaveSessionDraft, putSessionDraft, rowThread, sessionDraftKey, threadGroupsStore } = await import("../src/state/thread-groups")
const { threadArchiveKey } = await import("../electron/contracts/thread-lifecycle")
const { rememberDraft } = await import("../src/state/drafts")
const { SessionTabList } = await import("../src/components/stage/session-tabs")
const { TooltipProvider } = await import("../src/components/ui/tooltip")

const thread = randomUUID()
const [first, second, third] = [randomUUID(), randomUUID(), randomUUID()]

function ref(path: string, harness: string, sessionId: string, title?: string): ThreadRef {
  return { harness, nativeId: path, path, title, threadId: thread, sessionId }
}

function presence(key: string, harness: string, sessionId: string, status: AcpPresence["status"] = "ready"): AcpPresence {
  return { key, harness, cwd: "/repo", createdAt: 1, status, threadId: thread, sessionId }
}

const group: ThreadGroup = {
  id: ThreadIdSchema.parse(thread),
  sessions: [
    { id: SessionIdSchema.parse(first), origin: "native", started: true },
    { id: SessionIdSchema.parse(second), origin: "fork", started: true },
    { id: SessionIdSchema.parse(third), origin: "new", started: false },
  ],
}
const groups = { [thread]: group }
const threadOf = { [first]: thread, [second]: thread, [third]: thread }

/* Rail fold ----------------------------------------------------------------- */

const parent = ref("/claude/p.jsonl", "claude", first, "Fix rail flicker")
const alias = ref("/claude/alias.jsonl", "claude", first)
const fork = presence("fork", "codex", second, "running")
const rows: FoldRow[] = [
  { kind: "native", key: parent.path, ref: parent },
  { kind: "native", key: alias.path, ref: alias },
  { kind: "live", key: fork.key, presence: fork },
]
const fold = foldThreads(rows, groups, threadOf)
assert.deepEqual([...fold.byLead.keys()], [parent.path], "the first Session's row stands for the Thread")
assert.deepEqual(fold.byLead.get(parent.path)?.members.map((row) => row.key), [parent.path, fork.key], "members in tab order")
assert.deepEqual([...fold.hidden].sort(), [alias.path, fork.key].sort(), "the fork and the alias leave the list")
assert.equal(foldThreads(rows.slice(0, 1), groups, threadOf).byLead.size, 0, "a Thread with one row visible stays an ordinary row")
assert.equal(foldThreads(rows, {}, {}), EMPTY_FOLD, "no groups, nothing folds")

const status = foldedThreadStatus(fold.byLead.get(parent.path)?.members ?? [], () => ({ kind: "review", at: 1, unread: false }))
assert.equal(status.kind, "working", "the row wears the most demanding status among its Sessions")
assert.equal(presenceThreadStatus(presence("x", "grok", first, "needs-permission")).kind, "needs-permission")

// The rail folds on every catalog event; 2,000 rows with 100 multi-Session
// Threads must stay well under a frame.
const manyGroups: Record<string, ThreadGroup> = {}
const manyThreadOf: Record<string, string> = {}
const manyRows: FoldRow[] = []
const sharedOwners = Array.from({ length: 100 }, () => randomUUID())
for (let index = 0; index < 2_000; index++) {
  const session = randomUUID()
  const owner = sharedOwners[Math.floor(index / 3)] ?? randomUUID()
  if (index < 300) {
    const current = manyGroups[owner] ?? { id: ThreadIdSchema.parse(owner), sessions: [] }
    current.sessions.push({ id: SessionIdSchema.parse(session), origin: "native", started: true })
    manyGroups[owner] = current
    manyThreadOf[session] = owner
  }
  const row: ThreadRef = { harness: "codex", nativeId: String(index), path: `/codex/${index}`, threadId: owner, sessionId: session }
  manyRows.push({ kind: "native", key: row.path, ref: row })
}
for (let warm = 0; warm < 20; warm++) foldThreads(manyRows, manyGroups, manyThreadOf)
const timings: number[] = []
for (let run = 0; run < 50; run++) {
  const started = performance.now()
  const result = foldThreads(manyRows, manyGroups, manyThreadOf)
  timings.push(performance.now() - started)
  assert.equal(result.byLead.size, 100)
}
timings.sort((left, right) => left - right)
const median = timings[Math.floor(timings.length / 2)] ?? Infinity
assert.ok(median < 1, `folding 2,000 rows took ${median.toFixed(3)}ms at the median`)

/* Tabs ---------------------------------------------------------------------- */

const draft = { id: randomUUID(), thread, cwd: "/repo", title: "Fix rail flicker" }
const tabs = threadSessionTabs({ thread, group, refs: [parent, alias], presences: [fork], draft })
assert.deepEqual(tabs.map((tab) => [tab.kind, tab.id]), [["session", first], ["session", second], ["draft", draft.id]], "Sessions in order, the empty one left out, the new tab last")
assert.equal(tabs[0]?.kind === "session" && tabs[0].ref?.path, parent.path, "the first catalog row names a Session")

const starting = { ...draft, session: third }
const whileStarting = threadSessionTabs({ thread, group, refs: [parent], presences: [fork, presence("tab", "opencode", third, "starting")], draft: starting })
assert.deepEqual(whileStarting.map((tab) => tab.kind), ["session", "session", "session"], "once its Session starts, the new tab is that Session's tab")

const beforeEvent = threadSessionTabs({ thread, refs: [parent], presences: [presence("late", "devin", randomUUID())], draft: undefined })
assert.equal(beforeEvent.length, 2, "a row naming the Thread shows before the group's event arrives")

const archivedFork = new Set([threadArchiveKey({ kind: "live", id: fork.key })])
assert.deepEqual(threadSessionTabs({ thread, group, refs: [parent], presences: [fork], archived: archivedFork }).map((tab) => tab.id), [first], "an archived Session leaves the strip")
assert.deepEqual(threadSessionTabs({ thread, group, refs: [parent], presences: [fork], archived: archivedFork, shown: second }).map((tab) => tab.id), [first, second], "unless it is on screen")

const elsewhere = randomUUID()
const moved = { [first]: thread, [second]: elsewhere }
assert.deepEqual(threadSessionTabs({ thread, refs: [parent], presences: [fork], threadOf: moved }).map((tab) => tab.id), [first], "a Session another Thread's group names leaves before its row is listed again")
assert.deepEqual(threadSessionTabs({ thread: elsewhere, refs: [parent], presences: [fork], threadOf: moved }).map((tab) => tab.id), [second], "and shows in that Thread")
assert.equal(rowThread(fork, moved), elsewhere)
assert.equal(rowThread(fork, {}), thread, "a Session no group names keeps the Thread it was listed with")

assert.deepEqual(
  whileStarting.map((tab) => sessionTabTitle(tab, {})),
  ["Fix rail flicker", "Codex", "OpenCode"],
  "an untitled Session's tab names its agent, so two new ones never share a name"
)

/* New tab lifecycle ------------------------------------------------------- */

putSessionDraft(draft, true)
leaveSessionDraft()
assert.equal(threadGroupsStore.get().drafts[thread], undefined, "an empty new tab goes when you leave it")

putSessionDraft(draft, true)
rememberDraft(sessionDraftKey(draft) ?? "", "compare the two rail fixes")
leaveSessionDraft()
assert.deepEqual(threadGroupsStore.get().drafts[thread], draft, "one holding text stays")
assert.equal(threadGroupsStore.get().open, null)
assert.ok(saved.get("mako.thread-session-drafts.v1")?.includes(draft.id), "and survives a restart")
assert.equal(sessionDraftKey(draft), sessionDraftKey({ ...draft, id: randomUUID() }), "its text is kept per Thread, not per tab")

/* Strip ----------------------------------------------------------------------- */

const strip = renderToStaticMarkup(
  <TooltipProvider>
    <div role="tablist">
      <SessionTabList tabs={tabs} here={{ thread, session: second }} paneId="main" agentActive />
    </div>
  </TooltipProvider>
)
assert.match(strip, /aria-selected="true"[^>]*data-tab-id="agent"[^>]*data-session-tab="[^"]+"/, "the Session on screen is the selected tab")
assert.equal((strip.match(/role="tab"/g) ?? []).length, 3)
assert.match(strip, />Fix rail flicker</)
assert.match(strip, />Draft</, "a new tab off screen reads as a draft")
assert.match(strip, /aria-label="Add a session to this Thread"/, "the + says what it does")
assert.match(strip, /aria-haspopup="menu"/, "and offers a new Session or an existing one")
assert.doesNotMatch(strip, /data-new/, "tabs painted with their strip do not animate")
assert.match(strip, /aria-label="Archive Codex"/, "a Session tab archives that Session alone")
assert.match(strip, /aria-label="Close new tab"/)

const alone = renderToStaticMarkup(
  <TooltipProvider>
    <div role="tablist">
      <SessionTabList tabs={tabs.filter((tab) => tab.id !== second)} here={{ thread, session: first }} paneId="main" agentActive />
    </div>
  </TooltipProvider>
)
assert.doesNotMatch(alone, /aria-label="Archive /, "a Thread's only Session is archived from its row, as the Thread")

discardSessionDraft(thread)
assert.equal(threadGroupsStore.get().drafts[thread], undefined)
console.log("thread tabs: ok")
