import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { MachineReading } from "@mako/host/base/machine-load"
import { parseVerdicts } from "@mako/host/contracts/performance-verdict"
import { buildRepository, concluded, CONFIRM_ROUNDS, judge, MAX_ROUNDS, medianInterval, ROUNDS, settle, type Machine, type Paired, type Settling } from "./perf-reference"

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
 * machine's median decides the rest, and a busy machine's rows get more
 * rounds and then are unsure. The busy machine here is simulated: readings
 * that say other work holds most cores, and runs that land on a slower core
 * at random, as macOS places a whole process under load.
 */
const ALLOWED = 1.25
const row = (ratios: number[], busy: boolean): Paired => ({ key: "row", reference: ratios.map(() => 1), head: ratios, busy: ratios.map(() => busy) })

assert.equal(medianInterval([1, 2, 3]), undefined, "three rounds bound nothing at 95%")
assert.deepEqual(medianInterval([5, 1, 4, 2, 3]), [1, 5], "five rounds are bounded by their extremes")
assert.deepEqual(medianInterval(Array.from({ length: 15 }, (_, index) => 15 - index)), [4, 12], "fifteen by their fourth from either end")

assert.equal(judge(row([1.05, 0.98, 1.1], false), ALLOWED).outcome, "within", "a quiet machine's row under the allowance passes on its first rounds")
assert.equal(judge(row([1.4, 1.35, 1.38], false), ALLOWED).outcome, undefined, "one over on its first rounds is measured again")
assert.equal(judge(row([1.4, 1.35, 1.38, 1.42, 1.3, 1.36, 1.39], false), ALLOWED).outcome, "slower", "and called slower when it stays over")
assert.equal(judge(row([1.05, 0.98, 1.1], true), ALLOWED).outcome, undefined, "a busy machine's median alone settles nothing")
assert.equal(judge(row([2.1, 1.9, 2.3, 2, 1.8], true), ALLOWED).outcome, "slower", "a real regression blocks however busy the machine")
assert.equal(judge(row(Array.from({ length: 15 }, (_, index) => [0.7, 1, 1.4][index % 3]!), true), ALLOWED).outcome, "unsure", "noise as wide as the allowance, on a busy machine, is unsure")
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
assert.equal(noise.rows[0]!.rounds, MAX_ROUNDS, "it's measured in every round a busy machine gets")
assert.equal(noise.rows[0]!.outcome, "unsure", "a busy row the rounds can't settle is unsure")
assert.equal(noise.unsure.length, 1)
assert.deepEqual(noise.busy, ["other work kept 12.6 of 14 cores busy"], "and the verdict says why")

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
assert.match(impatient.said, /Still busy after 30 s .*measuring anyway, in up to 15 rounds/)

// Rounds on a busy machine have a time of their own, so a check with many rows ends inside the updater's.
const hurried = await settled(1, Infinity, 0, 0)
assert.equal(hurried.rows[0]!.outcome, "unsure", "out of time on a busy machine, an unsettled row is unsure")
assert.equal(hurried.rows[0]!.rounds, ROUNDS + CONFIRM_ROUNDS, "after the seven rounds that bound its median")
assert.match(hurried.said, /Measured for the 0 s a busy machine gets; rows it hasn't settled are unsure\./)
assert.equal((await settled(2, Infinity, 0, 0)).rows[0]!.outcome, "slower", "a real regression is caught in those seven")
console.log("PASS: a busy machine is waited out, measured in more rounds for as long as it gets, and never fails unchanged code")

const folder = mkdtempSync(join(tmpdir(), "mako-perf-verdict-"))
try {
  const file = join(folder, "verdict.jsonl")
  const busy = { ...noise, unsure: [`${KEY}: unsure`], rows: noise.rows.map((measured) => ({ ...measured, outcome: "unsure" as const })) }
  assert.deepEqual(await concluded("perf:decoders", busy, ALLOWED, file), [], "under the updater an unsure row doesn't fail the script")
  assert.deepEqual(await concluded("perf:decoders", regression, ALLOWED, file), regression.failed, "a slower one does")
  const verdicts = parseVerdicts(readFileSync(file, "utf8"))
  assert.deepEqual(verdicts.map((verdict) => verdict.rows[0]!.outcome), ["unsure", "slower"], "each conclusion is a line the updater reads")
  assert.deepEqual(verdicts[0]!.busy, ["other work kept 12.6 of 14 cores busy"])
  assert.match((await concluded("perf:decoders", busy, ALLOWED, undefined))[0]!, /unsure; measure it again on a quieter machine$/, "with nobody to choose, unsure fails")
} finally {
  rmSync(folder, { recursive: true, force: true })
}
console.log("PASS: an unsure row is the updater's to decide, recorded with what was measured")
