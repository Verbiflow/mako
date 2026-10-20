import { environmentForExecutable } from "../base/executable.js"
import { spawnProviderProcess } from "./provider-process.js"

/** A harness's own process as its start spawns it, and the line its start writes first, if it writes one. */
export interface PrefetchLaunch {
  command: string
  args: readonly string[]
  env: NodeJS.ProcessEnv
  /** Written once the process exists; its first answer to it, or to nothing, ends the read. */
  first?: string
}

/**
 * What a start runs first, run ahead: the harness's process, spawned as its start spawns it, through its first
 * exchange and then stopped. A cloud machine runs it as it boots, for the harness its Thread was made for, so the
 * start's own process finds what it reads in the page cache instead of on the disk. On fresh copies, each handshake
 * went from 1.1–3.0 s to 0.1–2.1 s (2026-10-20). It runs before any sign-in: only what runs before one.
 */
export type StartPrefetch =
  | { kind: "process"; via: string; launch(env: NodeJS.ProcessEnv, cwd: string): Promise<PrefetchLaunch | undefined> }
  | { kind: "none"; reason: string }

export interface PrefetchOutcome {
  /** The process answered its first exchange, rather than exiting or running out of time first. */
  answered: boolean
  ms: number
}

/** Long enough for a cold harness on a slow copy; a start that comes meanwhile isn't held by it. */
const PREFETCH_MS = 20_000
/** A stopped process that hasn't gone by then is killed. */
const STOP_MS = 2_000

/** Runs `launch` until its first answer, its exit or `timeoutMs`, then stops it and its process group. Never throws. */
export function prefetchStart(launch: PrefetchLaunch, cwd: string, owner: string, timeoutMs = PREFETCH_MS): Promise<PrefetchOutcome> {
  const began = performance.now()
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawnProviderProcess>
    try {
      child = spawnProviderProcess(launch.command, launch.args, { cwd, env: environmentForExecutable(launch.command, launch.env) }, { kind: "prefetch", owner })
    } catch {
      return resolve({ answered: false, ms: Math.round(performance.now() - began) })
    }
    let settled = false
    const settle = (answered: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ answered, ms: Math.round(performance.now() - began) })
      if (child.exitCode !== null || child.signalCode !== null) return
      child.kill("SIGTERM")
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      }, STOP_MS).unref()
    }
    const timer = setTimeout(() => settle(false), timeoutMs)
    timer.unref()
    child.stdout.once("data", () => settle(true))
    child.once("error", () => settle(false))
    child.once("exit", () => settle(false))
    // Read and dropped: a pipe left full would hold the process up.
    child.stdout.resume()
    child.stderr.resume()
    child.stdin.on("error", () => undefined)
    if (launch.first !== undefined) child.stdin.write(`${launch.first}\n`)
  })
}
