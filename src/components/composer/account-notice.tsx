import { useEffect } from "react"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { accountReading, stopSwitches, waitText, type AccountReading } from "@/lib/account-switch"
import type { LiveSessionState, UsageWindow } from "@/lib/types"
import type { AccountLimitOffer } from "@mako/host/contracts/account-usage"
import { usageWindowName } from "@/lib/usage-window"
import { accounts, useAccounts, type ProviderAccount } from "@/state/accounts"
import { acp, activeLiveAcp, useAcp } from "@/state/acp"
import { shallowEqual } from "@/state/store"
import type { ComposerNotice, ComposerNoticeAction } from "@/extend/notices"

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
 * A notice producer (`registerNotice`).
 */
export function useAccountSwitchNotice(): ComposerNotice | null {
  const live = useAcp((state) => {
    const current = activeLiveAcp(state)
    return current ? { harness: current.harness, session: current.session, requests: current.requests, canceling: current.canceling } : null
  }, shallowEqual)
  const harness = live?.harness
  const listed = useAccounts((state) => harness ? state.accounts.filter((account) => account.harness === harness) : NONE, shallowEqual)
  const label = useAccounts((state) => state.providers.find((provider) => provider.provider === harness && provider.mode === "selectable")?.label)
  useEffect(() => { if (harness) accounts.load() }, [harness])
  const reading = live && label ? accountReading(live, listed) : null
  if (!live || !label || !reading) return null
  const text = noticeText(reading, live.session, label)

  const actions: ComposerNoticeAction[] = []
  if (reading.kind === "waiting" && stopSwitches(reading.waitingFor))
    actions.push({ label: live.canceling ? "Stopping…" : "Stop and switch", primary: true, disabled: live.canceling, onClick: () => void acp.cancel() })
  if (reading.kind === "differs")
    actions.push({ label: "Settings", primary: true, onClick: () => window.dispatchEvent(new CustomEvent("mako:settings", { detail: "agents" })) })
  return {
    id: "account-switch",
    tone: reading.kind === "differs" ? "caution" : "info",
    icon: <HarnessIcon harness={live.harness} />,
    title: text.title,
    description: text.description,
    actions,
    data: { "data-account-notice": reading.kind },
  }
}

/** A notice's words: what holds, then what follows from it. */
interface NoticeWords {
  title: string
  description?: string
}

function noticeText(reading: AccountReading, session: LiveSessionState, label: string): NoticeWords {
  if (reading.kind === "differs") return { title: `${label} is signed in as ${reading.principal}, not ${reading.expected}`, description: "messages won’t send until that’s fixed" }
  if (reading.kind === "waiting") return { title: `Switches to ${reading.selected} when ${waitText(reading.waitingFor)}`, description: "your message is waiting" }
  const { running, selected, removing } = reading
  if (session.status === "running") return removing
    ? { title: `This turn runs as ${running}`, description: `Mako removes it when the turn ends; the next message uses ${selected}` }
    : { title: `This turn runs as ${running}`, description: `the next message switches to ${selected}` }
  if (session.backgroundTasks) return removing
    ? { title: `Background work runs as ${running}`, description: `Mako removes it when it finishes; a new message waits for it, then uses ${selected}` }
    : { title: `Background work runs as ${running}`, description: `a new message waits for it, then switches to ${selected}` }
  return { title: `This session runs as ${running}`, description: `your next message switches it to ${selected}` }
}

/**
 * One line above the composer when the account this harness runs on is near
 * its plan limit, or the harness just refused a turn on it, and another of
 * its accounts has room. The host decides (`AccountLimitOffer`); switching
 * is the person's click, since an account is money. Goes once the account
 * in use is no longer the one the offer is about.
 *
 * A notice producer (`registerNotice`).
 */
export function useAccountLimitNotice(): ComposerNotice | null {
  const harness = useAcp((state) => activeLiveAcp(state)?.harness)
  const offer = useAccounts((state) => harness ? state.limitOffers[harness] : undefined)
  const active = useAccounts((state) => harness ? state.accounts.find((account) => account.harness === harness && account.active)?.name : undefined)
  const label = useAccounts((state) => state.providers.find((provider) => provider.provider === harness)?.label)
  const busy = useAccounts((state) => Boolean(state.busy))
  if (!harness || !offer || !label || (active !== undefined && active !== offer.from.name)) return null
  const text = limitText(offer, label)
  const to = offer.to.email ?? offer.to.name
  return {
    id: "account-limit",
    tone: offer.because === "refused" ? "caution" : "info",
    icon: <HarnessIcon harness={harness} />,
    title: text.title,
    description: text.description,
    actions: [
      { label: `Switch to ${to}`, primary: true, disabled: busy, title: `Every ${label} session switches to ${to}`, onClick: () => void accounts.select(harness, offer.to.name) },
      { label: "Not now", onClick: () => accounts.declineOffer(harness) },
    ],
    data: { "data-account-limit": offer.because },
  }
}

function limitText(offer: AccountLimitOffer, label: string): NoticeWords {
  const from = offer.from.email ?? offer.from.name
  const to = offer.to.email ?? offer.to.name
  const room = offer.to.window ? `${to} is at ${Math.round(offer.to.window.usedPercent)}%` : `${to} has room`
  if (offer.because === "refused") return { title: `${label} stopped the last turn on ${from}'s limits`, description: room }
  const window = offer.from.window
  return window
    ? { title: `${from} is at ${Math.round(window.usedPercent)}% of its ${limitName(window)}`, description: room }
    : { title: `${from} is near its ${label} limit`, description: room }
}

function limitName(window: UsageWindow): string {
  return usageWindowName(window).replace(/^\S/, (first) => first.toLowerCase())
}
