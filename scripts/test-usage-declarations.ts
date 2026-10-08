// Each harness declares what it reports about usage (`usage` in its
// definition), and the window reads that declaration instead of whatever
// arrives. This holds the declarations to the decoders: every recorded
// session and fixture is replayed through its harness's decoder, and a
// reading the declaration rules out fails, as does a declared one no
// recording shows. What a recording can't show (Grok's word that it missed
// calls, which no scripted session triggers) is held by `test-session-usage.ts`.
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { CONTEXT_COMPACTED } from "@mako/sessions/events"
import { HARNESS_USAGE_LABELS, type HarnessUsageKey } from "../electron/contracts/harness-usage.ts"
import { providerHost } from "../electron/providers/index.ts"
import { decoderFor, FIXTURE_ROOT, readRecording, replayed } from "./native-decoding.ts"

/** What one harness's recordings showed, counted by recording. */
interface Shown {
  recordings: number
  context: number
  tokens: number
  cost: number
  missedCalls: number
  compactions: number
  /** Recordings whose meter, after a compaction, kept its earlier reading marked. */
  staleAfterCompaction: number
}

async function recordingsOf(harness: string): Promise<string[]> {
  const folder = join(FIXTURE_ROOT, harness)
  const files = (await readdir(folder)).filter((name) => name.endsWith(".json")).map((name) => join(folder, name))
  const pairs = join(folder, "pairs")
  if (existsSync(pairs)) for (const pair of (await readdir(pairs)).sort()) files.push(join(pairs, pair, "capture.jsonl"))
  return files
}

async function shownBy(harness: string): Promise<Shown> {
  const shown: Shown = { recordings: 0, context: 0, tokens: 0, cost: 0, missedCalls: 0, compactions: 0, staleAfterCompaction: 0 }
  for (const file of await recordingsOf(harness)) {
    const recording = await readRecording(file)
    const decoder = decoderFor(harness).open(recording.session)
    const seen = { context: false, tokens: false, cost: false, missedCalls: false, compacted: false, stale: false }
    for (const { decoded } of replayed(decoder, recording))
      for (const item of decoded) {
        if (item.kind === "compacted" || (item.kind === "marker" && item.marker.label === CONTEXT_COMPACTED)) seen.compacted = true
        const usage = item.kind === "state" ? item.patch.usage : undefined
        if (!usage) continue
        if (usage.used !== undefined) seen.context = true
        if (usage.tokens) seen.tokens = true
        if (usage.cost) seen.cost = true
        if (usage.unrecorded) seen.missedCalls = true
        if (usage.compacted) seen.stale = true
      }
    shown.recordings++
    if (seen.context) shown.context++
    if (seen.tokens) shown.tokens++
    if (seen.cost) shown.cost++
    if (seen.missedCalls) shown.missedCalls++
    if (seen.compacted) shown.compactions++
    if (seen.stale) shown.staleAfterCompaction++
  }
  return shown
}

/** The fields a recording can show, each with the count that shows it. */
const READINGS = {
  context: "context",
  window: "context",
  tokens: "tokens",
  cost: "cost",
  missedCalls: "missedCalls",
} as const satisfies Partial<Record<HarnessUsageKey, keyof Shown>>
/** Shown only through a case no recording reaches; its absence is still held. */
const UNRECORDED = new Set<HarnessUsageKey>(["missedCalls"])

const failures: string[] = []
const rows: string[] = []
for (const { provider, usage } of providerHost.harnesses.list()) {
  const shown = await shownBy(provider)
  const fail = (problem: string) => failures.push(`${provider}: ${problem}`)
  for (const [key, count] of Object.entries(READINGS) as [keyof typeof READINGS, keyof Shown][]) {
    const declared = usage[key].state === "implemented"
    const label = HARNESS_USAGE_LABELS[key].toLowerCase()
    if (!declared && shown[count] > 0) fail(`declares no ${label} (${usage[key].state === "absent" ? usage[key].reason : usage[key].state}), yet ${shown[count]} of ${shown.recordings} recordings show one`)
    if (declared && shown[count] === 0 && !UNRECORDED.has(key)) fail(`declares ${label}, yet none of its ${shown.recordings} recordings shows one`)
  }
  const compaction = usage.compaction.state
  if (compaction === "implemented" && shown.staleAfterCompaction)
    fail(`declares that compaction says what is left, yet ${shown.staleAfterCompaction} recordings keep the earlier reading marked`)
  if (compaction === "default" && shown.compactions && !shown.staleAfterCompaction)
    fail("declares that the meter waits for the next reply after compaction, yet no recording with a compaction marks its reading")
  if (compaction === "default" && !shown.compactions) fail("declares what its meter reads after compaction, yet no recording compacts")
  if (compaction === "absent" && shown.staleAfterCompaction) fail("declares no meter after compaction, yet a recording marks a reading as compacted")
  rows.push([provider.padEnd(9), String(shown.recordings).padStart(3), ...(["context", "tokens", "cost", "missedCalls", "compactions", "staleAfterCompaction"] as const).map((key) => String(shown[key]).padStart(key.length))].join("  "))
}

console.log(`harness   rec  context  tokens  cost  missedCalls  compactions  staleAfterCompaction`)
for (const row of rows) console.log(row)
if (failures.length) assert.fail(failures.join("\n"))
console.log("usage declarations: every recording's readings agree with what its harness declares")
