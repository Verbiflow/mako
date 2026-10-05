import { accountIdentity } from "@/lib/account-identity"
import type { ProviderAccount } from "@/state/accounts"
import type { LiveAcpConversation } from "@/state/acp-state"
import type { AccountSwitchWait } from "../../electron/contracts/live-conversations"

/** What a session says about its account when it isn't the one selected for its harness. */
export type AccountReading =
  | { kind: "differs"; principal: string; expected: string }
  | { kind: "waiting"; selected: string; waitingFor: AccountSwitchWait }
  | { kind: "pending"; running: string; selected: string; removing?: true }

type LiveAccountView = Pick<LiveAcpConversation, "session" | "requests">

const WAITS = {
  background: "its background work finishes",
  subagents: "its subagents finish",
  children: "its child sessions finish",
  approval: "you answer its approval",
  turn: "this turn ends",
  operation: "its current step ends",
} satisfies Record<AccountSwitchWait, string>

/** Stop ends these, and the waiting message then switches the session. */
const STOPPABLE: ReadonlySet<AccountSwitchWait> = new Set(["background", "subagents", "turn"])

export function waitText(wait: AccountSwitchWait): string {
  return WAITS[wait]
}

export function stopSwitches(wait: AccountSwitchWait): boolean {
  return STOPPABLE.has(wait)
}

/** Null when the session runs as the selected account, or the harness can't say. */
export function accountReading(live: LiveAccountView, listed: readonly ProviderAccount[]): AccountReading | null {
  const context = live.session.executionContext
  const ended = live.session.status === "closed" || live.session.status === "failed"
  if (context?.confirmation?.kind === "differs" && !ended && live.session.connection === "connected")
    return { kind: "differs", principal: context.confirmation.principal, expected: context.confirmation.expected }
  const selected = listed.find((account) => account.active)
  if (!selected || selected.missing) return null
  const waiting = live.requests?.find((request) => request.status === "queued" && request.accountSwitch)?.accountSwitch
  if (waiting) return { kind: "waiting", selected: accountIdentity(selected), waitingFor: waiting.waitingFor }
  const running = context?.account
  if (ended || running?.kind !== "configured" || running.name === selected.name) return null
  const launched = listed.find((account) => account.name === running.name)
  const principal = context?.identity.kind === "reported" ? context.identity.principal : undefined
  const reading: AccountReading = {
    kind: "pending",
    running: principal ?? (launched ? accountIdentity(launched) : running.name),
    selected: accountIdentity(selected),
  }
  if (launched?.removing) reading.removing = true
  return reading
}
