/**
 * Hot paths of the harness layer against recorded baselines: the live path,
 * each decoder, and each store reader opening its largest kept pair to the
 * viewer's first page (`npm run harness:saved-open` times the largest
 * sessions on this machine instead). Each one is
 * timed as a multiple of a fixed calibration workload run alongside it, so
 * a baseline holds across machines; one more than 25% over its baseline
 * fails, after a second measurement rules out a passing stall.
 *
 *   npm run test:performance                                  check every budget
 *   npx tsx scripts/test-performance-budgets.ts --update       record what this machine measures now
 */
import assert from "node:assert/strict"
import { cp, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { SessionCatalog, VIEWER_PAGE } from "@mako/sessions"
import { declaredToolNames, identifyTool } from "@mako/sessions/tool-identity"
import {
  deliverLiveUpdates,
  queueLiveUpdate,
  reduceLiveUpdates,
  type LiveBlock,
  type LivePending,
  type LiveUpdate,
} from "@mako/sessions/live-content"
import { SessionUsage, type UsageObservation } from "../electron/session-usage"
import { PAIRS_FOLDER, PairSchema, storeReader } from "./decode-compare"
import { decodeSession, decoders, FIXTURE_ROOT, loadFixtures } from "./native-decoding"

const BUDGETS = join(import.meta.dirname, "performance-budgets.json")
const ALLOWED_REGRESSION = 1.25
const BaselinesSchema = z.record(z.string(), z.number().positive())

type Budget = () => number | Promise<number>

/** The fastest of several runs: what the work costs without a collection or another process in the way. */
async function measure(run: Budget, repetitions = 11): Promise<number> {
  await run()
  let fastest = Infinity
  for (let index = 0; index < repetitions; index++) {
    const started = performance.now()
    await run()
    fastest = Math.min(fastest, performance.now() - started)
  }
  return fastest
}

/** Work of the same mix the budgets do: strings, objects, maps and JSON. */
function calibration(): number {
  let sum = 0
  const map = new Map<string, number>()
  for (let index = 0; index < 20_000; index++) {
    const text = `item-${index}-${"x".repeat(index % 64)}`
    map.set(text, index)
    sum += JSON.parse(JSON.stringify({ text, index })).index + (map.get(text) ?? 0)
  }
  return sum
}

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
const turn: LiveBlock[] = reduceLiveUpdates([], [
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
const { files } = await loadFixtures()
const sources = decoders()
const toolCalls = sources.flatMap((source) =>
  declaredToolNames(source.provider).map((name) => ({ harness: source.provider, name, input: "{\"path\":\"/a/b.ts\",\"command\":\"npm test\"}" })))

/** Every budget: what it times, returning how much work it did so a run that did none fails. */
const hostBudgets = {
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
    let blocks: LiveBlock[] = []
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
} satisfies Record<string, () => number>
const budgets = new Map<string, Budget>(Object.entries(hostBudgets))
for (const source of sources) {
  const largest = files
    .filter((file) => file.fixture.harness === source.provider)
    .sort((left, right) => right.fixture.steps.length - left.fixture.steps.length)[0]
  if (!largest) continue
  const messages = largest.fixture.steps.map((step) => step.message)
  budgets.set(`${source.provider} decodes ${largest.name} x50`, () => {
    let steps = 0
    for (let round = 0; round < 50; round++) steps += decodeSession(source, largest.fixture.session, messages).length
    return steps
  })
}

/** Each reader's largest kept pair store, copied out so no reader opens the fixture itself. */
async function savedSessions(scratch: string): Promise<{ reader: string; name: string; home: string; path: string }[]> {
  const largest = new Map<string, { name: string; folder: string; path: string; bytes: number }>()
  for (const harness of await readdir(FIXTURE_ROOT)) {
    const root = join(FIXTURE_ROOT, harness, PAIRS_FOLDER)
    for (const name of await readdir(root).catch(() => [])) {
      const folder = join(root, name)
      const pair = PairSchema.parse(JSON.parse(await readFile(join(folder, "pair.json"), "utf8")))
      const bytes = await treeBytes(join(folder, "home"))
      for (const store of pair.stores)
        if (bytes > (largest.get(store.reader)?.bytes ?? -1)) largest.set(store.reader, { name: `${harness}/${name}`, folder, path: store.path, bytes })
    }
  }
  return Promise.all([...largest].map(async ([reader, session]) => {
    const home = join(scratch, reader)
    await cp(join(session.folder, "home"), home, { recursive: true })
    return { reader, name: session.name, home, path: join(home, session.path) }
  }))
}

async function treeBytes(folder: string): Promise<number> {
  const files = (await readdir(folder, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile())
  const sizes = await Promise.all(files.map(async (entry) => (await stat(join(entry.parentPath, entry.name))).size))
  return sizes.reduce((sum, size) => sum + size, 0)
}

// Opening a saved conversation as the app does after a launch: discover the store, then the viewer's first page.
const scratch = await mkdtemp(join(tmpdir(), "mako-saved-history-"))
for (const session of await savedSessions(scratch)) {
  budgets.set(`${session.reader} opens ${session.name} to its first page x10`, async () => {
    let entries = 0
    for (let round = 0; round < 10; round++) {
      const catalog = new SessionCatalog([storeReader(session.reader, session.home)])
      await catalog.scan()
      entries += (await catalog.page(session.path, undefined, 100, VIEWER_PAGE))?.entries.length ?? 0
    }
    return entries
  })
}

async function units(run: Budget): Promise<number> {
  const reference = await measure(calibration)
  return (await measure(run)) / reference
}

const update = process.argv.includes("--update")
const recorded = update ? {} : BaselinesSchema.parse(JSON.parse(await readFile(BUDGETS, "utf8")))
const measured: Record<string, number> = {}
const failures: string[] = []
for (const [name, run] of budgets) {
  assert.ok(await run(), `${name} did no work`)
  let value = await units(run)
  const baseline = recorded[name]
  if (!update && baseline === undefined) failures.push(`${name}: no baseline; run with --update and commit ${BUDGETS}`)
  if (baseline !== undefined && value > baseline * ALLOWED_REGRESSION) value = Math.min(value, await units(run))
  measured[name] = Number(value.toFixed(3))
  const ratio = baseline === undefined ? "" : ` (${((value / baseline) * 100).toFixed(0)}% of baseline)`
  console.log(`${name}: ${value.toFixed(3)} calibration units${ratio}`)
  if (baseline !== undefined && value > baseline * ALLOWED_REGRESSION)
    failures.push(`${name}: ${value.toFixed(3)} is more than ${Math.round((ALLOWED_REGRESSION - 1) * 100)}% over its baseline ${baseline}`)
}
await rm(scratch, { recursive: true, force: true })
for (const name of Object.keys(recorded))
  if (!budgets.has(name)) failures.push(`${name}: a baseline with no budget; run with --update`)
if (update) {
  await writeFile(BUDGETS, `${JSON.stringify(measured, null, 2)}\n`)
  console.log(`Recorded ${Object.keys(measured).length} baselines in ${BUDGETS}`)
} else {
  assert.deepEqual(failures, [], failures.join("\n"))
  console.log(`Performance budgets: ${budgets.size} hot paths within ${Math.round((ALLOWED_REGRESSION - 1) * 100)}% of their baselines`)
}
