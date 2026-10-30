import { SLOP_PX } from "./motion"

/** What a tap presses: the transcript's folds, steps, approval answers and links. Fields keep the browser's own taps. */
const PRESSABLE = "button, summary, a[href], label, [role=button], [role=tab], [role=menuitem], [role=option], [role=switch], [role=checkbox]"
/** Held longer than this, it's a press and hold (text selection, the system's menu), not a tap. */
const TAP_MS = 650
/** A touch this soon after the scroller moved catches a glide: it stops the scroll and presses nothing, as on iOS. */
const GLIDE_CATCH_MS = 120

/**
 * Taps in the open conversation land as the finger lifts, on what was under it. Safari drops the click of a tap when
 * the page changes under the finger between touch-down and lift, and a conversation at work redraws many times a
 * second: an approval's Allow or a fold's chevron could take two or three tries. Here the lift is the click (the
 * browser's own is cancelled), on the element touched, or on the one now drawn in its place under the finger.
 *
 * Only within `scope` (the transcript and its approvals), and never in fields or the composer's dock, whose press and
 * hold (dictation) is its own. Returns how to stop.
 */
export function tapOnLift(root: HTMLElement, scope: (element: Element) => boolean): () => void {
  let touch: { x: number; y: number; at: number; target: HTMLElement } | undefined
  let scrolledAt = 0
  const pressable = (element: Element | null): HTMLElement | undefined => {
    const found = element?.closest<HTMLElement>(PRESSABLE)
    if (!found || !root.contains(found) || !scope(found)) return undefined
    if (found.matches(":disabled, [aria-disabled=true]") || found.closest("input, textarea, select, [contenteditable=true]")) return undefined
    return found
  }
  const start = (event: TouchEvent) => {
    const finger = event.touches[0]
    touch = undefined
    if (event.touches.length !== 1 || !finger || performance.now() - scrolledAt < GLIDE_CATCH_MS) return
    const target = pressable(event.target instanceof Element ? event.target : null)
    if (target) touch = { x: finger.clientX, y: finger.clientY, at: performance.now(), target }
  }
  const move = (event: TouchEvent) => {
    const finger = event.touches[0]
    if (touch && finger && Math.hypot(finger.clientX - touch.x, finger.clientY - touch.y) > SLOP_PX) touch = undefined
  }
  const end = (event: TouchEvent) => {
    const held = touch
    touch = undefined
    const finger = event.changedTouches[0]
    if (!held || !finger || performance.now() - held.at > TAP_MS) return
    const target = held.target.isConnected ? held.target : pressable(document.elementFromPoint(finger.clientX, finger.clientY))
    if (!target) return
    // The lift is the click: the browser's own, which a redraw may have lost, isn't sent at all.
    if (event.cancelable) event.preventDefault()
    target.click()
  }
  const cancel = () => {
    touch = undefined
  }
  const scrolled = () => {
    scrolledAt = performance.now()
  }
  root.addEventListener("touchstart", start, { capture: true, passive: true })
  root.addEventListener("touchmove", move, { capture: true, passive: true })
  root.addEventListener("touchend", end, { capture: true, passive: false })
  root.addEventListener("touchcancel", cancel, { capture: true })
  root.addEventListener("scroll", scrolled, { capture: true, passive: true })
  return () => {
    root.removeEventListener("touchstart", start, { capture: true })
    root.removeEventListener("touchmove", move, { capture: true })
    root.removeEventListener("touchend", end, { capture: true })
    root.removeEventListener("touchcancel", cancel, { capture: true })
    root.removeEventListener("scroll", scrolled, { capture: true })
  }
}
