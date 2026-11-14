/**
 * How many Fins a machine runs at once, from what a Fin costs there. A thinking Fin waits on its model and costs
 * little; what costs is the builds and test suites it runs. So each Fin is charged its light cost (cores and memory
 * outside builds) and room is kept for a few builds at a time, after a reserve for the person's own work:
 *
 *   capacity = floor(min((cores − reserve − builds·buildCores) / finCores, (memory − reserve − builds·buildMemory) / finMemory))
 *
 * The hardware and a cost learned over days set the number (`FinCostModel`); pressure only lowers it, slowly and
 * within a floor (`CapacityGovernor`). Everything here is pure: the host feeds it readings and a clock.
 */

const GB = 1024 ** 3

/** A machine as capacity reads it. `headless`: nobody works at it, so the reserve for the person is small. */
export interface FinHardware {
  cores: number
  memoryBytes: number
  headless?: boolean
}

/** What one Fin costs on a machine: its light cost outside builds, and what one build or test run takes at its peak. */
export interface FinCost {
  cores: number
  memoryBytes: number
  buildCores: number
  buildMemoryBytes: number
}

/**
 * Before a machine has measured its own Fins: measured 2026-11-03 on a 14-core Mac, where the average Fin's processes
 * held 0.35 GB (the largest 1.8 GB) and one building Fin took 6 cores at its peak while idle ones took none.
 */
export const PRIOR_COST: FinCost = { cores: 0.35, memoryBytes: 0.8 * GB, buildCores: 6, buildMemoryBytes: 3 * GB }

/** The most Fins one machine is given, however large: past it the person sets a number of their own. */
export const DEVICE_CEILING = 64
/** The most builds capacity keeps room for at once. */
const BUILDS_MOST = 4

/** A machine's capacity, with what it's based on. */
export interface DeviceCapacity {
  atOnce: number
  /** The bound each resource sets, before the ceiling. */
  cpu: number
  memory: number
  /** Builds it keeps room for at once. */
  builds: number
  reserve: { cores: number; memoryBytes: number }
  cost: FinCost
  /** In the person's words: "14 cores, 36 GB · a Fin ≈ 0.35 core, 0.8 GB · room for 1 build". */
  why: string
}

/** What's kept for the person's own work: a seventh of the cores (at least two) and a fifth of memory (at least 4 GB); a sixteenth and a tenth on a headless machine. */
export function reserveOf(hardware: FinHardware): DeviceCapacity["reserve"] {
  return hardware.headless
    ? { cores: Math.max(0.5, hardware.cores / 16), memoryBytes: Math.max(GB, hardware.memoryBytes / 10) }
    : { cores: Math.max(2, hardware.cores / 7), memoryBytes: Math.max(4 * GB, hardware.memoryBytes / 5) }
}

export function deviceCapacity(hardware: FinHardware, cost: FinCost = PRIOR_COST, ceiling = DEVICE_CEILING): DeviceCapacity {
  const reserve = reserveOf(hardware)
  const cores = Math.max(0, hardware.cores - reserve.cores)
  const memory = Math.max(0, hardware.memoryBytes - reserve.memoryBytes)
  // A build takes at most half of what's left, so a small machine keeps room for its Fins too.
  const buildCores = Math.min(cost.buildCores, cores / 2)
  const buildMemory = Math.min(cost.buildMemoryBytes, memory / 2)
  const builds = Math.max(1, Math.min(BUILDS_MOST, Math.floor(cores / (2 * Math.max(buildCores, 0.01)))))
  const cpu = (cores - builds * buildCores) / Math.max(cost.cores, 0.01)
  const mem = (memory - builds * buildMemory) / Math.max(cost.memoryBytes, 1)
  const atOnce = Math.max(1, Math.min(ceiling, Math.floor(Math.min(cpu, mem))))
  const shown = { ...cost, buildCores, buildMemoryBytes: buildMemory }
  return { atOnce, cpu, memory: mem, builds, reserve, cost: shown, why: capacityWhy(hardware, shown, builds) }
}

function capacityWhy(hardware: FinHardware, cost: FinCost, builds: number): string {
  return `${trim(hardware.cores)} cores, ${Math.round(hardware.memoryBytes / GB)} GB · a Fin ≈ ${trim(cost.cores)} core, ${trim(cost.memoryBytes / GB)} GB · room for ${builds} ${builds === 1 ? "build" : "builds"}`
}

const trim = (value: number) => String(Math.round(value * 100) / 100)

/** A machine's state now, as pressure reads it: each true while it holds. */
export interface PressureReading {
  /** The machine is short of memory: swap is nearly gone, or the system says memory is under pressure. */
  memory?: boolean
  /** The machine is hot enough to slow its CPU. */
  thermal?: boolean
  /** The person's own work, the load Fins don't account for, takes more than their reserve. */
  person?: boolean
  /** Less disk is free than worktrees need. */
  disk?: boolean
}

const MINUTE = 60_000
/** A reading's weight halves over this: one busy minute moves the average a little. */
const AVERAGE_MS = 5 * MINUTE
/** Pressure must hold this long, as the average, before capacity goes down; relief this long before it comes back up. */
const PRESSED_HOLD_MS = 3 * MINUTE
const RELIEF_HOLD_MS = 5 * MINUTE
/** How fast it moves once it does: one Fin a minute. */
const STEP_MS = MINUTE

/**
 * Lowers a machine's capacity under sustained pressure and brings it back, never by one busy minute: each signal is
 * a moving average that must hold before anything moves, then the number moves one a minute, down to a floor of half
 * (at least four where the machine takes eight or more) and back up after relief holds. It only bounds new starts.
 */
export class CapacityGovernor {
  #average = 0
  #lastAt: number | undefined
  #pressedSince: number | undefined
  #relievedSince: number | undefined
  #steppedAt: number | undefined
  #cut = 0
  #why: (keyof PressureReading)[] = []

  /** One reading at `now`: the share of signals that hold feeds the average. */
  read(now: number, pressure: PressureReading): void {
    const held = (["memory", "thermal", "person", "disk"] as const).filter((signal) => pressure[signal])
    const sample = held.length ? 1 : 0
    const elapsed = this.#lastAt === undefined ? AVERAGE_MS : Math.max(0, now - this.#lastAt)
    const keep = Math.pow(0.5, elapsed / AVERAGE_MS)
    this.#average = this.#average * keep + sample * (1 - keep)
    this.#lastAt = now
    if (held.length) this.#why = held
    const pressed = this.#average >= 0.5
    if (pressed) {
      this.#relievedSince = undefined
      this.#pressedSince ??= now
    } else {
      this.#pressedSince = undefined
      this.#relievedSince ??= now
    }
  }

  /** The capacity it allows now of `base`, the machine's own. */
  allow(now: number, base: number): Allowed {
    const floor = base >= 8 ? Math.max(4, Math.ceil(base / 2)) : Math.max(1, Math.ceil(base / 2))
    const most = base - floor
    const due = this.#steppedAt === undefined || now - this.#steppedAt >= STEP_MS
    if (this.#pressedSince !== undefined && now - this.#pressedSince >= PRESSED_HOLD_MS && due && this.#cut < most) {
      this.#cut += 1
      this.#steppedAt = now
    } else if (this.#relievedSince !== undefined && now - this.#relievedSince >= RELIEF_HOLD_MS && due && this.#cut > 0) {
      this.#cut -= 1
      this.#steppedAt = now
    }
    this.#cut = Math.min(this.#cut, most)
    const atOnce = base - this.#cut
    if (!this.#cut) return { atOnce }
    const minutes = Math.round((now - (this.#pressedSince ?? this.#steppedAt ?? now)) / MINUTE)
    return { atOnce, why: `${atOnce} now, not ${base}: ${this.#why.map((signal) => PRESSURE_WORDS[signal]).join(" and ")}${this.#pressedSince !== undefined ? ` for ${minutes} min` : ", easing"}` }
  }
}

/** What the governor allows: the number, and while it's lower than the machine's own, why. */
export interface Allowed {
  atOnce: number
  why?: string
}

const PRESSURE_WORDS = { memory: "memory pressure", thermal: "it's running hot", person: "your own work is busy", disk: "disk is nearly full" } as const

/**
 * The cloud's Fins at once: each runs in a sandbox of its own (or `finsPerSandbox` in a bigger one), so the bound is
 * the sandboxes the person's plan runs at once and those their daily spend ceiling still pays for an hour of.
 */
export interface CloudCapacityInput {
  planSandboxes?: number
  finsPerSandbox?: number
  sandboxCentsPerHour?: number
  runningSandboxes?: number
  dailySpendCents?: number
  spentTodayCents?: number
}

export function cloudCapacity(input: CloudCapacityInput): number | undefined {
  const per = Math.max(1, input.finsPerSandbox ?? 1)
  const running = input.runningSandboxes ?? 0
  let sandboxes = input.planSandboxes
  if (input.dailySpendCents !== undefined && input.sandboxCentsPerHour) {
    const left = input.dailySpendCents - (input.spentTodayCents ?? 0)
    const paid = Math.max(0, Math.floor(left / input.sandboxCentsPerHour))
    sandboxes = Math.min(sandboxes ?? Number.POSITIVE_INFINITY, paid)
    if (sandboxes < running) sandboxes = running
  }
  return sandboxes === undefined || !Number.isFinite(sandboxes) ? undefined : sandboxes * per
}
