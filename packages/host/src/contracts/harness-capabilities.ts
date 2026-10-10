/**
 * How a harness stands on one thing a live conversation can do. Every
 * capability is declared in exactly one of these, so neither the host nor
 * the window infers one from a missing method or a failed call:
 * - `implemented`: Mako drives it; `via` names the native mechanism.
 * - `no-op`: Mako accepts the action and there is nothing for it to do.
 * - `default`: Mako does nothing itself; the harness's own behaviour,
 *   named in `reason`, already gives the result.
 * - `absent`: not implemented. `by: "harness"` when the harness has no such
 *   thing, `by: "mako"` when it has one Mako does not drive yet; the second
 *   is a gap to close.
 */
export type Capability<Detail extends object = object> =
  | ({ state: "implemented"; via: string } & Detail)
  | { state: "no-op"; reason: string }
  | { state: "default"; reason: string }
  | { state: "absent"; by: "harness" | "mako"; reason: string }

export const implemented = (via: string): Capability => ({ state: "implemented", via })
type Not<State extends Capability["state"]> = Extract<Capability, { state: State }>
export const noOp = (reason: string): Not<"no-op"> => ({ state: "no-op", reason })
export const byDefault = (reason: string): Not<"default"> => ({ state: "default", reason })
export const harnessLacks = (reason: string): Not<"absent"> => ({ state: "absent", by: "harness", reason })
export const makoLacks = (reason: string): Not<"absent"> => ({ state: "absent", by: "mako", reason })

/**
 * Every capability of one harness, projected from its live driver. A
 * capability only one harness has is a key here like any other, and the
 * rest say why they lack it, so its UI registers against the key.
 */
export interface LiveCapabilities {
  resume: Capability
  /** What Mako may do with the harness's process while its conversation is idle. */
  residency: Capability
  turnRecovery: Capability
  fork: Capability
  steering: Capability<{ lands: import("./providers-acp.js").LiveSteering }>
  compaction: Capability
  planning: Capability
  approvals: Capability
  /**
   * `request`: the turn waits on the answer, given through the approval the
   * harness raised. `session`: the question stays in the conversation after
   * the turn and survives a restart, answered or dismissed in the session.
   */
  questions: Capability<{ asks: "request" | "session" }>
  modes: Capability
  nativeAgents: Capability
  backgroundStop: Capability
  contextBreakdown: Capability
}
export type LiveCapabilityKey = keyof LiveCapabilities

/** The order the window and the audit list them in. */
export const LIVE_CAPABILITY_KEYS: readonly LiveCapabilityKey[] = [
  "resume", "residency", "turnRecovery", "fork", "steering", "compaction", "planning",
  "approvals", "questions", "modes", "nativeAgents", "backgroundStop", "contextBreakdown",
]

export const LIVE_CAPABILITY_LABELS = {
  resume: "Resume",
  residency: "Idle process",
  turnRecovery: "Process death mid-turn",
  fork: "Fork",
  steering: "Steering",
  compaction: "Compaction",
  planning: "Planning",
  approvals: "Approvals",
  questions: "Questions",
  modes: "Modes",
  nativeAgents: "Subagents",
  backgroundStop: "Background work on Stop",
  contextBreakdown: "Context breakdown",
} satisfies Record<LiveCapabilityKey, string>

/** The words a declaration carries: how it works, or why there is nothing to drive. */
export function capabilityText(capability: Capability): string {
  return capability.state === "implemented" ? capability.via : capability.reason
}

/** Where a harness's capabilities are unknown, as for one this Mac cannot run; nothing is offered. */
export function unknownCapabilities(reason: string): LiveCapabilities {
  const unknown = { state: "absent", by: "mako", reason } as const
  return {
    resume: unknown, residency: unknown, turnRecovery: unknown, fork: unknown, steering: unknown, compaction: unknown, planning: unknown,
    approvals: unknown, questions: unknown, modes: unknown, nativeAgents: unknown, backgroundStop: unknown, contextBreakdown: unknown,
  }
}
