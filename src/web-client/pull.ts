import { useEffect, useRef, useState, type RefObject } from "react"
import { catchElement, rubberband, SETTLE, springTo } from "./motion"

/** Pulled this far, a release refreshes. */
export const PULL_THRESHOLD = 64
/** Where the content rests while it refreshes: the spinner's room. */
const HOLD = 48

/**
 * Pull to refresh at the top of a list: the content follows the finger with growing resistance, the shared Spinner
 * turning with the distance; let go past the threshold and it holds while `refresh` runs, then springs home. The list
 * is live without it; it's the gesture people reach for when unsure, and it re-reads the list at once.
 */
export function usePullToRefresh(scroller: RefObject<HTMLElement | null>, content: RefObject<HTMLElement | null>, refresh: () => Promise<void>) {
  const [pulled, setPulled] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const busy = useRef(false)
  const run = useRef(refresh)
  useEffect(() => {
    run.current = refresh
  }, [refresh])
  useEffect(() => {
    const list = scroller.current
    const moved = content.current
    if (!list || !moved) return
    let start: number | undefined
    let distance = 0
    const touchStart = (event: TouchEvent) => {
      if (busy.current || event.touches.length !== 1 || list.scrollTop > 0) return
      start = event.touches[0]!.clientY
      catchElement(moved)
    }
    const touchMove = (event: TouchEvent) => {
      if (start === undefined) return
      const delta = event.touches[0]!.clientY - start
      if (delta <= 0 || list.scrollTop > 0) {
        if (distance > 0) {
          distance = 0
          moved.style.transform = ""
          setPulled(0)
        }
        return
      }
      if (event.cancelable) event.preventDefault()
      distance = rubberband(delta, list.clientHeight, 0.5)
      moved.style.transform = `translate3d(0, ${distance}px, 0)`
      setPulled(distance)
    }
    const touchEnd = () => {
      if (start === undefined) return
      start = undefined
      const at = distance
      distance = 0
      if (at < PULL_THRESHOLD) {
        void springTo(moved, "y", 0, { from: at, spring: SETTLE }).then(() => setPulled(0))
        return
      }
      busy.current = true
      setRefreshing(true)
      void springTo(moved, "y", HOLD, { from: at, spring: SETTLE })
      void run
        .current()
        .catch(() => undefined)
        .then(() => springTo(moved, "y", 0, { spring: SETTLE }))
        .then(() => {
          busy.current = false
          setRefreshing(false)
          setPulled(0)
        })
    }
    list.addEventListener("touchstart", touchStart, { passive: true })
    list.addEventListener("touchmove", touchMove, { passive: false })
    list.addEventListener("touchend", touchEnd)
    list.addEventListener("touchcancel", touchEnd)
    return () => {
      list.removeEventListener("touchstart", touchStart)
      list.removeEventListener("touchmove", touchMove)
      list.removeEventListener("touchend", touchEnd)
      list.removeEventListener("touchcancel", touchEnd)
    }
  }, [scroller, content])
  return { pulled, refreshing }
}

