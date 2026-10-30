import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { browserDrewBack } from "./back"
import { catchElement, reducedMotion, rubberband, settle, SETTLE, SLOP_PX, springTo, Velocity } from "./motion"

/** Where an edge swipe may start: the screen's left edge, as on an iPhone. */
const EDGE_PX = 24
/** How far the screen under moves while the one on top slides: a quarter of its width, so it reads as behind. */
const UNDER_SHIFT = 0.25
const FLICK = 0.5

/** What moves with the screen on top: the list behind it, a quarter of its travel, and the shade over the list. */
function behind(list: HTMLElement | null, dim: HTMLElement | null): Array<{ element: HTMLElement; frame: (progress: number) => Keyframe }> {
  const width = innerWidth
  return [
    ...(list ? [{ element: list, frame: (progress: number): Keyframe => ({ transform: `translate3d(${-width * UNDER_SHIFT * progress}px, 0, 0)` }) }] : []),
    ...(dim ? [{ element: dim, frame: (progress: number): Keyframe => ({ opacity: String(progress) }) }] : []),
  ]
}

/**
 * A phone's screens: the list under, and what's open on top of it, sliding in from the right and back out the way it
 * came, the list drifting a quarter behind and dimming. The list stays mounted under, where it was scrolled. The screen
 * on top follows a finger from the left edge, and Back is its release past a third or a flick; let go short of that,
 * it springs back. A screen swapped for another (a notification opening another Thread) changes without a slide.
 */
export function ScreenStack({ under, top, topKey, onBack }: { under: ReactNode; top: ReactNode | null; topKey: string | undefined; onBack: () => void }) {
  const [shown, setShown] = useState<{ node: ReactNode; key: string } | null>(top && topKey ? { node: top, key: topKey } : null)
  const [leaving, setLeaving] = useState(false)
  const topLayer = useRef<HTMLDivElement>(null)
  const underLayer = useRef<HTMLDivElement>(null)
  const shade = useRef<HTMLDivElement>(null)
  const swiped = useRef(false)
  /** Opened with the app (a reload, a notification's link): already there, nothing slides. */
  const arrivedWithApp = useRef(top !== null)

  // Pushed, swapped or popped: what's on top follows the route, and a pop keeps drawing the last screen as it leaves.
  // A screen comes on top or is swapped by its key; while it's there, it draws as the route renders it now, and the
  // last of it is kept only to draw as it leaves.
  if (top && topKey && shown?.key !== topKey) setShown({ node: top, key: topKey })
  if (!top && shown && !leaving) setLeaving(true)
  if (top && leaving) setLeaving(false)

  const companions = () => behind(underLayer.current, shade.current)
  const empty = shown === null

  useLayoutEffect(() => {
    const screen = topLayer.current
    if (!screen) return
    const opening = arrivedWithApp.current
    arrivedWithApp.current = false
    if (leaving) {
      if (swiped.current || browserDrewBack() || reducedMotion()) {
        swiped.current = false
        setShown(null)
        setLeaving(false)
        for (const { element } of companions()) element.removeAttribute("style")
        return
      }
      const width = innerWidth
      const from = catchElement(screen).x
      // Out the way it came: the list comes back from behind as the screen goes.
      void springTo(screen, "x", width, { from, spring: SETTLE, also: companions().map((each) => ({ element: each.element, frame: (progress: number) => each.frame(1 - (from + (width - from) * progress) / width) })) }).then(() => {
        setShown(null)
        setLeaving(false)
        for (const { element } of companions()) element.removeAttribute("style")
      })
      return
    }
    if (opening || reducedMotion()) {
      for (const each of companions()) settle(each.element, each.frame(1))
      return
    }
    screen.style.transform = `translate3d(${innerWidth}px, 0, 0)`
    void springTo(screen, "x", 0, { spring: SETTLE, also: companions() })
    // Runs when a screen comes on top or starts leaving; a swap of one screen for another keeps both as they are.
  }, [leaving, empty])

  const back = useRef(onBack)
  useEffect(() => {
    back.current = onBack
  }, [onBack])
  const shownKey = shown?.key
  // The edge swipe, by touch: Back by the finger. Held across the route's renders, so a swipe never loses its finger.
  useEffect(() => {
    const screen = topLayer.current
    if (!screen || shownKey === undefined || leaving) return
    let start: { x: number; y: number; from: number } | undefined
    let dragging = false
    const velocity = new Velocity()
    const width = () => innerWidth
    const follow = (offset: number) => {
      const x = offset < 0 ? rubberband(offset, width()) : offset
      screen.style.transform = `translate3d(${x}px, 0, 0)`
      for (const each of companions()) settle(each.element, each.frame(1 - Math.max(0, x) / width()))
      velocity.add(x)
    }
    const touchStart = (event: TouchEvent) => {
      const touch = event.touches[0]
      if (event.touches.length !== 1 || !touch || touch.clientX > EDGE_PX) return
      start = { x: touch.clientX, y: touch.clientY, from: catchElement(screen).x }
      velocity.add(start.from)
    }
    const touchMove = (event: TouchEvent) => {
      const touch = event.touches[0]
      if (!start || !touch) return
      const dx = touch.clientX - start.x
      const dy = touch.clientY - start.y
      if (!dragging) {
        if (Math.hypot(dx, dy) < SLOP_PX) return
        // Mostly sideways and to the right, or it's the page's own scroll.
        if (dx <= 0 || Math.abs(dy) > Math.abs(dx)) {
          start = undefined
          return
        }
        dragging = true
      }
      if (event.cancelable) event.preventDefault()
      follow(start.from + dx - SLOP_PX)
    }
    const touchEnd = () => {
      if (!start) return
      start = undefined
      if (!dragging) return
      dragging = false
      const at = catchElement(screen).x
      const speed = velocity.get()
      if (speed > FLICK || (at > width() / 3 && speed > -FLICK)) {
        swiped.current = true
        void springTo(screen, "x", width(), { velocity: speed, spring: SETTLE, also: companions().map((each) => ({ element: each.element, frame: (progress: number) => each.frame(1 - (at + (width() - at) * progress) / width()) })) }).then(() => back.current())
        return
      }
      void springTo(screen, "x", 0, { velocity: speed, spring: SETTLE, also: companions().map((each) => ({ element: each.element, frame: (progress: number) => each.frame(1 - (at / width()) * (1 - progress)) })) })
    }
    screen.addEventListener("touchstart", touchStart, { passive: true })
    screen.addEventListener("touchmove", touchMove, { passive: false })
    screen.addEventListener("touchend", touchEnd)
    screen.addEventListener("touchcancel", touchEnd)
    return () => {
      screen.removeEventListener("touchstart", touchStart)
      screen.removeEventListener("touchmove", touchMove)
      screen.removeEventListener("touchend", touchEnd)
      screen.removeEventListener("touchcancel", touchEnd)
    }
  }, [shownKey, leaving])

  const covered = shown !== null && !leaving
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
      <div ref={underLayer} className="web-screen" inert={covered} aria-hidden={covered || undefined}>
        {under}
      </div>
      {shown ? (
        <>
          <div ref={shade} className="web-screen-shade" aria-hidden />
          <div ref={topLayer} key={shown.key} className="web-screen web-screen-top">
            {top ?? shown.node}
          </div>
        </>
      ) : null}
    </div>
  )
}
