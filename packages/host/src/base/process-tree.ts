import { execFile } from "node:child_process"
import { onWindows } from "./platform.js"
import { processStartedAt, processStartMatches } from "./process-liveness.js"
import { windowsTaskkill } from "./system-tools.js"

/**
 * A process and everything it started, as one thing to signal or ask after. On macOS and Linux that is the process
 * group the process leads (the host's runners and provider launches give each child a group of its own), signalled as
 * `kill(-pid)`. Windows has no process groups and `kill(-pid)` names nothing there: a stop ends the tree under the
 * process at once with `taskkill /T /F`, which finds its children by their parent while the process is still there to
 * find them by, and a console program hears no SIGTERM anyway.
 */
export interface TreeSignalOptions {
  /**
   * Whether `pid` is surely the process meant: true where its caller holds it (its child, unreaped, so Node holds its
   * handle and the pid can be no other's). On macOS and Linux, a pid that leads no group (it shares its parent's) is
   * then signalled alone. False where the pid was only heard of, and may be another's by now: there only its group is
   * signalled, and on Windows nothing unless `startedAt` proves it the same process.
   */
  orProcess?: boolean
  /**
   * The caller holds the process as its own unreaped child, so its pid is no other's: on Windows its tree is ended
   * even where `orProcess` is false. Defaults to `orProcess`.
   */
  held?: boolean
  /** When the process started (ms), as `processStartedAt` read it: on Windows, read again just before taskkill. */
  startedAt?: number
}

/** Signals `pid`'s tree; on Windows any signal ends it. */
export function signalProcessTree(pid: number, signal: NodeJS.Signals, { orProcess = true, held = orProcess, startedAt }: TreeSignalOptions = {}): void {
  if (onWindows()) {
    if (held) taskkillTree(pid)
    else if (startedAt !== undefined) void verifiedTaskkill(pid, startedAt)
    return
  }
  try {
    process.kill(-pid, signal)
    return
  } catch {
    // No group led by this pid: it shares another's, or is gone.
  }
  if (!orProcess) return
  try {
    process.kill(pid, signal)
  } catch {
    // Gone already.
  }
}

/**
 * Whether anything of `pid`'s tree is left: any member of its group (one another user's process refuses still counts);
 * on Windows, where a tree has no name of its own, whether the process itself is.
 */
export function processTreeAlive(pid: number): boolean {
  try {
    process.kill(onWindows() ? pid : -pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM"
  }
}

/** taskkill only once the pid is seen to be the process that started at `startedAt`: one recycled since is left alone. */
async function verifiedTaskkill(pid: number, startedAt: number): Promise<void> {
  const actual = await processStartedAt(pid, AbortSignal.timeout(10_000)).catch(() => undefined)
  if (actual !== undefined && processStartMatches(startedAt, actual, 2_000)) taskkillTree(pid)
}

/**
 * `taskkill /T /F` of `pid`'s tree, by its whole path, in the background. It runs outside the host's stop scope, since
 * a stop is when it is needed; it answers 128 for a process already gone, which is the outcome asked for.
 */
function taskkillTree(pid: number): void {
  execFile(windowsTaskkill(), ["/PID", String(pid), "/T", "/F"], { timeout: 5_000, windowsHide: true }, () => undefined)
}
