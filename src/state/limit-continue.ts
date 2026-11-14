import { useEffect, useState } from "react"
import { useAccounts } from "@/state/accounts"
import { activeLiveAcp, useAcp } from "@/state/acp"
import { continueNext, nextPlace } from "@/state/fin-asks"
import { promptDelivery } from "@/state/prompt-delivery"

/** A Thread a limit holds, with somewhere to go: where, and the person's two answers. */
export interface LimitContinue {
  /** The harness it would go on: the offer's mark, as this is a choice of where to go. */
  harness: string
  to: string
  busy: boolean
  go(): void
  notNow(): void
}

/**
 * The one offer of a Thread a limit holds and Mako doesn't move by itself: a Thread with no Fins is the person's to
 * decide. The host says where it would go (`Agents.nextPlace`); nowhere, and there's no offer, only the queue's line
 * saying when it goes again. Another account to switch to is the same decision, and that offer has it. "Not now" stands
 * for this wait.
 */
export function useLimitContinue(): LimitContinue | null {
  const key = useAcp((state) => activeLiveAcp(state)?.key)
  const harness = useAcp((state) => activeLiveAcp(state)?.harness)
  const since = useAcp((state) => {
    const current = activeLiveAcp(state)
    return current && promptDelivery(current).queued.find((prompt) => prompt.retry?.cause === "rate-limited" && prompt.pause !== "stop")?.retry?.since
  })
  const offered = useAccounts((state) => (harness ? state.limitOffers[harness] : undefined))
  const [place, setPlace] = useState<{ key: string; to: string; harness: string }>()
  const [busy, setBusy] = useState(false)
  const [declined, setDeclined] = useState<string>()
  const held = since !== undefined
  useEffect(() => {
    if (!key || !held) return
    let current = true
    void nextPlace(key).then((next) => {
      if (current) setPlace(next ? { key, to: next.label, harness: next.harness } : undefined)
    })
    return () => { current = false }
  }, [key, held])
  const wait = `${key}:${since}`
  if (!key || !held || place?.key !== key || declined === wait || offered?.to) return null
  return {
    harness: place.harness,
    to: place.to,
    busy,
    go: () => {
      setBusy(true)
      void continueNext(key).finally(() => setBusy(false))
    },
    notNow: () => setDeclined(wait),
  }
}
