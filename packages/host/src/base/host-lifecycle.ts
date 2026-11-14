import { spawn } from "node:child_process"
import { acquireHostLock, type HostLockOptions, type HostLock } from "./host-lock.js"
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

/** The environment variable a successor finds its predecessor's pid in. */
export const SUCCEEDS_ENV = "MAKO_HOST_SUCCEEDS"

/** Past the wait for its exit, how long a predecessor gets to answer each signal. */
const TERM_MS = 5_000
const KILL_MS = 5_000

/**
 * How the host ends. A restart starts the same program again, detached,
 * before this one exits; the successor waits for this process's lock
 * (`acquireSuccessorLock`).
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
    // A test's stand-in for an exit macOS keeps going after every thread ended (`MAKO_EXIT_HOLD_MS`): the process stays,
    // holding nothing, as the person's did.
    const hold = Number(process.env.MAKO_EXIT_HOLD_MS)
    if (hold > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, hold)
    process.exit(code)
  }
}

/** The predecessor a restarted host waits for, read once and kept from its own children. */
export function takePredecessor(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const pid = Number(env[SUCCEEDS_ENV])
  delete env[SUCCEEDS_ENV]
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
}

/** `stuck` says why a predecessor still holding the data root wasn't ended, and how to end it. */
export type SuccessorLock = HostLock | (Extract<HostLock, { kind: "taken" }> & { stuck: string })

export interface SuccessorLockOptions {
  /** A short-lived holder waited out before refusing, as `acquireHostLock`'s `brief`: a `mako-host` command, never a host that answers. */
  brief?: HostLockOptions["brief"]
  log(message: string, fields: HostLogFields): void
  /** How long a predecessor gets to exit by itself. */
  waitMs?: number
  /** Each signal's wait, and the signals themselves. */
  answerMs?: { SIGTERM: number; SIGKILL: number }
  signal?(pid: number, signal: "SIGTERM" | "SIGKILL"): void
  /** This process's parent, read as it is now. */
  parent?(): number
}

/**
 * The data root's lock for a host that may follow another. A predecessor exits once its cleanup is done, so one that
 * holds the lock past `waitMs` is stuck in its exit (Node's can deadlock with V8's compiler threads) with nothing left
 * to lose. It is ended only while it is this process's parent, as `nodeHostExit` made it, read again right before each
 * signal: on macOS and Linux a process that exits hands its children on before its pid can be anyone else's, so the
 * parent's pid is still the predecessor's. The read and the signal are two calls apart, and the pid would have to be
 * freed and every other pid handed out between them; Linux's pidfd would close even that, and Node has no way to it.
 * A predecessor that isn't this process's parent is left as it is, and the host says how to stop it. The lock is what
 * says it ended: the kernel frees it with the process, while a killed process can still be listed until it's reaped.
 */
export async function acquireSuccessorLock(dataRoot: string, predecessor: number | undefined, options: SuccessorLockOptions): Promise<SuccessorLock> {
  const lock = await acquireHostLock(dataRoot, { predecessor, waitMs: options.waitMs, brief: options.brief })
  if (lock.kind === "held" || predecessor === undefined) return lock
  const pid = predecessor
  const answerMs = options.answerMs ?? { SIGTERM: TERM_MS, SIGKILL: KILL_MS }
  const send = options.signal ?? ((target, signal) => void process.kill(target, signal))
  const parent = options.parent ?? (() => process.ppid)
  if (lock.holder !== pid && lock.holder !== null) return lock
  const stop = `stop it with \`kill -9 ${pid}\`, then start Mako again`
  const notEnded = async (stuck: string): Promise<SuccessorLock> => {
    // It may have gone by itself as we looked.
    const last = await acquireHostLock(dataRoot)
    if (last.kind === "held") return last
    options.log("the host before this one is stuck and wasn't ended", { pid, why: stuck })
    return { ...last, stuck }
  }
  // A holder that names nobody (`acquireHostLock`) is the predecessor while it's this process's parent, and may be while
  // its pid still runs: said so, with how to check, and never signalled.
  if (lock.holder === null && parent() !== pid) {
    if (!running(pid)) return lock
    return notEnded(`the data root is still held and the lock can't say by whom; pid ${pid}, the host before this one, still runs and isn't this host's parent, so nothing says it's still that host: if \`ps -p ${pid}\` shows Mako, ${stop}`)
  }
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    if (parent() !== pid) return notEnded(`pid ${pid} holds the data root past its exit and isn't this host's parent, so nothing says it's still that host: ${stop}`)
    options.log("ending the host before this one, which held the data root past its exit", { pid, signal })
    try {
      send(pid, signal)
    } catch (error) {
      return notEnded(`${signal} to pid ${pid} failed (${error instanceof Error ? error.message : String(error)}): ${stop}`)
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
  return notEnded(`pid ${pid} still holds the data root after SIGKILL: ${stop}`)
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM"
  }
}
