import { useCallback, useState, useSyncExternalStore } from "react"
import { acpStore } from "@/state/acp-state"
import { scopedAcp, type ConversationScope } from "@/state/conversation-scope"
import type { LiveProjection } from "@/state/live-projection"
import { ExchangePacer } from "@/lib/stream-pace"

const browserClock = {
  now: () => performance.now(),
  schedule: (run: () => void, ms: number) => {
    const timer = setTimeout(run, ms)
    return () => clearTimeout(timer)
  },
}

/**
 * The scoped conversation's turns as the transcript draws them: the store's, except that an answer growing is drawn at
 * its pace (`ExchangePacer`, `answerPaceMs`), not at every batch the host sends.
 */
export function usePacedProjection(scope: ConversationScope | null): LiveProjection | undefined {
  const [pacer] = useState(() => new ExchangePacer<LiveProjection>(browserClock))
  const read = useCallback(() => scopedAcp(acpStore.get(), scope)?.projection, [scope])
  const subscribe = useCallback((notify: () => void) => {
    const stop = acpStore.subscribe(() => pacer.take(read(), notify))
    return () => {
      stop()
      pacer.stop()
    }
  }, [pacer, read])
  return useSyncExternalStore(subscribe, () => pacer.shown(read()))
}
