import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { monitorEventLoopDelay } from "node:perf_hooks"
import { FROM_AGENTS } from "@mako/host/conversations/agent-wakes"
import { AgentsWorld, HARNESSES } from "./lib/agents-world.ts"

/*
 * What 32 children cost the host's event loop (`npm run bench:orch-host`):
 * two leads of 16 children each, round the six harnesses, each child taking
 * STEPS steps of text and a progress report a step, then ending with a done
 * report that wakes its lead. The loop's delay is measured idle first
 * (before) and then across the whole tree's work (after); the tree adds no
 * hold over the budget. Each budget fails the run.
 */
const LEADS = 2
const EACH = 16
const STEPS = 8
const STEP_MS = 120
const BUDGET = { loopMaxMs: 100 }

const root = mkdtempSync(join(tmpdir(), "mako-orch-host-"))
const world = new AgentsWorld({
  root,
  script: async (turn) => {
    if (turn.text.startsWith(FROM_AGENTS) || !turn.text.includes("child:")) return "ok"
    for (let step = 1; step <= STEPS; step += 1) {
      await new Promise((resolve) => setTimeout(resolve, STEP_MS))
      turn.world.live.observe({ type: "live-update", id: turn.conversation, update: { kind: "text", text: `Step ${step} of ${turn.harness}'s part. ` } })
      await turn.world.agents.report(turn.caller, { status: "progress", summary: `Step ${step} is done. Next the one after.`, clientKey: `s${step}` })
    }
    await turn.world.agents.report(turn.caller, { status: "done", summary: `Reviewed ${turn.harness}'s part.`, clientKey: "done" })
    return "Done."
  },
})

async function measure(work: () => Promise<void>) {
  const delay = monitorEventLoopDelay({ resolution: 5 })
  delay.enable()
  await work()
  delay.disable()
  return { p99Ms: Math.round(delay.percentile(99) / 1e5) / 10, maxMs: Math.round(delay.max / 1e5) / 10 }
}

try {
  const leads = [await world.lead("codex"), await world.lead("claude")]
  const before = await measure(() => new Promise((resolve) => setTimeout(resolve, STEPS * STEP_MS + 2_000)))
  let spawned = 0
  const after = await measure(async () => {
    for (let i = 0; i < EACH; i += 1)
      for (const lead of leads.slice(0, LEADS)) {
        const started = await world.agents.start(lead.caller, { brief: { objective: `Review part ${i}.` }, harness: HARNESSES[spawned % HARNESSES.length]!, name: `part-${i}`, clientKey: `part-${i}`, cwd: root })
        assert.ok(!("refused" in started), JSON.stringify(started))
        spawned += 1
      }
    await world.settle(2_600, 120_000)
  })
  const wakes = world.prompts.filter((prompt) => leads.some((lead) => lead.conversation === prompt.conversation)).length + world.steers.length
  const diagnostics = world.agents.diagnostics()
  console.log(JSON.stringify({ children: spawned, before, after, wakes, diagnostics: { children: diagnostics.children, running: diagnostics.running, notices: diagnostics.notices } }))
  assert.equal(spawned, LEADS * EACH)
  assert.ok(after.maxMs <= BUDGET.loopMaxMs, `the loop held ${after.maxMs} ms; the budget is ${BUDGET.loopMaxMs}`)
  console.log("bench orch-host: ok")
} finally {
  await world.close()
  rmSync(root, { recursive: true, force: true })
}
