/** A timer gap inside the work window: its wall time and the CPU the loop's thread used in it. */
export interface LoopGap {
  ms: number
  fromMs: number
  toMs: number
  cpuMs: number
}

/**
 * The longest timer gap, by wall time, and `busiest`, the gap whose thread used the most CPU. A runner that preempts
 * the process stretches a gap's wall time with no CPU in it; a synchronous stretch of the loop's own work shows as
 * CPU. A check that must not fail on a preempted runner judges `busiest.cpuMs` and keeps a loose bound on `ms`.
 */
export interface LoopHold extends LoopGap {
  busiest: LoopGap
}

/** The longest timer gap during work, including its final synchronous stretch, with no later work charged to it. */
export async function longestHold(work: () => Promise<void>): Promise<LoopHold> {
  const started = performance.now()
  let last = started
  let cpu = process.threadCpuUsage()
  let longest: LoopGap = { ms: 0, fromMs: 0, toMs: 0, cpuMs: 0 }
  let busiest: LoopGap = longest
  let timer: ReturnType<typeof setTimeout>
  const sample = () => {
    const now = performance.now()
    const used = process.threadCpuUsage(cpu)
    const ms = now - last
    const gap = { ms, fromMs: last - started, toMs: now - started, cpuMs: (used.user + used.system) / 1_000 }
    if (ms > longest.ms) longest = gap
    if (gap.cpuMs > busiest.cpuMs) busiest = gap
    last = now
    cpu = process.threadCpuUsage()
  }
  const tick = () => {
    sample()
    timer = setTimeout(tick, 1)
  }
  timer = setTimeout(tick, 1)
  try {
    await work()
    sample()
    return { ...longest, busiest }
  } finally {
    clearTimeout(timer)
  }
}
