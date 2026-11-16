import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import type { LiveSnapshot } from "@mako/host/contracts/live-conversations"
import { TURN_CHANGES_VERSION } from "@mako/host/contracts/turn-changes"
import { LiveJournal } from "@mako/host/conversations/live-journal"
import { residentOf } from "@mako/host/conversations/live-runtime"
import { LiveTurnChanges, type TurnLedger } from "@mako/host/conversations/live-turn-changes"

const microtasks = async () => { for (let i = 0; i < 60; i++) await Promise.resolve() }

for (const recovers of [true, false]) test(`a failed final flush ${recovers ? "retries and recovers" : "still counts at the existing give-up deadline"}`, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), "mako-count-retry-"))
  const journal = new LiveJournal(folder, "c0ffee00-1234-4abc-8def-0123456789ab")
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_800_000_000_000 })
  let failing = true, counted = 0
  const snapshot: LiveSnapshot = {
    session: { connection: "connected", id: "c0ffee00-1234-4abc-8def-0123456789ab", harness: "claude", cwd: "/repo", status: "ready", modes: [], currentMode: null, configOptions: [] },
    revision: 1, createdAt: Date.now(), blocks: [], base: null, permissions: [],
    requests: [{ id: "turn", text: "Write a file", attachments: [], status: "completed" }],
  }
  const resident = residentOf(snapshot, journal)
  const ledger: TurnLedger = {
    placement: () => ({ thread: "thread", session: "session" }),
    flushed: async () => { if (failing) throw new AggregateError([], "Shell reconciliation is incomplete") },
    countTurn: async (thread, turn, state) => ({ version: TURN_CHANGES_VERSION, thread, turn, state, own: { files: 1, added: 1, removed: 0 }, maybe: { files: 0, added: 0, removed: 0 }, others: { files: 0, added: 0, removed: 0 }, files: [], more: 0, journal: "c0ffee00-1234-4abc-8def-0123456789ab", through: 1, at: Date.now() }),
    settledThrough: () => true,
    counted: () => { counted++ }, turnsChangedAfter: () => new Map(), settleMs: 20,
  }
  const counts = new LiveTurnChanges({ ledger: () => ledger, flush() {} })
  try {
    counts.ended(resident, "turn"); await microtasks()
    t.mock.timers.tick(20); await microtasks()
    assert.equal(resident.counting, 1, "an inventory error must not drop the pending final count")
    assert.notEqual(resident.snapshot.requests[0]!.changes?.state, "settled")
    if (recovers) failing = false
    t.mock.timers.tick(recovers ? 5 : 120_000); await microtasks()
    assert.equal(resident.snapshot.requests[0]!.changes?.state, "settled")
    assert.equal(resident.counting, 0)
    assert.equal(counted, 1)
  } finally {
    t.mock.timers.reset()
    await journal.close()
    await rm(folder, { recursive: true, force: true })
  }
})
