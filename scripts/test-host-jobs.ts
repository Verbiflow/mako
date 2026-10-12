import assert from "node:assert/strict"
import { setTimeout as sleep } from "node:timers/promises"
import { HostJobs } from "@mako/host/base/host-jobs"

const timers = () => process.getActiveResourcesInfo().filter((kind) => kind === "Timeout").length

{
  const jobs = new HostJobs()
  const before = timers()
  let runs = 0
  jobs.every("count", 10, () => { runs += 1 })
  assert.equal(timers(), before, "A job's timer keeps nothing alive")
  await sleep(80)
  assert.ok(runs >= 3, `A job runs again and again (${runs} runs)`)
  const [state] = jobs.list()
  assert.equal(state?.name, "count")
  assert.equal(state?.runs, runs)
  assert.equal(state?.failures, 0)
  jobs.stop()
  const stopped = runs
  await sleep(40)
  assert.equal(runs, stopped, "Nothing runs after stop")
  assert.throws(() => jobs.every("late", 10, () => {}), /stopping/, "A stopped host schedules nothing")
}

{
  const jobs = new HostJobs()
  let running = 0
  let most = 0
  let started = 0
  jobs.every("slow", 5, async () => {
    started += 1
    running += 1
    most = Math.max(most, running)
    await sleep(30)
    running -= 1
  })
  await sleep(100)
  jobs.stop()
  assert.equal(most, 1, "A run still going when the next is due is skipped")
  assert.ok(started >= 2 && started <= 4, `Skipped runs aren't queued (${started} started)`)
}

{
  const jobs = new HostJobs()
  let calls = 0
  jobs.every("flaky", 10, () => {
    calls += 1
    if (calls === 1) throw new Error("disk full")
  })
  await sleep(60)
  jobs.stop()
  const [state] = jobs.list()
  assert.equal(state?.failures, 1)
  assert.equal(state?.lastError, "disk full")
  assert.ok(calls >= 2, "A job that failed runs again")
}

{
  const jobs = new HostJobs()
  jobs.every("once", 1_000, () => {})
  assert.throws(() => jobs.every("once", 1_000, () => {}), /scheduled twice/, "Two jobs never share a name")
  jobs.stop()
}

{
  const jobs = new HostJobs()
  let runs = 0
  const cancel = jobs.every("cancelled", 10, () => { runs += 1 })
  await sleep(35)
  cancel()
  const cancelled = runs
  assert.ok(cancelled >= 1)
  await sleep(40)
  assert.equal(runs, cancelled, "A cancelled job runs no more")
  assert.deepEqual(jobs.list(), [], "and leaves the list")
  jobs.every("cancelled", 10, () => {})
  jobs.stop()
}

{
  const jobs = new HostJobs()
  let runs = 0
  jobs.every("hourly, first soon", 60_000, () => { runs += 1 }, { firstAfterMs: 10 })
  await sleep(40)
  jobs.stop()
  assert.equal(runs, 1, "The first run comes after firstAfterMs, the next after everyMs")
}

{
  // Each scheduled run is one setTimeout; unreferenced timers don't show in getActiveResourcesInfo.
  const realSetTimeout = globalThis.setTimeout
  let scheduled = 0
  globalThis.setTimeout = Object.assign((...args: Parameters<typeof realSetTimeout>) => {
    scheduled += 1
    return realSetTimeout(...args)
  }, realSetTimeout)
  try {
    const jobs = new HostJobs()
    const windows = jobs.demand("a window is open")
    const waiting = jobs.demand("an operation waits")
    let runs = 0
    jobs.every("for windows", 10, () => { runs += 1 }, { needs: [windows, waiting] })
    assert.equal(scheduled, 0, "A job none of whose demands is on schedules no timer")
    assert.deepEqual(jobs.list()[0]?.needs, ["a window is open", "an operation waits"])
    assert.equal(jobs.list()[0]?.paused, true)
    await sleep(40)
    assert.equal(runs, 0, "and never runs")
    windows.set(true)
    assert.equal(jobs.list()[0]?.paused, false)
    await sleep(40)
    assert.ok(runs >= 2, `It runs once a demand is on (${runs} runs)`)
    waiting.set(true)
    windows.set(false)
    await sleep(30)
    assert.equal(jobs.list()[0]?.paused, false, "Any one demand keeps it going")
    waiting.set(false)
    const paused = runs
    const timers = scheduled
    assert.equal(jobs.list()[0]?.paused, true)
    await sleep(40)
    assert.equal(runs, paused, "Paused again, it runs no more")
    assert.equal(scheduled, timers, "and schedules no timer")
    windows.set(true)
    jobs.stop()
    const stopped = scheduled
    windows.set(false)
    windows.set(true)
    await sleep(30)
    assert.equal(scheduled, stopped, "A demand changing after stop schedules nothing")
  } finally {
    globalThis.setTimeout = realSetTimeout
  }
}

console.log("Host jobs: named, unreferenced, repeating; an overlapping run is skipped, a failure is counted and the job goes on, a name is used once, nothing runs after stop or cancel, the first run can come sooner, and a job paused for want of a demand holds no timer until one is on")
