import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentsStartResult } from "@mako/host/contracts/agent-tools"
import { AgentsWorld } from "./lib/agents-world.ts"

/**
 * Starts against stops, generated (`npm run test:start-interleavings`): seeded schedules of starts, starts again with
 * the same key, starts of other keys, stops by name, stops of all, preparations that fail or resolve in any order and
 * host crashes, each step a few milliseconds after the last. After each schedule: at most one Fin per key, no Fin open
 * that a stop came after without a start after it, every call answered once, and nothing left held by a start.
 */
const SCHEDULES = Number(process.env.SCHEDULES ?? 96)
const KEYS = ["alpha", "beta", "gamma"] as const
type Key = (typeof KEYS)[number]

function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

interface Gate {
  resolve(): void
  reject(error: Error): void
}

type Step =
  | { kind: "start"; key: Key; queue: boolean }
  | { kind: "stop"; key: Key }
  | { kind: "stop-all" }
  | { kind: "resolve" }
  | { kind: "fail" }
  | { kind: "crash" }

function schedule(next: () => number): Step[] {
  const steps: Step[] = []
  const pick = <T,>(items: readonly T[]) => items[Math.floor(next() * items.length)]!
  for (let at = 0; at < 14; at += 1) {
    const roll = next()
    if (roll < 0.4) steps.push({ kind: "start", key: pick(KEYS), queue: next() < 0.5 })
    else if (roll < 0.52) steps.push({ kind: "stop", key: pick(KEYS) })
    else if (roll < 0.6) steps.push({ kind: "stop-all" })
    else if (roll < 0.8) steps.push({ kind: "resolve" })
    else if (roll < 0.92) steps.push({ kind: "fail" })
    else steps.push({ kind: "crash" })
  }
  return steps
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check: () => boolean, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await sleep(10)
  }
}

async function run(seed: number, root: string): Promise<void> {
  const next = random(seed)
  const steps = schedule(next)
  const limit = seed % 3 === 0 ? 1 : 4
  const gates: Gate[] = []
  const w = new AgentsWorld({
    root: join(root, `seed-${seed}`),
    finLimit: () => limit,
    preparing: () => new Promise<void>((resolve, reject) => gates.push({ resolve, reject })),
    script: async (turn) => {
      if (turn.text.includes("You're fin:")) await turn.world.hold(turn.conversation)
      return "ok"
    },
  })
  const take = (which: "first" | "any") => {
    if (!gates.length) return undefined
    const at = which === "first" ? 0 : Math.floor(next() * gates.length)
    return gates.splice(at, 1)[0]
  }
  const calls: { key: Key; at: number; answer: Promise<AgentsStartResult>; settled?: AgentsStartResult | Error }[] = []
  const stops: { key?: Key; at: number }[] = []
  const trace: string[] = []
  try {
    const apex = await w.apex("claude")
    for (const [at, step] of steps.entries()) {
      trace.push(JSON.stringify(step))
      if (step.kind === "start") {
        const call: (typeof calls)[number] = { key: step.key, at, answer: w.agents.start(apex.caller, { brief: { objective: "Hold" }, name: step.key, clientKey: step.key, cwd: w.root, ...(step.queue && { queue: true }) }) }
        call.answer.then((answer) => (call.settled = answer), (error: Error) => (call.settled = error))
        calls.push(call)
      } else if (step.kind === "stop") {
        stops.push({ key: step.key, at })
        await w.agents.stop(apex.caller, { child: step.key })
      } else if (step.kind === "stop-all") {
        stops.push({ at })
        await w.agents.stop(apex.caller, { child: "all" })
      } else if (step.kind === "resolve") take("any")?.resolve()
      else if (step.kind === "fail") take("any")?.reject(new Error("its worktree couldn't be made"))
      else {
        // A crash takes every preparation under way with it; the next host starts from the store.
        const before = w.agents
        await until(() => {
          for (const gate of gates.splice(0)) gate.reject(new Error("the host stopped"))
          return before.startsUnderWay() === 0 && calls.every((call) => call.settled !== undefined)
        }, "the old host's starts to end")
        await w.restart()
      }
      await sleep(Math.floor(next() * 12))
    }
    // Every preparation left comes back, one after another.
    await until(() => {
      take("first")?.resolve()
      return calls.every((call) => call.settled !== undefined) && !gates.length
    }, "every start to be answered")
    await until(() => w.agents.startsUnderWay() === 0 && !gates.length, "every start's record to settle")
    const edges = w.store.edges().all
    const keyOf = (op: string) => op.slice(op.lastIndexOf(":") + 1)
    for (const key of KEYS) {
      const mine = edges.filter((edge) => keyOf(edge.op) === key)
      assert.ok(mine.length <= 1, `one Fin per key: ${key} has ${mine.length}`)
      const open = mine.find((edge) => !edge.closedAt)
      const lastStop = Math.max(-1, ...stops.filter((stop) => stop.key === undefined || stop.key === key).map((stop) => stop.at))
      if (open) assert.ok(calls.some((call) => call.key === key && call.at > lastStop), `${key} is open though a stop at step ${lastStop} came after every start of it`)
    }
    for (const call of calls) assert.ok(call.settled !== undefined && !(call.settled instanceof Error), `every call is answered: ${call.key} at step ${call.at}: ${String(call.settled)}`)
    assert.equal(w.agents.startsUnderWay(), 0, "no start left holding a name, a place or a stop")
    assert.ok(w.agents.diagnostics().running <= limit, `no place booked twice: ${w.agents.diagnostics().running} running of ${limit}`)
  } catch (error) {
    throw new Error(`seed ${seed} (limit ${limit}): ${error instanceof Error ? error.message : String(error)}\n  ${trace.join("\n  ")}`)
  } finally {
    for (const gate of gates.splice(0)) gate.resolve()
    await w.close()
  }
}

/** The schedule a review found: the same key started twice while the first prepares, then stop-all, then each preparation ends in turn. */
async function sameKeyThenStopAll(root: string): Promise<void> {
  const gates: (() => void)[] = []
  const w = new AgentsWorld({
    root: join(root, "same-key"),
    finLimit: () => 3,
    preparing: () => new Promise<void>((resolve) => gates.push(resolve)),
    script: async (turn) => {
      if (turn.text.includes("You're fin:")) await turn.world.hold(turn.conversation)
      return "ok"
    },
  })
  try {
    const apex = await w.apex("claude")
    const input = { name: "job", clientKey: "same-key", brief: { objective: "Hold" }, cwd: w.root }
    const first = w.agents.start(apex.caller, input)
    await until(() => gates.length === 1, "the first to prepare")
    const again = w.agents.start(apex.caller, input)
    await sleep(30)
    assert.equal(gates.length, 1, "the same key joins the start under way; it doesn't prepare again")
    const stopped = await w.agents.stop(apex.caller, { child: "all" })
    assert.deepEqual("stopped" in stopped && stopped.stopped, ["job"])
    gates.shift()!()
    await sleep(30)
    const answers = await Promise.all([first, again])
    for (const answer of answers) assert.ok("refused" in answer && /stopped it before it started/.test(answer.why), `each call hears it was stopped: ${JSON.stringify(answer)}`)
    assert.equal(w.store.edges().all.some((edge) => !edge.closedAt), false, "no Fin is open after the stop")
    assert.equal(w.prompts.filter((prompt) => prompt.text.includes("You're fin:")).length, 0, "and no brief went out")
    assert.equal(w.agents.startsUnderWay(), 0)
  } finally {
    for (const gate of gates) gate()
    await w.close()
  }
}

const root = mkdtempSync(join(tmpdir(), "mako-start-interleavings-"))
try {
  await sameKeyThenStopAll(root)
  for (let seed = 1; seed <= SCHEDULES; seed += 1) await run(seed, root)
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(`start interleavings: ${SCHEDULES} generated schedules, one Fin per key, none after a stop, every start answered, nothing left held`)
