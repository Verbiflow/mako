import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FROM_AGENTS, WAKES_PER_MINUTE } from "@mako/host/conversations/agent-wakes"
import { AgentsWorld } from "./lib/agents-world.ts"

/*
 * What a burst of reports costs a lead (`npm run bench:orch-wake`): one idle
 * lead starts CHILDREN children, more than the tree's running budget, so the
 * rest queue and start as others end; each child's turn reports EACH times
 * over a few seconds, 300 reports in all. Every report has its own number,
 * taken as it's made. The lead's wakes are its prompts: how many there are,
 * whether a report reached it twice or never, and whether the numbers came
 * in the order the reports were made. Each budget fails the run.
 */
const CHILDREN = 50
const EACH = 6
const REPORTS = CHILDREN * EACH
const BUDGET = { wakes: 10, duplicates: 0 }
/** The gap between one child's reports, as a busy child's steps come. */
const GAP_MS = { min: 150, spread: 450 }

const root = mkdtempSync(join(tmpdir(), "mako-orch-wake-"))
let made = 0
const world = new AgentsWorld({
  root,
  script: async (turn) => {
    if (turn.text.startsWith(FROM_AGENTS)) return "Noted."
    if (!turn.text.includes("child:")) return "ok"
    for (let i = 0; i < EACH; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, GAP_MS.min + Math.random() * GAP_MS.spread))
      made += 1
      const told = await turn.world.agents.report(turn.caller, { status: "done", summary: `R${made}. Part ${i + 1} of ${EACH} of ${turn.harness}'s review.`, clientKey: `r${i}` })
      assert.ok(!("refused" in told), JSON.stringify(told))
    }
    return "All parts reported."
  },
})
try {
  const lead = await world.lead("codex")
  const harnesses = ["claude", "cursor", "grok", "opencode", "devin"]
  const began = performance.now()
  for (let i = 0; i < CHILDREN; i += 1) {
    const started = await world.agents.start(lead.caller, { brief: { objective: `Review part ${i} of the sidebar.` }, harness: harnesses[i % harnesses.length]!, name: `part-${i}`, clientKey: `part-${i}`, cwd: root })
    assert.ok(!("refused" in started), JSON.stringify(started))
  }
  await world.settle(2_600, 240_000)
  const elapsed = performance.now() - began
  const wakes = world.prompts.filter((prompt) => prompt.conversation === lead.conversation)
  assert.equal(world.steers.length, 0, "a Codex lead is woken by turns, never steered")
  const numbers = wakes.flatMap((wake) => [...wake.text.matchAll(/: R(\d+)\./g)].map((match) => Number(match[1])))
  const duplicates = numbers.length - new Set(numbers).size
  const missing = REPORTS - new Set(numbers).size
  const inOrder = numbers.every((number, i) => i === 0 || number > numbers[i - 1]!)
  const sizes = wakes.map((wake) => [...wake.text.matchAll(/: R\d+\./g)].length)
  console.log(JSON.stringify({ children: CHILDREN, reports: made, wakes: wakes.length, perWake: sizes, duplicates, missing, inOrder, wakesPerMinuteCap: WAKES_PER_MINUTE, elapsedMs: Math.round(elapsed) }))
  assert.equal(made, REPORTS)
  assert.ok(wakes.length <= BUDGET.wakes, `${wakes.length} wakes for ${REPORTS} reports; the budget is ${BUDGET.wakes}`)
  assert.equal(duplicates, BUDGET.duplicates, "no report reaches the lead twice")
  assert.equal(missing, 0, "and none never")
  assert.ok(inOrder, "the lead hears them in the order they were made")
  const minute = wakes.map((wake) => wake.at).sort((a, b) => a - b)
  for (let i = WAKES_PER_MINUTE; i < minute.length; i += 1)
    assert.ok(minute[i]! - minute[i - WAKES_PER_MINUTE]! >= 60_000, `more than ${WAKES_PER_MINUTE} wakes in a minute`)
  console.log("bench orch-wake: ok")
} finally {
  await world.close()
  rmSync(root, { recursive: true, force: true })
}
