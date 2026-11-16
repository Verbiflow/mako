import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DeviceIdSchema, MoveIdSchema } from "@mako/host/contracts/thread-execution"
import { LiveMoves, type MoveAccess } from "@mako/host/conversations/live-moves"
import type { Dependencies } from "@mako/host/conversations/live-runtime"
import { ThreadStore, type JournalFacts } from "@mako/host/threads/store"

/**
 * A move's every step says so in the rows of all its Thread's conversations, not only those in memory. On a cloud
 * machine a Thread's new tab and fork are closed for its release; when the Mac then refused the way back and the machine
 * took the Thread again, only the conversation in memory heard it, and the other two stayed listed as `moving` on every
 * phone ("Bringing it back … 61%"), staging 2026-11-16, until something else moved them.
 *
 *   npx tsx scripts/test-move-rows.ts
 */
const root = mkdtempSync(join(tmpdir(), "mako-move-rows-"))
try {
  let clock = 1_000
  const threads = new ThreadStore(join(root, "threads.sqlite"), { now: () => clock++, realPath: (path) => path })
  const journal = (conversationId: string, nativeId: string, ancestry?: JournalFacts["ancestry"]): JournalFacts => ({
    conversationId,
    createdAt: clock++,
    harness: "opencode",
    bindings: [{ provider: "opencode", nativeId, path: `/opencode/${nativeId}` }],
    ...(ancestry && { ancestry }),
  })
  const moved = randomUUID()
  const placed = threads.registerJournal(journal(moved, "n-moved"), threads.person())
  // A tab and a fork made in the Thread: its own Sessions, none of them in memory when the Thread is taken back.
  const tab = randomUUID()
  const fork = randomUUID()
  threads.registerJournal(journal(tab, "n-tab", { parentId: moved, placement: "parent-thread" }), threads.person())
  threads.registerJournal(journal(fork, "n-fork", { parentId: moved, placement: "parent-thread" }), threads.person())
  const all = [moved, tab, fork].sort()
  assert.equal(threads.threadSessions(placed.thread).length, 3, "three Sessions in one Thread")

  const said: string[] = []
  const dependencies: Dependencies = {
    appPath: root,
    root,
    driver: () => undefined,
    history: async () => null,
    emit: () => undefined,
    threads,
    workMoved: (conversation) => void said.push(conversation),
  }
  const access: MoveAccess = {
    dependencies,
    resident: () => undefined,
    residents: () => [],
    control: () => assert.fail("nothing is in memory"),
    pending: () => undefined,
    canHibernate: () => true,
    hibernate: async () => undefined,
    resume: () => assert.fail("nothing is in memory to resume"),
  }
  const moves = new LiveMoves(access)
  const heard = () => [...new Set(said.splice(0))].sort()
  const actor = threads.person()
  const device = { kind: "device" as const, device: DeviceIdSchema.parse(randomUUID()) }

  // The way back asked of the machine: leaving, then released toward the device.
  const move = MoveIdSchema.parse(randomUUID())
  moves.begin({ move, thread: placed.thread, target: device, actor })
  assert.deepEqual(heard(), all, "leaving: every conversation's row says it moves")
  await moves.release({ operationId: randomUUID(), move, actor })
  assert.deepEqual(heard(), all, "released: every row says it's in transit")
  // The device refused it: the machine takes the Thread back, and every row says so.
  moves.reclaim({ operationId: randomUUID(), refusal: { move, by: device, reason: "opencode here is older" }, actor })
  assert.deepEqual(heard(), all, "taken back: every row is worked out again, those not in memory too")
  for (const session of threads.threadSessions(placed.thread)) assert.equal(threads.execution(session.session)?.state, "here")

  // A way back cancelled before the release: the same.
  const cancelled = MoveIdSchema.parse(randomUUID())
  moves.begin({ move: cancelled, thread: placed.thread, target: device, actor })
  heard()
  moves.cancel({ operationId: randomUUID(), move: cancelled, actor })
  assert.deepEqual(heard(), all, "cancelled: every row is worked out again")
  console.log("move rows: begin, release, reclaim and cancel each re-report all three of the Thread's conversations, none in memory")
} finally {
  rmSync(root, { recursive: true, force: true })
}
