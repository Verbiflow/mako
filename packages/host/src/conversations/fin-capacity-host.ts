import { availableParallelism, totalmem } from "node:os"
import { onLinux } from "../base/platform.js"
import type { FinCapacityReading } from "../contracts/fin-tuning.js"
import { CapacityGovernor, deviceCapacity, reserveOf, type FinHardware, type PressureReading } from "./fin-capacity.js"
import type { FinCostModel } from "./fin-cost.js"
import type { FinAtWork, FinCostReading } from "./fin-cost-sampler.js"
import { DISK_FREE_LEAST, SWAP_FREE_LEAST, type MacReading } from "./mac-capacity.js"

/** How long a reading of what Fins took stands when none comes after it: a few of the engine's looks. It says nothing of now past that. */
const FIN_CORES_FRESH_MS = 30_000

export interface FinCapacityDeps {
  /** This machine's load and pressure (`MacCapacity`). */
  read(): Promise<MacReading>
  costs: FinCostModel
  /** The person's own number for this device (Settings › Fins); undefined: its capacity. */
  own(): number | undefined
  /** `MAKO_FIN_SLOTS`: a test's host sets the number whatever the machine. */
  fixed?: number
  /** What each Fin at work here costs, read from its processes (`FinCostSampler`); the cost model learns from it. */
  sampler?: { sample(fins: readonly FinAtWork[]): Promise<FinCostReading[] | undefined> }
  hardware?(): FinHardware
  now?(): number
}

/**
 * This device's Fins at once (`fin-capacity.ts`): its hardware and what a Fin costs here set the number, the governor
 * lowers it under sustained pressure, and the person's own number replaces both. `observe` reads the machine; the
 * engine calls it as it looks at what waits, with the Fins at work and their harnesses.
 */
export class FinCapacity {
  readonly #deps: FinCapacityDeps
  readonly #governor = new CapacityGovernor()
  #mix: Record<string, number> = {}
  /** The cores the Fins at work took at the last reading of their processes (`sampler`), and when it was read. */
  #finCores = { cores: 0, at: 0 }
  #pressure: string | undefined
  #allowed: number | undefined
  #busyCores: number | undefined
  #pressedNow = false
  readonly #listeners = new Set<() => void>()

  constructor(deps: FinCapacityDeps) {
    this.#deps = deps
  }

  /** `fins`, the Fins at work here by conversation, when this look should also read what they cost. */
  async observe(working: number, mix: Readonly<Record<string, number>>, fins?: readonly FinAtWork[]): Promise<void> {
    const before = { fins: this.atOnce(), builds: this.builds() }
    this.#mix = { ...mix }
    if (fins && this.#deps.sampler) {
      const readings = await this.#deps.sampler.sample(fins).catch(() => undefined)
      for (const reading of readings ?? []) this.#deps.costs.add(reading)
      if (readings) this.#finCores = { cores: readings.reduce((sum, reading) => sum + reading.cores, 0), at: this.#now() }
    }
    const reading = await this.#deps.read().catch(() => undefined)
    const finCores = working && this.#now() - this.#finCores.at < FIN_CORES_FRESH_MS ? this.#finCores.cores : 0
    if (reading) {
      const pressure = pressureOf(reading, finCores, this.#hardware())
      this.#governor.read(this.#now(), pressure)
      this.#busyCores = reading.busyCores
      this.#pressedNow = Object.values(pressure).some(Boolean)
    }
    this.#deps.costs.save()
    this.#allow()
    if (this.atOnce() > before.fins || this.builds() > before.builds) this.changed()
  }

  /**
   * Builds that run at once (`BuildSlots`): the room capacity keeps for them, and one more while nothing presses on the
   * machine and its idle cores leave a build's room, so an idle machine isn't held to one.
   */
  builds(): number {
    const base = this.#base()
    const hardware = this.#hardware()
    const idle = !this.#pressedNow && this.#busyCores !== undefined && this.#busyCores + base.cost.buildCores <= hardware.cores - reserveOf(hardware).cores
    return base.builds + (idle ? 1 : 0)
  }

  /** Hears each time this device may take more than before: what waits for it goes then, not at the next look. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /** The number may be higher: it rose here, or the person changed theirs. */
  changed(): void {
    for (const listener of this.#listeners) listener()
  }

  /** The number in force now. */
  atOnce(): number {
    if (this.#deps.fixed !== undefined) return this.#deps.fixed
    return this.#deps.own() ?? this.#allowed ?? this.#allow()
  }

  reading(): FinCapacityReading {
    const base = this.#base()
    const allowed = this.#allowed ?? this.#allow()
    return {
      atOnce: this.atOnce(),
      auto: allowed,
      why: base.why,
      ...(this.#pressure && allowed < base.atOnce && { pressure: this.#pressure }),
      measured: this.#deps.costs.measured(),
    }
  }

  #allow(): number {
    const base = this.#base()
    const allowed = this.#governor.allow(this.#now(), base.atOnce)
    this.#allowed = allowed.atOnce
    this.#pressure = allowed.why
    return allowed.atOnce
  }

  #base() {
    return deviceCapacity(this.#hardware(), this.#deps.costs.cost(Object.keys(this.#mix).length ? this.#mix : undefined))
  }

  #hardware(): FinHardware {
    return this.#deps.hardware?.() ?? { cores: availableParallelism(), memoryBytes: totalmem(), ...(headless() && { headless: true }) }
  }

  #now(): number {
    return this.#deps.now?.() ?? Date.now()
  }
}

/**
 * What presses on the machine now, from one reading and the cores `finCores` its Fins' own processes were measured to
 * take. The person's own work is the busy cores those don't account for, and it presses only while it leaves fewer idle
 * cores than their reserve: idle cores are room, whoever keeps the rest busy, and a count of Fins says nothing of what
 * they take, since most of them wait on their models.
 */
export function pressureOf(reading: MacReading, finCores: number, hardware: FinHardware): PressureReading {
  const busy = reading.busyCores
  const reserve = reserveOf(hardware).cores
  return {
    memory: reading.memoryPressure === true || (reading.swapFreeBytes !== undefined && reading.swapFreeBytes < SWAP_FREE_LEAST),
    thermal: reading.hot === true,
    person: busy !== undefined && busy - finCores > reserve && hardware.cores - busy < reserve,
    disk: reading.diskFreeBytes !== undefined && reading.diskFreeBytes < DISK_FREE_LEAST,
  }
}

/** A machine nobody sits at: Linux without a display. A Mac always has its person. */
function headless(): boolean {
  return onLinux() && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY
}
