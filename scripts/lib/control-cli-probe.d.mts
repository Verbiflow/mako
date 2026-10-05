import type { startDesktopControlSession } from "@mako/control-runtime/session"

export type ControlCliSession = Awaited<ReturnType<typeof startDesktopControlSession>>

export interface ControlCliProbeStart {
  native?: { driver: string; socket: string }
  browser?: { url: string; token: string }
  executable?: string
  env?: NodeJS.ProcessEnv
  /** Directory holding the built control runtime; defaults to packages/control-runtime/dist. */
  runtimeRoot?: string
}

export type ControlCliProbeRequest =
  | { method: "exec"; arguments: { source: string } }
  | { method: "help"; arguments?: { tool?: string } }
  | { method: "status"; arguments?: Record<string, never> }

export interface ControlCliProbeOptions {
  /** Milliseconds before the CLI is interrupted; defaults to 70 seconds. */
  timeout?: number
  signal?: AbortSignal
}

/** A failed command carries the CLI's fault; a successful one carries its output blocks. */
export type ControlCliProbeResult =
  | { isError: true; structuredContent: unknown; content: Array<{ type: "text"; text: string }> }
  | { isError?: undefined; structuredContent?: undefined; content: unknown[] }

/** Acceptance helper: every request launches the real CLI against a task worker. */
export declare class ControlCliProbe {
  constructor(identity: { name: string; version?: string })
  readonly name: string
  session: ControlCliSession | undefined
  start(input?: ControlCliProbeStart): Promise<void>
  request(request: ControlCliProbeRequest, options?: ControlCliProbeOptions): Promise<ControlCliProbeResult>
  close(): Promise<void>
}
