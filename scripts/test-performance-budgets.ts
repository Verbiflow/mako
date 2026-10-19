/**
 * Hot paths of the live path against recorded baselines: the host queueing
 * and delivering updates, the window reducing them, usage folding and tool
 * identity. Each decoder, its live path, the window's projection and each
 * store reader's saved open have their budgets in `npm run perf:decoders`,
 * which `test:performance` runs too. Each one is timed with
 * `performance-measure.ts`, as a multiple of a fixed calibration workload
 * run alongside it, so a baseline holds across machines. One more than 25%
 * over its baseline is measured again to rule out a passing stall, then
 * beside the commit the baselines were recorded at (`at`), in turns
 * (`perf-reference.ts`): it fails only if it's more than 25% slower than that
 * code on this machine now.
 *
 *   npm run test:performance                                                   check every budget
 *   npx tsx --tsconfig tsconfig.app.json scripts/test-performance-budgets.ts --update         record what this machine measures now, at HEAD
 *   npx tsx --tsconfig tsconfig.app.json scripts/test-performance-budgets.ts --measure-only   print what it measures and check nothing
 */
import assert from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { declaredToolNames, identifyTool } from "@mako/sessions/tool-identity"
import { deliverLiveUpdates, queueLiveUpdate, reduceLiveUpdates, type LivePending, type LiveUpdate } from "@mako/sessions/live-content"
import { SessionUsage, type UsageObservation } from "@mako/host/harnesses/session-usage"
import { decoders } from "./native-decoding"
import { timing, type Work } from "./performance-measure"
import { committed, ROUNDS, script, settle, type Measurer, type Suspect } from "./perf-reference"
import type { Entry } from "@mako/sessions/entries"

const BUDGETS = join(import.meta.dirname, "performance-budgets.json")
const ALLOWED_REGRESSION = 1.25
const BaselinesSchema = z.object({
  /** The commit whose code the baselines measured: a budget over its baseline is measured again beside it. */
  at: z.string().regex(/^[0-9a-f]{40}$/).optional(),
  budgets: z.record(z.string(), z.number().positive()),
})

const text: LiveUpdate[] = Array.from({ length: 200_000 / 30 }, () => ({ kind: "text", text: "x".repeat(30) }))
const output: LiveUpdate[] = Array.from({ length: 2_000 }, (_, index) => ({
  kind: "tool-update", id: "call", outputAppend: `line ${index} ${"y".repeat(60)}\n`,
}))
const resent: LiveUpdate[] = (() => {
  let whole = ""
  return Array.from({ length: 400 }, (_, index) => {
    whole += `line ${index} ${"z".repeat(60)}\n`
    return { kind: "tool-update", id: "call", status: "in_progress", output: whole }
  })
})()
const turn: Entry[] = reduceLiveUpdates([], [
  { kind: "user", text: "Run the suite" },
  ...Array.from({ length: 100 }, (_, index): LiveUpdate => ({ kind: "tool", id: `read-${index}`, title: "Read", status: "completed", output: "ok" })),
  { kind: "tool", id: "call", title: "Run tests", status: "in_progress", output: "" },
])
const observations: UsageObservation[] = Array.from({ length: 20_000 }, (_, index): UsageObservation =>
  index % 3 === 0
    ? { kind: "call", tokens: { input: index, cacheRead: 1, cacheWrite: 2, output: 3 } }
    : index % 3 === 1
      ? { kind: "spent", tokens: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1, reasoning: 1 } }
      : { kind: "window", size: 200_000 })
const toolCalls = decoders().flatMap((source) =>
  declaredToolNames(source.provider).map((name) => ({ harness: source.provider, name, input: "{\"path\":\"/a/b.ts\",\"command\":\"npm test\"}" })))

/** A tree's budgets measured in a run of its own, each read from the line it prints; an older tree prints them the same way, whatever it then concludes. */
const budgetRuns = async (_reference: string, _keys: string[], scratch: string): Promise<Measurer> => {
  await mkdir(scratch, { recursive: true })
  let runs = 0
  return async (tree) => {
    const ran = await script(tree, "scripts/test-performance-budgets.ts", ["--measure-only"], join(scratch, `${runs++}.txt`))
    const units: Record<string, number> = {}
    for (const [, name, value] of ran.stdout.matchAll(/^(.+): ([\d.]+) calibration units/gm)) units[name!] = Number(value)
    if (!Object.keys(units).length) throw new Error(`test-performance-budgets.ts in ${tree} exited ${ran.code}:\n${ran.stderr.trim().split("\n").slice(-20).join("\n")}`)
    return units
  }
}

/** Every budget: what it times, returning how much work it did so a run that did none fails. */
const budgets = {
  /** 200,000 characters of answer in 30-character deltas inside one frame, as the host queues them, x20. */
  "host queues a streamed answer x20": () => {
    let flushes = 0
    for (let round = 0; round < 20; round++) {
      const pending: LivePending = { updates: [], pendingCharacters: 0 }
      for (const update of text)
        if (queueLiveUpdate(pending, update) === "full") {
          flushes++
          pending.updates = []
          pending.pendingCharacters = 0
          queueLiveUpdate(pending, update)
        }
      flushes += pending.updates.length
    }
    return flushes
  },
  /** A command printing 2,000 lines, one batch per line, against a turn of 100 calls. */
  "host delivers streamed output": () => {
    let blocks = turn
    for (const update of output) blocks = deliverLiveUpdates(blocks, [update]).blocks
    return blocks.length
  },
  /** A harness that sends a call's whole output again with every line. */
  "host delivers resent output": () => {
    let blocks = turn
    for (const update of resent) blocks = deliverLiveUpdates(blocks, [update]).blocks
    return blocks.length
  },
  /** The renderer reducing a 200,000-character answer one frame at a time. */
  "renderer reduces a streamed answer": () => {
    let blocks: Entry[] = []
    for (const update of text) blocks = reduceLiveUpdates(blocks, [update])
    return blocks.length
  },
  "usage folds 20,000 observations x10": () => {
    let changed = 0
    for (let round = 0; round < 10; round++) {
      const usage = new SessionUsage()
      for (const observation of observations) if (usage.observe(observation)) changed++
    }
    return changed
  },
  "tool identity resolves every declared name": () => {
    let known = 0
    for (let round = 0; round < 20; round++)
      for (const call of toolCalls) if (identifyTool(call).kind !== "other") known++
    return known
  },
} satisfies Record<string, Work>

const update = process.argv.includes("--update")
// What a run beside a reference build reads (`perf-reference.ts`): each budget's line, with no verdict.
const measureOnly = process.argv.includes("--measure-only")
const recorded: z.infer<typeof BaselinesSchema> = update || measureOnly ? { budgets: {} } : BaselinesSchema.parse(JSON.parse(await readFile(BUDGETS, "utf8")))
const measured: Record<string, number> = {}
const failures: string[] = []
const suspects: Suspect[] = []
for (const [name, run] of Object.entries(budgets)) {
  assert.ok(await run(), `${name} did no work`)
  let value = (await timing(run)).units
  const baseline = recorded.budgets[name]
  if (!update && !measureOnly && baseline === undefined) failures.push(`${name}: no baseline; run with --update and commit ${BUDGETS}`)
  if (baseline !== undefined && value > baseline * ALLOWED_REGRESSION) value = Math.min(value, (await timing(run)).units)
  measured[name] = Number(value.toFixed(3))
  const ratio = baseline === undefined ? "" : ` (${((value / baseline) * 100).toFixed(0)}% of baseline)`
  console.log(`${name}: ${value.toFixed(3)} calibration units${ratio}`)
  if (baseline !== undefined && value > baseline * ALLOWED_REGRESSION)
    suspects.push({ key: name, at: recorded.at, over: `${name}: ${value.toFixed(3)} is more than ${Math.round((ALLOWED_REGRESSION - 1) * 100)}% over its baseline ${baseline}` })
}
for (const name of Object.keys(recorded.budgets))
  if (!(name in budgets)) failures.push(`${name}: a baseline with no budget; run with --update`)
if (update) {
  const at = await committed(BUDGETS)
  await writeFile(BUDGETS, `${JSON.stringify(at ? { at, budgets: measured } : { budgets: measured }, null, 2)}\n`)
  console.log(`Recorded ${Object.keys(measured).length} baselines in ${BUDGETS}${at ? ` at ${at.slice(0, 8)}` : ""}`)
  if (!at) console.warn("This tree has uncommitted changes, so these baselines name no commit to measure beside when one goes over budget. Commit the code, then run --update again.")
} else if (!measureOnly) {
  if (suspects.length) failures.push(...await settle(suspects, { allowed: ALLOWED_REGRESSION, rounds: ROUNDS, say: console.log, measurer: budgetRuns }))
  assert.deepEqual(failures, [], failures.join("\n"))
  console.log(`Performance budgets: ${Object.keys(budgets).length} hot paths within ${Math.round((ALLOWED_REGRESSION - 1) * 100)}% of their baselines`)
}
