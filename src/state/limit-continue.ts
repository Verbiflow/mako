import { useEffect, useState } from "react"
import { activeLiveAcp, useAcp } from "@/state/acp"
import { continueNext, nextPlace } from "@/state/fin-asks"
import { shallowEqual } from "@/state/store"
import { usageLimitWait } from "@/state/usage-limit-wait"

/** A reset wait, with at most one opt-in alternative verified by the host. */
export interface LimitContinue {
  harness: string
  at: number
  resets: boolean
  to?: string
  busy: boolean
  go(): void
}

/** The queue owns recovery; this line says when and offers moving only when the host finds a next place. */
export function useLimitContinue(): LimitContinue | null {
  const held = useAcp(state => {
    const live = activeLiveAcp(state)
    const wait = live && !live.copy ? usageLimitWait(live.requests ?? []) : undefined
    return live && wait ? { key: live.key, harness: live.harness, ...wait } : null
  }, shallowEqual)
  const key = held?.key, harness = held?.harness
  const wait = held ? `${held.request.id}:${held.at}` : undefined
  const [place, setPlace] = useState<{ key: string; wait: string; to: string }>()
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!key || wait === undefined) return
    let current = true
    void nextPlace(key).then(next => {
      if (current) setPlace(next ? { key, wait, to: next.label } : undefined)
    })
    return () => { current = false }
  }, [key, harness, wait])
  if (!held) return null
  return {
    harness: held.harness, at: held.at, resets: held.resets,
    ...(place?.key === held.key && place.wait === wait && { to: place.to }),
    busy,
    go: () => { setBusy(true); void continueNext(held.key).finally(() => setBusy(false)) },
  }
}
