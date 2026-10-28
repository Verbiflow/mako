import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { cn } from "@/lib/utils"
import { catchElement, reducedMotion, rubberband, SETTLE, SLOP_PX, springTo, THROWN, Velocity } from "./motion"

/** The sheets open now, the newest last: Escape and Back close only the one on top. */
const stacked = new Set<object>()

/** A release faster than this, downwards, dismisses whatever the distance (px/ms). */
const FLICK = 0.5
/** A release past this share of the sheet's height dismisses it. */
const PAST = 1 / 3

/**
 * A sheet from the bottom of the screen, as a phone draws its choices: it rises from below, follows the finger 1:1 when
 * dragged down (from its handle, or from its content scrolled to the top), resists being pulled up, and on release
 * closes if it was flicked down or pulled past a third, else springs back at the finger's speed. Tapping outside, Back
 * and Escape close it too. It can be caught mid-flight. `open` is the parent's; `onDismiss` asks it to close, and the
 * sheet leaves on its own path before it unmounts.
 */
export function Sheet({ open, onDismiss, label, children, className, tall }: { open: boolean; onDismiss: () => void; label: string; children: ReactNode; className?: string; tall?: boolean }) {
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
    if (open) {
      opener.current = document.activeElement
      // Focus goes into the sheet, so keys never reach what's behind it (a field asks for it first by `autoFocus`).
      if (!sheet.contains(document.activeElement)) sheet.querySelector<HTMLElement>("textarea:not([disabled]), input:not([disabled]), button:not([disabled])")?.focus({ preventScroll: true })
      if (reducedMotion()) {
        sheet.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: "ease-out" })
        shade.style.opacity = "1"
        return
      }
      sheet.style.transform = `translate3d(0, ${height}px, 0)`
      void springTo(sheet, "y", 0, { spring: SETTLE, also: [{ element: shade, frame: fade }] })
      return
    }
    const velocity = release.current
    release.current = 0
    const done = () => {
      setMounted(false)
      if (opener.current instanceof HTMLElement && document.contains(opener.current)) opener.current.focus({ preventScroll: true })
    }
    if (reducedMotion()) {
      void sheet.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, easing: "ease-in", fill: "forwards" }).finished.then(done, done)
      return
    }
    const from = catchElement(sheet).y
    void springTo(sheet, "y", height, { from, velocity: Math.max(velocity, 0), spring: velocity > FLICK ? THROWN : SETTLE, also: [{ element: shade, frame: (progress) => fade(1 - progress) }] }).then(done)
  }, [open, mounted])

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

  // The drag: by pointer on the grab area (it never scrolls), by touch on the content when it's at its top.
  useEffect(() => {
    const sheet = panel.current
    if (!sheet || !open) return
    let start: { y: number; at: number; from: number; scroller: HTMLElement | null } | undefined
    let dragging = false
    const velocity = new Velocity()
    const height = () => sheet.getBoundingClientRect().height
    const move = (y: number) => {
      if (!start) return false
      const delta = y - start.y
      if (!dragging) {
        if (Math.abs(delta) < SLOP_PX) return false
        // Up, or a content that can still scroll up: the content's scroll, not the sheet's drag.
        if (delta < 0 || (start.scroller && start.scroller.scrollTop > 0)) {
          start = undefined
          return false
        }
        dragging = true
        sheet.dataset["dragging"] = ""
      }
      const offset = start.from + delta - SLOP_PX
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
      if (speed > FLICK || (at > height() * PAST && speed > -FLICK)) {
        release.current = speed
        dismiss.current()
        return
      }
      void springTo(sheet, "y", 0, { velocity: speed, spring: SETTLE, also: backdrop.current ? [{ element: backdrop.current, frame: () => ({ opacity: "1" }) }] : [] })
    }
    const begin = (y: number, target: EventTarget | null) => {
      const scroller = target instanceof Element ? target.closest<HTMLElement>("[data-sheet-scroll]") : null
      start = { y, at: performance.now(), from: catchElement(sheet).y, scroller }
      velocity.add(start.from)
    }
    const grab = sheet.querySelector<HTMLElement>("[data-sheet-grab]")
    const pointerDown = (event: PointerEvent) => {
      if (event.pointerType === "mouse" && event.button !== 0) return
      grab?.setPointerCapture(event.pointerId)
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
  }, [open])

  if (!mounted) return null
  return createPortal(
    <div className="web-sheet-layer" data-open={open || undefined}>
      <div ref={backdrop} className="web-sheet-backdrop" style={{ opacity: 0 }} onClick={onDismiss} aria-hidden />
      <div ref={panel} role="dialog" aria-modal aria-label={label} className={cn("web-sheet", tall && "web-sheet-tall", className)}>
        <div data-sheet-grab className="web-sheet-grab" aria-hidden>
          <span />
        </div>
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
