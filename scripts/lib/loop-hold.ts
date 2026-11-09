/** A timer gap inside the work window; CPU is diagnostic only, never a discount from its wall-time bound. */
export interface LoopHold {
  ms: number
  fromMs: number
  toMs: number
  cpuMs: number
}

/** The longest timer gap during work, including its final synchronous stretch, with no later work charged to it. */
export async function longestHold(work: () => Promise<void>): Promise<LoopHold> {
  const started = performance.now()
  let last = started
  let cpu = process.threadCpuUsage()
  let longest: LoopHold = { ms: 0, fromMs: 0, toMs: 0, cpuMs: 0 }
  let timer: ReturnType<typeof setTimeout>
  const sample = () => {
    const now = performance.now()
    const used = process.threadCpuUsage(cpu)
    const ms = now - last
    if (ms > longest.ms) longest = { ms, fromMs: last - started, toMs: now - started, cpuMs: (used.user + used.system) / 1_000 }
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
    return longest
  } finally {
    clearTimeout(timer)
  }
}
