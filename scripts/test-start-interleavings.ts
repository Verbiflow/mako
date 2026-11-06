import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentsStartResult } from "@mako/host/contracts/agent-tools"
import type { AgentCaller } from "@mako/host/contracts/agents"
import { z } from "zod"
import { spawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { AgentsWorld, fakeCatalog } from "./lib/agents-world.ts"

/**
 * Starts against stops, generated (`npm run test:start-interleavings`): seeded schedules of starts, starts again with
 * the same key, starts of other keys, stops by name, stops of all, preparations that fail or resolve in any order and
 * host crashes, each step a few milliseconds after the last. After each schedule: at most one Fin per key, no Fin open
 * that a stop came after without a start after it, every call answered once, and nothing left held by a start.
 */
const SCHEDULES = Number(process.env.SCHEDULES ?? 96)
/** Seeds a schedule once failed on, each run every time whatever `SCHEDULES` is: an engine they caught never comes back unseen. */
const FAILED_ONCE = [6, 12, 15, 24, 29, 117, 198]
const KEYS = ["alpha", "beta", "gamma", "delta", "epsilon"] as const
type Key = (typeof KEYS)[number]
/** What the per-step check reads of a queue row: whether it's held by a refusal or waits on other Fins. */
const QueuedRow = z.object({ refused: z.string().optional(), after: z.array(z.object({ name: z.string() })).optional() })

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
  | { kind: "halt" }
  | { kind: "link" }
  | { kind: "stop-linked" }
  | { kind: "crash" }

function schedule(next: () => number): Step[] {
  const steps: Step[] = []
  const pick = <T,>(items: readonly T[]) => items[Math.floor(next() * items.length)]!
  for (let at = 0; at < 14; at += 1) {
    const roll = next()
    if (roll < 0.4) steps.push({ kind: "start", key: pick(KEYS), queue: next() < 0.5 })
    else if (roll < 0.52) steps.push({ kind: "stop", key: pick(KEYS) })
    else if (roll < 0.6) steps.push({ kind: "stop-all" })
    else if (roll < 0.74) steps.push({ kind: "resolve" })
    else if (roll < 0.84) steps.push({ kind: "fail" })
    else if (roll < 0.89) steps.push({ kind: "halt" })
    else if (roll < 0.92) steps.push({ kind: "link" })
    else if (roll < 0.94) steps.push({ kind: "stop-linked" })
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
  // Tight tree budgets in some schedules, so the tree's running and started bounds bind as often as the device's.
  const budget = seed % 4 === 0 ? { running: 1, started: 3 } : seed % 4 === 1 ? { running: 2, started: 100 } : { running: 32, started: 100 }
  const gates: Gate[] = []
  const running = new Set<string>()
  // Runs a Thread's shell started and linked: real processes that take a few milliseconds to go after SIGTERM.
  const fake = fakeCatalog()
  const shells: { name: string; process: ChildProcess }[] = []
  const starts: number[] = []
  const halts: (() => void)[] = []
  const stopping: { done: boolean }[] = []
  const stop = (caller: AgentCaller, child: string) => {
    const held = { done: false }
    stopping.push(held)
    void w.agents.stop(caller, { child }).finally(() => (held.done = true))
  }
  const overlaps: number[] = []
  const w = new AgentsWorld({
    root: join(root, `seed-${seed}`),
    catalog: fake.catalog,
    budget,
    finLimit: () => limit,
    preparing: () => new Promise<void>((resolve, reject) => gates.push({ resolve, reject })),
    // A harness stops only when a step lets it: its turn runs on, shown stopped, until then.
    cancelling: () => new Promise<void>((resolve) => halts.push(resolve)),
    script: async (turn) => {
      if (!turn.text.includes("You're fin:")) return "ok"
      // What the harnesses run, not what the engine counts: never more turns at once than the device runs.
      // It starts only below the device's number, counting the linked runs whose processes still go.
      starts.push(running.size + shells.filter((shell) => shell.process.exitCode === null && shell.process.signalCode === null).length)
      running.add(turn.conversation)
      overlaps.push(running.size)
      await turn.world.hold(turn.conversation)
      running.delete(turn.conversation)
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
  /** What holds at every moment: no budget above its bound, and no waiter left behind a free place. */
  const holds = async (when: string) => {
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
    assert.ok(Math.max(0, ...overlaps) <= limit, `${when}: ${Math.max(...overlaps)} turns ran at once on a device that runs ${limit}`)
    assert.ok(starts.every((before) => before < limit), `${when}: a Fin started with ${Math.max(...starts)} already at work on a device that runs ${limit}`)
    const seen = w.agents.diagnostics()
    const rows = w.store.queuedSpawns()
    assert.ok(seen.running <= limit, `${when}: ${seen.running} running on a device that runs ${limit}`)
    for (const tree of seen.trees) {
      assert.ok(tree.running <= budget.running, `${when}: the tree runs ${tree.running} of its ${budget.running}`)
      assert.ok(tree.started <= budget.started, `${when}: the tree started ${tree.started} of its ${budget.started}, waiting ones counted`)
    }
    const treeRunning = Math.max(0, ...seen.trees.map((tree) => tree.running))
    if (seen.running < limit && treeRunning < budget.running)
      for (const row of rows) {
        const record = QueuedRow.parse(JSON.parse(row.record))
        if (record.refused || record.after?.length) continue
        assert.ok(w.agents.startUnderWay(row.op), `${when}: a waiter sits behind a free place (${seen.running} of ${limit} running)`)
      }
  }
  const answered = (answer: AgentsStartResult, when: string) => {
    if ("refused" in answer) return
    assert.ok(answer.tree.running <= answer.tree.of.running && answer.tree.started <= answer.tree.of.started, `${when}: an answer took more than its tree's budget: ${JSON.stringify(answer.tree)}`)
  }
  try {
    const apex = await w.apex("claude")
    for (const [at, step] of steps.entries()) {
      trace.push(JSON.stringify(step))
      if (step.kind === "start") {
        const call: (typeof calls)[number] = { key: step.key, at, answer: w.agents.start(apex.caller, { brief: { objective: "Hold" }, name: step.key, clientKey: step.key, cwd: w.root, ...(step.queue && { queue: true }) }) }
        call.answer.then((answer) => {
          call.settled = answer
          answered(answer, `${step.key}'s start at step ${at}`)
        }, (error: Error) => (call.settled = error))
        calls.push(call)
      } else if (step.kind === "stop") {
        stops.push({ key: step.key, at })
        stop(apex.caller, step.key)
      } else if (step.kind === "stop-all") {
        stops.push({ at })
        stop(apex.caller, "all")
      } else if (step.kind === "resolve") take("any")?.resolve()
      else if (step.kind === "fail") take("any")?.reject(new Error("its worktree couldn't be made"))
      else if (step.kind === "halt") halts.splice(Math.floor(next() * halts.length), 1)[0]?.()
      else if (step.kind === "link") {
        // Linked only while the device and the tree have room: a link is adopted whatever the limits, so the schedule keeps within them.
        const seen = w.agents.diagnostics()
        if (seen.running < limit && seen.trees.every((tree) => tree.running < budget.running && tree.started < budget.started)) {
          const exitMs = Math.floor(next() * 60)
          const shell = spawn(process.execPath, ["-e", `process.on("SIGTERM", () => setTimeout(() => process.exit(0), ${exitMs})); console.log("ready"); setInterval(() => {}, 1000)`], { detached: true, stdio: ["ignore", "pipe", "ignore"] })
          await new Promise<void>((resolve) => shell.stdout!.once("data", () => resolve()))
          const name = `shell-${shells.length}`
          shells.push({ name, process: shell })
          const nativeId = randomUUID()
          fake.write({ harness: "claude", nativeId, path: join(w.root, `${name}.jsonl`), cwd: w.root, startedAt: new Date().toISOString() }, [{ type: "tool", id: "one", name: "Bash", input: "{}", status: "completed" }])
          await w.agents.link(apex.caller, { harness: "claude", session: nativeId, pid: shell.pid!, name })
        }
      } else if (step.kind === "stop-linked") {
        const shell = shells.find((each) => each.process.exitCode === null && each.process.signalCode === null)
        if (shell) stop(apex.caller, shell.name)
      }
      else {
        // A crash takes every preparation under way, and every turn, with it; the next host starts from the store.
        running.clear()
        const before = w.agents
        await until(() => {
          for (const gate of gates.splice(0)) gate.reject(new Error("the host stopped"))
          for (const halt of halts.splice(0)) halt()
          return before.startsUnderWay() === 0 && calls.every((call) => call.settled !== undefined) && stopping.every((held) => held.done)
        }, "the old host's starts to end")
        await w.restart()
      }
      await sleep(Math.floor(next() * 12))
      await holds(`after step ${at}`)
    }
    // Every preparation left comes back, one after another.
    for (let left = 0; gates.length || halts.length || calls.some((call) => call.settled === undefined) || stopping.some((held) => !held.done); left += 1) {
      take("first")?.resolve()
      halts.shift()?.()
      await sleep(5)
      await holds(`resolving what's left (${left})`)
      if (left > 2_000) throw new Error("every start to be answered: still waiting")
    }
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
    throw new Error(`seed ${seed} (limit ${limit}): ${error instanceof Error ? error.message : String(error)}\n  ${trace.join("\n  ")}`, { cause: error })
  } finally {
    for (const gate of gates.splice(0)) gate.resolve()
    for (const halt of halts.splice(0)) halt()
    for (const shell of shells) shell.process.kill("SIGKILL")
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

/**
 * Two starts of different keys deciding together take the tree's last running place or its last started one once:
 * the second is refused, never both admitted past the budget.
 */
async function budgetsTakenOnce(root: string, budget: { running: number; started: number }): Promise<void> {
  const gates: (() => void)[] = []
  const w = new AgentsWorld({
    root: join(root, `budget-${budget.running}-${budget.started}`),
    budget,
    finLimit: () => 4,
    preparing: () => new Promise<void>((resolve) => gates.push(resolve)),
    script: async (turn) => {
      if (turn.text.includes("You're fin:")) await turn.world.hold(turn.conversation)
      return "ok"
    },
  })
  try {
    const apex = await w.apex("claude")
    const start = (clientKey: string) => w.agents.start(apex.caller, { brief: { objective: "Hold" }, name: clientKey, clientKey, cwd: w.root })
    const [one, two] = [start("one"), start("two")]
    const refused = await Promise.race([one, two].map((answer) => answer.then((settled) => ("refused" in settled ? settled : undefined))))
    await until(() => gates.length >= 1, "a start to prepare")
    await sleep(30)
    assert.equal(gates.length, 1, `only one start takes the tree's last place (${JSON.stringify(budget)})`)
    for (const gate of gates.splice(0)) gate()
    const answers = await Promise.all([one, two])
    const taken = answers.filter((answer) => !("refused" in answer))
    assert.equal(taken.length, 1, JSON.stringify(answers))
    assert.ok(refused === undefined || refused.refused === "budget")
    for (const answer of taken) if (!("refused" in answer)) assert.ok(answer.tree.running <= answer.tree.of.running && answer.tree.started <= answer.tree.of.started, JSON.stringify(answer.tree))
  } finally {
    for (const gate of gates) gate()
    await w.close()
  }
}

/**
 * A direct start whose preparation fails gives its place back to the waiter behind it from that failure, with no other
 * event: with no room watch, a waiter that starts at all started from the failure.
 */
async function failedStartFreesItsPlace(root: string): Promise<void> {
  let fail: (error: Error) => void = () => {}
  const prepared = new Map<string, number>()
  const w = new AgentsWorld({
    root: join(root, "failed-frees"),
    noRoomWatch: true,
    finLimit: () => 1,
    preparing: (options) => {
      prepared.set(options.parent!.name, performance.now())
      return options.parent!.name === "first" ? new Promise<void>((_, reject) => (fail = reject)) : undefined
    },
    script: async () => "Done",
  })
  try {
    const apex = await w.apex("claude")
    const first = w.agents.start(apex.caller, { brief: { objective: "Work" }, name: "first", clientKey: "first", cwd: w.root })
    await until(() => prepared.has("first"), "the first to prepare")
    const second = await w.agents.start(apex.caller, { brief: { objective: "Work" }, name: "second", clientKey: "second", queue: true, cwd: w.root })
    assert.ok(!("refused" in second) && second.state === "queued", JSON.stringify(second))
    const failedAt = performance.now()
    fail(new Error("its worktree couldn't be made"))
    assert.ok("refused" in (await first))
    await until(() => prepared.has("second"), "the waiter to start from the failure itself")
    assert.ok(prepared.get("second")! >= failedAt, "after the failure freed its place")
  } finally {
    fail(new Error("cleanup"))
    await w.close()
  }
}

const root = mkdtempSync(join(tmpdir(), "mako-start-interleavings-"))
try {
  await sameKeyThenStopAll(root)
  await budgetsTakenOnce(root, { running: 1, started: 100 })
  await budgetsTakenOnce(root, { running: 4, started: 1 })
  await failedStartFreesItsPlace(root)
  for (const seed of [...Array.from({ length: SCHEDULES }, (_, at) => at + 1), ...FAILED_ONCE.filter((seed) => seed > SCHEDULES)]) await run(seed, root)
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(`start interleavings: ${SCHEDULES} generated schedules and the seeds that once failed, one Fin per key, none after a stop, every start answered, nothing left held`)
