import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { z } from "zod"
import { PRIOR_COST, type FinCost } from "./fin-capacity.js"

/** One reading of a working Fin's processes: the cores they used over the reading's window and their resident memory. */
export interface FinCostSample {
  harness: string
  cores: number
  memoryBytes: number
  /** A build or test run held the window (a known build process, or more than `BUILD_CORES`). */
  build?: boolean
}

/** A window past this many cores is a build's, whatever its processes are named. */
export const BUILD_CORES = 1.5
/** Readings before a harness's own estimate counts in full; until then it's blended with `PRIOR_COST`. */
const TRUSTED_AFTER = 60
/** How far each reading moves an estimate: about a few days of readings at one every 10 s while Fins work. */
const STEP = 0.002

const Estimate = z.object({ value: z.number(), scale: z.number().nonnegative() })
type Estimate = z.infer<typeof Estimate>
const HarnessCost = z.object({ light: z.number().int().nonnegative(), builds: z.number().int().nonnegative(), cores: Estimate, memory: Estimate, buildCores: Estimate, buildMemory: Estimate })
type HarnessCost = z.infer<typeof HarnessCost>
const Stored = z.object({ version: z.literal(1), harnesses: z.record(z.string(), HarnessCost.optional().catch(undefined)) })

/**
 * What a Fin costs on this machine, per harness (`fin-capacity.ts`): the 75th percentile of its light cores and
 * memory, and the median peak of its builds, each a streaming quantile that moves a little with every reading, so it
 * follows the machine over days and never a single minute. A harness it hasn't read enough of is blended with
 * `PRIOR_COST`; one it never read is the prior. Kept in one file on this machine.
 */
export class FinCostModel {
  readonly #file: string | undefined
  #harnesses = new Map<string, HarnessCost>()
  #dirty = false

  constructor(file?: string) {
    this.#file = file
    if (!file) return
    try {
      const stored = Stored.parse(JSON.parse(readFileSync(file, "utf8")))
      for (const [harness, cost] of Object.entries(stored.harnesses)) if (cost) this.#harnesses.set(harness, cost)
    } catch {
      // A missing or unreadable file starts from the prior.
    }
  }

  add(sample: FinCostSample): void {
    if (!Number.isFinite(sample.cores) || !Number.isFinite(sample.memoryBytes) || sample.cores < 0 || sample.memoryBytes < 0) return
    const held = this.#harnesses.get(sample.harness) ?? fresh()
    const build = sample.build || sample.cores > BUILD_CORES
    if (build) {
      held.builds += 1
      held.buildCores = moved(held.buildCores, sample.cores, 0.5, held.builds)
      held.buildMemory = moved(held.buildMemory, sample.memoryBytes, 0.5, held.builds)
    } else {
      held.light += 1
      held.cores = moved(held.cores, sample.cores, 0.75, held.light)
      held.memory = moved(held.memory, sample.memoryBytes, 0.75, held.light)
    }
    this.#harnesses.set(sample.harness, held)
    this.#dirty = true
  }

  /** What a Fin costs here, weighted by `mix` (each harness's share of the Fins at work); every harness read, evenly, without one. */
  cost(mix?: Readonly<Record<string, number>>): FinCost {
    const weights = Object.entries(mix ?? Object.fromEntries([...this.#harnesses.keys()].map((harness) => [harness, 1]))).filter(([, weight]) => weight > 0)
    const total = weights.reduce((sum, [, weight]) => sum + weight, 0)
    if (!total) return PRIOR_COST
    const sum: FinCost = { cores: 0, memoryBytes: 0, buildCores: 0, buildMemoryBytes: 0 }
    for (const [harness, weight] of weights) {
      const one = this.of(harness)
      sum.cores += (one.cores * weight) / total
      sum.memoryBytes += (one.memoryBytes * weight) / total
      sum.buildCores += (one.buildCores * weight) / total
      sum.buildMemoryBytes += (one.buildMemoryBytes * weight) / total
    }
    return sum
  }

  /** One harness's cost here, blended with the prior until it has `TRUSTED_AFTER` readings of each kind. */
  of(harness: string): FinCost {
    const held = this.#harnesses.get(harness)
    if (!held) return PRIOR_COST
    const light = Math.min(1, held.light / TRUSTED_AFTER)
    const builds = Math.min(1, held.builds / TRUSTED_AFTER)
    const blend = (own: number, prior: number, trust: number) => own * trust + prior * (1 - trust)
    return {
      cores: blend(held.cores.value, PRIOR_COST.cores, light),
      memoryBytes: blend(held.memory.value, PRIOR_COST.memoryBytes, light),
      buildCores: blend(held.buildCores.value, PRIOR_COST.buildCores, builds),
      buildMemoryBytes: blend(held.buildMemory.value, PRIOR_COST.buildMemoryBytes, builds),
    }
  }

  /** Whether any harness's own readings count yet: until then the capacity is the prior's, and Settings says so. */
  measured(): boolean {
    return [...this.#harnesses.values()].some((held) => held.light >= TRUSTED_AFTER / 2)
  }

  /** Writes what changed since the last save; nothing without a file. */
  save(): void {
    if (!this.#file || !this.#dirty) return
    mkdirSync(dirname(this.#file), { recursive: true })
    const temporary = `${this.#file}.${process.pid}.tmp`
    writeFileSync(temporary, `${JSON.stringify({ version: 1, harnesses: Object.fromEntries(this.#harnesses) })}\n`)
    renameSync(temporary, this.#file)
    this.#dirty = false
  }
}

function fresh(): HarnessCost {
  return {
    light: 0,
    builds: 0,
    cores: { value: PRIOR_COST.cores, scale: PRIOR_COST.cores },
    memory: { value: PRIOR_COST.memoryBytes, scale: PRIOR_COST.memoryBytes },
    buildCores: { value: PRIOR_COST.buildCores, scale: PRIOR_COST.buildCores },
    buildMemory: { value: PRIOR_COST.buildMemoryBytes, scale: PRIOR_COST.buildMemoryBytes },
  }
}

/**
 * A streaming quantile: the estimate steps toward `quantile` of the readings by a share of their spread, larger
 * for its first readings so a new machine learns quickly, then `STEP`, so no run of readings swings it.
 */
function moved(estimate: Estimate, reading: number, quantile: number, count: number): Estimate {
  const rate = Math.max(STEP, 1 / (count + 1))
  const scale = estimate.scale + rate * (Math.abs(reading - estimate.value) - estimate.scale)
  const step = rate * Math.max(scale, 1e-6) * (reading > estimate.value ? quantile : quantile - 1) * 4
  return { value: Math.max(0, estimate.value + step), scale }
}
