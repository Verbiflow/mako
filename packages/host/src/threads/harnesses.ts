
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
   * The harness's processes this host started, by pid, each with the native session it holds (null before it has
   * one): its own, so a probe that can't tell which session a process holds doesn't take them for another app's.
   */
  own?: ReadonlyMap<number, string | null>
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
