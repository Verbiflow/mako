import { spawn } from "node:child_process"

/** Readings of a process's resident memory: only what `ps` said plainly counts, and anything else counts against them. */
export type ResidentMemory = { peakKb: number; readings: number; misses: number }

/** One reading of `pid`'s resident memory into `memory`, never rejecting. */
export function readResident(pid: string, memory: ResidentMemory): Promise<void> {
  return new Promise((done) => {
    const read = spawn("ps", ["-o", "rss=", "-p", pid], { stdio: ["ignore", "pipe", "ignore"] })
    let text = ""
    read.stdout.on("data", (chunk: Buffer) => { text += chunk.toString() })
    const miss = () => { memory.misses += 1; done() }
    read.once("error", miss)
    read.once("close", (code) => {
      const said = text.trim()
      if (code !== 0 || !/^\d+$/.test(said) || Number(said) === 0) return miss()
      memory.readings += 1
      memory.peakKb = Math.max(memory.peakKb, Number(said))
      done()
    })
  })
}

/**
 * Why `memory`, read once a second for `seconds`, can't say a process stayed under a limit: a peak is only as good as
 * what was read, and a process nobody could read isn't one using no memory. Undefined when it can.
 */
export function unmeasured(memory: ResidentMemory, seconds: number): string | undefined {
  const asked = memory.readings + memory.misses
  if (!memory.readings) return `none of ${asked} readings answered`
  if (memory.misses > asked / 10) return `${memory.misses} of ${asked} readings didn't answer`
  if (memory.readings < seconds / 2) return `${memory.readings} readings in ${Math.round(seconds)} s`
  return undefined
}
