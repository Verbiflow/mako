import { spawn } from "node:child_process"

/**
 * How the host stops: one path for every reason.
 *
 * The first stop runs cleanup once; a later one, for any reason, joins it and
 * changes nothing. Cleanup that fails still ends the process, with code 1.
 */
export type HostStopReason =
  | { kind: "signal"; signal: StopSignal }
  | { kind: "idle" }
  /** A client asked: quit, install an update and quit, or restart on the current build. */
  | { kind: "request"; action: "quit" | "install" | "restart" }

export type StopSignal = "SIGTERM" | "SIGINT" | "SIGHUP"

export type HostLifecycleState =
  | { kind: "running" }
  | { kind: "stopping"; reason: HostStopReason }
  | { kind: "stopped"; reason: HostStopReason; code: number }

export interface HostLifecycleOptions {
  cleanup(reason: HostStopReason): Promise<void>
  /** Ends the process once cleanup is done; `restart` asks for a successor on the current build. */
  exit(code: number, restart: boolean): void
  log(message: "stopping", fields: StopFields): void
  /** Records a failed cleanup before the process ends; awaited, so the record isn't lost. */
  failed(error: Error): Promise<void>
}

export interface HostLifecycle {
  stop(reason: HostStopReason): Promise<void>
  state(): HostLifecycleState
  running(): boolean
}

export function hostLifecycle(options: HostLifecycleOptions): HostLifecycle {
  let state: HostLifecycleState = { kind: "running" }
  let stopped: Promise<void> | undefined
  return {
    stop(reason) {
      if (stopped) return stopped
      state = { kind: "stopping", reason }
      options.log("stopping", reasonFields(reason))
      stopped = (async () => {
        let code = 0
        // The call that asked for the stop answers before cleanup closes host calls.
        await new Promise((done) => setImmediate(done))
        try {
          await options.cleanup(reason)
        } catch (error) {
          code = 1
          await options.failed(error instanceof Error ? error : new Error(String(error)))
        }
        state = { kind: "stopped", reason, code }
        options.exit(code, code === 0 && reason.kind === "request" && reason.action === "restart")
      })()
      return stopped
    },
    state: () => state,
    running: () => state.kind === "running",
  }
}

/** What the log records of a stop. */
export type StopFields = { signal: StopSignal } | { reason: "idle" | "quit" | "install" | "restart" }

function reasonFields(reason: HostStopReason): StopFields {
  if (reason.kind === "signal") return { signal: reason.signal }
  if (reason.kind === "request") return { reason: reason.action }
  return { reason: reason.kind }
}

/**
 * A termination signal stops the host through its lifecycle; a second one ends
 * the process at once. The host's listener stays attached through the first
 * signal: signal-exit (through proper-lockfile) re-raises a signal it finds
 * itself alone with, which would skip the cleanup.
 */
export function stopOnSignals(lifecycle: HostLifecycle): void {
  let signalled = false
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    const stop = () => {
      if (signalled) {
        process.removeListener(signal, stop)
        process.kill(process.pid, signal)
        return
      }
      signalled = true
      void lifecycle.stop({ kind: "signal", signal })
    }
    process.on(signal, stop)
  }
}

/** The environment variable a successor finds its predecessor's pid in. */
export const SUCCEEDS_ENV = "MAKO_HOST_SUCCEEDS"

/**
 * How the host ends. A restart starts the same program again, detached,
 * before this one exits; the successor waits for this process's lock
 * (`acquireHostLock`'s `predecessor`).
 */
export function nodeHostExit(): HostLifecycleOptions["exit"] {
  return (code, restart) => {
    if (restart) {
      const successor = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
        // Electron's Helper runs as Node again; the host took the flag out of its own environment.
        env: { ...process.env, [SUCCEEDS_ENV]: String(process.pid), ...(process.versions.electron && { ELECTRON_RUN_AS_NODE: "1" }) },
        detached: true,
        stdio: "ignore",
      })
      successor.unref()
    }
    process.exit(code)
  }
}

/** The predecessor a restarted host waits for, read once and kept from its own children. */
export function takePredecessor(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const pid = Number(env[SUCCEEDS_ENV])
  delete env[SUCCEEDS_ENV]
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
}
