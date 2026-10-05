import assert from "node:assert/strict"
import type { ThreadRef } from "@mako/sessions"
import { railAnnouncement } from "../src/lib/rail-announcement.ts"
import { acpStore } from "../src/state/acp-state.ts"
import { applyThreadGroupChange } from "../src/state/thread-groups.ts"
import { ThreadGroupSchema } from "../electron/contracts/thread-groups.ts"
import { wholeThreadTargets } from "../src/state/session-archive.ts"
import { threadsStore } from "../src/state/threads.ts"
import { archivedThread } from "../src/state/thread-lifecycle.ts"
import { threadArchiveKey, threadShownKey } from "../electron/contracts/thread-lifecycle.ts"

// Archiving a Thread's row puts every Session of it away, not only the rows
// a search or filter left showing: two catalog rows and a live conversation
// with no row yet, one of them filtered out of the rail.
const thread = "22222222-2222-4222-8222-222222222222"
const SHOWN = "a0000000-0000-4000-8000-000000000001"
const FILTERED = "a0000000-0000-4000-8000-000000000002"
const OTHER = "a0000000-0000-4000-8000-000000000003"
const LIVE = "a0000000-0000-4000-8000-000000000004"
const UNSENT = "a0000000-0000-4000-8000-000000000005"
const row = (name: string, session: string): ThreadRef => ({ harness: "codex", nativeId: name, path: `/sessions/${name}.jsonl`, threadId: thread, sessionId: session })
threadsStore.set({ threads: [row("shown", SHOWN), row("filtered-out", FILTERED), row("unrelated", OTHER)] })
acpStore.set({
  activeKey: null,
  conversations: {
    "live-1": { kind: "starting", key: "live-1", draftKey: "live-1", harness: "claude", cwd: "/repo", createdAt: 1, updatedAt: 1, blocks: [], queued: [], hiddenUserPrompt: null, sessionId: LIVE, threadId: thread, settingsTarget: { kind: "new", harness: "claude", cwd: "/repo" } },
  },
})
applyThreadGroupChange({
  thread,
  group: ThreadGroupSchema.parse({
    id: thread,
    sessions: [
      { id: SHOWN, origin: "imported", started: true },
      { id: FILTERED, origin: "imported", started: true },
      { id: LIVE, origin: "started", started: true },
      { id: UNSENT, origin: "new", started: false },
    ],
  }),
})

assert.deepEqual(wholeThreadTargets(thread), [
  { kind: "native", provider: "codex", nativeId: "shown" },
  { kind: "native", provider: "codex", nativeId: "filtered-out" },
  { kind: "live", id: "live-1" },
], "every Session with something to archive, whatever the rail shows")
assert.equal(wholeThreadTargets("33333333-3333-4333-8333-333333333333"), undefined, "a Thread of one Session archives its own row")
// A row its harness archived files with the archived ones until it's restored here.
const inCodex: ThreadRef = { harness: "codex", nativeId: "in-codex", path: "/home/.codex/archived_sessions/rollout-in-codex.jsonl", nativeArchived: true }
assert.equal(archivedThread(inCodex, new Set()), true)
assert.equal(archivedThread(inCodex, new Set([threadShownKey(threadArchiveKey({ kind: "native", provider: "codex", nativeId: "in-codex" }))])), false, "restored here")
assert.equal(archivedThread({ ...inCodex, nativeArchived: undefined }, new Set()), false)
const stamped: ThreadRef = { ...inCodex, nativeArchiveStamp: "1790000000000" }
const stampedShown = threadShownKey(threadArchiveKey({ kind: "native", provider: "codex", nativeId: "in-codex" }), "1790000000000")
assert.equal(archivedThread(stamped, new Set([stampedShown])), false, "restored here from this archive")
assert.equal(archivedThread({ ...stamped, nativeArchiveStamp: "1790000009999" }, new Set([stampedShown])), true, "archived again in Codex")
const asking = new Map([["/a", "needs-permission" as const]])
assert.equal(railAnnouncement(asking, [{ key: "/a", title: "Fix login", kind: "needs-permission" }]), undefined, "a row still asking isn't announced again")
assert.equal(railAnnouncement(asking, [{ key: "/a", title: "Fix login", kind: "needs-permission" }, { key: "/b", title: "Ship docs", kind: "failed" }]), "Ship docs failed", "a row that starts asking is")
assert.equal(railAnnouncement(new Map(), [{ key: "/a", title: "A", kind: "needs-permission" }, { key: "/b", title: "B", kind: "needs-permission" }]), "2 threads need you", "several at once are one announcement")
assert.equal(railAnnouncement(asking, []), undefined, "a row that stops asking says nothing")
console.log("thread archive targets: a Thread's row archives its hidden, filtered and live Sessions too; the rail announces only rows that start asking")
// The window's stores keep timers alive.
process.exit(0)
