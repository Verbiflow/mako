import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { cn } from "@/lib/utils"
import { catchElement, EASE_OUT, EASE_SWIFT, reducedMotion, rubberband, SETTLE, SLOP_PX, springTo, THROWN, Velocity } from "./motion"
import { useWide } from "./route"

/** The sheets open now, the newest last: Escape and Back close only the one on top. */
const stacked = new Set<object>()

/** A release faster than this, downwards, dismisses whatever the distance (px/ms). */
const FLICK = 0.5
/** A release past this share of the sheet's height dismisses it. */
const PAST = 1 / 3
/** An expandable sheet opens showing this share of its full height, and is pulled up to all of it. */
const MEDIUM = 0.55
/** A popover keeps this far from its chip and from the window's edges. */
const GAP_PX = 6
const EDGE_PX = 12
/**
 * What an opening sheet focuses, so keys never reach what's behind it: its first field or button. A search isn't one: on a
 * phone it would raise the keyboard over the choices it filters before anyone asked to type.
 */
const FIRST_FOCUS = "textarea:not([disabled]), input:not([disabled]):not([type='search']), button:not([disabled])"

/**
 * How a sheet is drawn: from the bottom on a phone; wide, as the desk draws a choice, a popover under (or over) the chip
 * that opened it, or a dialog in the middle when nothing did.
 */
type Form = "sheet" | "pop" | "dialog"

/** Where a popover goes: under its chip when there's room, else over it; never past the window's edges. */
function place(panel: HTMLElement, anchor: HTMLElement): void {
  const chip = anchor.getBoundingClientRect()
  const width = panel.offsetWidth
  const below = innerHeight - chip.bottom - GAP_PX - EDGE_PX
  const above = chip.top - GAP_PX - EDGE_PX
  const under = below >= Math.min(panel.scrollHeight, 360) || below >= above
  const left = Math.max(EDGE_PX, Math.min(chip.left, innerWidth - width - EDGE_PX))
  Object.assign(panel.style, {
    left: `${left}px`,
    top: under ? `${chip.bottom + GAP_PX}px` : "auto",
    bottom: under ? "auto" : `${innerHeight - chip.top + GAP_PX}px`,
    maxHeight: `${Math.max(160, under ? below : above)}px`,
    transformOrigin: `${chip.left + chip.width / 2 - left}px ${under ? "0" : "100%"}`,
  })
}

/**
 * A sheet from the bottom of the screen, as a phone draws its choices: it rises from below, follows the finger 1:1 when
 * dragged down (from its handle, or from its content scrolled to the top), resists being pulled up, and on release
 * closes if it was flicked down or pulled past a third, else springs back at the finger's speed. Tapping outside, Back
 * and Escape close it too. It can be caught mid-flight. `open` is the parent's; `onDismiss` asks it to close, and the
 * sheet leaves on its own path before it unmounts.
 *
 * Wide, the same choices are the desk's: a popover grown from `anchor` (the chip that opened it), or without one a
 * dialog in the middle, each in under 200 ms and gone faster.
 *
 * `expandable`: a sheet the full height of the screen that opens at a little over half of it, its top lower down; pulled
 * up, from its handle or its content, it rises to all of it, and it rests at whichever of the two is nearer, or the one
 * it was flicked towards. Pulled down from half, it closes as any sheet does.
 */
export function Sheet({ open, onDismiss, label, children, className, tall, anchor, expandable = false }: { open: boolean; onDismiss: () => void; label: string; children: ReactNode; className?: string; tall?: boolean; anchor?: HTMLElement | null; expandable?: boolean }) {
  const wide = useWide()
  const form: Form = !wide ? "sheet" : anchor ? "pop" : "dialog"
  const [mounted, setMounted] = useState(open)
  const panel = useRef<HTMLDivElement>(null)
  const backdrop = useRef<HTMLDivElement>(null)
  const release = useRef(0)
  const opener = useRef<Element | null>(null)
  if (open && !mounted) setMounted(true)

  // In: from below its own height. Out: to below, at the speed it was let go, then gone.
  useLayoutEffect(() => {
    const sheet = panel.current
    const shade = backdrop.current
    if (!sheet || !shade || !mounted) return
    const height = sheet.getBoundingClientRect().height
    const fade = (progress: number): Keyframe => ({ opacity: String(progress) })
    const done = () => {
      setMounted(false)
      if (opener.current instanceof HTMLElement && document.contains(opener.current)) opener.current.focus({ preventScroll: true })
    }
    if (form !== "sheet") {
      // The desk's: grown from its chip (or the middle) on the arriving curve, gone on the leaving one, faster.
      const lift = form === "pop" && sheet.style.bottom !== "auto" && sheet.style.bottom !== "" ? 4 : -4
      const from = { opacity: 0, transform: reducedMotion() ? "none" : `translate3d(0, ${form === "dialog" ? 8 : lift}px, 0) scale(0.97)` }
      if (open) {
        opener.current = document.activeElement
        if (form === "pop" && anchor) place(sheet, anchor)
        if (!sheet.contains(document.activeElement)) sheet.querySelector<HTMLElement>(FIRST_FOCUS)?.focus({ preventScroll: true })
        sheet.animate([from, { opacity: 1, transform: "none" }], { duration: 180, easing: EASE_OUT })
        shade.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: EASE_OUT, fill: "forwards" })
        return
      }
      shade.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, easing: EASE_SWIFT, fill: "forwards" })
      void sheet.animate([{ opacity: 1, transform: "none" }, from], { duration: 120, easing: EASE_SWIFT, fill: "forwards" }).finished.then(done, done)
      return
    }
    if (open) {
      opener.current = document.activeElement
      // Focus goes into the sheet, so keys never reach what's behind it (a field asks for it first by `autoFocus`).
      if (!sheet.contains(document.activeElement)) sheet.querySelector<HTMLElement>(FIRST_FOCUS)?.focus({ preventScroll: true })
      if (reducedMotion()) {
        if (expandable) sheet.style.transform = `translate3d(0, ${height * (1 - MEDIUM)}px, 0)`
        sheet.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: "ease-out" })
        shade.style.opacity = "1"
        return
      }
      sheet.style.transform = `translate3d(0, ${height}px, 0)`
      void springTo(sheet, "y", expandable ? height * (1 - MEDIUM) : 0, { spring: SETTLE, also: [{ element: shade, frame: fade }] })
      return
    }
    const velocity = release.current
    release.current = 0
    if (reducedMotion()) {
      void sheet.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, easing: "ease-in", fill: "forwards" }).finished.then(done, done)
      return
    }
    const from = catchElement(sheet).y
    void springTo(sheet, "y", height, { from, velocity: Math.max(velocity, 0), spring: velocity > FLICK ? THROWN : SETTLE, also: [{ element: shade, frame: (progress) => fade(1 - progress) }] }).then(done)
  }, [open, mounted, form, anchor, expandable])

  // Escape closes the sheet on top, the one opened last; Back (a route the parent pushed) is the parent's.
  const dismiss = useRef(onDismiss)
  useEffect(() => {
    dismiss.current = onDismiss
  }, [onDismiss])
  useEffect(() => {
    if (!open) return
    const me = {}
    stacked.add(me)
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || [...stacked].at(-1) !== me) return
      event.stopImmediatePropagation()
      dismiss.current()
    }
    addEventListener("keydown", key)
    return () => {
      stacked.delete(me)
      removeEventListener("keydown", key)
    }
  }, [open])

  // The drag: by pointer on the grab area (it never scrolls), by touch on the content when it's at its top. Only a
  // sheet is dragged; the desk's popovers and dialogs aren't.
  useEffect(() => {
    const sheet = panel.current
    if (!sheet || !open || form !== "sheet") return
    let start: { y: number; at: number; from: number; scroller: HTMLElement | null } | undefined
    let dragging = false
    const velocity = new Velocity()
    const height = () => sheet.getBoundingClientRect().height
    /** Where an expandable sheet rests at half; 0 for every other sheet, which rests only at its full height. */
    const medium = () => (expandable ? height() * (1 - MEDIUM) : 0)
    const move = (y: number) => {
      if (!start) return false
      const delta = y - start.y
      if (!dragging) {
        if (Math.abs(delta) < SLOP_PX) return false
        // Up from half, an expandable sheet rises; otherwise up, or a content that can still scroll up, is the
        // content's scroll, not the sheet's drag.
        const rises = delta < 0 && start.from > 1
        if ((delta < 0 && !rises) || (delta > 0 && start.scroller && start.scroller.scrollTop > 0)) {
          start = undefined
          return false
        }
        dragging = true
        sheet.dataset["dragging"] = ""
      }
      const offset = start.from + delta - Math.sign(delta) * SLOP_PX
      sheet.style.transform = `translate3d(0, ${offset < 0 ? rubberband(offset, height()) : offset}px, 0)`
      if (backdrop.current) backdrop.current.style.opacity = String(Math.max(0, 1 - Math.max(offset, 0) / height()))
      velocity.add(offset)
      return true
    }
    const end = () => {
      if (!start) return
      start = undefined
      if (!dragging) return
      dragging = false
      delete sheet.dataset["dragging"]
      const at = catchElement(sheet).y
      const speed = velocity.get()
      const half = medium()
      // Past half (or flicked down from it), it closes; between full and half, it rests at the nearer, or the flicked.
      if ((speed > FLICK && at >= half - 1) || (at > half + (height() - half) * PAST && speed > -FLICK)) {
        release.current = speed
        dismiss.current()
        return
      }
      const rest = half === 0 ? 0 : speed < -FLICK ? 0 : speed > FLICK ? half : at < half / 2 ? 0 : half
      void springTo(sheet, "y", rest, { velocity: speed, spring: SETTLE, also: backdrop.current ? [{ element: backdrop.current, frame: () => ({ opacity: "1" }) }] : [] })
    }
    const begin = (y: number, target: EventTarget | null) => {
      const scroller = target instanceof Element ? target.closest<HTMLElement>("[data-sheet-scroll]") : null
      start = { y, at: performance.now(), from: catchElement(sheet).y, scroller }
      velocity.add(start.from)
    }
    const grab = sheet.querySelector<HTMLElement>("[data-sheet-grab]")
    const pointerDown = (event: PointerEvent) => {
      if (event.pointerType === "mouse" && event.button !== 0) return
      try {
        grab?.setPointerCapture(event.pointerId)
      } catch {
        // A pointer that's already gone: the drag follows its moves on the handle without capturing it.
      }
      begin(event.clientY, null)
    }
    const pointerMove = (event: PointerEvent) => void move(event.clientY)
    grab?.addEventListener("pointerdown", pointerDown)
    grab?.addEventListener("pointermove", pointerMove)
    grab?.addEventListener("pointerup", end)
    grab?.addEventListener("pointercancel", end)
    const touchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1 || (event.target instanceof Element && event.target.closest("[data-sheet-grab]"))) return
      begin(event.touches[0]!.clientY, event.target)
    }
    const touchMove = (event: TouchEvent) => {
      // A second finger mid-drag is ignored: the sheet stays with the first.
      const touch = event.touches[0]
      if (touch && move(touch.clientY) && event.cancelable) event.preventDefault()
    }
    sheet.addEventListener("touchstart", touchStart, { passive: true })
    sheet.addEventListener("touchmove", touchMove, { passive: false })
    sheet.addEventListener("touchend", end)
    sheet.addEventListener("touchcancel", end)
    return () => {
      grab?.removeEventListener("pointerdown", pointerDown)
      grab?.removeEventListener("pointermove", pointerMove)
      grab?.removeEventListener("pointerup", end)
      grab?.removeEventListener("pointercancel", end)
      sheet.removeEventListener("touchstart", touchStart)
      sheet.removeEventListener("touchmove", touchMove)
      sheet.removeEventListener("touchend", end)
      sheet.removeEventListener("touchcancel", end)
    }
    // Held across the parent's renders (a live list re-renders it every few seconds): a drag never loses its finger.
  }, [open, form, expandable])

  if (!mounted) return null
  return createPortal(
    <div className="web-sheet-layer" data-open={open || undefined} data-form={form}>
      <div ref={backdrop} className="web-sheet-backdrop" style={{ opacity: 0 }} onClick={onDismiss} aria-hidden />
      <div ref={panel} role="dialog" aria-modal aria-label={label} data-form={form} className={cn("web-sheet", tall && "web-sheet-tall", expandable && form === "sheet" && "web-sheet-full", className)}>
        {form === "sheet" ? (
          <div data-sheet-grab className="web-sheet-grab" aria-hidden>
            <span />
          </div>
        ) : null}
        {children}
      </div>
    </div>,
    document.querySelector(".web-app") ?? document.body
  )
}

/** A sheet's own scrolling content: dragging down from its top pulls the sheet, from further down it scrolls. */
export function SheetScroll({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div data-sheet-scroll className={cn("web-scroll min-h-0 overflow-y-auto overscroll-contain", className)}>
      {children}
    </div>
  )
}
