import { execFile } from "node:child_process"
import { statfs } from "node:fs/promises"
import { availableParallelism, homedir, loadavg, totalmem } from "node:os"
import { promisify } from "node:util"
import { onMac } from "../base/platform.js"

/** What this Mac has and what's at work on it, as admission reads it when a Fin would start (`macSlots`). */
export interface MacReading {
  cores: number
  memoryBytes: number
  /** The 1-minute load average: runnable threads, the person's own work and every Fin's alike. */
  load: number
  /** Swap still free; undefined where it can't be read. */
  swapFreeBytes?: number
  /** Free space where worktrees are made; undefined where it can't be read. */
  diskFreeBytes?: number
  /** Fins at once as `MAKO_FIN_SLOTS` sets them, in place of the measure: a test's host, whatever machine runs it. */
  fixed?: number
}

/** How many Fins this Mac runs at once now, and why. */
export interface MacSlots {
  slots: number
  /** Fins at work on this Mac, every tree's. */
  working: number
  /** The load that isn't Fins': what else the person runs. */
  others: number
  /** In the person's words: "14 cores, 36 GB, 3 cores of other work". */
  why: string
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
/** Below these the Mac takes no Fin (`orchestration.md` 5.5): it's swapping or out of room for worktrees. */
const SWAP_FREE_LEAST = 300 * 1024 ** 2
const DISK_FREE_LEAST = 10 * 1024 ** 3

const GB = (bytes: number) => Math.round(bytes / 1024 ** 3)

/**
 * The Fins this Mac runs at once: the cores the person's own work leaves, a Fin's `FIN_LOAD` each, and its memory, a
 * Fin's `FIN_MEMORY` each, whichever is fewer, and always one, so a small or busy Mac's tree goes on a Fin at a time;
 * none while it's swapping or short of disk. The person's own work is the load the working Fins don't account for, so
 * a Mac busy with something else takes fewer.
 */
export function macSlots(reading: MacReading, working: number): MacSlots {
  if (reading.fixed !== undefined) return { slots: reading.fixed, working, others: 0, why: `${reading.fixed} set by MAKO_FIN_SLOTS` }
  const others = Math.max(0, reading.load - working * FIN_LOAD)
  const cpu = Math.floor((reading.cores - PERSON_CORES(reading.cores) - others) / FIN_LOAD)
  const memory = Math.floor((reading.memoryBytes - PERSON_MEMORY) / FIN_MEMORY)
  const short = reading.swapFreeBytes !== undefined && reading.swapFreeBytes < SWAP_FREE_LEAST ? "it's out of swap"
    : reading.diskFreeBytes !== undefined && reading.diskFreeBytes < DISK_FREE_LEAST ? `it has ${GB(reading.diskFreeBytes)} GB of disk free`
    : undefined
  const slots = short ? 0 : Math.max(1, Math.min(cpu, memory))
  const parts = [`${reading.cores} cores`, `${GB(reading.memoryBytes)} GB`, ...others >= 1 ? [`${Math.round(others)} cores of other work`] : [], ...short ? [short] : []]
  return { slots, working, others, why: parts.join(", ") }
}

/** Reads this Mac for `macSlots`, at most every `READ_EVERY_MS`: a burst of starts reads it once. */
export class MacCapacity {
  #last: { at: number; reading: MacReading } | undefined
  readonly #folder: string
  readonly #now: () => number

  readonly #fixed: number | undefined

  constructor(options: { folder?: string; now?: () => number; fixed?: number } = {}) {
    this.#folder = options.folder ?? homedir()
    this.#now = options.now ?? Date.now
    this.#fixed = options.fixed
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
      ...this.#fixed !== undefined && { fixed: this.#fixed },
    }
    this.#last = { at: now, reading }
    return reading
  }
}

const READ_EVERY_MS = 5_000

/** The Fins at once `MAKO_FIN_SLOTS` sets, a whole number of at least one; undefined to measure the Mac. */
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
