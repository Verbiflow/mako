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

console.log("Host jobs: named, unreferenced, repeating; an overlapping run is skipped, a failure is counted and the job goes on, a name is used once, and nothing runs after stop")
