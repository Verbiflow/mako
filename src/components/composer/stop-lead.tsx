import { useCallback, useState, type ReactNode } from "react"
import { StopLeadCard } from "@/components/composer/stop-lead-card"
import { acp, acpStore, useAcp } from "@/state/acp"
import { stopCounts, stoppableChildren, threadChildren } from "@/state/lead-children"

/**
 * Stop in a lead's composer. While any of its Threads works, Stop asks first,
 * in a small card on the button: stop the lead alone (the default, focused),
 * or it and every Thread still going. With nothing under it at work, Stop
 * stops at once, as anywhere else. The composer reads its children only when
 * Stop is pressed; the open card follows them live.
 */
interface LeadStop {
  /** What the composer's Stop does: asks, puts the card away, or stops. */
  press: () => void
  open: boolean
  /** The card, drawn on the Stop button's wrapper. */
  popover: ReactNode
}

export function useLeadStop({ conversationKey, onStopLead, phone }: { conversationKey: string | undefined; onStopLead: () => void; phone?: boolean }): LeadStop {
  const thread = useAcp((state) => (conversationKey ? state.conversations[conversationKey]?.threadId : undefined))
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  const press = () => {
    if (open) close()
    else if (stopCounts(threadChildren(acpStore.get(), thread)).working > 0) setOpen(true)
    else onStopLead()
  }
  const stopLead = () => {
    close()
    onStopLead()
  }
  const stopAll = () => {
    close()
    onStopLead()
    const key = conversationKey
    if (!key) return
    const children = stoppableChildren(threadChildren(acpStore.get(), thread))
    for (const child of children) void acp.stopAgent(key, child.nativeId)
  }
  return {
    press,
    open,
    popover: open ? <StopLeadCard thread={thread} phone={phone} onLead={stopLead} onAll={stopAll} onClose={close} /> : null,
  }
}
