import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FROM_AGENTS } from "@mako/host/conversations/agent-wakes"
import { AgentsWorld, HARNESSES } from "./lib/agents-world.ts"

/*
 * How long a lead waits for a spawn's receipt (`npm run bench:orch-spawn`):
 * a lead on each of the six harnesses starts EACH children, round the six
 * harnesses, while the children already started work; the receipt is what
 * `agents_start` answers, once the child's Thread, edge, Session and first
 * request are committed and its turn is on its way. Then the same spawns
 * again by key, which answer from the store. Each budget fails the run.
 */
const EACH = 16
const BUDGET = { receiptP95Ms: 250, repeatP95Ms: 50 }

const root = mkdtempSync(join(tmpdir(), "mako-orch-spawn-"))
const world = new AgentsWorld({
  root,
  script: async (turn) => {
    if (turn.text.startsWith(FROM_AGENTS) || !turn.text.includes("child:")) return "ok"
    await new Promise((resolve) => setTimeout(resolve, 200))
    return `Done: ${turn.harness} reviewed its part.`
  },
})

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))]! * 10) / 10
}

try {
  const leads = await Promise.all(HARNESSES.map((harness) => world.lead(harness)))
  const receipts: number[] = []
  const repeats: number[] = []
  const spawn = async (lead: (typeof leads)[number], i: number) => {
    const input = { brief: { objective: `Review part ${i} of the sidebar.` }, harness: HARNESSES[i % HARNESSES.length]!, name: `part-${i}`, clientKey: `part-${i}`, cwd: root }
    const began = performance.now()
    const started = await world.agents.start(lead.caller, input)
    return { elapsed: performance.now() - began, started }
  }
  for (let i = 0; i < EACH; i += 1)
    for (const lead of leads) {
      const { elapsed, started } = await spawn(lead, i)
      assert.ok(!("refused" in started) && !started.deduped, JSON.stringify(started))
      receipts.push(elapsed)
    }
  for (const lead of leads) {
    const { elapsed, started } = await spawn(lead, 0)
    assert.ok(!("refused" in started) && started.deduped)
    repeats.push(elapsed)
  }
  await world.settle(2_600, 120_000)
  const result = {
    spawns: receipts.length,
    receipt: { p50: percentile(receipts, 50), p95: percentile(receipts, 95), max: percentile(receipts, 100) },
    repeat: { p50: percentile(repeats, 50), p95: percentile(repeats, 95) },
  }
  console.log(JSON.stringify(result))
  assert.ok(result.receipt.p95 <= BUDGET.receiptP95Ms, `receipt p95 ${result.receipt.p95} ms; the budget is ${BUDGET.receiptP95Ms}`)
  assert.ok(result.repeat.p95 <= BUDGET.repeatP95Ms, `repeat p95 ${result.repeat.p95} ms; the budget is ${BUDGET.repeatP95Ms}`)
  console.log("bench orch-spawn: ok")
} finally {
  await world.close()
  rmSync(root, { recursive: true, force: true })
}
