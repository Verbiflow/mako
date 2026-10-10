import type { EmitResult, Thread } from "@mako/sessions"

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

/** How a harness sees its sessions open in other apps, which the rail shows as running there. */
export interface ProviderProcessProbe {
  provider: string
  pollIntervalMs?: number
  staleAfterMs?: number
  timeoutMs?: number
  probe(signal: AbortSignal, target?: ProviderProbeTarget): Promise<ProviderActivityResult>
}

/** Writes a Thread into the harness's own store as a native session, ready to reply to there. */
export interface ProviderSessionEmitter {
  provider: string
  emit(thread: Thread): Promise<EmitResult>
}

/** What Threads reads of the harnesses. */
export interface ThreadHarnesses {
  /** The harness's name as people read it. */
  label(harness: string): string
  processProbes(): readonly ProviderProcessProbe[]
  sessionEmitter(harness: string): ProviderSessionEmitter | undefined
}
