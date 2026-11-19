import { memo, useCallback, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import type { NativeAgent } from "@mako/host/contracts/native-agents"
import { useRowRef } from "@/lib/virtual-row-ref"

/** A Fin's row before it's measured: its two lines. */
const ROW_ESTIMATE = 48

/**
 * A long section's rows, drawn as they scroll into the panel: an Apex of a few hundred Fins, opened past its first
 * rows, mounts a screenful. The panel's own scroller scrolls them, so the list says where it starts inside it
 * (`scrollMargin`), read again whenever the Overview above it changes height.
 *
 * Memoized by hand: `useVirtualizer` keeps the React Compiler off this file.
 */
export const WindowedFins = memo(function WindowedFins({
  fins,
  scroller,
  row,
}: {
  fins: readonly NativeAgent[]
  scroller: RefObject<HTMLDivElement | null>
  /** One Fin's row; the same function while what it closes over stands, so a scroll draws only the rows coming in. */
  row: (agent: NativeAgent) => ReactNode
}) {
  const list = useRef<HTMLDivElement>(null)
  const [margin, setMargin] = useState(0)
  useLayoutEffect(() => {
    const element = list.current
    const scrolled = scroller.current
    if (!element || !scrolled) return
    const measure = () => {
      const next = Math.round(element.getBoundingClientRect().top - scrolled.getBoundingClientRect().top + scrolled.scrollTop)
      setMargin((held) => (held === next ? held : next))
    }
    measure()
    // Whatever stands above the list (a section opened, folded, a Fin changing section) moves where it starts. Read in
    // the next frame: setting it inside the observer's own pass resizes what it observes, which the browser reports.
    let frame: number | undefined
    const observer = new ResizeObserver(() => {
      frame ??= requestAnimationFrame(() => {
        frame = undefined
        measure()
      })
    })
    for (const above of scrolled.children) observer.observe(above)
    return () => {
      observer.disconnect()
      if (frame !== undefined) cancelAnimationFrame(frame)
    }
  }, [scroller])
  const keyOf = useCallback((index: number) => fins[index]?.nativeId ?? index, [fins])
  const virtualizer = useVirtualizer({
    count: fins.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW_ESTIMATE,
    overscan: 8,
    scrollMargin: margin,
    getItemKey: keyOf,
  })
  const measureRow = useRowRef(virtualizer)
  return (
    <div ref={list} data-overview-windowed={fins.length} className="relative" style={{ height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map((item) => {
        const agent = fins[item.index]
        return agent ? (
          <div
            key={item.key}
            data-index={item.index}
            ref={measureRow}
            className="absolute inset-x-0 top-0"
            style={{ transform: `translateY(${item.start - virtualizer.options.scrollMargin}px)` }}
          >
            {row(agent)}
          </div>
        ) : null
      })}
    </div>
  )
})
