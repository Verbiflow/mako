import { access, mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { z } from "zod"
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
 * Captures come from running Mako with `MAKO_NATIVE_CAPTURE=codex`; they sit
 * in `native-captures/` beside the host log. A capture holds conversation
 * content: read the fixture it becomes before committing it. A fixture's
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
  },
})

const path = positionals[0]
if (!path) {
  console.error("Usage: npm run decode -- <capture.jsonl | fixture.json | messages.jsonl> [--harness codex] [--session JSON] [--kind KIND] [--json] " +
    "[--fixture NAME --about TEXT --source TEXT --version VERSION --sdk NAME@VERSION --origin captured|written]")
  process.exit(2)
}

const recording = await readRecording(path)
const harness = options.harness ?? recording.harness
if (!harness) {
  console.error(`${path} has no capture header; name its harness with --harness`)
  process.exit(2)
}
const session = options.session ? z.record(z.string(), z.json()).parse(JSON.parse(options.session)) : recording.session
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
  await writeFile(target, serializeFixture({
    harness,
    source: options.source ?? "recorded with MAKO_NATIVE_CAPTURE",
    native,
    about: options.about,
    session,
    steps: steps.map((step) => ({ message: step.message, decoded: step.decoded })),
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
