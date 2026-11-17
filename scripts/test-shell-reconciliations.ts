import assert from "node:assert/strict"
import { afterEach, beforeEach, mock, test } from "node:test"
import { ShellReconciliations } from "@mako/host/attribution/shell-reconciliations"

beforeEach(() => mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000_000 }))
afterEach(() => mock.timers.reset())
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve() }
const tick = async (ms: number) => { mock.timers.tick(ms); await flush() }

test("turn-end requests coalesce into one scan after the lag window", async () => {
  let scans = 0
  const queue = new ShellReconciliations(async () => { scans++ }, () => {})
  for (let i = 0; i < 20; i++) queue.schedule("repo", 1000)
  let done = false
  const heard = queue.heard(["repo"]).then(() => { done = true })
  await tick(999); assert.equal(scans, 0); assert.equal(done, false)
  await tick(1); await heard
  assert.equal(scans, 1)
  await queue.close()
})

test("unrelated roots cannot delay a scoped watermark, even while one scan hangs or fails", async () => {
  const blocked = Promise.withResolvers<void>()
  let errors = 0
  const queue = new ShellReconciliations(async (root) => { if (root === "slow") await blocked.promise; if (root === "bad") throw new Error("HEAD moved") }, () => { errors++ })
  queue.schedule("slow", 0); await tick(0)
  queue.schedule("good", 0); await tick(250)
  await queue.heard(["good"])
  queue.schedule("bad", 0); await tick(250)
  assert.equal(await queue.heard(["bad"]), false)
  assert.equal(errors, 1)
  await queue.heard(["good"])
  blocked.resolve(); await queue.close()
})

test("host-wide concurrency is two and start rate is at most four per second", async () => {
  const gates = Array.from({ length: 12 }, () => Promise.withResolvers<void>())
  const starts: number[] = []
  let active = 0, peak = 0
  const queue = new ShellReconciliations(async () => {
    const index = starts.length
    starts.push(Date.now()); active++; peak = Math.max(peak, active)
    try { await gates[index]!.promise } finally { active-- }
  }, () => {})
  for (let i = 0; i < 12; i++) queue.schedule(String(i), 0)
  await tick(0); await tick(250); await tick(1000)
  assert.equal(starts.length, 2); assert.equal(peak, 2)
  for (let i = 0; i < 12; i++) { gates[i]!.resolve(); await flush(); await tick(250) }
  await queue.close()
  assert.equal(starts.length, 12)
  for (let i = 1; i < starts.length; i++) assert(starts[i]! - starts[i - 1]! >= 250)
})

test("later turns respect root spacing without extending an older turn's wait", async () => {
  const starts: number[] = []
  const queue = new ShellReconciliations(async () => { starts.push(Date.now()) }, () => {})
  queue.schedule("repo", 1000)
  const first = queue.heard(["repo"])
  await tick(500); queue.schedule("repo", 5000)
  await tick(500); await first
  assert.equal(starts.length, 1)
  await tick(4500); await queue.heard(["repo"])
  assert.equal(starts.length, 2)
  queue.schedule("repo", 0); await tick(1999); assert.equal(starts.length, 2)
  await tick(1); await queue.heard(["repo"]); assert.equal(starts.length, 3)
  await queue.close()
})

test("forget releases only that root and closing drains pending work within the cap", async () => {
  let scans = 0
  const queue = new ShellReconciliations(async () => { scans++ }, () => {})
  queue.schedule("gone", 1000); const forgotten = queue.heard(["gone"])
  queue.forget("gone"); await forgotten
  queue.schedule("kept", 1000)
  const closed = queue.close(); await tick(1000); await closed
  queue.schedule("closed", 0); await tick(5000)
  assert.equal(scans, 1)
})


test("queued and running captures retain their command evidence until the watermark completes", async () => {
  const gate = Promise.withResolvers<void>()
  const queue = new ShellReconciliations(async () => gate.promise, () => {})
  queue.schedule("repo", 1000, Date.now() - 20_000)
  queue.schedule("repo", 1000, Date.now() - 40_000)
  assert.equal(queue.since(), 960_000)
  await tick(1000)
  assert.equal(queue.since(), 960_000)
  gate.resolve(); await flush()
  assert.equal(queue.since(), Infinity)
  await queue.close()
})
