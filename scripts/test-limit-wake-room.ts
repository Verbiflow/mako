import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentsWorld, TESTED_HARNESSES } from "./lib/agents-world.ts"

/**
 * A turn a usage limit cut gives up its place while it waits, and takes one again to go on, as anything else does
 * (`npm run test:fin-fallback`), on each of the six harnesses: with a device and a tree of one, alpha is cut, queued
 * beta takes the place, and alpha's time comes. It doesn't run beside beta, and doesn't fail: it waits for the place,
 * goes when beta ends, and a Stop while it waits stands.
 */
const realNow = Date.now.bind(Date)
let ahead = 0
Date.now = () => realNow() + ahead

async function until(what: string, done: () => boolean): Promise<void> {
  const deadline = performance.now() + 15_000
  while (!done()) {
    if (performance.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const ALPHA = "ALPHA_CUT"
const BETA = "BETA_HOLDS"

async function run(root: string, harness: string, stops: boolean): Promise<void> {
  let attempts = 0
  let cut!: () => void
  const cutting = new Promise<void>((resolve) => { cut = resolve })
  const alpha = { conversation: "" }
  const beta = { conversation: "" }
  const world: AgentsWorld = new AgentsWorld({
    root,
    budget: { running: 1, started: 10 },
    finLimit: () => 1,
    accounts: { [harness]: [{ name: "default" }] },
    selected: { [harness]: "default" },
    moveOnLimit: () => false,
    script: async (turn) => {
      if (turn.text.includes(ALPHA) || turn.conversation === alpha.conversation) {
        attempts += 1
        if (attempts > 1) return "Alpha went on."
        await cutting
        turn.world.endWith(turn.conversation, { fail: "You've hit your usage limit. Try again in 1 hour." })
        return ""
      }
      if (turn.text.includes(BETA)) {
        beta.conversation = turn.conversation
        return turn.world.hold(turn.conversation).then(() => "Beta done.")
      }
      return "Noted."
    },
  })
  const label = `${harness}${stops ? ", stopped" : ""}`
  try {
    const apex = await world.apex(harness, "full")
    const started = await world.agents.start(apex.caller, { name: "alpha", brief: { objective: ALPHA }, harness, cwd: world.root, clientKey: "alpha" })
    assert.ok(!("refused" in started) && started.conversation, label)
    alpha.conversation = started.conversation!
    await until("alpha to run", () => world.live.session(alpha.conversation)?.status === "running")
    const queued = await world.agents.start(apex.caller, { name: "beta", brief: { objective: BETA }, harness, cwd: world.root, clientKey: "beta", queue: true })
    assert.ok(!("refused" in queued) && queued.state === "queued", label)
    cut()
    await until("beta to take the place alpha gave up", () => beta.conversation !== "")
    const waiting = () => world.live.snapshot(alpha.conversation)?.requests.find((request) => request.continues && request.retry?.cause === "rate-limited" && request.status === "held")
    await until("alpha's continuation to wait", () => waiting() !== undefined)
    assert.equal(world.agents.diagnostics().running, 1, `${label}: its place is beta's`)

    // Its time comes, with no room.
    ahead += waiting()!.retry!.at - Date.now() + 1
    world.live.wakeDue()
    await pause(200)
    assert.equal(attempts, 1, `${label}: it doesn't run beside beta`)
    assert.equal(world.agents.diagnostics().running, 1, `${label}: the device runs one`)
    assert.equal(waiting()?.status, "held", `${label}: it waits, and doesn't fail`)

    if (stops) {
      await world.agents.stop(apex.caller, { child: "alpha" })
      world.release(beta.conversation)
      await pause(300)
      world.live.wakeDue()
      await pause(200)
      assert.equal(attempts, 1, `${label}: nothing goes after its Stop`)
      return
    }
    // The place frees, and it goes, once.
    world.release(beta.conversation)
    await until(`${label}: alpha to go on`, () => attempts === 2)
    await until(`${label}: its turn to end`, () => world.live.session(alpha.conversation)?.status === "ready")
    assert.equal(attempts, 2, `${label}: once`)
  } finally {
    cut()
    for (const summary of world.live.summaries()) world.release(summary.session.id)
    await world.close()
  }
}

const root = mkdtempSync(join(tmpdir(), "mako-limit-wake-"))
try {
  for (const harness of TESTED_HARNESSES) {
    await run(join(root, harness), harness, false)
    await run(join(root, `${harness}-stopped`), harness, true)
  }
} finally {
  Date.now = realNow
  rmSync(root, { recursive: true, force: true })
}
console.log("limit wake: a turn a usage limit cut took a place again to go on, ran beside nothing, and a Stop while it waited stood; on all six harnesses")
