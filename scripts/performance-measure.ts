import { cp, readdir, readFile, stat } from "node:fs/promises"
import type { Profiler } from "node:inspector"
import { Session } from "node:inspector/promises"
import { join } from "node:path"
import { PAIRS_FOLDER, PairSchema } from "./decode-compare"
import { FIXTURE_ROOT } from "./native-decoding"

/**
 * How the performance scripts time work (`test-performance-budgets.ts`,
 * `perf-decoders.ts`): the main thread's CPU time, as a multiple of a fixed
 * calibration workload timed alongside, so a number recorded on one machine
 * holds on another. CPU time leaves out the time the thread waited for a
 * core, which on a loaded machine is most of the noise in wall time.
 */

export type Work = () => number | Promise<number>

/** Milliseconds of CPU time the calling thread has used. */
function cpu(): number {
  const { user, system } = process.threadCpuUsage()
  return (user + system) / 1000
}

async function once(run: Work): Promise<number> {
  const started = cpu()
  await run()
  return cpu() - started
}

/** Work of the same mix the hot paths do: strings, objects, maps and JSON. */
export function calibration(): number {
  let sum = 0
  const map = new Map<string, number>()
  for (let index = 0; index < 20_000; index++) {
    const text = `item-${index}-${"x".repeat(index % 64)}`
    map.set(text, index)
    sum += JSON.parse(JSON.stringify({ text, index })).index + (map.get(text) ?? 0)
  }
  return sum
}

export interface Timing {
  /** One run's CPU time, in milliseconds: the median sample's share. */
  ms: number
  /** The median of each sample as a multiple of the calibration run timed just before it. */
  units: number
  /** How far the middle half of the samples spread, as a fraction of `units`. */
  spread: number
}

/** A sample shorter than this is mostly the timer and the JIT's whims, so a short run is repeated within one. */
const SAMPLE_MS = 25

/**
 * The median of several samples after a warmup, each timed right after a
 * calibration run so the two see the same machine; a collection or another
 * process landing in one sample moves the median little. A sample repeats a
 * short run until it takes `SAMPLE_MS`.
 */
export async function timing(run: Work, repetitions = 11): Promise<Timing> {
  await run()
  calibration()
  const runs = Math.max(1, Math.ceil(SAMPLE_MS / Math.max(await once(run), 0.01)))
  const sample = async () => {
    for (let index = 0; index < runs; index++) await run()
    return runs
  }
  const ratios: number[] = []
  const times: number[] = []
  for (let index = 0; index < repetitions; index++) {
    const reference = await once(calibration)
    const ms = (await once(sample)) / runs
    times.push(ms)
    ratios.push(ms / reference)
  }
  const units = median(ratios)
  return { ms: median(times), units, spread: (quantile(ratios, 0.75) - quantile(ratios, 0.25)) / units }
}

/** How much CPU time a profile samples: fewer samples leave a frame's share to chance. */
const PROFILE_MS = 1_000

/** A CPU profile of the work alone, after a warmup, repeated until it has run `PROFILE_MS`, sampled every 100 µs. */
export async function profiled(run: Work): Promise<Profiler.Profile> {
  const repetitions = Math.max(1, Math.ceil(PROFILE_MS / Math.max(await once(run), 0.01)))
  const session = new Session()
  session.connect()
  try {
    await session.post("Profiler.enable")
    await session.post("Profiler.setSamplingInterval", { interval: 100 })
    await session.post("Profiler.start")
    for (let index = 0; index < repetitions; index++) await run()
    return (await session.post("Profiler.stop")).profile
  } finally {
    session.disconnect()
  }
}

export interface Hotspot {
  /** `function file:line`. */
  frame: string
  /** Time sampled in the frame itself. */
  selfMs: number
  /** Time sampled in the frame or anything it called, counted once per sample however often it recurs. */
  totalMs: number
}

/** A profile's frames by where its time went, hottest first. */
export function hotspots(profile: Profiler.Profile): Hotspot[] {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]))
  const parents = new Map<number, number>()
  for (const node of profile.nodes) for (const child of node.children ?? []) parents.set(child, node.id)
  const frame = (node: Profiler.ProfileNode) => {
    const { functionName, url, lineNumber } = node.callFrame
    return `${functionName || "(anonymous)"} ${url.split("/").slice(-2).join("/")}:${lineNumber + 1}`
  }
  const sampled = new Map<number, number>()
  for (const [index, id] of (profile.samples ?? []).entries()) sampled.set(id, (sampled.get(id) ?? 0) + (profile.timeDeltas?.[index] ?? 0))
  // The profiler's own start call is sampled too.
  for (const id of sampled.keys()) if (nodes.get(id)!.callFrame.url === "node:inspector") sampled.delete(id)
  const spots = new Map<string, Hotspot>()
  const spot = (name: string) => spots.get(name) ?? spots.set(name, { frame: name, selfMs: 0, totalMs: 0 }).get(name)!
  for (const [id, micros] of sampled) {
    spot(frame(nodes.get(id)!)).selfMs += micros / 1000
    const counted = new Set<string>()
    for (let at: number | undefined = id; at !== undefined; at = parents.get(at)) {
      const name = frame(nodes.get(at)!)
      if (counted.has(name)) continue
      counted.add(name)
      spot(name).totalMs += micros / 1000
    }
  }
  return [...spots.values()].sort((left, right) => right.selfMs - left.selfMs)
}

export function median(values: number[]): number {
  return quantile(values, 0.5)
}

function quantile(values: number[], at: number): number {
  const sorted = [...values].sort((left, right) => left - right)
  const position = (sorted.length - 1) * at
  const below = Math.floor(position)
  return sorted[below]! + (sorted[Math.ceil(position)]! - sorted[below]!) * (position - below)
}

/** A store reader's largest kept pair store, copied out so no reader opens the fixture itself. */
export interface KeptStore {
  reader: string
  /** The pair, as `<harness>/<name>`. */
  name: string
  home: string
  path: string
}

/** Each store reader's largest kept pair store (by its home's bytes), copied under `scratch`. */
export async function keptPairStores(scratch: string, root = FIXTURE_ROOT): Promise<KeptStore[]> {
  const largest = new Map<string, { name: string; folder: string; path: string; bytes: number }>()
  for (const harness of await readdir(root)) {
    const pairs = join(root, harness, PAIRS_FOLDER)
    for (const name of await readdir(pairs).catch(() => [])) {
      const folder = join(pairs, name)
      const pair = PairSchema.parse(JSON.parse(await readFile(join(folder, "pair.json"), "utf8")))
      const bytes = await treeBytes(join(folder, "home"))
      for (const store of pair.stores)
        if (bytes > (largest.get(store.reader)?.bytes ?? -1)) largest.set(store.reader, { name: `${harness}/${name}`, folder, path: store.path, bytes })
    }
  }
  return Promise.all([...largest].map(async ([reader, kept]) => {
    const home = join(scratch, reader)
    await cp(join(kept.folder, "home"), home, { recursive: true })
    return { reader, name: kept.name, home, path: join(home, kept.path) }
  }))
}

async function treeBytes(folder: string): Promise<number> {
  const files = (await readdir(folder, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile())
  const sizes = await Promise.all(files.map(async (entry) => (await stat(join(entry.parentPath, entry.name))).size))
  return sizes.reduce((sum, size) => sum + size, 0)
}
