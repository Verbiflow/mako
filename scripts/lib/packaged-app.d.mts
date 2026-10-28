import type { ChildProcess } from "node:child_process"
import type { RuntimeInfo } from "@mako/host/contracts/runtime"

export interface PackagedAppOptions {
  executable: string
  root: string
  workspace: string
  args?: string[]
  env?: Record<string, string | undefined>
  onStdoutLine?: (line: string) => void
}

/**
 * A packaged Mako's desktop run on a profile and a home of its own under `root`, driven over its DevTools protocol:
 * what TypeScript callers use of it.
 */
export class PackagedApp {
  constructor(options: PackagedAppOptions)
  readonly executable: string
  readonly root: string
  readonly workspace: string
  child: ChildProcess | undefined
  hostPid: number | undefined
  get profile(): string
  get clientFolder(): string
  /** The desktop's environment; without a caller's own `HOME`, it (re)makes `root/home` with fresh sign-ins. */
  environment(): NodeJS.ProcessEnv
  host(): Promise<RuntimeInfo | undefined>
  waitFor<T>(read: () => Promise<T> | T, predicate: (value: T) => boolean, label: string, timeout?: number): Promise<T>
  screenshot(path: string): Promise<string>
  start(): Promise<{ url: string; pid: number | undefined; hostPid: number }>
  stop(options?: { graceful?: boolean }): Promise<void>
}
