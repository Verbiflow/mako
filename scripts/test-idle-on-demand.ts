import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HostJobs, whileOn } from "@mako/host/base/host-jobs"
import { ROOM_WATCH_JOB } from "@mako/host/conversations/agents"
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
