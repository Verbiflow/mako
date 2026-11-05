import { availableParallelism, totalmem } from "node:os"
import { onLinux } from "../base/platform.js"
import type { FinCapacityReading } from "../contracts/fin-tuning.js"
import { CapacityGovernor, deviceCapacity, reserveOf, type FinHardware, type PressureReading } from "./fin-capacity.js"
import type { FinCostModel } from "./fin-cost.js"
import type { FinAtWork, FinCostReading } from "./fin-cost-sampler.js"
import { DISK_FREE_LEAST, FIN_LOAD, SWAP_FREE_LEAST, type MacReading } from "./mac-capacity.js"

export interface FinCapacityDeps {
  /** This machine's load and pressure (`MacCapacity`). */
  read(): Promise<MacReading>
  costs: FinCostModel
  /** The person's own number for this device (Settings › Fins); undefined: its capacity. */
  own(): number | undefined
  /** `MAKO_FIN_SLOTS`: a test's host sets the number whatever the machine. */
  fixed?: number
  /** What each Fin at work here costs, read from its processes (`FinCostSampler`); the cost model learns from it. */
  sampler?: { sample(fins: readonly FinAtWork[]): Promise<FinCostReading[]> }
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
  #pressure: string | undefined
  #allowed: number | undefined
  #load: number | undefined
  #pressedNow = false
  readonly #listeners = new Set<() => void>()

  constructor(deps: FinCapacityDeps) {
    this.#deps = deps
  }

  /** `fins`, the Fins at work here by conversation, when this look should also read what they cost. */
  async observe(working: number, mix: Readonly<Record<string, number>>, fins?: readonly FinAtWork[]): Promise<void> {
    const before = { fins: this.atOnce(), builds: this.builds() }
    this.#mix = { ...mix }
    if (fins && this.#deps.sampler) for (const reading of await this.#deps.sampler.sample(fins).catch(() => [])) this.#deps.costs.add(reading)
    const reading = await this.#deps.read().catch(() => undefined)
    if (reading) {
      const pressure = pressureOf(reading, working, this.#hardware())
      this.#governor.read(this.#now(), pressure)
      this.#load = reading.load
      this.#pressedNow = Object.values(pressure).some(Boolean)
    }
    this.#deps.costs.save()
    this.#allow()
    if (this.atOnce() > before.fins || this.builds() > before.builds) this.changed()
  }

  /**
   * Builds that run at once (`BuildSlots`): the room capacity keeps for them, and one more while nothing presses on the
   * machine and its load leaves a build's cores free, so an idle machine isn't held to one.
   */
  builds(): number {
    const base = this.#base()
    const hardware = this.#hardware()
    const idle = !this.#pressedNow && this.#load !== undefined && this.#load + base.cost.buildCores <= hardware.cores - reserveOf(hardware).cores
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

/** What presses on the machine now, from one reading: the person's own work is the load working Fins don't account for. */
export function pressureOf(reading: MacReading, working: number, hardware: FinHardware): PressureReading {
  const others = Math.max(0, reading.load - working * FIN_LOAD)
  return {
    memory: reading.memoryPressure === true || (reading.swapFreeBytes !== undefined && reading.swapFreeBytes < SWAP_FREE_LEAST),
    thermal: reading.hot === true,
    person: others > reserveOf(hardware).cores,
    disk: reading.diskFreeBytes !== undefined && reading.diskFreeBytes < DISK_FREE_LEAST,
  }
}

/** A machine nobody sits at: Linux without a display. A Mac always has its person. */
function headless(): boolean {
  return onLinux() && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY
}
