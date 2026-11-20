import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Actor } from "@mako/host/contracts/thread-identity"
import { DONE_FOLDS_AFTER_MS, ThreadMarkChangeSchema, foldsAsDone, marksNothing } from "@mako/host/contracts/thread-marks"
import { HELD_BY_TABLE, ThreadOperationConflictError, ThreadStore, type JournalFacts } from "@mako/host/threads/store"

/**
 * What the person marks a Thread with (`contracts/thread-marks.ts`), in the Thread store: a status and Mark as unread
 * set and cleared, a repeat of one operation changing nothing again, a merged pull request marking Done once per pull
 * request so a person moving it back keeps their status, the marks read whole and for a report's Threads, and a store
 * reopened keeping them.
 */
const root = mkdtempSync(join(tmpdir(), "mako-thread-marks-"))
const migration: Actor = { kind: "service", name: "migration" }
let clock = 1_000
const now = () => clock++

function journal(harness: string): JournalFacts {
  return { conversationId: randomUUID(), createdAt: clock++, harness, bindings: [{ provider: harness, nativeId: randomUUID(), path: `/${harness}/${randomUUID()}` }] }
}

try {
  const path = join(root, "threads.sqlite")
  const threads = new ThreadStore(path, { now })
  const person = threads.person()
  const first = threads.registerJournal(journal("codex"), migration)
  const second = threads.registerJournal(journal("claude"), migration)

  assert.equal(HELD_BY_TABLE.get("thread_marks"), "neither", "the marks table says what its writes change")
  assert.deepEqual(threads.marks(), [], "no Thread is marked at first")
  assert.deepEqual(threads.markEntry(first.thread), { thread: first.thread, status: null, statusAt: null, by: null, unreadAt: null })

  const operation = randomUUID()
  const reviewed = threads.markThread({ operationId: operation, thread: first.thread, change: { status: "in-review" }, actor: person })
  assert.equal(reviewed.status, "in-review")
  assert.equal(reviewed.by, "person")
  assert.ok(reviewed.statusAt !== null)
  assert.equal(reviewed.unreadAt, null, "a status leaves the unread mark as it was")
  const again = threads.markThread({ operationId: operation, thread: first.thread, change: { status: "in-review" }, actor: person })
  assert.deepEqual(again, reviewed, "a repeated operation changes nothing again")
  assert.throws(() => threads.markThread({ operationId: operation, thread: first.thread, change: { status: "done" }, actor: person }), ThreadOperationConflictError, "a reused operation with other content is refused")

  const unread = threads.markThread({ operationId: randomUUID(), thread: second.thread, change: { unread: true }, actor: person })
  assert.ok(unread.unreadAt !== null)
  assert.equal(unread.status, null)
  assert.deepEqual(threads.marks().map((entry) => entry.thread).sort(), [first.thread, second.thread].sort())
  const read = threads.markThread({ operationId: randomUUID(), thread: second.thread, change: { unread: false }, actor: person })
  assert.equal(read.unreadAt, null)
  assert.ok(marksNothing(read), "a Thread read again with no status marks nothing")
  assert.deepEqual(threads.marks().map((entry) => entry.thread), [first.thread], "a Thread that marks nothing isn't listed")

  // A merged pull request marks Done once; moved back, the same merge read again leaves the person's status.
  const pull = "https://github.com/acme/api/pull/7"
  const merged = threads.markPullMerged(first.thread, pull)
  assert.equal(merged?.status, "done")
  assert.equal(merged?.by, "pull")
  assert.equal(threads.markPullMerged(first.thread, pull), undefined, "the same merge read again changes nothing")
  threads.markThread({ operationId: randomUUID(), thread: first.thread, change: { status: "in-progress" }, actor: person })
  assert.equal(threads.markPullMerged(first.thread, pull), undefined, "a Thread moved back after its merge stays where it was put")
  assert.equal(threads.markEntry(first.thread)?.status, "in-progress")
  assert.equal(threads.markPullMerged(first.thread, "https://github.com/acme/api/pull/9")?.status, "done", "another pull request's merge marks it Done again")
  threads.markThread({ operationId: randomUUID(), thread: second.thread, change: { status: "done" }, actor: person })
  assert.equal(threads.markPullMerged(second.thread, pull), undefined, "a Thread already Done isn't marked again")
  assert.equal(threads.markEntry(second.thread)?.by, "person", "and keeps who marked it")

  const cleared = threads.markThread({ operationId: randomUUID(), thread: first.thread, change: { status: null }, actor: person })
  assert.deepEqual([cleared.status, cleared.statusAt, cleared.by], [null, null, null], "No status clears it")

  const report = threads.marksOf([first.thread, second.thread])
  assert.equal(report.has(first.thread), false, "a report's Threads that mark nothing say nothing")
  assert.equal(report.get(second.thread)?.status, "done")
  assert.equal(threads.marksOf([]).size, 0)
  threads.close()

  const reopened = new ThreadStore(path, { now })
  assert.equal(reopened.markEntry(second.thread)?.status, "done", "the marks outlive the store's closing")
  reopened.close()

  // The wire's change and the fold rule.
  assert.equal(ThreadMarkChangeSchema.safeParse({}).success, false, "a change changes something")
  assert.equal(ThreadMarkChangeSchema.safeParse({ status: "blocked" }).success, false)
  assert.equal(ThreadMarkChangeSchema.safeParse({ status: null, unread: true }).success, true)
  assert.equal(ThreadMarkChangeSchema.safeParse({ status: "done", extra: 1 }).success, false)
  const at = 10 * DONE_FOLDS_AFTER_MS
  assert.equal(foldsAsDone({ status: "done", statusAt: at }, at + DONE_FOLDS_AFTER_MS - 1), false, "Done for less than three days stays")
  assert.equal(foldsAsDone({ status: "done", statusAt: at }, at + DONE_FOLDS_AFTER_MS), true, "Done for three days folds")
  assert.equal(foldsAsDone({ status: "in-review", statusAt: 0 }, at), false)
  assert.equal(foldsAsDone(undefined, at), false)
  console.log("Thread marks checks clean: statuses, unread, repeats, merges marking Done once, reports, reopening")
} finally {
  rmSync(root, { recursive: true, force: true })
}
