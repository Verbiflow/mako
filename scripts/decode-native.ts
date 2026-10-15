import { createReadStream } from "node:fs"
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { z } from "zod"
import { aligned, comparePair, differences, liveDrawing, liveUpdates, messagesOf, PairSchema, storeDrawing, storeMessages, type Compared, type Known } from "./decode-compare.ts"
import { eventProvenance, provenanceLines } from "./event-provenance.ts"
import { KEPT_OUTPUTS_BUDGET, KeptOutputs, keptOutputsPath } from "@mako/sessions"
import { NativeStores } from "@mako/sessions/read-only-sqlite"
import { CodexRecords } from "@mako/sessions/codex-records"
import type { JsonValue } from "@mako/host/contracts/json"
import { nativeDiagnosticJson } from "@mako/host/base/native-diagnostic-json"
import {
  decoderFor,
  decodeSession,
  FIXTURE_ROOT,
  FixtureNativeSchema,
  readRecording,
  serializeFixture,
  summarize,
  type FixtureNative,
} from "./native-decoding.ts"

/**
 * Shows what a harness's decoder makes of recorded native messages, one
 * message at a time, and turns a recording into a fixture.
 *
 *   npm run decode -- <capture.jsonl | fixture.json | messages.jsonl>
 *   npm run decode -- --harness codex messages.jsonl --session '{"threadId":"t1"}'
 *   npm run decode -- capture.jsonl --kind item/completed     only matching messages
 *   npm run decode -- capture.jsonl --json                    decoded events as JSON lines
 *   npm run decode -- capture.jsonl --fixture compaction --about "…" --source "codex-cli 0.159.0 app-server" --version 0.159.0
 *   npm run decode -- shapes.jsonl --harness cursor --fixture … --version 1.0.31 --sdk @cursor/sdk@1.0.31 --origin written
 *
 *   npm run decode -- capture.jsonl --compare <store file>  the live drawing beside the store's
 *   npm run decode -- scripts/fixtures/native-decoding/grok/pairs/shell-and-edit
 *
 *   npm run decode -- --events <capture | pair folder>   each marker and turn, its record, and where its body came from
 *   npm run decode -- --events --store <store file> --harness claude
 *
 *   npm run decode -- --records <codex capture | rollout.jsonl>   which rollout bytes drew what
 *
 * `--records` is Codex's: its transcript is its rollout's records, live and
 * saved, through one decoder (`@mako/sessions/codex-records`). For a capture
 * it lists each record the driver read with its byte range in the rollout
 * and what it drew live, between the notifications it was read before; for
 * a rollout it lists each record with its byte range and what saved history
 * reads of it. Kinds, ids and sizes only, never content.
 *
 * `--events` lists every marker and provider-started turn instead of the
 * whole drawing: the native record it cites, whether it came from the live
 * wire for want of a record, and where its body was read (the record
 * itself, a command's output file, or the copy kept once that file is gone,
 * `KeptOutputs`), with how many copies are kept for the store's home.
 *
 * `--compare` reads the store file the session wrote with the harness's
 * history reader, or `--reader devin-ide` for Devin.app's journal (`--home`
 * when the store is not under your own home), and prints both drawings
 * aligned: ` ` both sides draw a line, `-` only the live wire, `+` only the
 * store. A pair folder compares its capture with each of its stores, and a
 * capture that resumes also its replay with the live turns before it.
 *
 * Captures are the streams Mako keeps of every launch, under
 * `~/.mako/records/streams/<harness>/` (`@mako/sessions/record-streams`).
 * A stream holds conversation content whole; a fixture is scrubbed of
 * bearer tokens and `token=` values, but read it before committing it. A fixture's
 * `native` comes from the flags, else from the recording: a capture is
 * `captured`, and its header's version is used when it has one.
 */

const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    harness: { type: "string" },
    session: { type: "string" },
    kind: { type: "string" },
    json: { type: "boolean", default: false },
    fixture: { type: "string" },
    about: { type: "string" },
    source: { type: "string" },
    version: { type: "string" },
    sdk: { type: "string" },
    origin: { type: "string" },
    force: { type: "boolean", default: false },
    compare: { type: "string" },
    home: { type: "string" },
    reader: { type: "string" },
    events: { type: "boolean", default: false },
    store: { type: "string" },
    records: { type: "boolean", default: false },
  },
})

/** What `--records` reads of a rollout record, a decoded event and a capture's read: kinds, ids and sizes. */
const RolloutKind = z.object({
  type: z.string(),
  payload: z.object({ type: z.string().optional(), item: z.object({ type: z.string().optional(), kind: z.string().optional() }).loose().optional() }).loose().optional(),
}).loose()
const DrawnEvent = z.object({
  kind: z.string(),
  update: z.object({
    kind: z.string(), id: z.string().optional(), status: z.string().optional(),
    text: z.string().optional(), output: z.string().optional(), outputAppend: z.string().optional(), effects: z.array(z.json()).optional(),
  }).loose().optional(),
}).loose()
const CapturedRead = z.object({ records: z.array(z.object({ from: z.number(), to: z.number(), record: z.json() })) })

if (options.events) {
  await printEvents()
  process.exit(0)
}

if (options.records) {
  await printRecords(positionals[0])
  process.exit(0)
}

const path = positionals[0]
if (!path) {
  console.error("Usage: npm run decode -- <capture.jsonl | fixture.json | messages.jsonl> [--harness codex] [--session JSON] [--kind KIND] [--json] " +
    "[--fixture NAME --about TEXT --source TEXT --version VERSION --sdk NAME@VERSION --origin captured|written]")
  process.exit(2)
}

if (await stat(path).then((info) => info.isDirectory(), () => false)) {
  const { pair, live, stores, replay } = await comparePair(path)
  console.log(`${pair.harness} ${pair.native.version}: ${pair.about}`)
  let failing = 0
  const report = (title: string, left: string[], right: string[], known: Known, result: Compared) => {
    console.log(`\n${title}`)
    printAligned(left, right)
    for (const difference of known) console.log(`known ${difference.side} ${difference.reason || "(no reason given)"}`)
    const problems = result.unexplained.length + result.settled.length + result.cited.conflicts.length + result.cited.oneSided.length + result.citedNow.length
    for (const problem of [...result.cited.conflicts, ...result.cited.oneSided]) console.log(`marker: ${problem}`)
    for (const listed of result.citedNow) console.log(`marker: listed as uncited, but now cited: ${listed.marker}`)
    console.log(`${result.unexplained.length} unexplained, ${result.settled.length} listed but settled, ${result.cited.agreed} markers cite the same record`)
    failing += problems
  }
  stores.forEach((store, index) => report(`live against ${store.reader} (${store.path})`, live, store.store, pair.stores[index]!.known, store))
  if (replay) report("live before resuming against the replay", replay.live, replay.replay, pair.replay?.known ?? [], replay)
  process.exit(failing ? 1 : 0)
}

const recording = await readRecording(path)
const harness = options.harness ?? recording.harness
if (!harness) {
  console.error(`${path} has no capture header; name its harness with --harness`)
  process.exit(2)
}
const session = options.session ? z.record(z.string(), z.json()).parse(JSON.parse(options.session)) : recording.session

if (options.compare) {
  const live = liveDrawing(harness, { ...recording, session })
  const store = await storeDrawing(options.reader ?? harness, harness, options.home ?? homedir(), options.compare)
  printAligned(live, store)
  process.exit(differences(live, store).length ? 1 : 0)
}

const source = decoderFor(harness)
const steps = decodeSession(source, session, recording.messages)

if (options.fixture) {
  if (!options.about) {
    console.error("A fixture says what it records: pass --about")
    process.exit(2)
  }
  const folder = join(FIXTURE_ROOT, harness)
  const target = join(folder, `${options.fixture}.json`)
  const exists = await access(target).then(() => true, () => false)
  if (exists && !options.force) {
    console.error(`${target} exists; pass --force to replace it`)
    process.exit(2)
  }
  const native = fixtureNative()
  await mkdir(folder, { recursive: true })
  // A stream keeps content whole; a fixture is committed, so bearer tokens and `token=` values are scrubbed from it.
  const scrubbed = (value: JsonValue): JsonValue => z.json().parse(JSON.parse(nativeDiagnosticJson(value)))
  await writeFile(target, serializeFixture({
    harness,
    source: options.source ?? "recorded from Mako's stream",
    native,
    about: options.about,
    session: z.record(z.string(), z.json()).parse(scrubbed(session)),
    steps: steps.map((step) => ({ message: scrubbed(step.message), decoded: step.decoded.map(scrubbed) })),
  }))
  console.log(`wrote ${target} (${steps.length} steps). It holds the recording's content: read it before committing.`)
  process.exit(0)
}

const tally = new Map<string, { count: number; events: number }>()
const unknown = new Set<string>()
steps.forEach((step, index) => {
  const seen = tally.get(step.kind) ?? { count: 0, events: 0 }
  seen.count++
  seen.events += step.decoded.length
  tally.set(step.kind, seen)
  if (!source.decoded.has(step.kind) && !source.silent.has(step.kind)) unknown.add(step.kind)
  if (options.kind && !step.kind.includes(options.kind)) return
  if (options.json) {
    console.log(JSON.stringify({ step: index + 1, kind: step.kind, decoded: step.decoded }))
    return
  }
  const note = source.silent.has(step.kind) ? "silent" : step.decoded.length ? "" : "nothing"
  console.log(`#${String(index + 1).padEnd(5)}${step.kind}${note ? `  (${note})` : ""}`)
  for (const event of step.decoded) console.log(`       ${summarize(event)}`)
})

if (!options.json) {
  console.log(`\n${steps.length} messages, ${tally.size} kinds:`)
  for (const [kind, seen] of [...tally].sort((a, b) => b[1].count - a[1].count))
    console.log(`  ${String(seen.count).padStart(5)}  ${kind}${seen.events ? "" : "  → nothing"}`)
  if (unknown.size) console.log(`\nNot yet decoded: ${[...unknown].join(", ")}`)
}

function printAligned(live: string[], store: string[]): void {
  const listing = aligned(live, store)
  for (const { side, line } of listing) console.log(`${side} ${line}`)
  const changed = listing.filter((entry) => entry.side !== " ").length
  console.log(`\nlive draws ${live.length} lines, the store ${store.length}; ${changed ? `${changed} differ` : "the same drawing"}`)
}

/** `--version none` is for a fixture written from a protocol schema alone, which then names its `--sdk`. */
function fixtureNative(): FixtureNative {
  const at = options.sdk?.lastIndexOf("@") ?? -1
  const sdk = options.sdk ? { name: options.sdk.slice(0, at), version: options.sdk.slice(at + 1) } : recording.native?.sdk
  const version = options.version === "none" ? null : options.version ?? recording.native?.version
  const parsed = FixtureNativeSchema.safeParse({ version, sdk, origin: options.origin ?? recording.native?.origin })
  if (parsed.success) return parsed.data
  console.error("A fixture names the native version it records: pass --version VERSION (or none), --sdk NAME@VERSION and --origin captured|written as needed.\n" +
    z.prettifyError(parsed.error))
  process.exit(2)
}

/** `--events`: each marker and provider-started turn, live, saved or both, with its record and its body's source. */
async function printEvents(): Promise<void> {
  const target = positionals[0]
  const section = (title: string, lines: string[]) => console.log(`\n${title}\n${lines.length ? lines.join("\n") : "  (no markers or provider-started turns)"}`)
  const kept = (home: string) => {
    const totals = new KeptOutputs(keptOutputsPath(home), new NativeStores(true)).totals()
    console.log(`\nkept outputs under ${keptOutputsPath(home)}: ${totals ? `${totals.copies} copies, ${Math.round(totals.bytes / 1024)} KB` : "unreadable"} (budget ${KEPT_OUTPUTS_BUDGET.copies} copies, ${KEPT_OUTPUTS_BUDGET.bytes / 1024 / 1024} MB)`)
  }
  if (target && await stat(target).then((info) => info.isDirectory(), () => false)) {
    const pair = PairSchema.parse(JSON.parse(await readFile(join(target, "pair.json"), "utf8")))
    const home = join(target, "home")
    const recording = await readRecording(join(target, "capture.jsonl"))
    section(`live (${pair.harness} capture)`, provenanceLines(eventProvenance(messagesOf(pair.harness, liveUpdates(pair.harness, recording)))))
    for (const store of pair.stores)
      section(`saved (${store.reader}: ${store.path})`, provenanceLines(eventProvenance((await storeMessages(store.reader, pair.harness, home, join(home, store.path))).messages)))
    return
  }
  if (target) {
    const recording = await readRecording(target)
    const harness = options.harness ?? recording.harness
    if (!harness) throw new Error(`${target} has no capture header; name its harness with --harness`)
    section(`live (${harness} capture)`, provenanceLines(eventProvenance(messagesOf(harness, liveUpdates(harness, { ...recording, session: options.session ? z.record(z.string(), z.json()).parse(JSON.parse(options.session)) : recording.session })))))
  }
  if (options.store) {
    const harness = options.harness
    if (!harness) throw new Error("--store needs --harness")
    const home = options.home ?? homedir()
    section(`saved (${options.reader ?? harness}: ${options.store})`, provenanceLines(eventProvenance((await storeMessages(options.reader ?? harness, harness, home, options.store)).messages)))
    kept(home)
  }
  if (!target && !options.store) {
    console.error("Usage: npm run decode -- --events <capture | pair folder> | --events --store <store file> --harness <harness> [--home <home>]")
    process.exit(2)
  }
}

/** A rollout record's kind as the decoder reads it: its type, its payload's and an item's. */
function recordKind(record: JsonValue): string {
  const parsed = RolloutKind.safeParse(record).data
  if (!parsed) return "(unreadable)"
  const item = parsed.payload?.item
  return [parsed.type, parsed.payload?.type, item?.type, item?.kind].filter((part) => part !== undefined).join(" ")
}

/** What one decoded event drew, without its text: its kind, the block it names and its status. */
function drawnSummary(event: JsonValue): string {
  const parsed = DrawnEvent.safeParse(event).data
  if (!parsed) return summarize(event, 80)
  const update = parsed.update
  if (!update) return parsed.kind
  const size = (update.text?.length ?? 0) + (update.output?.length ?? 0) + (update.outputAppend?.length ?? 0)
  return [`${parsed.kind} ${update.kind}`, update.id, update.status, update.effects ? `${update.effects.length} effects` : undefined, size ? `${size} chars` : undefined].filter(Boolean).join(" ")
}

/** `--records`: which bytes of a Codex rollout drew what, live from a capture or saved from the rollout itself. */
async function printRecords(target: string | undefined): Promise<void> {
  if (!target) {
    console.error("Usage: npm run decode -- --records <codex capture.jsonl | rollout.jsonl>")
    process.exit(2)
  }
  const recording = await readRecording(target)
  if (recording.harness === "codex") {
    // A read is its records in order; decoding them one at a time draws the same.
    const messages = recording.messages.flatMap((message) => {
      const read = CapturedRead.safeParse(message).data
      return read ? read.records.map((record) => ({ records: [record] })) : [message]
    })
    let drawn = 0
    for (const step of decodeSession(decoderFor("codex"), recording.session, messages)) {
      const read = CapturedRead.safeParse(step.message).data?.records[0]
      if (!read) {
        if (step.decoded.length) console.log(`        ${step.kind}: ${step.decoded.map(drawnSummary).join(" · ")}`)
        continue
      }
      drawn += step.decoded.length
      console.log(`${`${read.from}–${read.to}`.padEnd(22)}${recordKind(read.record)}${step.decoded.length ? ` → ${step.decoded.map(drawnSummary).join(" · ")}` : ""}`)
    }
    console.log(`
${messages.length} messages; the rollout's records drew ${drawn} events`)
    return
  }
  const records = new CodexRecords()
  let offset = 0
  let lines = 0
  for await (const line of rolloutLines(target)) {
    const from = offset
    offset += line.bytes + 1
    lines++
    if (line.skipped) {
      console.log(`${`${from}–${offset}`.padEnd(22)}(over 16 MB, skipped)`)
      continue
    }
    const reads = records.line(line.text)
    let record: JsonValue = null
    try {
      record = z.json().parse(JSON.parse(line.text))
    } catch {
      record = null
    }
    const summary = reads.map((read) => read.kind === "update" ? `${read.update.kind}${"id" in read.update && read.update.id ? ` ${read.update.id}` : ""}` : read.kind)
    console.log(`${`${from}–${offset}`.padEnd(22)}${recordKind(record)}${summary.length ? ` → ${summary.join(" · ")}` : ""}`)
  }
  console.log(`
${lines} records, ${offset} bytes`)
}

/** A rollout's lines with what each weighs, a line over 16 MB named but not kept, as the readers skip one. */
async function* rolloutLines(path: string): AsyncGenerator<{ text: string; bytes: number; skipped: boolean }> {
  const limit = 16 * 1024 * 1024
  let pieces: Buffer[] = []
  let size = 0
  for await (const chunk of createReadStream(path)) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    let start = 0
    for (let end = bytes.indexOf(0x0a); end >= 0; end = bytes.indexOf(0x0a, start)) {
      const piece = bytes.subarray(start, end)
      const whole = size + piece.length
      yield whole > limit ? { text: "", bytes: whole, skipped: true } : { text: Buffer.concat([...pieces, piece], whole).toString("utf8"), bytes: whole, skipped: false }
      pieces = []
      size = 0
      start = end + 1
    }
    if (size + bytes.length - start <= limit) pieces.push(Buffer.from(bytes.subarray(start)))
    size += bytes.length - start
  }
}
