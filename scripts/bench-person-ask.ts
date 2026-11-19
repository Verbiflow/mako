import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { monitorEventLoopDelay, performance } from "node:perf_hooks"
import { FROM_AGENTS } from "@mako/host/conversations/agent-wakes"
import { ThreadIdSchema } from "@mako/host/contracts/thread-identity"
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
 * batch's ask costs more than `BUDGET.askP99Ms` at the 99th percentile, or the loop holds past `BUDGET.loopMaxMs` more
 * than a yardstick beside it waited in the same window: a process of its own running none of Mako's code
 * (`lib/host-load-yardstick.mjs`, as `bench:host-load` calibrates), so a shared runner's stall, which stops both, isn't
 * read as the bench's. The ask is judged against a fixed piece of work timed beside it in the same process
 * (`reference`), never a fixed number of milliseconds, and a Fin reports every `REPORT_EVERY` batches through the engine,
 * as Fins at work do, so the walk is worked out again after each. A fixed 100 ms failed on main's gate (a hold of 104 ms beside test-watch-backend on its shard,
 * with the ask itself at 0.57 ms at the 99th percentile). `PERSON_ASK_INJECT_HOLD_MS` holds the loop that long mid-run,
 * to see a real hold still fail.
 */
const APEXES = 3
const EACH = 19
const BATCHES = 300
/** A Fin reports every this many batches, as Fins at work do: each report is a write of the store's, and moves its Fin. */
const REPORT_EVERY = 5
/**
 * An ask's 99th percentile against the same percentile of a fixed piece of work timed beside it in the same process
 * (`reference`): a runner's speed varies by several times between runs and slows both alike. A fixed 5 ms failed main
 * twice, at 5.46 ms, with no regression; the walk per Fin that the person's host held seconds on costs several times
 * this.
 */
const BUDGET = { askToReference: 40, loopMaxMs: 100 }

/** A fixed piece of work, long enough to time to a few percent (about a third of a millisecond on a Mac): objects made, read and dropped, as an ask does. */
function reference(): number {
  let sum = 0
  for (let index = 0; index < 12_000; index += 1) {
    const entry = { id: `fin-${index}`, state: { kind: index % 3 ? "working" : "ended" }, reports: [index, index + 1] }
    sum += entry.id.length + entry.reports.length + (entry.state.kind === "ended" ? 1 : 0)
  }
  return sum
}

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
  // The first Apex's Fins at work, each reporting in turn through the window.
  const working = world.agents.roster(apexes[0]!.conversation).flatMap((entry) => entry.child?.state?.kind === "working" ? [ThreadIdSchema.parse(entry.child.thread)] : [])
  assert.ok(working.length > 0, "some of its Fins work")
  const callerOf = (fin: string) => world.caller(world.store.thread(ThreadIdSchema.parse(fin))!.sessions.flatMap((session) => world.store.conversationsOf(session))[0]!)

  const yardstickOut = join(root, "yardstick.json")
  const yardstick = spawn(process.execPath, [join(import.meta.dirname, "lib/host-load-yardstick.mjs"), yardstickOut, "50"], { stdio: ["ignore", "inherit", "inherit"] })
  const yardstickDone = new Promise((done) => yardstick.once("exit", done))
  // Its heap made and its first ticks timed before the window opens.
  await new Promise((resolve) => setTimeout(resolve, 500))
  const inject = Number(process.env.PERSON_ASK_INJECT_HOLD_MS ?? 0)
  const asks: number[] = []
  const references: number[] = []
  let reported = 0
  const delay = monitorEventLoopDelay({ resolution: 5 })
  delay.enable()
  const began = performance.now()
  for (let batch = 0; batch < BATCHES; batch += 1)
    for (const apex of apexes) {
      // A batch of the Apex's conversation, then the publisher's check of its row against it.
      world.live.observe({ type: "live-update", id: apex.conversation, update: { kind: "text", text: `Token ${batch}. ` } })
      if (batch % REPORT_EVERY === 0 && apex === apexes[0]) {
        const fin = working[reported++ % working.length]!
        await world.agents.report(callerOf(fin), { status: "progress", summary: `Batch ${batch} under way.`, clientKey: `bench-${batch}` })
      }
      const at = performance.now()
      world.agents.personAsk(apex.conversation)
      asks.push(performance.now() - at)
      const from = performance.now()
      reference()
      references.push(performance.now() - from)
      if (batch % 10 === 0) await new Promise((resolve) => setImmediate(resolve))
      if (inject && batch === BATCHES / 2 && apex === apexes[0]) for (const until = performance.now() + inject; performance.now() < until; );
    }
  const tookMs = performance.now() - began
  delay.disable()
  yardstick.kill("SIGTERM")
  await yardstickDone
  const yardstickLate = Number(JSON.parse(readFileSync(yardstickOut, "utf8")).late.max)
  const result = {
    fins,
    batches: asks.length,
    reference: { p99Ms: round(percentile(references, 0.99)) },
    ask: { meanMs: round(asks.reduce((sum, ms) => sum + ms, 0) / asks.length), p50Ms: round(percentile(asks, 0.5)), p99Ms: round(percentile(asks, 0.99)), maxMs: round(Math.max(...asks)) },
    totalMs: Math.round(tookMs),
    loop: { p99Ms: Math.round(delay.percentile(99) / 1e5) / 10, maxMs: Math.round(delay.max / 1e5) / 10 },
    yardstick: { lateMaxMs: yardstickLate },
  }
  const loopLimit = BUDGET.loopMaxMs + yardstickLate
  console.log(JSON.stringify(result))
  const askLimit = BUDGET.askToReference * Math.max(result.reference.p99Ms, 0.01)
  assert.ok(result.ask.p99Ms <= askLimit, `an Apex's batch spent ${result.ask.p99Ms} ms at the 99th percentile on its Fins; the budget is ${BUDGET.askToReference} times a fixed piece of work's ${result.reference.p99Ms} ms beside it, ${round(askLimit)} ms`)
  assert.ok(result.loop.maxMs <= loopLimit, `the loop held ${result.loop.maxMs} ms; the budget is ${BUDGET.loopMaxMs} ms past the yardstick's worst wait in the same window, ${yardstickLate} ms`)
  console.log("bench person-ask: ok")
} finally {
  release()
  await world.close()
  rmSync(root, { recursive: true, force: true })
}
