import type { RuntimeValue } from "@mako/host/contracts/runtime"
import type { RuntimeInfo } from "@mako/host/transport/connection"

/** How a host's process ended: its code or signal, `ms` after it was spawned. */
export interface HostExit {
  code: number | null
  signal: NodeJS.Signals | null
  ms: number
}

export interface StartedHost {
  pid: number | undefined
  socket: string
  info: RuntimeInfo
  healthMs: number
  /** The host's own log, `logs/host.log` under its data root. */
  log: string
  call(channel: string, ...args: unknown[]): Promise<RuntimeValue>
  /** SIGTERM, as a machine's agent stops it; resolves with how it exited. */
  stop(timeoutMs?: number): Promise<HostExit & { stopMs: number }>
}

/**
 * A `mako-host` the Linux kit starts as a machine's agent would: the program
 * from PATH, its data root and socket in its environment, as installed
 * (`MAKO_PROD`). Its output goes to `output`, a file beside its data.
 */
export function startHost(input: { dataRoot: string; output: string; env?: NodeJS.ProcessEnv }): Promise<StartedHost>

export const SHARED_DAEMONS: string[]

/** Whether a process is one of Mako's shared daemons, which outlive a host by design. */
export function sharedDaemon(args: string): boolean

/** Every other process in this container: all but this one, its parent and its own children such as ps. */
export function othersRunning(): Promise<{ pid: number; ppid: number; args: string }[]>

/** Polls `read` until `done` says the value is final, or fails after `timeoutMs`. */
export function until<T>(read: () => Promise<T> | T, done: (value: T) => boolean, label: string, timeoutMs?: number): Promise<T>
