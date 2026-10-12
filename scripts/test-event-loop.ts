import assert from "node:assert/strict"
import { setTimeout as sleep } from "node:timers/promises"
import { EventLoopWatch } from "@mako/host/base/event-loop"
import { HostJobs } from "@mako/host/base/host-jobs"

const hold = (ms: number) => {
  const until = performance.now() + ms
  while (performance.now() < until) { /* holds the loop */ }
}

/** Counts the timers `run` schedules, unreferenced ones included. */
async function timersScheduledBy(run: () => Promise<void>): Promise<number> {
  const original = globalThis.setTimeout
  let scheduled = 0
  // SAFETY: the spy forwards every argument to the real setTimeout and returns its handle unchanged.
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    scheduled += 1
    return original(...args)
  }) as typeof setTimeout
  try {
    await run()
  } finally {
    globalThis.setTimeout = original
  }
  return scheduled
}

{
  const loop = new EventLoopWatch({ resolutionMs: 10, heldMs: 60, lingerMs: 50 })
  const idle = await timersScheduledBy(() => sleep(60).then(() => {}))
  assert.equal(idle, 0, "A host doing nothing schedules no watch timer")
  assert.equal(loop.snapshot().watching, false)
  assert.equal(loop.snapshot().delayMs.checks, 0)

  const done = loop.begin("mako:threads")
  assert.equal(loop.snapshot().watching, true, "Work begun is watched")
  hold(120)
  await sleep(30)
  done()
  const held = loop.snapshot()
  assert.equal(held.holds.count, 1, "A check that ran 100 ms late is one hold")
  assert.ok(held.holds.longest && held.holds.longest.ms >= 100, `The hold measures how long the loop was held (${held.holds.longest?.ms} ms)`)
  assert.match(held.holds.longest?.during[0] ?? "", /^mako:threads \(\d+ ms\)$/, "It names the work that was running")
  assert.ok(held.delayMs.max >= 100 && held.delayMs.checks >= 2)

  await sleep(40)
  assert.equal(loop.snapshot().watching, false, "With no work open the watch stops at its next check")
  const after = await timersScheduledBy(() => sleep(60).then(() => {}))
  assert.equal(after, 0, "A watch that stopped schedules nothing more")
  loop.stop()
}

{
  const loop = new EventLoopWatch({ resolutionMs: 10, heldMs: 60, lingerMs: 80 })
  loop.touch()
  await sleep(40)
  assert.equal(loop.snapshot().watching, true, "An event sent keeps the loop watched for the linger")
  hold(90)
  await sleep(20)
  assert.deepEqual(loop.snapshot().holds.longest?.during, [], "A hold with no named work running names none")
  await sleep(120)
  assert.equal(loop.snapshot().watching, false, "The linger ends")
  loop.stop()
}

{
  const loop = new EventLoopWatch({ resolutionMs: 10, heldMs: 60, lingerMs: 0 })
  const first = loop.begin("short")
  first()
  const long = loop.begin("long")
  await sleep(30)
  const short = loop.begin("short")
  hold(80)
  short()
  await sleep(20)
  long()
  const during = loop.snapshot().holds.longest?.during ?? []
  assert.match(during[0] ?? "", /^long /, "The longest-running work is named first")
  assert.equal(during.filter((label) => label.startsWith("short ")).length, 1, "Work named twice in a hold is listed once, by its longest run")
  loop.stop()
}

{
  const loop = new EventLoopWatch({ resolutionMs: 10, heldMs: 60, lingerMs: 0 })
  const jobs = new HostJobs(loop)
  jobs.every("read harness runtime versions", 5, () => hold(80), { firstAfterMs: 0 })
  await sleep(60)
  jobs.stop()
  assert.match(loop.snapshot().holds.longest?.during[0] ?? "", /^read harness runtime versions \(\d+ ms\)$/, "A job's run is named by the job")
  loop.stop()
  const stopped = await timersScheduledBy(async () => {
    loop.begin("after stop")()
    loop.touch()
  })
  assert.equal(stopped, 0, "A stopped watch watches nothing")
}

console.log("Event loop: unwatched and timerless while idle; work and sent events are watched; a hold names the work running, longest first; jobs are named")
