import assert from "node:assert/strict"
import type { ThreadRef } from "@mako/sessions"
import { railAnnouncement } from "../src/lib/rail-announcement.ts"
import { acpStore } from "../src/state/acp-state.ts"
import { threadGroupsStore } from "../src/state/thread-groups.ts"
import { wholeThreadTargets } from "../src/state/session-archive.ts"
import { threadsStore } from "../src/state/threads.ts"

// Archiving a Thread's row puts every Session of it away, not only the rows
// a search or filter left showing: two catalog rows and a live conversation
// with no row yet, one of them filtered out of the rail.
const thread = "22222222-2222-4222-8222-222222222222"
const row = (name: string, session: string): ThreadRef => ({ harness: "codex", nativeId: name, path: `/sessions/${name}.jsonl`, threadId: thread, sessionId: session })
threadsStore.set({ threads: [row("shown", "s-shown"), row("filtered-out", "s-filtered"), row("unrelated", "s-other")] })
acpStore.set({
  activeKey: null,
  conversations: {
    "live-1": { kind: "starting", key: "live-1", draftKey: "live-1", harness: "claude", cwd: "/repo", createdAt: 1, updatedAt: 1, blocks: [], queued: [], hiddenUserPrompt: null, sessionId: "s-live", threadId: thread, settingsTarget: { kind: "new", harness: "claude", cwd: "/repo" } },
  },
})
threadGroupsStore.set({
  groups: { [thread]: { id: thread, sessions: [{ id: "s-shown", origin: "imported", started: true }, { id: "s-filtered", origin: "imported", started: true }, { id: "s-live", origin: "started", started: true }, { id: "s-unsent", origin: "new", started: false }] } },
})

assert.deepEqual(wholeThreadTargets(thread), [
  { kind: "native", provider: "codex", nativeId: "shown" },
  { kind: "native", provider: "codex", nativeId: "filtered-out" },
  { kind: "live", id: "live-1" },
], "every Session with something to archive, whatever the rail shows")
assert.equal(wholeThreadTargets("33333333-3333-4333-8333-333333333333"), undefined, "a Thread of one Session archives its own row")
const asking = new Map([["/a", "needs-permission" as const]])
assert.equal(railAnnouncement(asking, [{ key: "/a", title: "Fix login", kind: "needs-permission" }]), undefined, "a row still asking isn't announced again")
assert.equal(railAnnouncement(asking, [{ key: "/a", title: "Fix login", kind: "needs-permission" }, { key: "/b", title: "Ship docs", kind: "failed" }]), "Ship docs failed", "a row that starts asking is")
assert.equal(railAnnouncement(new Map(), [{ key: "/a", title: "A", kind: "needs-permission" }, { key: "/b", title: "B", kind: "needs-permission" }]), "2 threads need you", "several at once are one announcement")
assert.equal(railAnnouncement(asking, []), undefined, "a row that stops asking says nothing")
console.log("thread archive targets: a Thread's row archives its hidden, filtered and live Sessions too; the rail announces only rows that start asking")
// The window's stores keep timers alive.
process.exit(0)
