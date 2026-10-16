/**
 * Every harness's decoding hot paths in one table, against a stored
 * baseline, so anyone can see in one command whether a decoder got slower:
 *
 *   decode       every kept fixture and pair capture through a fresh recorded decoder (per message)
 *   host         the same messages through the live engine, as the host hands the window (per message)
 *   projection   the window reducing and projecting each live update of the pair captures (per update)
 *   recorder     each message of the pair captures written to a stream, its frame's place handed out (per message)
 *   merge        each pair capture's stream merged with its store's record, as the host does once a turn lands (per entry)
 *   merge large  20,000 entries merged: the same, one in a hundred apart, and as far apart as the merge aligns (per entry)
 *   saved open   the largest kept pair store opened to the viewer's first page
 *   largest here this Mac's largest saved session opened to its first page (`--real`)
 *   usage scan   this Mac's last 30 days of the harness's usage records, from a cold ledger (`--real`)
 *
 * Each is timed as a multiple of a calibration workload (`performance-measure.ts`),
 * so the baseline holds across machines; a kept row more than 25% over it
 * fails, as does one with no baseline. A recording added since the baseline
 * scales that row's baseline by its items. Rows read from this Mac's stores
 * (`--real`) are reported, never failed: the stores grow.
 *
 *   npm run perf:decoders                          the kept rows against scripts/perf-decoders-baseline.json
 *   npm run perf:decoders -- --real                with this Mac's stores, read-only
 *   npm run perf:decoders -- --only claude --each  one harness, with each recording's decode
 *   npm run perf:decoders -- --update              record what this machine measures as the baseline
 *   npm run perf:decoders -- --save <file>         keep this run, e.g. from another checkout
 *   npm run perf:decoders -- --against <file>      compare with a kept run instead of the baseline
 *   npm run perf:decoders -- --fixtures <dir>      decode another checkout's recordings, so two trees read the same input
 */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { z } from "zod"
import { SessionCatalog, translatorBuild, VIEWER_PAGE } from "@mako/sessions"
import { NativeStores } from "@mako/sessions/read-only-sqlite"
import { reduceLiveUpdates, type LiveUpdate } from "@mako/sessions/live-content"
import { createHarnessHost, detachedHarnessContext } from "@mako/host/harnesses/harness-host"
import { usageHarnesses } from "@mako/host/harnesses/index"
import { UsageLedger, usageSummary } from "@mako/host/usage/index"
import { projectLive, type LiveProjection } from "../src/state/live-projection"
import { PAIRS_FOLDER, PairSchema, liveUpdates, storeReader } from "./decode-compare"
import { decoders, FIXTURE_ROOT, readRecording, replayed, type Recording } from "./native-decoding"
import { hotspots, keptPairStores, profiled, timing, type Timing, type Work } from "./performance-measure"
import type { Entry, RecordRef } from "@mako/sessions/entries"
import type { JsonValue } from "@mako/host/contracts/json"
import { nativeStream } from "@mako/host/harnesses/native-stream"
import { streamDifferences } from "@mako/sessions/harnesses"
import { MAX_STREAM_DIFFERENCES, mergeStream } from "@mako/sessions/stream-merge"

const BASELINE = join(import.meta.dirname, "perf-decoders-baseline.json")
const ALLOWED_REGRESSION = 1.25

const { values } = parseArgs({
  options: {
    real: { type: "boolean", default: false },
    only: { type: "string" },
    measure: { type: "string" },
    each: { type: "boolean", default: false },
    update: { type: "boolean", default: false },
    save: { type: "string" },
    against: { type: "string" },
    fixtures: { type: "string", default: FIXTURE_ROOT },
    json: { type: "boolean", default: false },
    profile: { type: "string" },
  },
})

const RowSchema = z.object({ units: z.number().positive(), ms: z.number().nonnegative(), count: z.number().int().nonnegative(), unit: z.string() })
type Row = z.infer<typeof RowSchema>
const RunSchema = z.record(z.string(), RowSchema)

/** Which measures say what this Mac's own stores cost, which grow, rather than what the kept recordings do. */
const REAL = new Set(["largest here", "usage scan"])

/** A measure's name without the store reader it names, as `saved open (devin-ide)` is a `saved open`. */
function family(measure: string): string {
  return measure.replace(/ \(.*\)$/, "")
}

function wanted(measure: string): boolean {
  return !values.measure || family(measure) === values.measure
}

interface Measure {
  harness: string
  measure: string
  /** How many items the work handles, which the row's per-item time divides by. */
  count: number
  unit: string
  run: Work
  repetitions?: number
}

async function recordings(harness: string): Promise<{ name: string; recording: Recording; pair: boolean }[]> {
  const folder = join(values.fixtures, harness)
  const pairs = join(folder, PAIRS_FOLDER)
  const found: { name: string; recording: Recording; pair: boolean }[] = []
  for (const name of (await readdir(pairs).catch(() => [])).sort())
    found.push({ name: `${harness}/pairs/${name}`, recording: await readRecording(join(pairs, name, "capture.jsonl")), pair: true })
  for (const entry of (await readdir(folder)).filter((file) => file.endsWith(".json")).sort())
    found.push({ name: `${harness}/${entry.slice(0, -".json".length)}`, recording: await readRecording(join(folder, entry)), pair: false })
  return found
}

function decodeAll(harness: string, kept: Recording[]): Work {
  const source = decoders().find((decoder) => decoder.provider === harness)!
  return () => {
    let events = 0
    for (const recording of kept) for (const { decoded } of replayed(source.open(recording.session), recording)) events += decoded.length
    return events
  }
}

/** The file a replayed capture's frames name, as a launch's do. */
const STREAM_KEY = "mako-streams:perf/capture.jsonl"

/** Each message written as the driver writes it: the recorder's synchronous part, which every frame waits on, then its write. */
function recordAll(harness: string, messages: readonly JsonValue[]): Work {
  return async () => {
    const streams = await mkdtemp(join(tmpdir(), "mako-perf-recorder-"))
    const stream = nativeStream(harness, "perf", () => ({}), streams, () => "perf")!
    let named = 0
    for (const message of messages) if (stream.record(message)) named++
    await stream.flush()
    await rm(streams, { recursive: true, force: true })
    return named
  }
}

/** Each pair capture's live entries, naming their frames, and its own store's record of the same turns. */
async function mergePairs(harness: string, fixtures: string): Promise<{ record: Entry[]; stream: Entry[] }[]> {
  const folder = join(fixtures, harness, PAIRS_FOLDER)
  const found: { record: Entry[]; stream: Entry[] }[] = []
  for (const name of (await readdir(folder).catch(() => [])).sort()) {
    const pair = PairSchema.parse(JSON.parse(await readFile(join(folder, name, "pair.json"), "utf8")))
    const own = pair.stores.find((store) => store.reader === pair.harness)
    if (!own) continue
    const thread = await storeReader(own.reader, join(folder, name, "home")).read(join(folder, name, "home", own.path))
    const recording = await readRecording(join(folder, name, "capture.jsonl"))
    found.push({ record: thread?.entries ?? [], stream: reduceLiveUpdates([], liveUpdates(pair.harness, recording, undefined, STREAM_KEY)) })
  }
  return found
}

/** A long conversation's two sides: equal; one entry in a hundred worded otherwise or only streamed; and differing in as many entries as the merge aligns. */
function largeMerges(): [string, Entry[], Entry[]][] {
  const turns = 2_000
  const record: Entry[] = []
  for (let turn = 0; turn < turns; turn++) {
    record.push({ type: "user", id: `u${turn}`, text: `Question ${turn}`, record: { ranges: [[turn * 1000, turn * 1000 + 100]] } })
    for (let step = 0; step < 4; step++) {
      record.push({ type: "text", id: `t${turn}.${step}`, text: `Reading part ${step} of turn ${turn}.` })
      record.push({ type: "tool", id: `call_${turn}_${step}`, name: "Read", status: "completed", input: `{"path":"src/${turn}/${step}.ts"}` })
    }
    record.push({ type: "text", id: `a${turn}`, text: `Turn ${turn} is done.` })
  }
  const ref = (index: number): RecordRef => ({ file: STREAM_KEY, ranges: [[index * 200, index * 200 + 200]] })
  const streamed = (entry: Entry, index: number): Entry => {
    if (entry.type === "tool") return { ...entry, record: undefined, output: "…", stream: ref(index) }
    const next: Entry = entry.type === "user" ? { ...entry, requestId: `r${index}`, stream: ref(index) } : { ...entry, stream: ref(index) }
    delete next.id
    delete next.record
    return next
  }
  const same = record.map(streamed)
  const apart = same.flatMap((entry, index): Entry[] => index % 100 !== 50 ? [entry]
    : entry.type === "text" ? [{ ...entry, text: `${entry.text} (as streamed)` }]
      : [entry, { type: "event", id: `w${index}`, label: "Warning", detail: "streamed only", stream: ref(index) }])
  const far = same.map((entry, index) => index < MAX_STREAM_DIFFERENCES / 2 && entry.type === "text" ? { ...entry, text: `other ${index}` } : entry)
  return [["same", record, same], ["1% apart", record, apart], ["far apart", record, far]]
}

/** The window's work for each update: the reducer's step, then the incremental projection over it. */
function projectAll(harness: string, streams: LiveUpdate[][]): Work {
  return () => {
    let messages = 0
    for (const updates of streams) {
      let blocks: Entry[] = []
      let projection: LiveProjection | undefined
      for (const update of updates) {
        blocks = reduceLiveUpdates(blocks, [update])
        projection = projectLive({ blocks, base: null, session: { status: "running", harness } }, projection)
      }
      messages += projection?.messages.length ?? 0
    }
    return messages
  }
}

const measures: Measure[] = []
const each: { name: string; messages: number; run: Work }[] = []
const harnesses = decoders().map((decoder) => decoder.provider).filter((harness) => !values.only || harness === values.only)
for (const harness of harnesses) {
  const found = await recordings(harness)
  const kept = found.map((entry) => entry.recording)
  const messages = kept.reduce((sum, recording) => sum + recording.messages.length, 0)
  if (wanted("decode")) measures.push({ harness, measure: "decode", count: messages, unit: "message", run: decodeAll(harness, kept) })
  const captures = found.filter((entry) => entry.pair).map((entry) => entry.recording)
  if (captures.length && wanted("host")) {
    const captured = captures.reduce((sum, recording) => sum + recording.messages.length, 0)
    measures.push({ harness, measure: "host", count: captured, unit: "message", repetitions: 5, run: () => captures.reduce((sum, recording) => sum + liveUpdates(harness, recording, undefined, STREAM_KEY).length, 0) })
  }
  if (captures.length && wanted("projection")) {
    const streams = captures.map((recording) => liveUpdates(harness, recording, undefined, STREAM_KEY))
    measures.push({ harness, measure: "projection", count: streams.reduce((sum, updates) => sum + updates.length, 0), unit: "update", repetitions: 5, run: projectAll(harness, streams) })
  }
  if (captures.length && wanted("recorder")) {
    const messages = captures.flatMap((recording) => recording.messages)
    measures.push({ harness, measure: "recorder", count: messages.length, unit: "message", repetitions: 5, run: recordAll(harness, messages) })
  }
  if (wanted("merge")) {
    const pairs = await mergePairs(harness, values.fixtures)
    if (pairs.length) measures.push({ harness, measure: "merge", count: pairs.reduce((sum, pair) => sum + pair.record.length + pair.stream.length, 0), unit: "entry", run: () => pairs.reduce((sum, { record, stream }) => sum + mergeStream(record, stream, streamDifferences(harness)).entries.length, 0) })
  }
  if (values.each) for (const entry of found) each.push({ name: entry.name, messages: entry.recording.messages.length, run: decodeAll(harness, [entry.recording]) })
}
if (wanted("merge large") && !values.only) for (const [name, record, stream] of largeMerges()) {
  measures.push({ harness: "merge", measure: `merge large (${name})`, count: record.length + stream.length, unit: "entry", repetitions: 5, run: () => mergeStream(record, stream, streamDifferences("claude")).entries.length })
}

const scratch = await mkdtemp(join(tmpdir(), "mako-perf-decoders-"))
const translator = translatorBuild()
for (const store of wanted("saved open") ? await keptPairStores(join(scratch, "pairs"), values.fixtures) : []) {
  const harness = store.reader === "devin-ide" ? "devin" : store.reader
  if (!harnesses.includes(harness)) continue
  measures.push({
    harness,
    measure: store.reader === harness ? "saved open" : `saved open (${store.reader})`,
    count: 1,
    unit: "open",
    run: async () => {
      const catalog = new SessionCatalog([storeReader(store.reader, store.home)], { translator })
      await catalog.scan()
      return (await catalog.page(store.path, undefined, 100, VIEWER_PAGE))?.entries.length ?? 0
    },
  })
}

if (values.real) {
  const home = homedir()
  for (const reader of wanted("largest here") ? ["claude", "codex", "cursor", "devin", "devin-ide", "grok", "opencode"] : []) {
    const harness = reader === "devin-ide" ? "devin" : reader
    if (!harnesses.includes(harness)) continue
    const catalog = new SessionCatalog([storeReader(reader, home)], { translator, readOnly: true })
    await catalog.scan()
    // OpenCode's `bytes` is a revision stamp, not a size; its largest is its newest there, as `harness:saved-open` reads it.
    const largest = catalog.list().sort((left, right) => (right.bytes ?? 0) - (left.bytes ?? 0))[0]
    if (!largest) continue
    measures.push({
      harness,
      measure: reader === harness ? "largest here" : `largest here (${reader})`,
      count: 1,
      unit: "open",
      repetitions: 3,
      run: async () => {
        const fresh = new SessionCatalog([storeReader(reader, home)], { translator, readOnly: true })
        await fresh.scan()
        return (await fresh.page(largest.path, undefined, 100, VIEWER_PAGE))?.entries.length ?? 1
      },
    })
  }
  const sessionsRoot = join(scratch, "no-mako-sessions")
  for (const usage of usageHarnesses(createHarnessHost(detachedHarnessContext(new NativeStores(false))))) {
    if (!usage.history || !harnesses.includes(usage.provider) || !wanted("usage scan")) continue
    measures.push({
      harness: usage.provider,
      measure: "usage scan",
      count: 1,
      unit: "scan",
      repetitions: 2,
      run: async () => {
        const summary = await usageSummary([usage], sessionsRoot, home, undefined, { ledger: new UsageLedger() })
        return summary.sessions + 1
      },
    })
  }
}

if (values.profile) {
  await mkdir(values.profile, { recursive: true })
  for (const { harness, measure, run } of measures) {
    const profile = await profiled(run)
    const path = join(values.profile, `${harness}-${measure}.cpuprofile`.replace(/[^\w.-]+/g, "-"))
    await writeFile(path, JSON.stringify(profile))
    const spots = hotspots(profile)
    const sampled = spots.reduce((sum, spot) => sum + spot.selfMs, 0)
    const share = (ms: number) => `${ms.toFixed(1).padStart(8)} ms ${((ms / sampled) * 100).toFixed(1).padStart(5)}%`
    console.log(`\n${harness}/${measure}: ${sampled.toFixed(0)} ms sampled, ${path}`)
    console.log("  self")
    for (const spot of spots.slice(0, 15)) console.log(`  ${share(spot.selfMs)}  ${spot.frame}`)
    console.log("  inclusive")
    for (const spot of [...spots].sort((left, right) => right.totalMs - left.totalMs).slice(1, 26)) console.log(`  ${share(spot.totalMs)}  ${spot.frame}`)
  }
  await rm(scratch, { recursive: true, force: true })
  process.exit()
}

const progress = process.stdout.isTTY && !values.json
const reference = values.against ?? BASELINE
const recorded: z.infer<typeof RunSchema> = values.update ? {} : await readFile(reference, "utf8").then((text) => RunSchema.parse(JSON.parse(text)), () => ({}))
const measured: Record<string, Row> = {}
const over: string[] = []
const rows: string[][] = [["harness", "measure", "items", "before", "budget", "after", "spread", "change", "after per item"]]
const filtered = Boolean(values.only || values.measure)
for (const { harness, measure, count, unit, run, repetitions } of measures) {
  const key = `${harness}/${measure}`
  let time: Timing = await timing(run, repetitions)
  const before = expected(recorded[key], count)
  const kept = !REAL.has(family(measure)) && !values.against && !values.update
  if (kept && !before) over.push(`${key}: no baseline; run with --update and commit ${BASELINE}`)
  const budget = kept && before ? before.units * ALLOWED_REGRESSION : undefined
  if (budget !== undefined && time.units > budget) {
    // A second measurement rules out a stall before a row is called slower.
    const again = await timing(run, repetitions)
    if (again.units < time.units) time = again
  }
  measured[key] = { units: round(time.units), ms: round(time.ms), count, unit }
  if (budget !== undefined && before && time.units > budget) over.push(`${key}: ${time.units.toFixed(3)} is ${percent(time.units / before.units - 1)} over its baseline ${round(before.units)} (budget ${budget.toFixed(3)})`)
  rows.push(row(harness, measure, count, unit, time, before, budget))
  if (progress) process.stdout.write(`\r${key} measured`.padEnd(60))
}
if (!filtered && !values.against && !values.update)
  for (const key of Object.keys(recorded)) if (!(key in measured)) over.push(`${key}: a baseline with no measure; run with --update`)
for (const { name, messages, run } of each) {
  const time = await timing(run)
  const key = `${name}/decode`
  measured[key] = { units: round(time.units), ms: round(time.ms), count: messages, unit: "message" }
  rows.push(row(name, "decode", messages, "message", time, expected(recorded[key], messages), undefined))
}
await rm(scratch, { recursive: true, force: true })

if (values.json) console.log(JSON.stringify(measured, null, 2))
else {
  if (progress) process.stdout.write("\r".padEnd(61) + "\r")
  console.log(`Calibration units against ${values.update ? "nothing (recording)" : reference}; lower is faster.\n`)
  printTable(rows)
}
if (values.save) await writeFile(values.save, `${JSON.stringify(measured, null, 2)}\n`)
if (values.update) {
  const kept = Object.fromEntries(Object.entries(measured).filter(([key]) => !key.split("/").some((part) => REAL.has(family(part)))))
  await writeFile(BASELINE, `${JSON.stringify(kept, null, 2)}\n`)
  console.log(`\nRecorded ${Object.keys(kept).length} baselines in ${BASELINE}`)
}
if (over.length) {
  console.error(`\nMore than ${Math.round((ALLOWED_REGRESSION - 1) * 100)}% slower than the baseline:\n${over.join("\n")}`)
  process.exitCode = 1
}

/**
 * A baseline for `count` items: a recording added or removed since it was
 * taken changes how much a row does, so its baseline scales with the items.
 */
function expected(before: Row | undefined, count: number): Row | undefined {
  if (!before || before.count === count || before.count === 0) return before
  return { ...before, units: before.units * (count / before.count), count }
}

function row(harness: string, measure: string, count: number, unit: string, time: Timing, before: Row | undefined, budget: number | undefined): string[] {
  return [
    harness,
    measure,
    `${count} ${count === 1 ? unit : unit.endsWith("y") ? `${unit.slice(0, -1)}ies` : `${unit}s`}`,
    before ? before.units.toFixed(3) : "-",
    budget === undefined ? "-" : budget.toFixed(3),
    time.units.toFixed(3),
    `±${(time.spread * 50).toFixed(0)}%`,
    before ? percent(time.units / before.units - 1) : "new",
    perItem(time.ms, count),
  ]
}

function round(value: number): number {
  return Number(value.toPrecision(4))
}

function percent(change: number): string {
  return `${change >= 0 ? "+" : ""}${(change * 100).toFixed(0)}%`
}

function perItem(ms: number, count: number): string {
  const each = ms / Math.max(count, 1)
  return each >= 1 ? `${each.toFixed(1)} ms` : `${(each * 1000).toFixed(2)} µs`
}

function printTable(table: string[][]): void {
  const widths = table[0]!.map((_, column) => Math.max(...table.map((row) => row[column]!.length)))
  for (const [index, row] of table.entries()) {
    console.log(row.map((cell, column) => column >= 2 ? cell.padStart(widths[column]!) : cell.padEnd(widths[column]!)).join("  "))
    if (index === 0) console.log(widths.map((width) => "-".repeat(width)).join("  "))
  }
}
