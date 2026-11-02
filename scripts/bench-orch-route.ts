import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FROM_AGENTS } from "@mako/host/conversations/agent-wakes"
import { AgentsWorld } from "./lib/agents-world.ts"

/*
 * What the front door costs on the host (`npm run bench:orch-route`): an Apex
 * on Codex with CHILDREN finished Fins across five harnesses. In a Fin's tab,
 * the person writes in its own conversation; addressed, they write to a Fin
 * from the Apex's composer (`mako:agents-direct`), and no turn of the Apex's
 * runs; routed, they write to the Apex, whose scripted model passes the
 * message on (`agents_send`, forward) the moment its turn starts, so the
 * model's own time is left out (a real model adds its turn's seconds). Each is
 * timed from the send to the Fin's harness being handed the message, its
 * p50 and p95 against BUDGET; so is the front-door note the Apex hears
 * ahead of each message, its size and the time to build it at CHILDREN and
 * at MANY Fins. Between samples it waits for turns to end, not for the
 * Apex's wakes: each Fin's report wakes the Apex, and past six a minute
 * those wait their turn, so an Apex turn may run inside a sample as it would
 * for the person.
 */
const CHILDREN = 20
const MANY = 100
const SAMPLES = 30
const BUDGET = { inFinP95Ms: 50, addressedP95Ms: 50, routedP95Ms: 150, noteBytes: 4096, noteP95Ms: 5 }
const HARNESSES = ["claude", "cursor", "grok", "opencode", "devin"]

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!
}

const summary = (values: number[]) => ({ p50: percentile(values, 50), p95: percentile(values, 95), max: Math.max(...values) })

const root = mkdtempSync(join(tmpdir(), "mako-orch-route-"))
const marker = /route to (area-\d+)/
const children: string[] = []
const threads: string[] = []
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
  const apex = await world.apex("codex")
  for (let i = 0; i < CHILDREN; i += 1) {
    const started = await world.agents.start(apex.caller, { brief: { objective: `Own area ${i} of the app: its screens, its tests and its release notes.` }, harness: HARNESSES[i % HARNESSES.length]!, name: `area-${i}`, clientKey: `area-${i}`, cwd: root })
    assert.ok(!("refused" in started) && started.conversation, JSON.stringify(started))
    children.push(started.conversation!)
    threads.push(started.child!)
  }
  await world.settle(600, 120_000)

  const inFin: number[] = []
  const addressed: number[] = []
  const routed: number[] = []
  const apexTurns = () => world.prompts.filter((prompt) => prompt.conversation === apex.conversation && !prompt.text.startsWith(FROM_AGENTS)).length
  for (let i = 0; i < SAMPLES; i += 1) {
    const index = i % CHILDREN
    const child = children[index]!
    const plain = `In its tab, message ${i} for area ${index}.`
    const sentAt = Date.now()
    world.say(child, plain)
    inFin.push((await handed(child, plain)) - sentAt)
    await world.settle(300, 30_000, "ignore")
    const straight = `Addressed message ${i} for area ${index}.`
    const turnsBefore = apexTurns()
    const addressedAt = Date.now()
    const answer = await world.agents.direct(apex.conversation, { to: threads[index]!, request: randomUUID(), text: straight })
    assert.ok(!("refused" in answer), JSON.stringify(answer))
    addressed.push((await handed(child, straight)) - addressedAt)
    assert.equal(apexTurns(), turnsBefore, "a message addressed to a Fin runs no turn of the Apex's")
    await world.settle(300, 30_000, "ignore")
    const through = `Please route to area-${index}: message ${i}.`
    const askedAt = Date.now()
    world.say(apex.conversation, through)
    routed.push((await handed(child, through)) - askedAt)
    await world.settle(300, 30_000, "ignore")
  }

  const note = (conversation: string) => world.agents.frontDoor(conversation, { actor: undefined })
  const lines = note(apex.conversation)
  const noteBytes = Buffer.byteLength(lines.join("\n"))
  const build: number[] = []
  for (let i = 0; i < 200; i += 1) {
    const began = performance.now()
    note(apex.conversation)
    build.push(performance.now() - began)
  }
  const big = await world.apex("claude")
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
    inFinMs: summary(inFin),
    addressedMs: summary(addressed),
    routedMs: summary(routed),
    note: { bytes: noteBytes, approxTokens: Math.round(noteBytes / 4), buildMs: summary(build.map((ms) => Math.round(ms * 1000) / 1000)) },
    noteAtMany: { children: MANY, bytes: manyBytes, buildMs: summary(buildMany.map((ms) => Math.round(ms * 1000) / 1000)) },
    budget: BUDGET,
  }
  console.log(JSON.stringify(result, null, 2))
  assert.ok(result.inFinMs.p95 <= BUDGET.inFinP95Ms, `in a Fin's tab p95 ${result.inFinMs.p95} ms > ${BUDGET.inFinP95Ms}`)
  assert.ok(result.addressedMs.p95 <= BUDGET.addressedP95Ms, `addressed to a Fin p95 ${result.addressedMs.p95} ms > ${BUDGET.addressedP95Ms}`)
  assert.ok(result.routedMs.p95 <= BUDGET.routedP95Ms, `through the Apex p95 ${result.routedMs.p95} ms > ${BUDGET.routedP95Ms}`)
  assert.ok(noteBytes <= BUDGET.noteBytes && manyBytes <= BUDGET.noteBytes, `the note is ${noteBytes} B at ${CHILDREN}, ${manyBytes} B at ${MANY}; the budget is ${BUDGET.noteBytes}`)
  assert.ok(result.noteAtMany.buildMs.p95 <= BUDGET.noteP95Ms, `the note builds in ${result.noteAtMany.buildMs.p95} ms at ${MANY}`)
  console.log("bench orch-route: ok")
} finally {
  await world.close()
  rmSync(root, { recursive: true, force: true })
}
