import { execFile } from "node:child_process"
import { onWindows } from "./platform.js"

/**
 * A process and everything it started, as one thing to signal or ask after. On macOS and Linux that is the process
 * group the process leads (the host's runners and provider launches give each child a group of its own), signalled as
 * `kill(-pid)`. Windows has no process groups and `kill(-pid)` names nothing there: a stop ends the tree under the
 * process at once with `taskkill /T /F`, which finds its children by their parent while the process is still there to
 * find them by, and a console program hears no SIGTERM anyway.
 */
export interface TreeSignalOptions {
  /**
   * When `pid` leads no group (it shares its parent's), signal it alone. Off for a caller that knows the pid led its
   * own group, where a group gone means the process is too and the pid may be another's by now.
   */
  orProcess?: boolean
}

/** Signals `pid`'s tree; on Windows any signal ends it. */
export function signalProcessTree(pid: number, signal: NodeJS.Signals, { orProcess = true }: TreeSignalOptions = {}): void {
  if (onWindows()) {
    taskkillTree(pid)
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

/**
 * `taskkill /T /F` of `pid`'s tree, in the background. It runs outside the host's stop scope, since a stop is when it is
 * needed; it answers 128 for a process already gone, which is the outcome asked for. Where it can't run, the process
 * alone is ended, as Node's own `kill` does.
 */
function taskkillTree(pid: number): void {
  execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { timeout: 5_000, windowsHide: true }, (error) => {
    if (!error || !processTreeAlive(pid)) return
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      // Gone between the two.
    }
  })
}
