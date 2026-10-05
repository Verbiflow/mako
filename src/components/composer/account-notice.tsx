import { useEffect } from "react"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { accountReading, stopSwitches, waitText } from "@/lib/account-switch"
import { accounts, useAccounts, type ProviderAccount } from "@/state/accounts"
import { acp, activeLiveAcp, useAcp } from "@/state/acp"
import { shallowEqual } from "@/state/store"
import { cn } from "@/lib/utils"

const NONE: ProviderAccount[] = []

/**
 * One line above the composer when this session isn't running as the account
 * selected for its harness. Accounts switch globally: a session keeps the
 * account it started with until its next message reopens it under the new
 * one, or until the work holding the old process ends, and the line says
 * which. When the agent reports a different identity than the account it was
 * launched with, it says so; nothing is sent until that's fixed. Silent when
 * they agree.
 *
 * Registered on `composer.above`.
 */
export function AccountSwitchNotice() {
  const live = useAcp((state) => {
    const current = activeLiveAcp(state)
    return current ? { harness: current.harness, session: current.session, requests: current.requests, canceling: current.canceling } : null
  }, shallowEqual)
  const harness = live?.harness
  const listed = useAccounts((state) => harness ? state.accounts.filter((account) => account.harness === harness) : NONE, shallowEqual)
  const label = useAccounts((state) => state.providers.find((provider) => provider.provider === harness && provider.mode === "selectable")?.label)
  useEffect(() => { if (harness) accounts.load() }, [harness])
  const reading = live && label ? accountReading(live, listed) : null
  if (!live || !reading) return null
  const text =
    reading.kind === "differs" ? `${label} is signed in as ${reading.principal}, not ${reading.expected}. Messages won’t send until that’s fixed.`
      : reading.kind === "waiting" ? `Switches to ${reading.selected} when ${waitText(reading.waitingFor)}. Your message is waiting.`
        : live.session.status === "running" ? `This turn runs as ${reading.running}. The next message switches to ${reading.selected}.`
          : `This session runs as ${reading.running}. Your next message switches it to ${reading.selected}.`

  return (
    <div
      role="status"
      data-account-notice={reading.kind}
      className={cn(
        "mb-1.5 flex items-center gap-2 rounded-md bg-raised px-2 py-1 text-ui",
        reading.kind === "differs" ? "text-caution" : "text-muted-foreground"
      )}
    >
      <HarnessIcon harness={live.harness} className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate" title={text}>{text}</span>
      {reading.kind === "waiting" && stopSwitches(reading.waitingFor) ? (
        <button
          type="button"
          disabled={live.canceling}
          onClick={() => void acp.cancel()}
          className="pressable shrink-0 rounded px-1.5 py-0.5 text-label font-medium text-foreground hover:bg-fill-hover disabled:opacity-60"
        >
          {live.canceling ? "Stopping…" : "Stop and switch"}
        </button>
      ) : null}
      {reading.kind === "differs" ? (
        <button
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent("mako:settings", { detail: "agents" }))}
          className="pressable shrink-0 rounded px-1.5 py-0.5 text-label font-medium text-foreground hover:bg-fill-hover"
        >
          Settings
        </button>
      ) : null}
    </div>
  )
}
