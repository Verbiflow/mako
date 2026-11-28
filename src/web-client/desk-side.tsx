import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react"
import { DeskSideLeaving } from "./desk-side-leaving"
import { useSideSlide } from "@/components/shell/side-slide"
import { activeAcp, useAcp } from "@/state/acp-state"
import { useAgentsOpen } from "./agents-open"
import { useFilesOpen } from "./files-open"
import { useReviewOpen } from "./review-open"
import { useSetupOpen } from "./setup-open"

/**
 * The right rail of a laptop's browser: the one place Changes, Files, Agents and Setup take turns in, beside the
 * Thread's pane, sliding in and out as the desktop's right sidebar does (`side-slide.ts`). The four layers stay mounted
 * in it, closed or not, as they keep their own addresses and followers; while it leaves, the one that was showing
 * keeps drawing what it showed (`useDeskSideLeaving`) until it's out of sight.
 */
export function DeskSide({ place, pane, children }: { place: string | undefined; pane: () => HTMLElement | null; children: ReactNode }) {
  const onScreen = useAcp((state) => Boolean(activeAcp(state)?.key))
  const review = useReviewOpen((state) => state.open !== null)
  const files = useFilesOpen((state) => state.open !== null)
  const agents = useAgentsOpen((state) => state.open)
  const setup = useSetupOpen((state) => state.open)
  const open = review || files || ((agents || setup) && onScreen)
  const side = useRef<HTMLDivElement>(null)
  // Laid over the pane to leave, it keeps the width the row gave it, which only the row knows.
  const width = useRef(0)
  useEffect(() => {
    const element = side.current
    if (!element) return
    const observer = new ResizeObserver(() => {
      if (!element.hasAttribute("data-leaving") && element.offsetWidth) width.current = element.offsetWidth
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  // Declared before the slide, so it runs first: the width is set before the slide reads how far it goes.
  useLayoutEffect(() => {
    const element = side.current
    if (element) element.style.width = element.hasAttribute("data-leaving") && width.current ? `${width.current}px` : ""
  })
  const slide = useSideSlide({ open, side: "right", panel: side, pane, context: place })
  return (
    <div ref={side} className="desk-side" data-open={open || undefined} data-leaving={slide.leaving || undefined}>
      <DeskSideLeaving value={slide.leaving}>{children}</DeskSideLeaving>
    </div>
  )
}
