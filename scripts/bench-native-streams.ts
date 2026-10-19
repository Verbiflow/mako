import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import fs from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { performance } from "node:perf_hooks"
import { setImmediate as tick } from "node:timers/promises"
import { z } from "zod"
import { nativeStream } from "@mako/host/harnesses/native-stream"
import { NativeStores } from "@mako/sessions/read-only-sqlite"
import { RecordStore } from "../packages/sessions/src/record-store.ts"
import { StreamListings, streamPath, streamsOf, streamsRoot, withStreams } from "../packages/sessions/src/record-streams.ts"
import { FIXTURE_ROOT, readRecording } from "./native-decoding.ts"

/**
 * What keeping every launch's stream costs, on the frames of every recorded
 * pair (`fixtures/native-decoding/<harness>/pairs/*\/capture.jsonl`), each
 * recorded again as the drivers record it now:
 *
 *   npm run bench:streams
 *
 * - the driver's cost: the time `record` holds the thread that decodes, per
 *   frame, and the appends that reach the disk, when frames come one per
 *   turn of the event loop (the worst case) and when they come in bursts;
 * - what a stream weighs against the harness's own records, per turn;
 * - what the record store keeps of it, and what a capture of a growing
 *   stream costs;
 * - finding a session's streams among many.
 */

const HARNESSES = ["claude", "codex", "cursor", "devin", "grok", "opencode"]
const root = await mkdtemp(join(tmpdir(), "mako-bench-streams-"))
const mib = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MiB`
const kib = (bytes: number) => `${(bytes / 1024).toFixed(1)} KiB`

let appends = 0
const appendFile = fs.appendFile
fs.appendFile = (...args: Parameters<typeof appendFile>) => {
  appends++
  return appendFile(...args)
}
syncBuiltinESMExports()

const PairFileSchema = z.object({ stores: z.array(z.object({ path: z.string() })).default([]) })
/** A rollout read as a pair embeds it, which a Codex stream now names by its bytes. */
const EmbeddedReadsSchema = z.object({ records: z.array(z.object({ from: z.number(), to: z.number() })).min(1) })

interface Pair {
  harness: string
  messages: unknown[]
  turns: number
  recordBytes: number
}

async function pairs(harness: string): Promise<Pair[]> {
  const found: Pair[] = []
  const folder = join(FIXTURE_ROOT, harness, "pairs")
  for (const name of (await readdir(folder).catch(() => [])).sort()) {
    const recording = await readRecording(join(folder, name, "capture.jsonl")).catch(() => null)
    if (!recording) continue
    const { stores } = PairFileSchema.parse(JSON.parse(await readFile(join(folder, name, "pair.json"), "utf8")))
    let recordBytes = 0
    for (const store of stores) recordBytes += await stat(join(folder, name, "home", store.path.replace(/#.*$/, ""))).then((info) => info.size, () => 0)
    const messages = recording.messages.map((message) => {
      const reads = EmbeddedReadsSchema.safeParse(message)
      return reads.success ? { records: { rollout: join(folder, name, "home", "rollout.jsonl"), from: reads.data.records[0]!.from, to: reads.data.records.at(-1)!.to } } : message
    })
    found.push({ harness, messages, turns: Math.max(1, recording.prompts?.length ?? 1), recordBytes })
  }
  return found
}

/** Records `messages` one per turn of the event loop, or all in one; the time `record` held the thread, and the appends. */
async function recordAll(harness: string, messages: unknown[], burst: boolean, nativeId = "bench-session", keep = false): Promise<{ cpuMs: number; wallMs: number; appends: number; bytes: number; path: string | null }> {
  const before = appends
  const stream = nativeStream(harness, "bench", () => ({}), streamsRoot(root), () => nativeId)
  if (!stream) throw new Error("no stream")
  let cpu = 0
  const started = performance.now()
  for (const message of messages) {
    const at = performance.now()
    stream.record(message)
    cpu += performance.now() - at
    if (!burst) await tick()
  }
  await stream.flush()
  const wallMs = performance.now() - started
  const bytes = stream.path ? (await stat(stream.path)).size : 0
  if (stream.path && !keep) await rm(stream.path)
  return { cpuMs: cpu, wallMs, appends: appends - before, bytes, path: stream.path }
}

console.log("The driver's cost, per harness, over every recorded pair's frames")
console.log(`${"harness".padEnd(9)} ${"frames".padStart(7)} ${"bytes".padStart(10)}   ${"µs/frame".padStart(8)} ${"appends".padStart(8)} ${"wall".padStart(8)}   burst: ${"µs/frame".padStart(8)} ${"appends".padStart(7)}`)
const all = new Map<string, Pair[]>()
for (const harness of HARNESSES) {
  const found = await pairs(harness)
  all.set(harness, found)
  const messages = found.flatMap((pair) => pair.messages)
  if (!messages.length) continue
  // Warm the stringifier and the regex once.
  await recordAll(harness, messages.slice(0, 200), true)
  const ticked = await recordAll(harness, messages, false)
  const burst = await recordAll(harness, messages, true)
  console.log(`${harness.padEnd(9)} ${String(messages.length).padStart(7)} ${mib(ticked.bytes).padStart(10)}   ${(ticked.cpuMs * 1000 / messages.length).toFixed(1).padStart(8)} ${String(ticked.appends).padStart(8)} ${`${ticked.wallMs.toFixed(0)} ms`.padStart(8)}   burst: ${(burst.cpuMs * 1000 / messages.length).toFixed(1).padStart(8)} ${String(burst.appends).padStart(7)}`)
}

console.log("\nWhat a stream weighs against the harness's own records, and what the record store keeps of it")
const store = new RecordStore(join(root, "store"), new NativeStores(false))
const streams = streamsRoot(root)
try {
  for (const harness of HARNESSES) {
    const found = all.get(harness) ?? []
    if (!found.length) continue
    let raw = 0
    let kept = 0
    let ms = 0
    for (const [index, pair] of found.entries()) {
      await recordAll(harness, pair.messages, true, `session-${index}`, true)
      const records = withStreams({ roots: [], files: [], databases: [] }, streams, await streamsOf(streams, harness, `session-${index}`))
      const report = await store.capture({ harness, nativeId: `session-${index}`, home: root, records })
      raw += report.newBytes
      kept += report.storedBytes
      ms += report.ms
    }
    const turns = found.reduce((sum, pair) => sum + pair.turns, 0)
    const records = found.reduce((sum, pair) => sum + pair.recordBytes, 0)
    console.log(`${harness.padEnd(9)} ${String(found.length).padStart(3)} pairs ${String(turns).padStart(4)} turns   stream ${kib(raw / turns).padStart(9)}/turn, ${(raw / Math.max(1, records)).toFixed(2)}× the records' ${kib(records / turns).padStart(9)}/turn   stored ${kib(kept / turns).padStart(8)}/turn (${(kept / Math.max(1, raw) * 100).toFixed(0)}%), ${(ms / found.length).toFixed(1)} ms a capture`)
  }

  // A long launch: a stream grown to 64 MiB, then one more turn's frames.
  const claude = (all.get("claude") ?? []).flatMap((pair) => pair.messages)
  const grown = streamPath(streams, "claude", "long.jsonl", "long-session")
  const turn = `${claude.map((message) => JSON.stringify({ at: new Date().toISOString(), message })).join("\n")}\n`
  await writeFile(grown, turn.repeat(Math.ceil(64 * 1024 * 1024 / turn.length)))
  const records = async () => withStreams({ roots: [], files: [], databases: [] }, streams, await streamsOf(streams, "claude", "long-session"))
  const first = await store.capture({ harness: "claude", nativeId: "long-session", home: root, records: await records() })
  await fs.appendFile(grown, turn.slice(0, turn.indexOf("\n", 64 * 1024) + 1))
  const next = await store.capture({ harness: "claude", nativeId: "long-session", home: root, records: await records() })
  console.log(`a ${mib((await stat(grown)).size)} stream: first capture ${first.ms} ms (${mib(first.storedBytes)} stored); 64 KiB more frames: ${next.ms} ms, ${kib(next.newBytes)} read, ${next.versions.map((version) => version.kind).join(" ")}`)
} finally {
  await store.close()
}

console.log("\nFinding a session's streams")
for (const count of [1_000, 10_000, 50_000]) {
  const folder = join(root, `many-${count}`)
  await fs.mkdir(join(folder, "codex"), { recursive: true })
  await Promise.all(Array.from({ length: count }, (_, index) => writeFile(streamPath(folder, "codex", "launch.jsonl", `session-${index}`), "")))
  const runs = 20
  let started = performance.now()
  for (let run = 0; run < runs; run++) await streamsOf(folder, "codex", `session-${count - 1}`)
  const listed = (performance.now() - started) / runs
  const listings = new StreamListings(folder)
  started = performance.now()
  await listings.of("codex", `session-${count - 1}`)
  const first = performance.now() - started
  started = performance.now()
  for (let run = 0; run < runs; run++) await listings.of("codex", `session-${run}`)
  console.log(`${String(count).padStart(6)} stream files: ${listed.toFixed(2)} ms listing the folder; the catalog's listing ${first.toFixed(2)} ms once, then ${((performance.now() - started) / runs * 1000).toFixed(0)} µs a capture`)
  await rm(folder, { recursive: true, force: true })
}

await rm(root, { recursive: true, force: true })
