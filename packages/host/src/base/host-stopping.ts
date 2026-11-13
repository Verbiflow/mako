import { AsyncLocalStorage } from "node:async_hooks"
import { withControlProcesses } from "@mako/control-runtime/processes"
import { withSessionProcesses } from "@mako/sessions/processes"
import { hostSpawn, hostFork, hostCommand } from "./host-command.js"

/** Expected cancellation, rather than a provider, network or authentication failure. */
export class HostStoppingError extends Error {
  constructor(message = "Mako's host is stopping. This request was not completed.") {
    super(message)
    this.name = "HostStoppingError"
  }
}

const hosts = new AsyncLocalStorage<HostStopping>()

/** What a probe that only reads the machine (`ps`, `lsof`, `sysctl`) is run with. */
export interface ProbeOptions {
  env?: NodeJS.ProcessEnv
  cwd?: string
  timeout?: number
  maxBuffer?: number
  signal?: AbortSignal
}

/**
 * Probes run in a long-lived child of the host's, answering by message (`childProcessReader`), so the host never
 * spawns one on its loop: a spawn from a host of several hundred megabytes held the loop for tens of milliseconds
 * on a busy Mac, and its probes spawned hundreds a minute (`hostCommand` routes them here).
 */
export interface HostProbes {
  /** `file` with `args`, answered as `hostCommand` answers: its output, or an error carrying `code`, `stdout` and `stderr`. */
  run(file: string, args: readonly string[], options: ProbeOptions): Promise<{ stdout: string; stderr: string }>
  /** When `pid` started, as `ps -o lstart` says; every pid asked about in one turn is read by one `ps`. */
  startedAt(pid: number, signal?: AbortSignal): Promise<number>
}

/**
 * Outside work ends before host calls drain; local commits and cleanup then
 * finish while their stores are open. Each host owns its own cancellation.
 */
export class HostStopping {
  private readonly controller = new AbortController()
  private readonly owners = new Map<() => void | Promise<void>, string>()
  private stopped: Promise<void> | undefined
  /** Where this host's probes run, once composition gives it one; without it they're spawned here. */
  probes: HostProbes | undefined

  get signal(): AbortSignal { return this.controller.signal }

  run<T>(operation: () => T): T {
    return hosts.run(this, () => withControlProcesses({ spawn: hostSpawn, fork: hostFork, command: hostCommand }, () => withSessionProcesses({ fork: hostFork }, operation)))
  }

  /** Register the owner that can actually end a wait, not just abandon its promise. */
  register(name: string, cancel: () => void | Promise<void>): () => void {
    this.signal.throwIfAborted()
    this.owners.set(cancel, name)
    return () => { this.owners.delete(cancel) }
  }

  /** Starts every cancellation before waiting for any of them. Repeated stops join it. */
  stop(): Promise<void> {
    if (this.stopped) return this.stopped
    this.controller.abort(new HostStoppingError())
    const cancelling = [...this.owners].map(async ([cancel, name]) => {
      try { await cancel() } catch (cause) { throw new Error(`Could not stop ${name}`, { cause }) }
    })
    this.owners.clear()
    this.stopped = Promise.allSettled(cancelling).then((results) => {
      const failed = results.flatMap((result) => result.status === "rejected" ? [result.reason] : [])
      if (failed.length) throw new AggregateError(failed, "Outside work did not stop cleanly")
    })
    return this.stopped
  }
}

/** The host that owns this work, including work a call started and later joined. */
export function hostStopping(): HostStopping | undefined { return hosts.getStore() }

/** A borrowed client's request can end without taking ownership of the client itself. */
export async function untilStopped<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void work.catch(() => {})
    throw signal.reason
  }
  let abort: (() => void) | undefined
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason)
    if (signal.aborted) abort()
    else signal.addEventListener("abort", abort, { once: true })
  })
  try { return await Promise.race([work, stopped]) }
  finally { if (abort) signal.removeEventListener("abort", abort) }
}

/** HTTP headers and body both observe the owning host's stop, as well as the caller's deadline. */
export function stoppingSignal(signal: AbortSignal): AbortSignal
export function stoppingSignal(signal?: AbortSignal | null): AbortSignal | undefined
export function stoppingSignal(signal?: AbortSignal | null): AbortSignal | undefined {
  const stopping = hostStopping()?.signal
  return stopping && signal ? AbortSignal.any([stopping, signal]) : stopping ?? signal ?? undefined
}

export const hostFetch: typeof fetch = (input, init) => {
  const signal = stoppingSignal(init?.signal ?? (input instanceof Request ? input.signal : undefined))
  return fetch(input, { ...init, ...signal && { signal } })
}
