import { execFile } from "node:child_process"
import { statfs } from "node:fs/promises"
import { availableParallelism, homedir, totalmem } from "node:os"
import { promisify } from "node:util"
import { coresBusy, cpuTicks, type CpuTicks } from "../base/machine-load.js"
import { onMac } from "../base/platform.js"

/** What this Mac has and what's at work on it, as a Fin's start reads it (`macLoad`). */
export interface MacReading {
  cores: number
  memoryBytes: number
  /** Cores busy on average since the last reading, the person's own work and every Fin's alike; the rest are idle (`coresBusy`). */
  busyCores: number
  /** Swap still free; undefined where it can't be read. */
  swapFreeBytes?: number
  /** Free space where worktrees are made; undefined where it can't be read. */
  diskFreeBytes?: number
  /** The system says memory is under pressure (macOS's warn or critical level); undefined where it can't be read. */
  memoryPressure?: boolean
  /** The CPU is slowed for heat (macOS's CPU speed limit under 100); undefined where it can't be read. */
  hot?: boolean
}

/**
 * How this Mac stands as a Fin starts: a warning, never a reason it waits. How many run at once is the person's
 * limit (`FIN_LIMIT`); a busy Mac says so in the start's answer, so its Apex runs heavy work one at a time.
 */
export interface MacLoad {
  /** In the person's words: "14 cores, 36 GB, 3 cores of other work". */
  why: string
  /** Set while the Fins at work already take what the person's own work leaves, or it's out of swap or disk. */
  busy?: true
}

/**
 * A working Fin's share of the Mac, in cores. Measured 2026-11-03 on a 14-core Mac: 13 Fins at work, with the builds
 * and tests they ran, held the 1-minute load at 26.8, and one Fin building took 6 cores at its peak while idle ones
 * took none.
 */
export const FIN_LOAD = 2
/** A working Fin's memory: the largest Fin's processes held 1.8 GB that day and the average 0.35 GB. */
export const FIN_MEMORY = 1024 ** 3
/** What the person keeps for their own apps whatever Fins want: a seventh of the cores, at least two, and 4 GB. */
const PERSON_CORES = (cores: number) => Math.max(2, cores / 7)
const PERSON_MEMORY = 4 * 1024 ** 3
/** Below these the Mac is short whatever its load: it's swapping or out of room for worktrees. */
export const SWAP_FREE_LEAST = 300 * 1024 ** 2
export const DISK_FREE_LEAST = 10 * 1024 ** 3

const GB = (bytes: number) => Math.round(bytes / 1024 ** 3)

/**
 * Whether this Mac is busy: its idle cores, past the person's, have no room for another Fin at `FIN_LOAD`, or the Fins
 * at work take its memory, a Fin's `FIN_MEMORY` each, or it's swapping or short of disk. An idle core is room whatever
 * keeps the others busy. Other work is the busy cores the working Fins don't account for.
 */
export function macLoad(reading: MacReading, working: number): MacLoad {
  const others = Math.max(0, reading.busyCores - working * FIN_LOAD)
  const cpu = Math.floor((idleCores(reading) - PERSON_CORES(reading.cores)) / FIN_LOAD)
  const memory = Math.floor((reading.memoryBytes - PERSON_MEMORY) / FIN_MEMORY)
  const short = reading.swapFreeBytes !== undefined && reading.swapFreeBytes < SWAP_FREE_LEAST ? "it's out of swap"
    : reading.diskFreeBytes !== undefined && reading.diskFreeBytes < DISK_FREE_LEAST ? `it has ${GB(reading.diskFreeBytes)} GB of disk free`
    : undefined
  const parts = [`${reading.cores} cores`, `${GB(reading.memoryBytes)} GB`, ...others >= 1 ? [`${Math.round(others)} cores of other work`] : [], ...short ? [short] : []]
  const load: MacLoad = { why: parts.join(", ") }
  if (short || cpu < 1 || working >= memory) load.busy = true
  return load
}

/** The cores nothing is using. */
export function idleCores(reading: MacReading): number {
  return Math.max(0, reading.cores - reading.busyCores)
}

/** Reads this Mac for `macLoad`, at most every `READ_EVERY_MS`: a burst of starts reads it once. */
export class MacCapacity {
  #last: { at: number; reading: MacReading } | undefined
  readonly #folder: string
  readonly #now: () => number
  readonly #ticks: () => CpuTicks
  #ticksThen: CpuTicks

  constructor(options: { folder?: string; now?: () => number; ticks?: () => CpuTicks } = {}) {
    this.#folder = options.folder ?? homedir()
    this.#now = options.now ?? Date.now
    this.#ticks = options.ticks ?? cpuTicks
    this.#ticksThen = this.#ticks()
  }

  async read(): Promise<MacReading> {
    const now = this.#now()
    if (this.#last && now - this.#last.at < READ_EVERY_MS) return this.#last.reading
    const [swapFreeBytes, diskFreeBytes, memoryPressure, hot] = await Promise.all([swapFree(), statfs(this.#folder).then((stats) => stats.bavail * stats.bsize, () => undefined), pressured(), throttled()])
    const ticks = this.#ticks()
    const cores = availableParallelism()
    const reading: MacReading = {
      cores,
      memoryBytes: totalmem(),
      busyCores: coresBusy(this.#ticksThen, ticks, cores),
      ...swapFreeBytes !== undefined && { swapFreeBytes },
      ...diskFreeBytes !== undefined && { diskFreeBytes },
      ...memoryPressure !== undefined && { memoryPressure },
      ...hot !== undefined && { hot },
    }
    this.#ticksThen = ticks
    this.#last = { at: now, reading }
    return reading
  }
}

const READ_EVERY_MS = 5_000

/** The Fins at once `MAKO_FIN_SLOTS` sets in place of the person's limit, a whole number of at least one: a test's host. */
export function finSlots(): number | undefined {
  const set = Number(process.env.MAKO_FIN_SLOTS)
  return Number.isInteger(set) && set >= 1 ? set : undefined
}

const run = promisify(execFile)

/** macOS's free swap (`sysctl vm.swapusage`: "total = 5120.00M  used = 4208.94M  free = 911.06M"); undefined elsewhere. */
async function swapFree(): Promise<number | undefined> {
  if (!onMac()) return undefined
  const said = await run("/usr/sbin/sysctl", ["-n", "vm.swapusage"], { timeout: 2_000 }).then((out) => out.stdout, () => "")
  const free = /free = ([\d.]+)([KMG])/.exec(said)
  if (!free) return undefined
  const unit = free[2] === "G" ? 1024 ** 3 : free[2] === "M" ? 1024 ** 2 : 1024
  return Number(free[1]) * unit
}

/** macOS's memory pressure (`sysctl kern.memorystatus_vm_pressure_level`: 1 normal, 2 warn, 4 critical); undefined elsewhere. */
async function pressured(): Promise<boolean | undefined> {
  if (!onMac()) return undefined
  const said = await run("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"], { timeout: 2_000 }).then((out) => out.stdout.trim(), () => "")
  const level = Number(said)
  return said && Number.isFinite(level) ? level >= 2 : undefined
}

/** Whether macOS slows the CPU for heat (`pmset -g therm`: "CPU_Speed_Limit = 100"); undefined elsewhere. */
async function throttled(): Promise<boolean | undefined> {
  if (!onMac()) return undefined
  const said = await run("/usr/bin/pmset", ["-g", "therm"], { timeout: 2_000 }).then((out) => out.stdout, () => "")
  const limit = /CPU_Speed_Limit\s*=\s*(\d+)/.exec(said)
  return limit ? Number(limit[1]) < 100 : undefined
}
