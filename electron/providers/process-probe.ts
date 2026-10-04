import type { ProviderCapability } from "./registry.js"

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
}

export type ProviderActivityResult =
  | { kind: "available"; sessions: ProviderActivitySession[] }
  | {
      kind: "unavailable"
      reason: "unsupported" | "timeout" | "permission" | "failed" | "incomplete"
    }

export interface ProviderProcessProbe extends ProviderCapability {
  pollIntervalMs?: number
  staleAfterMs?: number
  timeoutMs?: number
  probe(signal: AbortSignal, target?: ProviderProbeTarget): Promise<ProviderActivityResult>
}
