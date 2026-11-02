import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FROM_AGENTS } from "@mako/host/conversations/agent-wakes"
import { AgentsWorld } from "./lib/agents-world.ts"

/*
 * What the front door costs on the host (`npm run bench:orch-route`): a lead
 * on Codex with CHILDREN finished Threads across five harnesses. Direct, the
 * person writes in a child's own tab; through the lead, they write to the
 * lead, whose scripted model passes the message on (`agents_send`, forward)
 * the moment its turn starts, so the model's own time is left out. Each is
 * timed from the send to the child's harness being handed the message, its
 * p50 and p95 against BUDGET; so is the front-door note the lead hears
 * ahead of each message, its size and the time to build it at CHILDREN and
 * at MANY children. Between samples it waits for turns to end, not for the
 * lead's wakes: each child's report wakes the lead, and past six a minute
 * those wait their turn, so a lead turn may run inside a sample as it would
 * for the person.
 */
const CHILDREN = 20
const MANY = 100
const SAMPLES = 30
const BUDGET = { directP95Ms: 50, viaLeadP95Ms: 150, noteBytes: 4096, noteP95Ms: 5 }
const HARNESSES = ["claude", "cursor", "grok", "opencode", "devin"]

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!
}

const summary = (values: number[]) => ({ p50: percentile(values, 50), p95: percentile(values, 95), max: Math.max(...values) })

const root = mkdtempSync(join(tmpdir(), "mako-orch-route-"))
const marker = /route to (area-\d+)/
const children: string[] = []
const world = new AgentsWorld({
  root,
  budget: { running: 2 * MANY, started: 4 * MANY },
  script: async (turn) => {
    if (children.includes(turn.conversation) || turn.text.startsWith(FROM_AGENTS)) return "Done."
    const to = marker.exec(turn.text)?.[1]
    if (!to) return "ok"
    const sent = await turn.world.agents.send(turn.caller, { to, forward: true, clientKey: randomUUID() })
    assert.ok(!("refused" in sent), JSON.stringify(sent))
    return `Passed to ${to}.`
  },
})

/** When `child`'s harness was handed a message ending `words`, waiting for it. */
async function handed(child: string, words: string): Promise<number> {
  const deadline = Date.now() + 10_000
  for (;;) {
    const prompt = world.prompts.find((each) => each.conversation === child && each.text.endsWith(words))
    if (prompt) return prompt.at
    if (Date.now() > deadline) throw new Error(`${child} never got "${words}"`)
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

try {
  const lead = await world.lead("codex")
  for (let i = 0; i < CHILDREN; i += 1) {
    const started = await world.agents.start(lead.caller, { brief: { objective: `Own area ${i} of the app: its screens, its tests and its release notes.` }, harness: HARNESSES[i % HARNESSES.length]!, name: `area-${i}`, clientKey: `area-${i}`, cwd: root })
    assert.ok(!("refused" in started) && started.conversation, JSON.stringify(started))
    children.push(started.conversation!)
  }
  await world.settle(600, 120_000)

  const direct: number[] = []
  const viaLead: number[] = []
  for (let i = 0; i < SAMPLES; i += 1) {
    const index = i % CHILDREN
    const child = children[index]!
    const plain = `Direct message ${i} for area ${index}.`
    const sentAt = Date.now()
    world.say(child, plain)
    direct.push((await handed(child, plain)) - sentAt)
    await world.settle(300, 30_000, "ignore")
    const routed = `Please route to area-${index}: message ${i}.`
    const askedAt = Date.now()
    world.say(lead.conversation, routed)
    viaLead.push((await handed(child, routed)) - askedAt)
    await world.settle(300, 30_000, "ignore")
  }

  const note = (conversation: string) => world.agents.frontDoor(conversation, { actor: undefined })
  const lines = note(lead.conversation)
  const noteBytes = Buffer.byteLength(lines.join("\n"))
  const build: number[] = []
  for (let i = 0; i < 200; i += 1) {
    const began = performance.now()
    note(lead.conversation)
    build.push(performance.now() - began)
  }
  const big = await world.lead("claude")
  for (let i = 0; i < MANY; i += 1) {
    const started = await world.agents.start(big.caller, { brief: { objective: `Part ${i}.` }, harness: HARNESSES[i % HARNESSES.length]!, name: `part-${i}`, clientKey: `part-${i}`, cwd: root })
    assert.ok(!("refused" in started), JSON.stringify(started))
  }
  await world.settle(600, 240_000)
  const buildMany: number[] = []
  for (let i = 0; i < 100; i += 1) {
    const began = performance.now()
    note(big.conversation)
    buildMany.push(performance.now() - began)
  }
  const manyBytes = Buffer.byteLength(note(big.conversation).join("\n"))

  const result = {
    children: CHILDREN,
    samples: SAMPLES,
    directMs: summary(direct),
    viaLeadMs: summary(viaLead),
    note: { bytes: noteBytes, approxTokens: Math.round(noteBytes / 4), buildMs: summary(build.map((ms) => Math.round(ms * 1000) / 1000)) },
    noteAtMany: { children: MANY, bytes: manyBytes, buildMs: summary(buildMany.map((ms) => Math.round(ms * 1000) / 1000)) },
    budget: BUDGET,
  }
  console.log(JSON.stringify(result, null, 2))
  assert.ok(result.directMs.p95 <= BUDGET.directP95Ms, `direct p95 ${result.directMs.p95} ms > ${BUDGET.directP95Ms}`)
  assert.ok(result.viaLeadMs.p95 <= BUDGET.viaLeadP95Ms, `through the lead p95 ${result.viaLeadMs.p95} ms > ${BUDGET.viaLeadP95Ms}`)
  assert.ok(noteBytes <= BUDGET.noteBytes && manyBytes <= BUDGET.noteBytes, `the note is ${noteBytes} B at ${CHILDREN}, ${manyBytes} B at ${MANY}; the budget is ${BUDGET.noteBytes}`)
  assert.ok(result.noteAtMany.buildMs.p95 <= BUDGET.noteP95Ms, `the note builds in ${result.noteAtMany.buildMs.p95} ms at ${MANY}`)
  console.log("bench orch-route: ok")
} finally {
  await world.close()
  rmSync(root, { recursive: true, force: true })
}
