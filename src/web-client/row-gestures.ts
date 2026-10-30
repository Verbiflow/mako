import { useEffect, useRef, type RefObject } from "react"
import { catchElement, EASE_SWIFT, reducedMotion, ROW, rubberband, SLOP_PX, springTo, Velocity } from "./motion"

/** The width of a row's swipe action, Archive. */
export const ACTION_PX = 88
/** Let go past this share of the action's width, the row stays open on it. */
const OPEN_SHARE = 0.42
/** A full swipe goes this far past the action, or past this share of the row, whichever is further. */
const COMMIT_PAST_PX = 44
const COMMIT_SHARE = 0.58
/** A flick, in px/ms: a release this fast goes the way it was thrown. */
const FLICK = 0.5
/** Held this long without moving, a row offers its menu. */
const HOLD_MS = 500
/** Longer than this, a touch that never moved is a hold that was let go, not a tap. */
const TAP_MS = 650
/** A row archived slides out in this long, then the rows under it close the gap in this long. */
const OUT_MS = 220
const COLLAPSE_MS = 180

/** How far a row must be pulled to archive it on release: past its action and well across the row. */
export function commitDistance(width: number, actions = ACTION_PX): number {
  return Math.max(actions + COMMIT_PAST_PX, width * COMMIT_SHARE)
}

/** Where a row let go mid-swipe goes: shut, open on its action, or all the way (archived). */
export type Release = "close" | "open" | "commit"

/**
 * Where a swiped row goes as the finger lifts, from how far it's pulled (`offset`, negative to the left) and how fast
 * it was moving (`velocity`, px/ms). Past the full swipe it's archived; thrown left once its action is out, too. A
 * flick right shuts it, a flick left opens it; otherwise it opens once its action is 42% out.
 */
export function swipeRelease({ offset, velocity, width, actions = ACTION_PX }: { offset: number; velocity: number; width: number; actions?: number }): Release {
  const pulled = Math.max(0, -offset)
  if (pulled >= commitDistance(width, actions)) return "commit"
  if (velocity < -FLICK && pulled > actions) return "commit"
  if (velocity > FLICK) return "close"
  if (velocity < -FLICK) return "open"
  return pulled >= actions * OPEN_SHARE ? "open" : "close"
}

/** The row now open on its action, if any: one at a time, and a touch anywhere else in the list shuts it. */
let openRow: { row: HTMLElement; close: () => void } | undefined

export interface RowGestureHandlers {
  /** A tap: the finger lifted where it came down, soon. */
  onTap(): void
  /** Held still for half a second: the row's menu. */
  onHold(): void
  /** Swiped all the way, or its action tapped: called once the row has slid out and closed its gap. */
  onArchive(): void
}

/**
 * A list row under a finger: a tap opens it as the finger lifts, a hold offers its menu, and a swipe left reveals
 * Archive, following the finger with resistance past the row's edge. Let go, it springs open on the action or shut
 * (`ROW`: stiffness 330, damping 26, mass 0.7) at the finger's speed, or past the full swipe slides out in 220 ms and
 * closes its gap in 180 ms before it's archived. A drag that's mostly vertical is the list's scroll, and is left to it.
 *
 * `container` holds the action behind `row`, which moves. Without `swipe` only taps and holds are read.
 */
export function useRowGestures(container: RefObject<HTMLElement | null>, row: RefObject<HTMLElement | null>, swipe: boolean, handlers: RowGestureHandlers): void {
  const latest = useRef(handlers)
  useEffect(() => {
    latest.current = handlers
  })
  useEffect(() => {
    const box = container.current
    const front = row.current
    if (!box || !front) return
    let touch: { x: number; y: number; at: number; from: number } | undefined
    let mode: "undecided" | "swipe" | "scroll" = "undecided"
    let held = false
    let holdTimer: ReturnType<typeof setTimeout> | undefined
    let leaving = false
    const velocity = new Velocity()
    const width = () => box.clientWidth
    const show = (offset: number) => {
      box.toggleAttribute("data-swiping", offset < 0)
      box.toggleAttribute("data-armed", -offset >= commitDistance(width()))
      box.style.setProperty("--pulled", `${Math.max(0, -offset)}px`)
    }
    const follow = (offset: number) => {
      const edge = -width()
      const x = offset > 0 ? rubberband(offset, width()) * 0.4 : offset < edge ? edge + rubberband(offset - edge, width()) : offset
      front.style.transform = `translate3d(${x}px, 0, 0)`
      show(x)
      velocity.add(x)
    }
    const settle = (to: number, speed = 0) => {
      show(to)
      if (to === 0) {
        box.toggleAttribute("data-swiping", true)
        if (openRow?.row === front) openRow = undefined
      } else openRow = { row: front, close: () => settle(0) }
      void springTo(front, "x", to, { velocity: speed, spring: ROW }).then(() => {
        if (to === 0) box.removeAttribute("data-swiping")
      })
    }
    const archive = async () => {
      if (leaving) return
      leaving = true
      if (openRow?.row === front) openRow = undefined
      const from = catchElement(front).x
      show(-width())
      if (!reducedMotion()) {
        await front.animate([{ transform: `translate3d(${from}px, 0, 0)` }, { transform: `translate3d(${-width()}px, 0, 0)` }], { duration: OUT_MS, easing: EASE_SWIFT, fill: "forwards" }).finished
        await box.animate([{ height: `${box.offsetHeight}px` }, { height: "0px" }], { duration: COLLAPSE_MS, easing: EASE_SWIFT, fill: "forwards" }).finished
      }
      latest.current.onArchive()
    }
    const stopHold = () => {
      clearTimeout(holdTimer)
      holdTimer = undefined
      box.removeAttribute("data-held")
    }
    const start = (event: TouchEvent) => {
      const finger = event.touches[0]
      if (leaving || event.touches.length !== 1 || !finger) return
      if (event.target instanceof Element && event.target.closest("[data-swipe-action]")) return
      touch = { x: finger.clientX, y: finger.clientY, at: performance.now(), from: catchElement(front).x }
      mode = "undecided"
      held = false
      velocity.add(touch.from)
      // Another row left open shuts as this one is touched; touching this one while open only shuts it.
      if (openRow && openRow.row !== front) openRow.close()
      if (touch.from !== 0) return
      box.setAttribute("data-held", "")
      holdTimer = setTimeout(() => {
        held = true
        box.removeAttribute("data-held")
        holdTimer = undefined
        latest.current.onHold()
      }, HOLD_MS)
    }
    const move = (event: TouchEvent) => {
      const finger = event.touches[0]
      if (!touch || !finger || held) return
      const dx = finger.clientX - touch.x
      const dy = finger.clientY - touch.y
      if (mode === "undecided") {
        if (Math.hypot(dx, dy) < SLOP_PX) return
        stopHold()
        // Mostly sideways, to the left (or either way on a row already open), and the row can be swiped: it's a swipe.
        mode = swipe && Math.abs(dx) > Math.abs(dy) && (dx < 0 || touch.from < 0) ? "swipe" : "scroll"
        if (mode === "scroll") return
      }
      if (mode !== "swipe") return
      if (event.cancelable) event.preventDefault()
      follow(touch.from + dx - Math.sign(dx) * SLOP_PX)
    }
    const end = (event: TouchEvent) => {
      const began = touch
      touch = undefined
      stopHold()
      if (!began) return
      if (held) {
        // The menu is up: the lift that ends the hold presses nothing.
        if (event.cancelable) event.preventDefault()
        return
      }
      if (mode === "swipe") {
        const at = catchElement(front).x
        const speed = velocity.get()
        const release = swipeRelease({ offset: at, velocity: speed, width: width() })
        if (release === "commit") void archive()
        else settle(release === "open" ? -ACTION_PX : 0, speed)
        return
      }
      if (mode === "scroll" || performance.now() - began.at > TAP_MS) return
      // A tap: its click is the lift's, so a row redrawn under the finger (a timer, a status) still opens.
      if (event.cancelable) event.preventDefault()
      if (began.from !== 0) settle(0)
      else latest.current.onTap()
    }
    const cancel = () => {
      stopHold()
      if (mode === "swipe" && touch) settle(0)
      touch = undefined
    }
    const menu = (event: Event) => {
      event.preventDefault()
      stopHold()
      latest.current.onHold()
    }
    const action = (event: Event) => {
      if (event.target instanceof Element && event.target.closest("[data-swipe-action]")) void archive()
    }
    box.addEventListener("touchstart", start, { passive: true })
    box.addEventListener("touchmove", move, { passive: false })
    box.addEventListener("touchend", end, { passive: false })
    box.addEventListener("touchcancel", cancel)
    box.addEventListener("contextmenu", menu)
    box.addEventListener("click", action)
    return () => {
      stopHold()
      if (openRow?.row === front) openRow = undefined
      box.removeEventListener("touchstart", start)
      box.removeEventListener("touchmove", move)
      box.removeEventListener("touchend", end)
      box.removeEventListener("touchcancel", cancel)
      box.removeEventListener("contextmenu", menu)
      box.removeEventListener("click", action)
    }
  }, [container, row, swipe])
}
