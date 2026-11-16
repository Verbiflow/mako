import assert from "node:assert/strict"
import { afterEach, beforeEach, mock, test } from "node:test"
import { ShellReconciliations } from "@mako/host/attribution/shell-reconciliations"

beforeEach(() => mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000_000 }))
afterEach(() => mock.timers.reset())
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }

test("a burst coalesces an immediate pass and a trailing pass without blocking callers", async () => {
  let scans = 0
  const queue = new ShellReconciliations(async () => { scans++ }, () => {})
  for (let i = 0; i < 20; i++) queue.schedule("repo", 1000)
  assert.equal(scans, 0)
  let heard = false
  const pending = queue.heard().then(() => { heard = true })
  mock.timers.tick(50); await flush()
  assert.equal(scans, 1); assert.equal(heard, false)
  mock.timers.tick(949); await flush(); assert.equal(heard, false)
  mock.timers.tick(1); await pending
  assert.equal(scans, 2); assert.equal(heard, true)
  await queue.close()
})

test("overlapping commands never run inventories concurrently and older watermarks do not starve", async () => {
  let scans = 0, active = 0
  const blocked = Promise.withResolvers<void>()
  const queue = new ShellReconciliations(async () => {
    assert.equal(active++, 0)
    try { if (++scans === 1) await blocked.promise } finally { active-- }
  }, () => {})
  queue.schedule("repo", 100)
  let first = false
  const pending = queue.heard().then(() => { first = true })
  mock.timers.tick(50); await flush(); assert.equal(scans, 1)
  queue.schedule("repo", 1000)
  mock.timers.tick(50); await flush(); assert.equal(first, false)
  blocked.resolve(); await flush()
  mock.timers.tick(0); await pending
  assert.equal(first, true)
  let later = false
  const remaining = queue.heard().then(() => { later = true })
  await flush(); assert.equal(later, false)
  mock.timers.tick(1000); await remaining
  assert.equal(later, true)
  await queue.close()
})

test("a failed pass is visible to finalization and a later inventory recovers it", async () => {
  let fail = true, errors = 0
  const queue = new ShellReconciliations(async () => { if (fail) throw new Error("Git helper unavailable") }, () => { errors++ })
  queue.schedule("repo", 50)
  const pending = queue.heard()
  const rejected = assert.rejects(pending, /incomplete/)
  mock.timers.tick(50); await rejected
  assert.equal(errors, 1)
  fail = false
  await queue.heard()
  await queue.close()
})

test("ordinary flushes do not consume the delivery allowance; close and forgetting release all ownership", async () => {
  let scans = 0
  const queue = new ShellReconciliations(async () => { scans++ }, () => {})
  queue.schedule("repo", 5000)
  await queue.flush(); assert.equal(scans, 1)
  await queue.flush(); assert.equal(scans, 1, "an ordinary read does not rescan the root again during its lag window")
  let heard = false
  const pending = queue.heard().then(() => { heard = true })
  await flush(); assert.equal(heard, false)
  await queue.close(); await pending
  assert.equal(scans, 2)
  queue.schedule("closed", 100); mock.timers.tick(10_000); await flush(); assert.equal(scans, 2)
  const other = new ShellReconciliations(async () => {}, () => {})
  other.schedule("gone", 5000)
  const forgotten = other.heard(); other.forget("gone"); await forgotten; await other.close()
})
