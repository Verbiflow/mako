import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FROM_AGENTS } from "@mako/host/contracts/children"
import { AgentsWorld, type Script } from "./lib/agents-world.ts"

/**
 * The two ways an Apex and its Fins can talk themselves into the ground (`npm run test:comms-storm`), on a scratch host
 * with every harness a scripted model:
 *
 * - **Interruption.** An Apex busy on a long turn while 30 Fins finish around it. How often is it steered while it
 *   works, how much of its turn runs uninterrupted, how many turns does it take once free, and how long does the
 *   longest result wait to reach it?
 * - **Backlog.** A Fin busy on a long turn while its Apex, the person and Mako each leave it something. How many turns
 *   does it take to hear all of it once free, and does each message arrive exactly once?
 *
 * Each measure is held to a target (`INVARIANTS`). Where Mako doesn't meet one yet, `EXPECTED_FAILING` says so, and the
 * test fails if a target's result differs from what's expected, either way: a change that meets one flips it here.
 * Every number goes to `BENCH {…}` on stdout and to `$COMMS_STORM_OUT` when set, so a PR can quote before and after.
 */

const FINS = 30
/** How long the Apex's own turn runs while its Fins finish: the storm happens inside it. */
const APEX_TURN_MS = 45_000
/** The Fins finish spread over this much of the Apex's turn. */
const SPREAD_MS = 30_000
/** After the Apex's turn ends, how long the bench watches it take what waited. */
const AFTER_MS = 20_000
/** The shortest stretch of a turn that counts as time to think, uninterrupted. */
const THINK_MS = 10_000

type Invariant = "apexSteersPerMinute" | "apexThinkShare" | "apexTurnsPerMinuteAfter" | "resultWaitMaxMs" | "finBacklogTurns"
type Bound = { max: number } | { min: number }
interface Measure { name: Invariant; value: number; target: string; ok: boolean }

const INVARIANTS = {
  /** Unrequested steers into the Apex's running turn per minute of it. */
  apexSteersPerMinute: { max: 1 },
  /** The share of the Apex's running turn spent in uninterrupted stretches of at least `THINK_MS`. */
  apexThinkShare: { min: 0.8 },
  /** Turns the Apex takes per minute once its own turn ends, while the storm's results arrive. */
  apexTurnsPerMinuteAfter: { max: 3 },
  /** The longest any Fin's result waits between its report and the Apex hearing it, in ms. */
  resultWaitMaxMs: { max: APEX_TURN_MS + 5_000 },
  /** Turns a Fin takes, once its long turn ends, to hear what its Apex, the person and Mako left it meanwhile. */
  finBacklogTurns: { max: 1 },
} satisfies Record<Invariant, Bound>

/**
 * What Mako doesn't meet yet, each with a ceiling it mustn't get worse than: each later PR that meets a target removes
 * it, or tightens its ceiling, and the test then holds it there.
 */
const EXPECTED_FAILING = new Map<Invariant, Bound>([["finBacklogTurns", { max: 3 }]])

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(what: string, done: () => boolean, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await delay(20)
  }
}

const root = mkdtempSync(join(tmpdir(), "mako-comms-storm-"))
const measures: Measure[] = []
const record = (name: Invariant, value: number) => {
  const bound: Bound = INVARIANTS[name]
  const ok = "max" in bound ? value <= bound.max : value >= bound.min
  measures.push({ name, value: Math.round(value * 1000) / 1000, target: "max" in bound ? `≤ ${bound.max}` : `≥ ${bound.min}`, ok })
}

/** An Apex on a harness that takes steers at a step, busy for `APEX_TURN_MS` while 30 Fins report done, spread out. */
async function interruption(): Promise<void> {
  const finished = new Map<string, number>()
  const fins = new Set<string>()
  // The Fins' finishes start together when the bench releases them, once the Apex's long turn runs: a Fin finishing
  // early would wake an idle Apex and measure nothing.
  let release: () => void = () => {}
  const released = new Promise<void>((resolve) => { release = resolve })
  const script: Script = async (turn) => {
    if (fins.has(turn.conversation) || turn.text.includes("You're fin:")) {
      fins.add(turn.conversation)
      const part = /Part (\d+)/.exec(turn.text)?.[1]
      if (!part) return "ok"
      await released
      await delay((Number(part) / FINS) * SPREAD_MS)
      finished.set(part, Date.now())
      return `Done: part ${part} checked.`
    }
    if (turn.text.includes("Long work")) await turn.world.hold(turn.conversation)
    return "Noted."
  }
  const world = new AgentsWorld({ root: join(root, "interruption"), script, finLimit: () => 64, steering: { claude: { lands: "step", hears: "at its next step" } } })
  try {
    const apex = await world.apex("claude", "full")
    for (let index = 1; index <= FINS; index += 1) {
      const started = await world.agents.start(apex.caller, { brief: { objective: `Part ${index}: check it.` }, harness: "codex", name: `part-${index}`, clientKey: `p${index}`, cwd: world.root })
      assert.ok(!("refused" in started), JSON.stringify(started))
    }
    world.say(apex.conversation, "Long work: plan the release.")
    await until("the Apex's long turn", () => world.live.session(apex.conversation)?.status === "running")
    const running = world.live.snapshot(apex.conversation)?.requests.filter((request) => request.status === "dispatching") ?? []
    assert.ok(running.length === 1 && running[0]!.text.includes("Long work"), `the Apex's running turn is its long work: ${JSON.stringify(running.map((request) => request.text.slice(0, 80)))}`)
    const began = Date.now()
    release()
    await delay(APEX_TURN_MS)
    const ended = Date.now()
    world.release(apex.conversation)
    await delay(AFTER_MS)
    await world.settle(500, 60_000, "ignore")

    const steers = world.steers.filter((steer) => steer.conversation === apex.conversation && steer.at >= began && steer.at <= ended).map((steer) => steer.at)
    record("apexSteersPerMinute", steers.length / ((ended - began) / 60_000))
    // The turn split at each steer: the share spent in stretches long enough to think in.
    const cuts = [began, ...steers, ended]
    let thinking = 0
    for (let index = 1; index < cuts.length; index += 1) if (cuts[index]! - cuts[index - 1]! >= THINK_MS) thinking += cuts[index]! - cuts[index - 1]!
    record("apexThinkShare", thinking / (ended - began))
    const apexTurns = world.prompts.filter((prompt) => prompt.conversation === apex.conversation && prompt.at > ended && prompt.at <= ended + AFTER_MS)
    record("apexTurnsPerMinuteAfter", apexTurns.length / (AFTER_MS / 60_000))
    // Each part's result: when the Apex first heard it, by a turn or a steer.
    const heard = [...world.prompts.filter((prompt) => prompt.conversation === apex.conversation), ...world.steers.filter((steer) => steer.conversation === apex.conversation)]
      .filter((entry) => entry.text.includes(FROM_AGENTS))
    let longest = 0
    for (const [part, at] of finished) {
      const first = heard.filter((entry) => entry.text.includes(`"part-${part}"`)).map((entry) => entry.at).sort((left, right) => left - right)[0]
      assert.ok(first !== undefined, `part ${part}'s result reached its Apex`)
      longest = Math.max(longest, first - at)
    }
    assert.equal(finished.size, FINS, "every Fin finished")
    record("resultWaitMaxMs", longest)
  } finally {
    await world.close()
  }
}

/** A Fin busy on a long turn while its Apex sends three messages, the person writes in its Thread and Mako leaves a note. */
async function backlog(): Promise<void> {
  let fin = ""
  const script: Script = async (turn) => {
    if (turn.conversation === fin && turn.text.includes("Long work")) await turn.world.hold(turn.conversation)
    return "ok"
  }
  const world = new AgentsWorld({ root: join(root, "backlog"), script })
  try {
    const apex = await world.apex("claude", "full")
    const started = await world.agents.start(apex.caller, { brief: { objective: "Build the thing." }, harness: "codex", name: "builder", clientKey: "builder", cwd: world.root })
    assert.ok(!("refused" in started) && started.conversation)
    fin = started.conversation!
    await world.settle(300, 20_000, "ignore")
    world.say(fin, "Long work: the migration.")
    await until("the Fin's long turn", () => world.live.session(fin)?.status === "running")
    const words = ["Apex one: also the docs.", "Apex two: skip the changelog.", "Apex three: land after #12."]
    for (const [index, text] of words.entries()) {
      const sent = await world.agents.send(apex.caller, { to: "builder", text, clientKey: `backlog-${index}` })
      assert.ok(!("refused" in sent), JSON.stringify(sent))
    }
    world.say(fin, "Person: use the staging database.")
    world.live.submit(fin, randomUUID(), "Mako: your wait on fin:docs ended: it finished.", [], undefined, undefined, undefined, { kind: "service", name: "turn-wait" })
    const before = world.prompts.filter((prompt) => prompt.conversation === fin).length
    world.release(fin)
    await world.settle(500, 30_000, "ignore")
    const turns = world.prompts.filter((prompt) => prompt.conversation === fin).slice(before)
    for (const text of [...words, "Person: use the staging database.", "Mako: your wait on fin:docs ended"])
      assert.equal(turns.filter((turn) => turn.text.includes(text)).length, 1, `${text} reached the Fin exactly once`)
    record("finBacklogTurns", turns.length)
  } finally {
    await world.close()
  }
}

try {
  await interruption()
  await backlog()
  const out = { fins: FINS, apexTurnMs: APEX_TURN_MS, spreadMs: SPREAD_MS, afterMs: AFTER_MS, thinkMs: THINK_MS, measures }
  console.log(`BENCH ${JSON.stringify(out)}`)
  if (process.env.COMMS_STORM_OUT) writeFileSync(process.env.COMMS_STORM_OUT, `${JSON.stringify(out, null, 2)}\n`)
  for (const measure of measures) console.log(`${measure.ok ? "meets" : "misses"} ${measure.name}: ${measure.value} (target ${measure.target})`)
  const within = (value: number, bound: Bound) => ("max" in bound ? value <= bound.max : value >= bound.min)
  const surprises = measures.flatMap((measure) => {
    const ceiling = EXPECTED_FAILING.get(measure.name)
    if (!ceiling) return measure.ok ? [] : [`${measure.name} misses its target`]
    if (measure.ok) return [`${measure.name} now meets its target: take it out of EXPECTED_FAILING`]
    return within(measure.value, ceiling) ? [] : [`${measure.name} got worse than its baseline ceiling (${"max" in ceiling ? `≤ ${ceiling.max}` : `≥ ${ceiling.min}`})`]
  })
  assert.deepEqual(surprises, [], "every target is where it's expected")
  console.log("comms storm: ok")
} finally {
  rmSync(root, { recursive: true, force: true })
}
