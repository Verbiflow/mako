import { readFile, readdir } from "node:fs/promises"
import { basename } from "node:path"

/** Clock ticks per second in `/proc`, which Linux fixes at 100 for user space. */
const TICKS = 100

/** Every process's CPU time so far by name, and the machine's, read from `/proc`. */
export interface CpuSample {
  at: number
  /** The machine's busy ticks, every CPU's together. */
  busy: number
  byName: Map<string, number>
  /** This process's own threads by name: its JavaScript, V8's helpers (`V8Worker`), libuv's pool, its workers. */
  threads: Map<string, number>
}

/** What used the CPU between two samples: the busiest names first, and what no listed process accounts for. */
export interface CpuUse {
  ms: number
  /** CPU seconds spent, every CPU's together. */
  busy: number
  top: Array<{ name: string; seconds: number }>
  /** This process's threads that spent any, by name. */
  threads: Array<{ name: string; seconds: number }>
}

/** A sample of every process's CPU time, or undefined where there's no `/proc` (any machine but Linux). */
export async function sampleCpu(): Promise<CpuSample | undefined> {
  const stat = await readFile("/proc/stat", "utf8").catch(() => undefined)
  if (stat === undefined) return undefined
  // cpu user nice system idle iowait irq softirq steal: busy is all but idle and iowait.
  const fields = stat.slice(0, stat.indexOf("\n")).trim().split(/\s+/).slice(1).map(Number)
  const busy = fields.reduce((sum, value, index) => (index === 3 || index === 4 ? sum : sum + value), 0)
  const byName = new Map<string, number>()
  const pids = (await readdir("/proc").catch(() => [])).filter((name) => /^\d+$/.test(name))
  await Promise.all(pids.map(async (pid) => {
    const line = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => undefined)
    if (!line) return
    const close = line.lastIndexOf(")")
    const rest = line.slice(close + 2).split(" ")
    // After the name: state is field 3, utime field 14 and stime field 15.
    const ticks = Number(rest[11]) + Number(rest[12])
    if (!ticks) return
    const name = await processName(pid, line.slice(line.indexOf("(") + 1, close))
    byName.set(name, (byName.get(name) ?? 0) + ticks)
  }))
  const threads = new Map<string, number>()
  const tids = await readdir("/proc/self/task").catch(() => [])
  await Promise.all(tids.map(async (tid) => {
    const line = await readFile(`/proc/self/task/${tid}/stat`, "utf8").catch(() => undefined)
    if (!line) return
    const close = line.lastIndexOf(")")
    const rest = line.slice(close + 2).split(" ")
    const ticks = Number(rest[11]) + Number(rest[12])
    const name = line.slice(line.indexOf("(") + 1, close)
    if (ticks) threads.set(name, (threads.get(name) ?? 0) + ticks)
  }))
  return { at: performance.now(), busy, byName, threads }
}

/** A process's name as a person would know it: its command, or for a script runtime, the script it runs. */
async function processName(pid: string, command: string): Promise<string> {
  // The kernel's numbered workers are one cost.
  if (command.startsWith("kworker/")) return "kworker"
  if (!/^(node|bun|python3?|MainThread)$/.test(command)) return command
  // Node names its main thread `MainThread`.
  const runtime = command === "MainThread" ? "node" : command
  const argv = (await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "")).split("\0").filter(Boolean)
  const script = argv.slice(1).find((arg) => !arg.startsWith("-"))
  return script ? `${runtime}:${basename(script)}` : runtime
}

/** The CPU used between `before` and `after`, its `limit` busiest names. */
export function cpuBetween(before: CpuSample, after: CpuSample, limit = 5): CpuUse {
  const spent: Array<{ name: string; seconds: number }> = []
  let listed = 0
  for (const [name, ticks] of after.byName) {
    const delta = ticks - (before.byName.get(name) ?? 0)
    if (delta <= 0) continue
    listed += delta
    spent.push({ name, seconds: delta / TICKS })
  }
  spent.sort((a, b) => b.seconds - a.seconds)
  const busy = Math.max(0, after.busy - before.busy) / TICKS
  const top = spent.slice(0, limit)
  // Processes that ended between the samples, and the kernel's own work, are counted only in the machine's total.
  const unlisted = busy - listed / TICKS
  if (unlisted >= 0.05) top.push({ name: "ended or kernel", seconds: unlisted })
  const threads: Array<{ name: string; seconds: number }> = []
  for (const [name, ticks] of after.threads) {
    const delta = ticks - (before.threads.get(name) ?? 0)
    if (delta > 0) threads.push({ name, seconds: delta / TICKS })
  }
  threads.sort((a, b) => b.seconds - a.seconds)
  return { ms: Math.round(after.at - before.at), busy, top, threads }
}

/** This process's threads: "MainThread 0.31 s, V8Worker 0.20 s". */
export function describeThreads(use: CpuUse): string {
  return use.threads.map((entry) => `${entry.name} ${entry.seconds.toFixed(2)} s`).join(", ")
}

/** One line's worth: "1.62 s busy in 1.20 s: devin 0.61 s, node:host-main.js 0.40 s". */
export function describeCpu(use: CpuUse): string {
  const round = (seconds: number) => `${seconds.toFixed(2)} s`
  return `${round(use.busy)} busy in ${round(use.ms / 1000)}: ${use.top.map((entry) => `${entry.name} ${round(entry.seconds)}`).join(", ")}`
}
