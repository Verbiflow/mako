import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { SquareIcon } from "lucide-react"
import { ROLE_WORD } from "@mako/host/contracts/agents"
import { Action } from "@/components/ui/kit"
import { LeadMark } from "@/components/ui/lead-mark"
import { cn } from "@/lib/utils"
import { useAcp } from "@/state/acp"
import { stopCounts, threadChildren } from "@/state/lead-children"
import { shallowEqual } from "@/state/store"

/** The phone card's margin each side: `w-[calc(100vw-24px)]`. */
const PHONE_MARGIN = 12

/**
 * What Stop in a lead's composer asks while any of its Threads works, on the
 * button (`useLeadStop`): stop the lead alone, focused, or it and every Thread
 * a stop reaches. No scrim; Escape or a press outside puts it away.
 */
export function StopLeadCard({ thread, phone, onLead, onAll, onClose }: { thread: string | undefined; phone?: boolean; onLead: () => void; onAll: () => void; onClose: () => void }) {
  const { working, reached } = useAcp((state) => stopCounts(threadChildren(state, thread)), shallowEqual)
  const others = reached - working
  const card = useRef<HTMLDivElement>(null)
  // The last working one finished while the card was up: nothing is left to ask about.
  useEffect(() => {
    if (working === 0) onClose()
  }, [working, onClose])
  // On the phone the card spans the screen less its margins, wherever the button sits; the caret stays on the button.
  const [span, setSpan] = useState<{ right: number; caret: number }>()
  useLayoutEffect(() => {
    const button = card.current?.parentElement?.getBoundingClientRect()
    if (!phone || !button) return
    const right = button.right - (window.innerWidth - PHONE_MARGIN)
    setSpan({ right, caret: button.width / 2 - 4 - right })
  }, [phone])
  useEffect(() => {
    const away = (event: PointerEvent) => {
      const target = event.target
      // The Stop button under the card toggles it itself.
      if (!(target instanceof Node) || card.current?.parentElement?.contains(target)) return
      onClose()
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation()
        onClose()
      }
    }
    document.addEventListener("pointerdown", away, true)
    document.addEventListener("keydown", escape, true)
    return () => {
      document.removeEventListener("pointerdown", away, true)
      document.removeEventListener("keydown", escape, true)
    }
  }, [onClose])
  const words = `${working} of its Threads ${working === 1 ? "is" : "are"} working${others ? `, ${others} more waiting` : ""}`
  return (
    <div
      ref={card}
      role="dialog"
      aria-label={`Stop the ${ROLE_WORD}`}
      data-stop-lead
      className={cn(
        "card-floating absolute z-30 flex max-h-[120px] flex-col gap-1.5 p-1.5",
        phone ? "bottom-[calc(100%+8px)] w-[calc(100vw-24px)]" : "right-0 bottom-[calc(100%+6px)] w-[300px] max-w-[320px]"
      )}
      style={phone ? { right: span?.right ?? 0 } : undefined}
    >
      <div className="flex items-center gap-1.5 px-1.5 pt-1 text-label text-faint">
        <LeadMark className="size-3" />
        <span className="truncate">{words}</span>
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        <Action size={phone ? "md" : "sm"} tone="outline" autoFocus onClick={onLead} className={phone ? "h-10" : undefined}>
          Stop the {ROLE_WORD} only
        </Action>
        <Action size={phone ? "md" : "sm"} tone="danger" onClick={onAll} className={phone ? "h-10" : undefined}>
          <SquareIcon className="size-2.5 fill-current" strokeWidth={0} />
          Stop all {working + others + 1}
        </Action>
      </div>
      <span aria-hidden className={cn("absolute -bottom-1 size-2 rotate-45 bg-[var(--popover)]", !phone && "right-3")} style={phone ? { right: span?.caret ?? 18 } : undefined} />
    </div>
  )
}
