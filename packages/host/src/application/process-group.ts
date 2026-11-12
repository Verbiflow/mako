import { stoppingSignal } from "../base/host-stopping.js"
import { execFile, spawn } from "node:child_process"
import { promisify } from "node:util"
import { z } from "zod"

/** How long a stopped step's process group has between SIGTERM and SIGKILL. */
export const GROUP_STOP_GRACE_MS = 5000

/** After SIGKILL, how long to wait for the group to be reaped before giving up on it. */
const GROUP_REAP_MS = 5000

export interface GroupRunOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  /** `inherit` shows the step in the terminal; `pipe` hands its output to `output`. */
  stdio: "inherit" | "pipe"
  output?: (stream: "stdout" | "stderr", text: string) => void
  /** Stops the step's whole process group when it aborts. */
  signal?: AbortSignal
  /** Stops it the same way once this long has passed. */
  timeoutMs?: number
  /** `GROUP_STOP_GRACE_MS` unless a test shortens it. */
  graceMs?: number
}

export interface GroupRunResult {
  /** The step's exit code; null when a signal ended it. */
  code: number | null
  /** Why it was stopped, or null when it ended by itself. */
  stopped: "aborted" | "timeout" | null
}

const errnoSchema = z.object({ code: z.string() })
const run = promisify(execFile)

/**
 * Whether the process table shows nothing alive in group `group`. macOS answers EPERM for a group of only zombies, the
 * last member gone and not yet reaped, as it does for a live member Mako may not signal, so EPERM alone says neither. A
 * table that can't be read shows nothing, and the group counts as alive.
 */
export async function groupHoldsNothingAlive(group: number): Promise<boolean> {
  const table = await run("ps", ["-A", "-o", "pgid=,stat="], { maxBuffer: 16 * 1024 * 1024, timeout: 5_000 }).catch(() => undefined)
  if (!table) return false
  return table.stdout.split("\n").every((row) => {
    const [pgid, stat] = row.trim().split(/\s+/)
    return Number(pgid) !== group || stat?.startsWith("Z") === true
  })
}

/**
 * Runs a build step (npm install, npm run build, packaging) in a process
 * group of its own, and stops the whole group when `signal` aborts or
 * `timeoutMs` passes: SIGTERM, then SIGKILL after `graceMs`.
 *
 * Signalling only the step's own pid stopped npm and left what it had
 * started (install scripts, the compile) writing node_modules and dist; a
 * second run then installed over the first. A stopped step therefore
 * settles only once nothing in its group is left, so whatever runs next
 * never overlaps it. Settings › Updates and `npm run update:local` both run
 * their steps through this.
 */
export async function runProcessGroup(command: string, args: string[], options: GroupRunOptions): Promise<GroupRunResult> {
  options = { ...options, signal: stoppingSignal(options.signal) }
  options.signal?.throwIfAborted()
  const grace = options.graceMs ?? GROUP_STOP_GRACE_MS
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: options.stdio === "inherit" ? "inherit" : ["ignore", "pipe", "pipe"],
    detached: true,
  })
  const output = options.output
  if (output) {
    child.stdout?.setEncoding("utf8").on("data", (text: string) => output("stdout", text))
    child.stderr?.setEncoding("utf8").on("data", (text: string) => output("stderr", text))
  }
  let failure: Error | null = null
  /** A stop this group refused: nothing but its being gone settles that, a look at it being allowed included. */
  let denied: Error | null = null
  /** Whether the last look at the group was answered EPERM: of a live member, or of only zombies (`groupHoldsNothingAlive`). */
  let unclear = false
  /** Signals the group; false once nothing in it is left. */
  const signalGroup = (name: NodeJS.Signals | 0): boolean => {
    if (!child.pid) return false
    try {
      process.kill(-child.pid, name)
      return true
    } catch (error) {
      const code = errnoSchema.safeParse(error).data?.code
      const raised = error instanceof Error ? error : new Error(String(error))
      if (code === "EPERM") {
        if (name === 0) unclear = true
        else denied ??= raised
        return true
      }
      if (code !== "ESRCH") failure ??= raised
      return false
    }
  }
  /** Whether the group has anything left, an unclear answer settled by the process table. */
  const present = async (): Promise<boolean> => {
    unclear = false
    if (!signalGroup(0)) return false
    return !unclear || !(await groupHoldsNothingAlive(child.pid!))
  }
  let stopped: GroupRunResult["stopped"] = null
  let killAt = 0
  // A step that ignores SIGTERM never exits by itself, so the SIGKILL is due whether or not it has.
  let force: ReturnType<typeof setTimeout> | undefined
  const stop = (reason: "aborted" | "timeout") => {
    if (stopped) return
    stopped = reason
    killAt = Date.now() + grace
    signalGroup("SIGTERM")
    force = setTimeout(() => signalGroup("SIGKILL"), grace)
  }
  const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => stop("timeout"), options.timeoutMs)
  const abort = () => stop("aborted")
  options.signal?.addEventListener("abort", abort, { once: true })
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject)
      child.once("close", resolve)
    })
    if (stopped) {
      // The step itself is gone; what it started may not be. Wait for its
      // group to empty, with SIGKILL at the grace for whatever is still there.
      const gone = async (until: number) => {
        while ((await present()) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 25))
        return !(await present())
      }
      if (!(await gone(killAt))) {
        signalGroup("SIGKILL")
        await gone(Date.now() + GROUP_REAP_MS)
      }
      // Something outlived the stop, so the step's end is no end of its work.
      if (await present()) failure ??= denied ?? new Error("The step's process group outlived its kill")
    }
    if (failure) throw failure
    return { code, stopped }
  } finally {
    clearTimeout(timer)
    clearTimeout(force)
    options.signal?.removeEventListener("abort", abort)
  }
}
