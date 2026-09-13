import assert from "node:assert/strict"
import type { ThreadRef } from "@mako/sessions"
import type { ExternalThreadActivity } from "../electron/contracts/host-events-boot.ts"
import {
  WRITE_ACTIVE_MS,
  deriveActivity,
  indexActivityRefs,
  sameActivity,
  type ActivityInputs,
} from "../electron/thread-activity.ts"

const cursor: ThreadRef = { harness: "cursor", nativeId: "agent-1", path: "/home/.cursor/acp-sessions/agent-1/store.db" }
const fork: ThreadRef = { ...cursor, path: "/home/.cursor/chats/ws/agent-1/store.db", identity: "chats:agent-1" }
const claude: ThreadRef = { harness: "claude", nativeId: "c-1", path: "/home/.claude/projects/p/c-1.jsonl" }
const devin: ThreadRef = { harness: "devin", nativeId: "d-1", path: "/home/.devin/sessions.db#d-1" }
const index = indexActivityRefs([cursor, fork, claude, devin])
const now = 1_000_000

function derive(overrides: Partial<ActivityInputs>): Map<string, ExternalThreadActivity> {
  return deriveActivity({
    index,
    probes: [],
    writes: new Map(),
    heldElsewhere: () => false,
    previous: new Map(),
    now,
    ...overrides,
  })
}

// A probe that can only see the store open reports open; nothing is invented.
const open = derive({ probes: [["cursor", [{ path: cursor.path, status: "open" }]]] })
assert.deepEqual(open.get(cursor.path), { provider: "cursor", since: now, status: "open", detail: undefined, evidence: undefined })

// The same store written moments ago is a running turn, and says the evidence is writes.
const streaming = derive({
  probes: [["cursor", [{ path: cursor.path, status: "open" }]]],
  writes: new Map([[cursor.path, now - 800]]),
})
assert.equal(streaming.get(cursor.path)?.status, "active")
assert.equal(streaming.get(cursor.path)?.evidence, "writes")

// Writes older than the window no longer count; the probe's own word returns.
const settled = derive({
  probes: [["cursor", [{ path: cursor.path, status: "open" }]]],
  writes: new Map([[cursor.path, now - WRITE_ACTIVE_MS]]),
  previous: streaming,
})
assert.equal(settled.get(cursor.path)?.status, "open")
assert.equal(settled.get(cursor.path)?.evidence, undefined)
assert.equal(settled.get(cursor.path)?.since, now, "a settle is a new observation")

// A process that reports its own turn is never relabelled as inferred.
const reported = derive({
  probes: [["claude", [{ nativeId: "c-1", status: "active", detail: "Running a tool" }]]],
  writes: new Map([[claude.path, now - 100]]),
})
assert.deepEqual(reported.get(claude.path), { provider: "claude", since: now, status: "active", detail: "Running a tool", evidence: undefined })

// `since` survives while the activity is the same, so a needs-input marker is stable.
const before = new Map<string, ExternalThreadActivity>([[claude.path, { provider: "claude", since: now - 5_000, status: "needs-input" }]])
const again = derive({ probes: [["claude", [{ nativeId: "c-1", status: "needs-input" }]]], previous: before })
assert.equal(again.get(claude.path)?.since, now - 5_000)

// A session another Mako host holds has no process here; its writes mark it running.
const held = derive({
  writes: new Map([[devin.path, now - 2_000]]),
  heldElsewhere: (ref) => ref.harness === "devin",
})
assert.equal(held.get(devin.path)?.status, "active")
assert.equal(held.get(devin.path)?.evidence, "writes")
assert.equal(held.get(devin.path)?.provider, "devin")

// A written store nobody holds or has open says nothing: the renderer's
// "Updated" covers that, and it must not become a working mark.
const orphan = derive({ writes: new Map([[claude.path, now - 100]]) })
assert.equal(orphan.size, 0)

// A native id shared by a store and its chats fork resolves through the identity key.
const byIdentity = derive({ probes: [["cursor", [{ nativeId: "agent-1", status: "open" }]]] })
assert.equal(byIdentity.get(cursor.path)?.status, "open")
assert.equal(byIdentity.has(fork.path), false, "the fork keeps its own identity and is not shadowed")

// Two probes on one path: needs-input wins, and active outranks open.
const contested = derive({
  probes: [
    ["cursor", [{ path: cursor.path, status: "open" }]],
    ["cursor", [{ path: cursor.path, status: "active" }]],
  ],
})
assert.equal(contested.get(cursor.path)?.status, "active")

assert.equal(sameActivity(streaming.get(cursor.path), settled.get(cursor.path)), false)
assert.equal(
  sameActivity(
    { provider: "cursor", since: 1, status: "active", evidence: "writes" },
    { provider: "cursor", since: 2, status: "active", evidence: "writes" }
  ),
  true,
  "a fresh `since` alone is not a change worth an event"
)

console.log("thread activity: ok")
