import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterCollections } from "@mako/host/base/heap-watch"
import { HostJobs, whileOn } from "@mako/host/base/host-jobs"
import { ROOM_WATCH_JOB } from "@mako/host/conversations/agents"
import { ProviderActivityMonitor } from "@mako/host/threads/activity-monitor"
import type { ProviderActivitySession } from "@mako/host/threads/harnesses"
import { AgentsWorld, type Script } from "./lib/agents-world.ts"

/**
 * An idle host does none of this on a timer (`npm run test:fin-capacity`): the harnesses' process probes run only while
 * something watches (a window, the CLI, another host: `ThreadCatalogDeps.watched`, held by `whileOn`), and the room watch
 * (this device's load and what its Fins cost, every 10 s) only while a Fin holds a place here or a start waits for room.
 */
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(what: string, done: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await pause(20)
  }
}

// A demand says when it turns on and off; `whileOn` starts work as it turns on, now if it's on, and stops it as it turns off.
{
  const jobs = new HostJobs()
  const watched = jobs.demand("a client is subscribed")
  const calls: string[] = []
  const stop = whileOn(watched, () => calls.push("on"), () => calls.push("off"))
  assert.deepEqual(calls, [], "off at first: nothing runs")
  watched.set(true)
  watched.set(true)
  watched.set(false)
  assert.deepEqual(calls, ["on", "off"], "each change heard once")
  stop()
  watched.set(true)
  assert.deepEqual(calls, ["on", "off"], "and nothing once unsubscribed")
  const already = jobs.demand("already on")
  already.set(true)
  const late: string[] = []
  whileOn(already, () => late.push("on"), () => late.push("off"))
  assert.deepEqual(late, ["on"], "one already on starts at once")
  jobs.stop()
}

// The probes run while any demand they watch is on (a window, or a run followed here with none open), and a session that
// ended while they were paused reads ended once they run again: the next engine is told against what they last said.
{
  const jobs = new HostJobs()
  const windows = jobs.demand("a client is subscribed")
  const runs = jobs.demand("followed agent runs on this device")
  let open: ProviderActivitySession[] = [{ path: "/sessions/a.jsonl", status: "active" }]
  let looks = 0
  let changes = 0
  const monitor = new ProviderActivityMonitor({
    probes: () => [{ provider: "fixture", pollIntervalMs: 20, idlePollMs: 20, probe: async () => { looks++; return { kind: "available", sessions: open } } }],
    changed: () => changes++,
  })
  monitor.watch(windows)
  const releaseRuns = monitor.watch(runs)
  monitor.start()
  assert.equal(monitor.running, false, "nothing watches: no probe runs")
  windows.set(true)
  await until("the first look", () => monitor.sessions.get("fixture")?.length === 1)
  assert.equal(changes, 1)
  windows.set(false)
  assert.equal(monitor.running, false, "the last window closed: the probes pause")
  const paused = looks
  await pause(80)
  assert.equal(looks, paused, "and look at nothing while paused")
  assert.equal(monitor.sessions.get("fixture")?.length, 1, "what they last said stands")
  open = []
  runs.set(true)
  assert.equal(monitor.running, true, "a run followed here, with no window: the probes run")
  await until("the ended session said ended", () => monitor.sessions.get("fixture")?.length === 0)
  assert.equal(changes, 2, "the first look after a pause that finds nothing still says so")
  releaseRuns()
  assert.equal(monitor.running, false)
  monitor.stop()
  jobs.stop()
  console.log("idle on demand: the probes run while a window or a followed run watches, and a session that ended while paused reads ended")
}

// The heap is read after collections, at most once a window, never on a timer: nothing allocated, nothing read.
{
  let reads = 0
  const stop = afterCollections(60_000, () => reads++)
  try {
    let kept: unknown[] = []
    for (let round = 0; round < 200 && reads === 0; round += 1) {
      kept = Array.from({ length: 20_000 }, (_, index) => ({ index, text: `garbage ${index}` }))
      await pause(1)
    }
    assert.ok(kept.length > 0)
    assert.equal(reads, 1, "allocating enough to collect reads the heap")
    for (let round = 0; round < 50; round += 1) kept = Array.from({ length: 20_000 }, (_, index) => ({ index }))
    await pause(20)
    assert.equal(reads, 1, "and again only once the window has passed")
  } finally {
    stop()
  }
  console.log("idle on demand: the heap is read after collections, at most once a window")
}

// The room watch holds no timer with no Fin here, runs while one works, and stops once it's done.
{
  const root = mkdtempSync(join(tmpdir(), "mako-idle-on-demand-"))
  const fins = new Set<string>()
  const script: Script = async (turn) => {
    if (turn.text.includes("You're fin:")) {
      fins.add(turn.conversation)
      await turn.world.hold(turn.conversation)
      return "Done."
    }
    return "ok"
  }
  const world = new AgentsWorld({ root, script })
  try {
    const roomWatch = () => world.jobs.list().find((job) => job.name === ROOM_WATCH_JOB)
    const apex = await world.apex("claude", "full")
    await world.settle(200, 10_000, "ignore")
    assert.equal(roomWatch()?.paused, true, `an idle host's room watch holds no timer: ${JSON.stringify(roomWatch())}`)
    const started = await world.agents.start(apex.caller, { brief: { objective: "Build it." }, harness: "codex", name: "builder", clientKey: "builder", cwd: world.root })
    assert.ok(!("refused" in started) && started.conversation, JSON.stringify(started))
    await until("the Fin at work", () => fins.size === 1)
    assert.equal(roomWatch()?.paused, false, "a Fin at work here: the room watch runs")
    world.release(started.conversation!)
    await world.settle(300, 20_000, "ignore")
    await until("the room watch to stop with nothing at work", () => roomWatch()?.paused === true)
    console.log("idle on demand: probes follow a demand; the room watch holds no timer without a Fin at work or a start waiting")
  } finally {
    await world.close()
    rmSync(root, { recursive: true, force: true })
  }
}
