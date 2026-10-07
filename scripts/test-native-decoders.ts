import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import { isDeepStrictEqual, parseArgs } from "node:util"
import { z } from "zod"
import type { JsonValue } from "../electron/codex-app-json.ts"
import {
  decoders,
  decodeSession,
  loadFixtures,
  serializeFixture,
  summarize,
  type DecodedStep,
} from "./native-decoding.ts"

/**
 * Every harness decoder against its recorded sessions.
 *
 *   npm run test:decoders                                      check every fixture
 *   npx tsx scripts/test-native-decoders.ts --harness codex    one harness
 *   npx tsx scripts/test-native-decoders.ts --only compaction  fixtures whose name matches
 *   npx tsx scripts/test-native-decoders.ts --update           accept what decoders produce now
 *   npx tsx scripts/test-native-decoders.ts --coverage         list kinds no fixture exercises
 *
 * A step without `decoded` is new: `--update` fills it in for review. Beyond
 * the expected events, each step checks the decoder's own lists: a kind it
 * calls silent decodes to nothing, a kind it calls decoded is not reported
 * unknown, and a kind on neither list is reported unknown.
 */

const { values: options } = parseArgs({
  options: {
    update: { type: "boolean", default: false },
    harness: { type: "string" },
    only: { type: "string" },
    coverage: { type: "boolean", default: false },
  },
})

const UnknownSchema = z.object({ kind: z.literal("unknown"), type: z.string(), reason: z.string() })
const MAX_DIFF_LINES = 40

const failures: string[] = []
const fail = (where: string, problem: string) => failures.push(`✗ ${where}\n${indent(problem)}`)
const sources = decoders().filter((source) => !options.harness || source.provider === options.harness)
assert.ok(sources.length, options.harness ? `No decoder for ${options.harness}` : "No harness has a decoder")

for (const source of sources) {
  const { files, invalid } = await loadFixtures(source.provider)
  for (const file of invalid) fail(file.name, file.problem)
  if (!files.length && !invalid.length) fail(source.provider, `has a decoder and no fixtures in scripts/fixtures/native-decoding/${source.provider}`)
  const exercised = new Set<string>()
  const vendorKinds = new Set<string>()
  let checked = 0
  for (const file of files) {
    const { fixture } = file
    if (fixture.harness !== source.provider) {
      fail(file.name, `says it records ${fixture.harness} but sits in ${source.provider}/`)
      continue
    }
    const steps = decodeSession(source, fixture.session, fixture.steps.map((step) => step.message))
    for (const step of steps) exercised.add(step.kind)
    if (options.only && !file.name.includes(options.only)) continue
    checked++
    let changed = 0
    steps.forEach((step, index) => {
      const where = `${file.name} step ${index + 1} (${step.kind})`
      const declared = source.declares?.(step.message)
      if (declared) vendorKinds.add(step.kind)
      for (const problem of listProblems(step, source.silent, source.decoded, declared)) fail(where, problem)
      const expected = fixture.steps[index]!.decoded
      if (expected && isDeepStrictEqual(expected, step.decoded)) return
      if (options.update) {
        fixture.steps[index]!.decoded = step.decoded
        changed++
        return
      }
      fail(where, expected ? difference(expected, step.decoded) : "has no expected events yet; run with --update and review them")
    })
    if (changed) {
      await writeFile(file.path, serializeFixture(fixture))
      console.log(`updated ${file.name}: ${changed} step${changed === 1 ? "" : "s"}`)
    }
  }
  const decoded = [...source.decoded]
  const missing = decoded.filter((kind) => !exercised.has(kind)).sort()
  const silent = [...source.silent].filter((kind) => exercised.has(kind)).length
  console.log(`${source.provider}: ${checked} fixture${checked === 1 ? "" : "s"}; ` +
    `${decoded.length - missing.length} of ${decoded.length} decoded kinds and ${silent} of ${source.silent.size} silent kinds exercised` +
    (vendorKinds.size ? `, ${vendorKinds.size} more classed by the harness's own tables` : ""))
  if (!options.only && missing.length) fail(source.provider, `decoded kinds lack fixtures: ${missing.join(", ")}`)
  if (options.coverage && missing.length) console.log(indent(`not exercised: ${missing.join(", ")}`))
}

if (failures.length) {
  console.error(`\n${failures.join("\n\n")}\n`)
  console.error(`${failures.length} decoding fixture problem${failures.length === 1 ? "" : "s"}. ` +
    "If a change is intended, run `npx tsx scripts/test-native-decoders.ts --update` and review the fixture diff.")
  process.exit(1)
}
console.log("PASS: every harness decoder matches its recorded sessions")

function listProblems(step: DecodedStep, silent: ReadonlySet<string>, decoded: ReadonlySet<string>, declared?: "decoded" | "silent"): string[] {
  const unknown = step.decoded.flatMap((event) => {
    const parsed = UnknownSchema.safeParse(event)
    return parsed.success && parsed.data.type === step.kind ? [parsed.data.reason] : []
  })
  if (declared === "silent" || silent.has(step.kind))
    return step.decoded.length ? ["is listed silent, yet decodes to events"] : []
  if (declared === "decoded" || decoded.has(step.kind))
    return unknown.includes("unknown") ? ["is listed decoded, yet the decoder reports it unknown"] : []
  return unknown.length ? [] : ["is on neither list, yet the decoder did not report it unknown; list it as decoded or silent"]
}

function difference(expected: JsonValue[], actual: JsonValue[]): string {
  const lines = [
    "expected:",
    ...expected.map((event) => `  ${summarize(event)}`),
    "decoded:",
    ...actual.map((event) => `  ${summarize(event)}`),
  ]
  try {
    assert.deepStrictEqual(actual, expected)
  } catch (error) {
    const detail = String(error instanceof Error ? error.message : error).split("\n").slice(1)
    lines.push("difference:", ...detail.slice(0, MAX_DIFF_LINES))
    if (detail.length > MAX_DIFF_LINES) lines.push(`… ${detail.length - MAX_DIFF_LINES} more lines`)
  }
  return lines.join("\n")
}

function indent(text: string): string {
  return text.split("\n").map((line) => `    ${line}`).join("\n")
}
