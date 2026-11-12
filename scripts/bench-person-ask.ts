import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { monitorEventLoopDelay, performance } from "node:perf_hooks"
import { FROM_AGENTS } from "@mako/host/conversations/agent-wakes"
import { AgentsWorld } from "./lib/agents-world.ts"

/*
 * What an Apex's row costs as its conversation streams, with a tree as large as the person's on 2026-11-11 (57 Fins
 * under three Apexes): `npm run bench:person-ask`.
 *
 * Every batch an Apex's conversation flushes is checked against its row (`SessionPublisher.shown`), and every report of
 * the account's list makes its row (`ownedSessions`); both ask `Agents.personAsk` what of its Fins waits on the person.
 * The host's own profiles that day named that walk (`personAsk < look < stateOf < childReading`) in holds of 0.3-0.6 s a
 * batch. Here each Apex streams BATCHES batches, each asking once as the publisher does, while some of its Fins work,
 * some wait on a decision of the person's and some have finished; the loop's delay is measured across it. Fails when a
 * batch's ask costs more than `BUDGET.askP99Ms` at the 99th percentile or the loop holds past `BUDGET.loopMaxMs`.
 */
const APEXES = 3
const EACH = 19
const BATCHES = 300
const BUDGET = { askP99Ms: 5, loopMaxMs: 100 }

const root = mkdtempSync(join(tmpdir(), "mako-person-ask-"))
let release: () => void = () => {}
const held = new Promise<void>((resolve) => (release = resolve))
const world = new AgentsWorld({
  root,
  finLimit: () => 64,
  finCeiling: () => 64,
  script: async (turn) => {
    if (turn.text.startsWith(FROM_AGENTS) || !turn.text.includes("You're fin:")) return "ok"
    const part = Number(/part-(\d+)/.exec(turn.text)?.[1] ?? 0)
    await turn.world.agents.report(turn.caller, { status: "progress", summary: `Part ${part} is under way.`, clientKey: "progress" })
    if (part % 3 === 1) {
      await turn.world.agents.report(turn.caller, { status: "done", summary: `Part ${part} is ready to land.`, question: `Merge part ${part}?`, options: [{ label: "Merge" }, { label: "Leave open" }], decides: "person", clientKey: "decide" })
      return "Done."
    }
    if (part % 3 === 2) {
      await turn.world.agents.report(turn.caller, { status: "done", summary: `Part ${part} is done.`, clientKey: "done" })
      return "Done."
    }
    // The rest work all through.
    await held
    return "Done."
  },
})

const percentile = (values: number[], at: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * at))] ?? 0
const round = (ms: number) => Math.round(ms * 100) / 100

try {
  const apexes = await Promise.all(Array.from({ length: APEXES }, (_, index) => world.apex(index % 2 ? "codex" : "claude", "full")))
  for (let i = 0; i < EACH; i += 1)
    for (const apex of apexes) {
      const started = await world.agents.start(apex.caller, { brief: { objective: `Review part-${i}.` }, harness: "codex", name: `part-${i}`, clientKey: `part-${i}`, cwd: root, mode: "background", wake: "finish" })
      assert.ok(!("refused" in started), JSON.stringify(started))
    }
  // Settled when every Fin is listed and each that finishes has: the rest work on until the end.
  const finished = () => apexes.every((apex) => world.agents.roster(apex.conversation).filter((entry) => entry.child?.state?.kind === "ended").length >= Math.floor((EACH * 2) / 3))
  for (const deadline = Date.now() + 120_000; !finished(); ) {
    if (Date.now() > deadline) throw new Error("The Fins didn't finish in two minutes")
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  const fins = apexes.reduce((count, apex) => count + world.agents.roster(apex.conversation).length, 0)
  assert.equal(fins, APEXES * EACH)
  const asking = apexes.map((apex) => world.agents.personAsk(apex.conversation))
  assert.ok(asking.every((found) => found !== undefined), "each Apex's row waits on a decision of its Fins'")

  const asks: number[] = []
  const delay = monitorEventLoopDelay({ resolution: 5 })
  delay.enable()
  const began = performance.now()
  for (let batch = 0; batch < BATCHES; batch += 1)
    for (const apex of apexes) {
      // A batch of the Apex's conversation, then the publisher's check of its row against it.
      world.live.observe({ type: "live-update", id: apex.conversation, update: { kind: "text", text: `Token ${batch}. ` } })
      const at = performance.now()
      world.agents.personAsk(apex.conversation)
      asks.push(performance.now() - at)
      if (batch % 10 === 0) await new Promise((resolve) => setImmediate(resolve))
    }
  const tookMs = performance.now() - began
  delay.disable()
  const result = {
    fins,
    batches: asks.length,
    ask: { meanMs: round(asks.reduce((sum, ms) => sum + ms, 0) / asks.length), p50Ms: round(percentile(asks, 0.5)), p99Ms: round(percentile(asks, 0.99)), maxMs: round(Math.max(...asks)) },
    totalMs: Math.round(tookMs),
    loop: { p99Ms: Math.round(delay.percentile(99) / 1e5) / 10, maxMs: Math.round(delay.max / 1e5) / 10 },
  }
  console.log(JSON.stringify(result))
  assert.ok(result.ask.p99Ms <= BUDGET.askP99Ms, `an Apex's batch spent ${result.ask.p99Ms} ms at the 99th percentile on its Fins; the budget is ${BUDGET.askP99Ms}`)
  assert.ok(result.loop.maxMs <= BUDGET.loopMaxMs, `the loop held ${result.loop.maxMs} ms; the budget is ${BUDGET.loopMaxMs}`)
  console.log("bench person-ask: ok")
} finally {
  release()
  await world.close()
  rmSync(root, { recursive: true, force: true })
}
