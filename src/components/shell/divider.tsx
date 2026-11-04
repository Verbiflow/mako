import { useCallback, useEffect, useRef } from "react"
import { cn } from "@/lib/utils"

/**
 * A 6px gutter of the shell between two panes, with no line in it: the
 * panes' own tone separates them, and a bar shows only under the pointer or
 * focus. Dragging writes straight to a ref-held callback and never through
 * React state, so a resize costs one style write per frame instead of a tree
 * render.
 */
export function Divider({
  side,
  size,
  min,
  max,
  onResize,
  onCommit,
  className,
}: {
  side: "left" | "right" | "bottom"
  size: number
  min: number
  max: number
  onResize: (next: number) => void
  onCommit: (next: number) => void
  className?: string
}) {
  const state = useRef<{
    start: number
    base: number
    latest: number
    frame: number | null
  }>({ start: 0, base: 0, latest: 0, frame: null })
  const cleanup = useRef<(() => void) | undefined>(undefined)
  useEffect(() => () => cleanup.current?.(), [])
  const horizontal = side === "bottom"

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || !event.isPrimary) return
      cleanup.current?.()
      event.preventDefault()
      const handle = event.currentTarget
      handle.focus()
      handle.setPointerCapture(event.pointerId)
      state.current = {
        start: horizontal ? event.clientY : event.clientX,
        base: size,
        latest: size,
        frame: null,
      }
      const cursor = document.body.style.cursor
      const userSelect = document.body.style.userSelect
      document.body.style.cursor = horizontal ? "row-resize" : "col-resize"
      document.body.style.userSelect = "none"

      const move = (moveEvent: PointerEvent) => {
        const point = horizontal ? moveEvent.clientY : moveEvent.clientX
        const delta = point - state.current.start
        const raw = state.current.base + (side === "left" ? delta : -delta)
        const next = Math.round(Math.min(max, Math.max(min, raw)))
        state.current.latest = next
        if (state.current.frame !== null) return
        state.current.frame = requestAnimationFrame(() => {
          state.current.frame = null
          onResize(state.current.latest)
        })
      }
      const release = () => {
        handle.removeEventListener("pointermove", move)
        handle.removeEventListener("pointerup", finish)
        handle.removeEventListener("pointercancel", cancel)
        handle.removeEventListener("lostpointercapture", finish)
        document.body.style.cursor = cursor
        document.body.style.userSelect = userSelect
        if (state.current.frame !== null) {
          cancelAnimationFrame(state.current.frame)
          state.current.frame = null
        }
        cleanup.current = undefined
        if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId)
      }
      const finish = () => {
        release()
        onResize(state.current.latest)
        onCommit(state.current.latest)
      }
      const cancel = () => {
        release()
        onResize(size)
      }
      cleanup.current = release
      handle.addEventListener("lostpointercapture", finish)
      handle.addEventListener("pointermove", move)
      handle.addEventListener("pointerup", finish)
      handle.addEventListener("pointercancel", cancel)
    },
    [horizontal, max, min, onCommit, onResize, side, size]
  )

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label={horizontal ? "Resize terminal dock" : `Resize ${side} sidebar`}
      aria-valuetext={`${size} pixels`}
      onKeyDown={(event) => {
        const decrease = horizontal ? "ArrowDown" : side === "left" ? "ArrowLeft" : "ArrowRight"
        const increase = horizontal ? "ArrowUp" : side === "left" ? "ArrowRight" : "ArrowLeft"
        if (![decrease, increase, "Home", "End"].includes(event.key)) return
        event.preventDefault()
        const step = event.shiftKey ? 40 : 10
        const target = event.key === "Home" ? min : event.key === "End" ? max :
          size + (event.key === increase ? step : -step)
        const next = Math.max(min, Math.min(max, target))
        onResize(next)
        onCommit(next)
      }}
      aria-orientation={horizontal ? "horizontal" : "vertical"}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={size}
      onPointerDown={onPointerDown}
      onDoubleClick={() => {
        onResize(min)
        onCommit(min)
      }}
      className={cn(
        "no-drag group relative z-10 shrink-0 bg-shell",
        horizontal ? "h-1.5 w-full cursor-row-resize" : "h-full w-1.5 cursor-col-resize",
        className
      )}
    >
      {/* The grab area reaches past the gutter; the bar inside shows only under the pointer or focus. */}
      <span aria-hidden className={cn("absolute", horizontal ? "-top-1 -bottom-1 inset-x-0" : "inset-y-0 -left-1 -right-1")} />
      <span
        aria-hidden
        className={cn(
          "absolute rounded-full transition-colors duration-150 group-hover:bg-foreground/20 group-focus-visible:bg-foreground/35 group-active:bg-foreground/35",
          horizontal ? "inset-x-0 top-1/2 h-0.5 -translate-y-1/2" : "inset-y-0 left-1/2 w-0.5 -translate-x-1/2"
        )}
      />
    </div>
  )
}
