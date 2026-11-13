import { hostProbe } from "./host-command.js"
import { readFile } from "node:fs/promises"
import { availableParallelism, cpus, loadavg } from "node:os"
import { onMac } from "./platform.js"

/**
 * How busy this machine is with work other than the caller's: what a
 * measurement of speed needs to know before it trusts itself. Under load,
 * macOS moves whole processes onto the efficiency cores and memory-heavy
 * work slows more than the rest, so a timing taken then says more about the
 * machine than about the code (`scripts/perf-reference.ts`, the local
 * updater's performance check).
 */


export type MemoryPressure = "normal" | "warning" | "critical"
/** macOS's thermal pressure: above nominal, the system slows the cores to cool down. */
export type ThermalPressure = "nominal" | "moderate" | "heavy" | "critical"

/**
 * How short of memory this machine is: macOS's own pressure level, or
 * Linux's pressure stall figures. Anything unreadable counts as normal.
 */
export async function memoryPressure(): Promise<MemoryPressure> {
  if (onMac()) {
    const level = await hostProbe("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]).then(({ stdout }) => Number(stdout.trim()), () => 1)
    return level >= 4 ? "critical" : level >= 2 ? "warning" : "normal"
  }
  const text = await readFile("/proc/pressure/memory", "utf8").catch(() => "")
  const average = (kind: string) => Number(new RegExp(`^${kind} avg10=([\\d.]+)`, "m").exec(text)?.[1] ?? 0)
  return average("full") > 10 ? "critical" : average("some") > 20 ? "warning" : "normal"
}

/** macOS's thermal pressure, as `OSThermalNotification` levels it; undefined where it can't be read. */
export async function thermalPressure(): Promise<ThermalPressure | undefined> {
  if (!onMac()) return undefined
  const level = await hostProbe("notifyutil", ["-g", "com.apple.system.thermalpressurelevel"])
    .then(({ stdout }) => Number(stdout.trim().split(/\s+/).at(-1)), () => Number.NaN)
  if (!Number.isInteger(level) || level < 0) return undefined
  return level === 0 ? "nominal" : level === 1 ? "moderate" : level === 2 ? "heavy" : "critical"
}

/** Every core's busy and total time so far, in milliseconds. */
export interface CpuTicks {
  busy: number
  total: number
}

export function cpuTicks(): CpuTicks {
  let busy = 0
  let total = 0
  for (const { times } of cpus()) {
    const working = times.user + times.nice + times.sys + times.irq
    busy += working
    total += working + times.idle
  }
  return { busy, total }
}

/**
 * The cores kept busy between two readings of `cpuTicks`, on average: time the CPU really spent, so what's left of
 * `cores` is idle. Not the load average, which counts every thread that wanted a core at the kernel's sample, however
 * briefly: on 2026-11-05 this 14-core Mac's stood at 18 while 5 cores sat idle, with six short `git status` at a time.
 */
export function coresBusy(from: CpuTicks, to: CpuTicks, cores = availableParallelism()): number {
  const elapsed = to.total - from.total
  return elapsed > 0 ? ((to.busy - from.busy) / elapsed) * cores : 0
}

export interface MachineReading {
  cores: number
  /** Cores kept busy, on average over the reading, by work other than the caller's. */
  othersBusy: number
  /** The one-minute load average: reported, not judged, since it trails by a minute and counts the caller's threads too. */
  loadAverage: number
  memory: MemoryPressure
  thermal: ThermalPressure | undefined
}

/** The machine over the next `windowMs`, the caller running nothing meanwhile: whatever is busy is other work. */
export async function readMachine(windowMs = 2_000): Promise<MachineReading> {
  const from = cpuTicks()
  await new Promise((resolve) => setTimeout(resolve, windowMs))
  const to = cpuTicks()
  const cores = availableParallelism()
  const othersBusy = coresBusy(from, to, cores)
  const [memory, thermal] = await Promise.all([memoryPressure(), thermalPressure()])
  return { cores, othersBusy, loadAverage: loadavg()[0] ?? 0, memory, thermal }
}

/** More than this share of the cores kept busy by other work leaves a measured process no fast core to count on. */
export const BUSY_SHARE = 0.5

/** Why a reading can't be trusted to time code by, in words; empty when the machine is quiet. */
export function busyReasons(reading: MachineReading): string[] {
  const reasons: string[] = []
  if (reading.othersBusy > reading.cores * BUSY_SHARE) reasons.push(`other work kept ${reading.othersBusy.toFixed(1)} of ${reading.cores} cores busy`)
  if (reading.thermal && reading.thermal !== "nominal") reasons.push(`thermal pressure was ${reading.thermal}`)
  if (reading.memory !== "normal") reasons.push(`memory pressure was ${reading.memory}`)
  return reasons
}

/** A reading in one line, as a log or a report says it. */
export function describeMachine(reading: MachineReading): string {
  const thermal = reading.thermal ? `, thermal ${reading.thermal}` : ""
  return `other work ${reading.othersBusy.toFixed(1)} of ${reading.cores} cores, load average ${reading.loadAverage.toFixed(1)}, memory ${reading.memory}${thermal}`
}

/**
 * Whether other work kept this machine busy since the last ask: more than
 * `BUSY_SHARE` of the cores, or the cores slowed for heat. Memory pressure
 * doesn't count, since a degraded fseventsd is itself one cause of it. The
 * first ask counts from when this was made.
 */
export function busySinceLastAsk(): () => Promise<boolean> {
  let last = cpuTicks()
  return async () => {
    const now = cpuTicks()
    const cores = availableParallelism()
    const othersBusy = coresBusy(last, now, cores)
    last = now
    const thermal = await thermalPressure()
    return othersBusy > cores * BUSY_SHARE || (thermal !== undefined && thermal !== "nominal")
  }
}
