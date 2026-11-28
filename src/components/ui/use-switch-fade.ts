import { useLayoutEffect, useRef, type RefObject } from "react"
import { EASE_OUT, motionMs, reducedMotion } from "@/lib/motion"

/**
 * One view of a place giving way to another (a sidebar's tab, the Thread in a tablet's pane): when `view` changes,
 * the element fades up from nothing over `--duration-switch`. Opacity only, so nothing moves and nothing lays out;
 * never on the first paint, nor when the place itself comes or goes (`view` undefined), nor under reduced motion.
 */
export function useSwitchFade(element: RefObject<HTMLElement | null>, view: string | undefined): void {
  const shown = useRef(view)
  useLayoutEffect(() => {
    const was = shown.current
    if (was === view) return
    shown.current = view
    // Coming or going whole (a sidebar opening) is another motion's to draw.
    if (was === undefined || view === undefined) return
    const node = element.current
    if (!node || reducedMotion()) return
    node.animate([{ opacity: 0 }, { opacity: 1 }], { duration: motionMs("switch"), easing: EASE_OUT })
  }, [element, view])
}
