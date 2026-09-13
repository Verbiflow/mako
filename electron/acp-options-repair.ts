import type { SessionConfigOption } from "@agentclientprotocol/sdk"
import type { AcpOptionsRepair } from "./providers/acp-source.js"

/**
 * How often the host asks an agent to rebuild an incomplete option set
 * before the start fails. Each ask is one `session/set_config_option`; an
 * agent whose backend fetch is what failed may take its own timeout to
 * answer, so the count stays small and the pause between asks short.
 */
export const OPTIONS_REPAIR_ATTEMPTS = 2
export const OPTIONS_REPAIR_PAUSE_MS = 1_500

/** The start failure when an agent's option set stays incomplete: its `message` is what the user reads. */
export class AcpOptionsUnavailableError extends Error {
  readonly attempts: number
  readonly lastRefusal: string | undefined

  constructor(reason: string, attempts: number, lastRefusal: string | undefined) {
    super(reason)
    this.name = "AcpOptionsUnavailableError"
    this.attempts = attempts
    this.lastRefusal = lastRefusal
  }
}

export interface RepairSessionOptionsInput {
  options: SessionConfigOption[]
  /** The model the tuning is about to select, so the repair names it. */
  model: string | undefined
  degraded(options: SessionConfigOption[], model: string | undefined): AcpOptionsRepair | undefined
  /** Send one config change; resolves with the agent's rebuilt options, rejects when the agent refuses it. */
  set(request: { configId: string; value: string }): Promise<SessionConfigOption[]>
  /** Called once per attempt that did not finish the repair, with what the agent said. */
  onAttempt?(attempt: number, refusal: string | undefined): void
  attempts?: number
  pauseMs?: number
  sleep?(ms: number): Promise<void>
}

/**
 * Return a complete option set, asking the agent to rebuild an incomplete
 * one a bounded number of times. A complete set returns untouched with no
 * request sent. A refused repair (the agent's fetch failed again) is one
 * spent attempt, as is a rebuilt set that is still incomplete; the pause
 * between attempts gives a backend hiccup room to pass. When the budget is
 * spent the start fails with the provider's own reason so the user reads
 * why the session cannot take the selection, not "cannot change context".
 */
export async function repairSessionOptions(input: RepairSessionOptionsInput): Promise<SessionConfigOption[]> {
  const attempts = input.attempts ?? OPTIONS_REPAIR_ATTEMPTS
  const pauseMs = input.pauseMs ?? OPTIONS_REPAIR_PAUSE_MS
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  let options = input.options
  const initial = input.degraded(options, input.model)
  if (!initial) return options
  let repair: AcpOptionsRepair = initial
  let lastRefusal: string | undefined
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (!repair.request) throw new AcpOptionsUnavailableError(repair.reason, attempt - 1, lastRefusal)
    if (attempt > 1) await sleep(pauseMs)
    try {
      options = await input.set(repair.request)
      lastRefusal = undefined
    } catch (error: unknown) {
      lastRefusal = error instanceof Error ? error.message : String(error)
      input.onAttempt?.(attempt, lastRefusal)
      continue
    }
    const remaining = input.degraded(options, input.model)
    if (!remaining) return options
    repair = remaining
    input.onAttempt?.(attempt, undefined)
  }
  throw new AcpOptionsUnavailableError(repair.reason, attempts, lastRefusal)
}
