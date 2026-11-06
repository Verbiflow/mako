import assert from "node:assert/strict"
import type { ThreadRef } from "@mako/sessions"
import { railAnnouncement } from "../src/lib/rail-announcement.ts"
import { archivedThread } from "../src/state/thread-lifecycle.ts"
import { threadArchiveKey, threadShownKey } from "@mako/host/contracts/thread-lifecycle"

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
console.log("thread archive targets: a row its harness archived files apart until restored; the rail announces only rows that start asking")
// The window's stores keep timers alive.
process.exit(0)
