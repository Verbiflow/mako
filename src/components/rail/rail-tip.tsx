import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react"
import { createPortal } from "react-dom"

/**
 * The rail's hover overlay: a row's full text — the title the row truncates,
 * where the conversation has lived, its model and its folder.
 *
 * These were native `title` tooltips. Since Electron 38 (Chromium 140) a
 * `title` on macOS shows late, shows once and then rarely, or never shows
 * (electron/electron#49843, confirmed and still open at Electron 43), and a
 * row whose text changed under the pointer — the rename hint on the title,
 * the row's own text on either side of it — restarted that wait each time.
 * That is the lag a hovered row had.
 *
 * One listener on the scroller now reads `data-tip` off the row under the
 * pointer and renders one element, portaled and pointer-transparent, after
 * the delay a native tooltip takes; moving straight to the next row hands
 * the tip over without waiting. Rows pay nothing for it, nothing animates,
 * and anything marked `data-tip-quiet` (a row's controls) keeps the tip
 * away so its own label stands alone.
 */
const SHOW_MS = 400
/** A tip hidden this recently means the pointer is scanning: the next row shows at once. */
const HANDOFF_MS = 300
const GAP_PX = 4
const MARGIN_PX = 8

type Tip = { text: string; anchor: DOMRect }

export function RailTip({ scroller }: { scroller: RefObject<HTMLElement | null> }) {
  const [tip, setTip] = useState<Tip | null>(null)
  const node = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const root = scroller.current
    if (!root) return
    let timer = 0
    let row: HTMLElement | null = null
    let shown = false
    let hiddenAt = Number.NEGATIVE_INFINITY

    const hide = () => {
      window.clearTimeout(timer)
      row = null
      if (!shown) return
      shown = false
      hiddenAt = performance.now()
      setTip(null)
    }
    const show = (next: HTMLElement) => {
      const text = next.dataset["tip"]
      if (!text) return
      shown = true
      setTip({ text, anchor: next.getBoundingClientRect() })
    }
    const onOver = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null
      const next = target?.closest<HTMLElement>("[data-tip]") ?? null
      if (!next || !root.contains(next) || target?.closest("[data-tip-quiet]")) {
        hide()
        return
      }
      if (next === row) return
      const handoff = shown || performance.now() - hiddenAt < HANDOFF_MS
      hide()
      row = next
      if (handoff) {
        show(next)
        return
      }
      timer = window.setTimeout(() => {
        if (row === next) show(next)
      }, SHOW_MS)
    }
    const onOut = (event: PointerEvent) => {
      if (!row) return
      if (event.relatedTarget instanceof Node && row.contains(event.relatedTarget)) return
      hide()
    }

    root.addEventListener("pointerover", onOver)
    root.addEventListener("pointerout", onOut)
    root.addEventListener("pointerdown", hide)
    root.addEventListener("scroll", hide, { passive: true })
    window.addEventListener("blur", hide)
    return () => {
      window.clearTimeout(timer)
      root.removeEventListener("pointerover", onOver)
      root.removeEventListener("pointerout", onOut)
      root.removeEventListener("pointerdown", hide)
      root.removeEventListener("scroll", hide)
      window.removeEventListener("blur", hide)
    }
  }, [scroller])

  // Below the row, flush with its left edge, like the native tooltip it
  // replaces; above it when the bottom of the window is closer than that.
  useLayoutEffect(() => {
    const element = node.current
    if (!element || !tip) return
    const { width, height } = element.getBoundingClientRect()
    const { anchor } = tip
    let top = anchor.bottom + GAP_PX
    if (top + height > window.innerHeight - MARGIN_PX)
      top = Math.max(MARGIN_PX, anchor.top - GAP_PX - height)
    const left = Math.max(
      MARGIN_PX,
      Math.min(anchor.left, window.innerWidth - MARGIN_PX - width)
    )
    element.style.transform = `translate(${left}px, ${top}px)`
  }, [tip])

  if (!tip) return null
  const [title, ...rest] = tip.text.split("\n")
  return createPortal(
    <div
      ref={node}
      role="tooltip"
      data-rail-tip
      className="pointer-events-none fixed top-0 left-0 z-50 max-w-xs rounded-md bg-foreground px-3 py-1.5 text-label wrap-anywhere text-background"
    >
      <p className="font-medium">{title}</p>
      {rest.map((line, index) => (
        <p key={index} className="text-background/70">
          {line}
        </p>
      ))}
    </div>,
    document.body
  )
}
