import { execFile } from "node:child_process"
import { statfs } from "node:fs/promises"
import { availableParallelism, homedir, loadavg, totalmem } from "node:os"
import { promisify } from "node:util"
import { onMac } from "../base/platform.js"

/** What this Mac has and what's at work on it, as a Fin's start reads it (`macLoad`). */
export interface MacReading {
  cores: number
  memoryBytes: number
  /** The 1-minute load average: runnable threads, the person's own work and every Fin's alike. */
  load: number
  /** Swap still free; undefined where it can't be read. */
  swapFreeBytes?: number
  /** Free space where worktrees are made; undefined where it can't be read. */
  diskFreeBytes?: number
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
 * A working Fin's share of the Mac, in cores of load. Measured 2026-11-03 on a 14-core Mac: 13 Fins at work, with
 * the builds and tests they ran, held the 1-minute load at 26.8, and one Fin building took 6 cores at its peak while
 * idle ones took none.
 */
export const FIN_LOAD = 2
/** A working Fin's memory: the largest Fin's processes held 1.8 GB that day and the average 0.35 GB. */
export const FIN_MEMORY = 1024 ** 3
/** What the person keeps for their own apps whatever Fins want: a seventh of the cores, at least two, and 4 GB. */
const PERSON_CORES = (cores: number) => Math.max(2, cores / 7)
const PERSON_MEMORY = 4 * 1024 ** 3
/** Below these the Mac is short whatever its load: it's swapping or out of room for worktrees. */
const SWAP_FREE_LEAST = 300 * 1024 ** 2
const DISK_FREE_LEAST = 10 * 1024 ** 3

const GB = (bytes: number) => Math.round(bytes / 1024 ** 3)

/**
 * Whether this Mac is busy: the Fins at work take the cores the person's own work leaves, a Fin's `FIN_LOAD` each, or
 * its memory, a Fin's `FIN_MEMORY` each, or it's swapping or short of disk. The person's own work is the load the
 * working Fins don't account for.
 */
export function macLoad(reading: MacReading, working: number): MacLoad {
  const others = Math.max(0, reading.load - working * FIN_LOAD)
  const cpu = Math.floor((reading.cores - PERSON_CORES(reading.cores) - others) / FIN_LOAD)
  const memory = Math.floor((reading.memoryBytes - PERSON_MEMORY) / FIN_MEMORY)
  const short = reading.swapFreeBytes !== undefined && reading.swapFreeBytes < SWAP_FREE_LEAST ? "it's out of swap"
    : reading.diskFreeBytes !== undefined && reading.diskFreeBytes < DISK_FREE_LEAST ? `it has ${GB(reading.diskFreeBytes)} GB of disk free`
    : undefined
  const parts = [`${reading.cores} cores`, `${GB(reading.memoryBytes)} GB`, ...others >= 1 ? [`${Math.round(others)} cores of other work`] : [], ...short ? [short] : []]
  const load: MacLoad = { why: parts.join(", ") }
  if (short || working >= Math.min(cpu, memory)) load.busy = true
  return load
}

/** Reads this Mac for `macLoad`, at most every `READ_EVERY_MS`: a burst of starts reads it once. */
export class MacCapacity {
  #last: { at: number; reading: MacReading } | undefined
  readonly #folder: string
  readonly #now: () => number

  constructor(options: { folder?: string; now?: () => number } = {}) {
    this.#folder = options.folder ?? homedir()
    this.#now = options.now ?? Date.now
  }

  async read(): Promise<MacReading> {
    const now = this.#now()
    if (this.#last && now - this.#last.at < READ_EVERY_MS) return this.#last.reading
    const [swapFreeBytes, diskFreeBytes] = await Promise.all([swapFree(), statfs(this.#folder).then((stats) => stats.bavail * stats.bsize, () => undefined)])
    const reading: MacReading = {
      cores: availableParallelism(),
      memoryBytes: totalmem(),
      load: loadavg()[0] ?? 0,
      ...swapFreeBytes !== undefined && { swapFreeBytes },
      ...diskFreeBytes !== undefined && { diskFreeBytes },
    }
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
