import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { MachineReading } from "@mako/host/base/machine-load"
import { parseVerdicts, PERFORMANCE_VERDICT_VARIABLE } from "@mako/host/contracts/performance-verdict"
import { buildRepository, concluded, CONFIRM_ROUNDS, judge, MAX_ROUNDS, medianInterval, ROUNDS, settle, UNSURE_REPORTED_VARIABLE, type Machine, type Paired, type Settling } from "./perf-reference"

/**
 * Where a performance reference's history is read. A checkout reads its own;
 * Settings › Updates builds a copy with no `.git` in `<updates>/checkout`,
 * whose source the updater passes as `MAKO_BUILD_SOURCE`, or, from an
 * installed app that predates it, names in `<updates>/source.json`.
 */

const root = mkdtempSync(join(tmpdir(), "mako-perf-reference-"))
try {
  // Folders of its own, so the test reads the same wherever it runs, a build copy without `.git` included.
  const repository = join(root, "checkout-with-history")
  mkdirSync(join(repository, ".git"), { recursive: true })
  const updates = join(root, "updates")
  const copy = join(updates, "checkout")
  mkdirSync(copy, { recursive: true })

  assert.equal(buildRepository(repository, undefined), repository, "a checkout reads its own history")
  assert.equal(buildRepository(copy, "/somewhere/else"), "/somewhere/else", "the updater's MAKO_BUILD_SOURCE wins")
  assert.equal(buildRepository(copy, undefined), copy, "with nothing naming a source, the copy is all there is")

  writeFileSync(join(updates, "source.json"), JSON.stringify(repository))
  assert.equal(buildRepository(copy, undefined), repository, "an older updater's source.json names the checkout")

  writeFileSync(join(updates, "source.json"), JSON.stringify(join(root, "gone")))
  assert.equal(buildRepository(copy, undefined), copy, "a named checkout with no repository isn't taken")
  writeFileSync(join(updates, "source.json"), "{not json")
  assert.equal(buildRepository(copy, undefined), copy, "nor an unreadable record")
  console.log("PASS: a performance reference reads the history of the checkout, the updater's source, or the checkout source.json names")
} finally {
  rmSync(root, { recursive: true, force: true })
}

/*
 * A row is judged on its rounds' head over reference: wholly over the
 * allowance at 95% is slower and wholly under it within, busy or not; a quiet
 * machine's median under the allowance is within, and a row over it at the
 * median alone gets more rounds and then is unsure. The busy machine here is
 * simulated: readings that say other work holds most cores, and runs that
 * land on a slower core at random, as macOS places a whole process under load.
 */
const ALLOWED = 1.25
const row = (ratios: number[], busy: boolean): Paired => ({ key: "row", reference: ratios.map(() => 1), head: ratios, busy: ratios.map(() => busy) })

assert.equal(medianInterval([1, 2, 3]), undefined, "three rounds bound nothing at 95%")
assert.deepEqual(medianInterval([5, 1, 4, 2, 3]), [1, 5], "five rounds are bounded by their extremes")
assert.deepEqual(medianInterval(Array.from({ length: 15 }, (_, index) => 15 - index)), [4, 12], "fifteen by their fourth from either end")

assert.equal(judge(row([1.05, 0.98, 1.1], false), ALLOWED).outcome, "within", "a quiet machine's row under the allowance passes on its first rounds")
assert.equal(judge(row([1.4, 1.35, 1.38], false), ALLOWED).outcome, undefined, "one over on its first rounds is measured again")
assert.equal(judge(row([1.05, 1.1, 2.2], false), ALLOWED).outcome, undefined, "so is one whose median is under it with a round over it: twice as slow can read that way")
assert.equal(judge(row([1.4, 1.35, 1.38, 1.42, 1.3, 1.36, 1.39], false), ALLOWED).outcome, "slower", "and called slower when it stays over")
assert.equal(judge(row([1.05, 0.98, 1.1], true), ALLOWED).outcome, undefined, "a busy machine's median alone settles nothing")
assert.equal(judge(row([2.1, 1.9, 2.3, 2, 1.8], true), ALLOWED).outcome, "slower", "a real regression blocks however busy the machine")
assert.equal(judge(row(Array.from({ length: 15 }, (_, index) => [0.7, 1, 1.4][index % 3]!), true), ALLOWED, true).outcome, "unsure", "noise as wide as the allowance, on a busy machine out of time, is unsure")
// Unchanged code, as a quiet CI runner read it on 2026-11-05: over at the median, between -8% and +44%.
const ciNoise = [1.4, 1.36, 1.04, 1.385, 1, 0.92, 1.44]
assert.equal(judge(row(ciNoise, false), ALLOWED).outcome, undefined, "a quiet machine's median over the allowance alone isn't slower: it's measured again")
assert.equal(judge(row(Array.from({ length: 15 }, (_, index) => ciNoise[index % 7]!), false), ALLOWED).outcome, undefined, "fifteen rounds don't end it")
assert.equal(judge(row(Array.from({ length: MAX_ROUNDS }, (_, index) => ciNoise[index % 7]!), false), ALLOWED).outcome, "unsure", "and it's unsure when all of them can't settle it")
assert.equal(judge(row(ciNoise.map((ratio) => ratio * 2), false), ALLOWED).outcome, "slower", "twice as slow through that noise is slower")
// Seed 1085's fifteen rounds of the noise below as the shape of a row: most near twice, four down near the allowance.
const grossRounds = Array.from({ length: MAX_ROUNDS }, (_, index) => (index % 3 ? 1.76 : 1.21))
assert.equal(judge(row(grossRounds, false), ALLOWED).interval![0], 1.21, "an interval reaching under the allowance")
assert.equal(judge(row(grossRounds, false), ALLOWED).outcome, "slower", "doesn't let a median past twice the allowance go unsure")
assert.equal(judge(row(grossRounds.slice(0, 7), true), ALLOWED, true).outcome, "slower", "nor does running out of time")
assert.equal(judge(row(Array.from({ length: MAX_ROUNDS }, (_, index) => [0.7, 1.7, 1.7][index % 3]!), false), ALLOWED).outcome, "unsure", "though a median that high with rounds on both sides of the reference stays unsure")
console.log("PASS: a row is within, slower, measured again, or unsure, by its rounds and the machine")

/** The same pseudo-random draws every run, so the test reads the same wherever it runs. */
function draws(seed: number): () => number {
  let state = seed
  return () => ((state = (state * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
}

const quiet: MachineReading = { cores: 14, othersBusy: 1.2, loadAverage: 2, memory: "normal", thermal: "nominal" }
const loaded: MachineReading = { cores: 14, othersBusy: 12.6, loadAverage: 26.7, memory: "normal", thermal: "nominal" }
/** A machine busy for its first `busyReads` readings, quiet after; its waits take no time. */
function machine(busyReads: number): Machine & { reads: number; waited: number } {
  const state = {
    reads: 0,
    waited: 0,
    read: async () => (state.reads++ < busyReads ? loaded : quiet),
    wait: async (ms: number) => void (state.waited += ms),
  }
  return state
}

/** Head `slower` times the reference, each run 40% slower when it lands on a slow core: half the time while the machine is busy. */
function measurer(slower: number, box: ReturnType<typeof machine>, busyReads: number, random = draws(7)): Settling["measurer"] {
  return async () => async (tree) => {
    const core = box.reads <= busyReads && random() < 0.5 ? 1.4 : 1
    return { [KEY]: (tree === here ? slower : 1) * core * (0.97 + random() * 0.06) }
  }
}
const KEY = "merge/merge large (same)"
const here = dirname(import.meta.dirname)
const suspect = [{ key: KEY, at: "3c2c7d6d47f69afad7731e1023ba7b4d74662ea2", over: `${KEY}: over its baseline` }]
async function settled(slower: number, busyReads: number, quietWaitMs = 0, busyMeasureMs?: number) {
  const box = machine(busyReads)
  const said: string[] = []
  const result = await settle(suspect, {
    allowed: ALLOWED, rounds: ROUNDS, say: (line) => said.push(line), quietWaitMs, machine: box, busyMeasureMs,
    reference: async () => "/reference", measurer: measurer(slower, box, busyReads),
  })
  return { ...result, said: said.join("\n"), box }
}

const noise = await settled(1, Infinity)
assert.deepEqual(noise.failed, [], "unchanged code on a busy machine is never called slower")
assert.equal(noise.rows[0]!.outcome, "within", "more rounds, for as long as a busy machine gets them, settle what the first didn't")
assert.ok(noise.rows[0]!.rounds > ROUNDS + CONFIRM_ROUNDS && noise.rows[0]!.rounds <= MAX_ROUNDS, `it took ${noise.rows[0]!.rounds} rounds`)

const regression = await settled(2, Infinity)
assert.equal(regression.rows[0]!.outcome, "slower", "a real regression on a busy machine still fails")
assert.match(regression.failed[0]!, /^merge\/merge large \(same\): \+\d+% beside 3c2c7d6d .*between .*: slower$/)

const waited = await settled(1.1, 3, 60_000)
assert.equal(waited.box.waited, 30_000, "a busy machine is waited out, a reading every 10 seconds")
assert.match(waited.said, /This machine is busy \(other work kept 12\.6 of 14 cores busy\); waiting up to 60 s/)
assert.match(waited.said, /Quiet after 30 s/)
assert.equal(waited.rows[0]!.outcome, "within", "and measured quiet, 10% slower is within")
assert.equal(waited.rows[0]!.rounds, ROUNDS, "on its first rounds")

const impatient = await settled(1, Infinity, 30_000)
assert.match(impatient.said, /Still busy after 30 s .*measuring anyway, in up to 31 rounds/)

// Rounds on a busy machine have a time of their own, so a check with many rows ends inside the updater's.
const hurried = await settled(1, Infinity, 0, 0)
assert.equal(hurried.rows[0]!.outcome, "unsure", "out of time on a busy machine, an unsettled row is unsure")
assert.equal(hurried.rows[0]!.rounds, ROUNDS + CONFIRM_ROUNDS, "after the seven rounds that bound its median")
assert.match(hurried.said, /Measured for the 0 s a busy machine gets; rows it hasn't settled are unsure\./)
assert.equal(hurried.unsure.length, 1)
assert.deepEqual(hurried.busy, ["other work kept 12.6 of 14 cores busy"], "and the verdict says why")
assert.equal((await settled(2, Infinity, 0, 0)).rows[0]!.outcome, "slower", "a real regression is caught in those seven")
console.log("PASS: a busy machine is waited out, measured in more rounds for as long as it gets, and never fails unchanged code")

// A quiet machine as noisy as CI's runner, each run up to 30% either way: unchanged code is never slower, twice as slow always is.
const quietly = (slower: number, seed: number) => {
  const random = draws(seed)
  return settle(suspect, {
    allowed: ALLOWED, rounds: ROUNDS, say: () => {}, quietWaitMs: 0, machine: machine(0), reference: async () => "/reference",
    measurer: async () => async (tree) => ({ [KEY]: (tree === here ? slower : 1) * (1 + 0.3 * (random() * 2 - 1)) }),
  })
}
// Seed 1085 is the one that held a doubled row at unsure after fifteen rounds (+76%, between +21% and +104%).
const seeds = Array.from({ length: 2_000 }, (_, index) => index + 1)
const unchanged = await Promise.all(seeds.map((seed) => quietly(1, seed)))
assert.deepEqual(unchanged.flatMap((result) => result.failed), [], "unchanged code on a noisy quiet machine is never slower")
const doubled = await Promise.all(seeds.map((seed) => quietly(2, seed)))
assert.deepEqual(doubled.map((result) => result.rows[0]!.outcome).filter((outcome) => outcome !== "slower"), [], "twice as slow through the same noise always is")
console.log("PASS: on a quiet machine as noisy as CI's, unchanged code is never slower and a regression of twice always is")

// A busy machine's time cut short, at seven rounds, through the same noise: a row they didn't settle doesn't pass CI.
const cutShort = (slower: number, seed: number) => {
  const random = draws(seed)
  return settle(suspect, {
    allowed: ALLOWED, rounds: ROUNDS, say: () => {}, quietWaitMs: 0, machine: machine(Infinity), busyMeasureMs: 0, reference: async () => "/reference",
    measurer: async () => async (tree) => ({ [KEY]: (tree === here ? slower : 1) * (1 + 0.3 * (random() * 2 - 1)) }),
  })
}
const inCI = { [UNSURE_REPORTED_VARIABLE]: "1" }
// Seed 9 stops at seven rounds with a median of +49%, between +15% and +200%.
const nine = await cutShort(2, 9)
assert.equal(nine.rows[0]!.outcome, "unsure")
assert.equal(nine.rows[0]!.rounds, ROUNDS + CONFIRM_ROUNDS)
assert.match((await concluded("perf:decoders", nine, ALLOWED, null, inCI))[0]!, /the run was cut before its rounds could settle it$/, "CI fails it, and says the run was cut")
assert.deepEqual((await Promise.all(seeds.map(async (seed) => {
  const run = await cutShort(2, seed)
  return { seed, outcome: run.rows[0]!.outcome, passes: !(await concluded("perf:decoders", run, ALLOWED, null, inCI)).length }
}))).filter(({ outcome, passes }) => outcome !== "within" && passes), [], "twice as slow passes a cut run only as its first rounds' median")
assert.deepEqual(await concluded("perf:decoders", { ...nine, unsure: [`${KEY}: unsure`], cut: [] }, ALLOWED, null, inCI), [], "with all its rounds in, an unsure row is only reported")
process.env[UNSURE_REPORTED_VARIABLE] = "1"
try {
  let round = 0
  const measuredOn = await settle(suspect, {
    allowed: ALLOWED, rounds: ROUNDS, say: () => {}, quietWaitMs: 0, machine: machine(Infinity), reference: async () => "/reference",
    measurer: async () => async (tree) => ({ [KEY]: tree === here ? ciNoise[round++ % ciNoise.length]! : 1 }),
  })
  assert.equal(measuredOn.rows[0]!.rounds, MAX_ROUNDS, "CI gives a busy machine's row every round, the time it takes no limit")
} finally {
  delete process.env[UNSURE_REPORTED_VARIABLE]
}
console.log("PASS: a run cut short fails in CI, saying so, and CI itself doesn't cut one short")

const folder = mkdtempSync(join(tmpdir(), "mako-perf-verdict-"))
try {
  const file = join(folder, "verdict.jsonl")
  const busy = { ...hurried, unsure: [`${KEY}: unsure`], cut: [] }
  assert.deepEqual(await concluded("perf:decoders", busy, ALLOWED, file), [], "under the updater an unsure row doesn't fail the script")
  assert.deepEqual(await concluded("perf:decoders", regression, ALLOWED, file), regression.failed, "a slower one does")
  const verdicts = parseVerdicts(readFileSync(file, "utf8"))
  assert.deepEqual(verdicts.map((verdict) => verdict.rows[0]!.outcome), ["unsure", "slower"], "each conclusion is a line the updater reads")
  assert.deepEqual(verdicts[0]!.busy, ["other work kept 12.6 of 14 cores busy"])
  const underUpdater = process.env[PERFORMANCE_VERDICT_VARIABLE]
  process.env[PERFORMANCE_VERDICT_VARIABLE] = file
  try {
    assert.match((await concluded("perf:decoders", busy, ALLOWED, null, {}))[0]!, /unsure; measure it again on a quieter machine$/, "with nobody to choose, unsure fails, even under the updater")
    assert.deepEqual(await concluded("perf:decoders", busy, ALLOWED, null, { [UNSURE_REPORTED_VARIABLE]: "1" }), [], "in CI an unsure row is reported, not failed")
    assert.deepEqual(await concluded("perf:decoders", regression, ALLOWED, null, { [UNSURE_REPORTED_VARIABLE]: "1" }), regression.failed, "and a slower one fails there")
  } finally {
    if (underUpdater === undefined) delete process.env[PERFORMANCE_VERDICT_VARIABLE]
    else process.env[PERFORMANCE_VERDICT_VARIABLE] = underUpdater
  }
} finally {
  rmSync(folder, { recursive: true, force: true })
}
console.log("PASS: an unsure row is the updater's to decide, recorded with what was measured")
