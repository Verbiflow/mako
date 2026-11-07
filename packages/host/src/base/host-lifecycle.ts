import { execFileSync, spawn } from "node:child_process"
import { acquireHostLock, type HostLock } from "./host-lock.js"
import type { HostLogFields } from "./host-log.js"

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
  /** The host couldn't start; the process ends with code 1 once cleanup is done. */
  | { kind: "failed"; error: string }

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
        let code = reason.kind === "failed" ? 1 : 0
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
export type StopFields = { signal: StopSignal } | { reason: "idle" | "quit" | "install" | "restart" } | { reason: "failed"; error: string }

function reasonFields(reason: HostStopReason): StopFields {
  if (reason.kind === "signal") return { signal: reason.signal }
  if (reason.kind === "request") return { reason: reason.action }
  if (reason.kind === "failed") return { reason: "failed", error: reason.error }
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

/** The environment variable a successor finds its predecessor in: its pid, and when that process started. */
export const SUCCEEDS_ENV = "MAKO_HOST_SUCCEEDS"

/** The host a restarted one follows; `start` is absent from a host older than this, or where `ps` can't say. */
export interface Predecessor {
  pid: number
  start?: string
}

/** Past the wait for its exit, how long a predecessor gets to answer each signal. */
const TERM_MS = 5_000
const KILL_MS = 5_000

/**
 * When a process started, as the system records it, which a pid given to another process since can't share. Null when
 * nothing runs under the pid, or `ps` can't say, as on Windows.
 */
export function processStart(pid: number): string | null {
  try {
    const start = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    })
    return start.trim() || null
  } catch {
    return null
  }
}

/**
 * How the host ends. A restart starts the same program again, detached,
 * before this one exits; the successor waits for this process's lock
 * (`acquireSuccessorLock`).
 */
export function nodeHostExit(): HostLifecycleOptions["exit"] {
  return (code, restart) => {
    if (restart) {
      const start = processStart(process.pid)
      const successor = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
        // Electron's Helper runs as Node again; the host took the flag out of its own environment.
        env: { ...process.env, [SUCCEEDS_ENV]: `${process.pid}${start ? `:${start}` : ""}`, ...(process.versions.electron && { ELECTRON_RUN_AS_NODE: "1" }) },
        detached: true,
        stdio: "ignore",
      })
      successor.unref()
    }
    process.exit(code)
  }
}

/** The predecessor a restarted host waits for, read once and kept from its own children. */
export function takePredecessor(env: NodeJS.ProcessEnv = process.env): Predecessor | undefined {
  const [, digits, start] = /^(\d+)(?::(.+))?$/.exec(env[SUCCEEDS_ENV] ?? "") ?? []
  delete env[SUCCEEDS_ENV]
  const pid = Number(digits)
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined
  return { pid, ...start && { start } }
}

/** `stuck` says why a predecessor still holding the data root wasn't ended. */
export type SuccessorLock = HostLock | (Extract<HostLock, { kind: "taken" }> & { stuck: string })

export interface SuccessorLockOptions {
  log(message: string, fields: HostLogFields): void
  /** How long a predecessor gets to exit by itself. */
  waitMs?: number
  /** Each signal's wait, and the signals themselves. */
  answerMs?: { SIGTERM: number; SIGKILL: number }
  signal?(pid: number, signal: "SIGTERM" | "SIGKILL"): void
  startOf?(pid: number): string | null
}

/**
 * The data root's lock for a host that may follow another. A predecessor exits once its cleanup is done, so one that
 * holds the lock past `waitMs` is stuck in its exit (Node's can deadlock with V8's compiler threads) with nothing left
 * to lose. Only that process is ended: the one under the pid it named, started when it said it did, read again before
 * each signal so a pid given to another process since is left alone, and never while another process is named as the
 * lock's holder. The lock is what says it ended:
 * the kernel frees it with the process, while a killed process can still be listed until its parent reaps it.
 */
export async function acquireSuccessorLock(dataRoot: string, predecessor: Predecessor | undefined, options: SuccessorLockOptions): Promise<SuccessorLock> {
  const lock = await acquireHostLock(dataRoot, { predecessor: predecessor?.pid, waitMs: options.waitMs })
  if (lock.kind === "held" || !predecessor) return lock
  const { pid, start } = predecessor
  const answerMs = options.answerMs ?? { SIGTERM: TERM_MS, SIGKILL: KILL_MS }
  const send = options.signal ?? ((target, signal) => void process.kill(target, signal))
  const startOf = options.startOf ?? processStart
  // A holder that names nobody may be this one (`acquireHostLock`), so it stands while the process still runs.
  if (lock.holder !== pid && !(lock.holder === null && startOf(pid) !== null)) return lock
  const notEnded = async (stuck: string): Promise<SuccessorLock> => {
    // It may have gone by itself as we looked.
    const last = await acquireHostLock(dataRoot)
    if (last.kind === "held") return last
    options.log("the host before this one is stuck and wasn't ended", { pid, start: start ?? "", why: stuck })
    return { ...last, stuck }
  }
  if (!start) return notEnded(`pid ${pid} didn't say when it started, so it can't be told from a process that took its pid`)
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    const now = startOf(pid)
    if (now !== start) return notEnded(`pid ${pid} is no longer the host that named it: it started ${now ?? "at no time ps can read"}, not ${start}`)
    options.log("ending the host before this one, which held the data root past its exit", { pid, start, signal })
    try {
      send(pid, signal)
    } catch (error) {
      return notEnded(`${signal} to pid ${pid} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    const until = Date.now() + answerMs[signal]
    for (;;) {
      const after = await acquireHostLock(dataRoot)
      if (after.kind === "held") {
        options.log("the host before this one ended", { pid, signal })
        return after
      }
      if (Date.now() >= until) {
        if (after.holder !== pid && after.holder !== null) return after
        break
      }
      await new Promise((done) => setTimeout(done, 50))
    }
  }
  return notEnded(`pid ${pid} still holds the data root after SIGKILL`)
}
