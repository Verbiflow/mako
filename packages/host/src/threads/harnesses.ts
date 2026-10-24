import type { MakoProcess } from "../base/provider-children.js"

/** Mako's recorded harness processes by pid, read when asked. */
export type MakoProcesses = () => ReadonlyMap<number, MakoProcess>

export type ProviderActivityStatus = "active" | "needs-input" | "open"

export interface ProviderActivitySession {
  nativeId?: string
  path?: string
  status: ProviderActivityStatus
  detail?: string
}

/** Execution admission names the source being inspected; observation may scan the default inventory. */
export interface ProviderProbeTarget {
  nativeId: string
  path: string
  /**
   * The harness processes Mako's hosts on this Mac recorded, each with the session it holds (`readMakoProcesses`):
   * read only by a probe that finds a process it can't place otherwise, so it isn't taken for another app's.
   */
  mako?: MakoProcesses
}

export type ProviderActivityResult =
  | { kind: "available"; sessions: ProviderActivitySession[] }
  | {
      kind: "unavailable"
      reason: "unsupported" | "timeout" | "permission" | "failed" | "incomplete"
    }

/** How a harness sees its sessions open in other apps, which the rail shows as running there. */
export interface ProviderProcessProbe {
  provider: string
  pollIntervalMs?: number
  staleAfterMs?: number
  timeoutMs?: number
  probe(signal: AbortSignal, target?: ProviderProbeTarget): Promise<ProviderActivityResult>
}

/** What Threads reads of the harnesses. */
export interface ThreadHarnesses {
  /** The harness's name as people read it. */
  label(harness: string): string
  processProbes(): readonly ProviderProcessProbe[]
}
