import { useCallback, useState, type ReactNode } from "react"
import { StopApexCard } from "@/components/composer/stop-apex-card"
import { acp, acpStore, useAcp } from "@/state/acp"
import { stopCounts, stoppableChildren, threadChildren } from "@/state/apex-fins"

/**
 * Stop in an Apex's composer. While any of its Fins works, Stop asks first,
 * in a small card on the button: stop the Apex alone (the default, focused),
 * or it and every Fin still going. With no Fin at work, Stop
 * stops at once, as anywhere else. The composer reads its Fins only when
 * Stop is pressed; the open card follows them live.
 */
interface ApexStop {
  /** What the composer's Stop does: asks, puts the card away, or stops. */
  press: () => void
  open: boolean
  /** The card, drawn on the Stop button's wrapper. */
  popover: ReactNode
}

export function useApexStop({ conversationKey, onStopApex, phone }: { conversationKey: string | undefined; onStopApex: () => void; phone?: boolean }): ApexStop {
  const thread = useAcp((state) => (conversationKey ? state.conversations[conversationKey]?.threadId : undefined))
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  const press = () => {
    if (open) close()
    else if (stopCounts(threadChildren(acpStore.get(), thread)).working > 0) setOpen(true)
    else onStopApex()
  }
  const stopApex = () => {
    close()
    onStopApex()
  }
  const stopAll = () => {
    close()
    onStopApex()
    const key = conversationKey
    if (!key) return
    const children = stoppableChildren(threadChildren(acpStore.get(), thread))
    for (const child of children) void acp.stopAgent(key, child.nativeId)
  }
  return {
    press,
    open,
    popover: open ? <StopApexCard thread={thread} phone={phone} onApex={stopApex} onAll={stopAll} onClose={close} /> : null,
  }
}
