import { useEffect, useRef, useState, type ReactNode } from "react"
import type { TreeRow } from "@/lib/file-tree"
import { cn } from "@/lib/utils"

const ROW_HEIGHT = 24
const OVERSCAN = 8

export function ChangeList({
  rows,
  compact,
  fitContent = false,
  renderRow,
}: {
  rows: TreeRow[]
  compact: boolean
  fitContent?: boolean
  renderRow: (row: TreeRow) => ReactNode
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const [range, setRange] = useState({ first: 0, count: 32 })
  const measure = () => {
    const node = scroller.current
    if (!node) return
    const first = Math.floor(node.scrollTop / ROW_HEIGHT)
    const count = Math.ceil(node.clientHeight / ROW_HEIGHT) + 1
    setRange((current) =>
      current.first === first && current.count === count
        ? current
        : { first, count }
    )
  }
  useEffect(() => {
    const node = scroller.current
    if (!node) return
    const observer = new ResizeObserver(() => {
      const first = Math.floor(node.scrollTop / ROW_HEIGHT)
      const count = Math.ceil(node.clientHeight / ROW_HEIGHT) + 1
      setRange((current) =>
        current.first === first && current.count === count
          ? current
          : { first, count }
      )
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  const first = Math.min(range.first, Math.max(0, rows.length - range.count))
  const start = Math.max(0, first - OVERSCAN)
  const end = Math.min(rows.length, first + range.count + OVERSCAN)
  return (
    <div
      ref={scroller}
      data-change-list
      data-row-count={rows.length}
      role="list"
      aria-label="Changed files"
      onScroll={measure}
      className={cn(
        "min-h-0 overflow-y-auto overscroll-contain px-1 py-1",
        compact ? "max-h-[34%] shrink-0" : fitContent ? "shrink" : "flex-1"
      )}
      style={fitContent ? { flexBasis: rows.length * ROW_HEIGHT + 8 } : undefined}
      onKeyDown={(event) => {
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return
        const target = event.target
        if (!(target instanceof HTMLElement)) return
        const row = target.closest<HTMLElement>("[data-change-row]")
        const node = scroller.current
        if (!row || !node) return
        event.preventDefault()
        const current = Number(row.dataset.changeRow)
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? rows.length - 1
              : Math.max(
                  0,
                  Math.min(
                    rows.length - 1,
                    current + (event.key === "ArrowDown" ? 1 : -1)
                  )
                )
        if (next * ROW_HEIGHT < node.scrollTop)
          node.scrollTop = next * ROW_HEIGHT
        else if ((next + 1) * ROW_HEIGHT > node.scrollTop + node.clientHeight)
          node.scrollTop = (next + 1) * ROW_HEIGHT - node.clientHeight
        measure()
        requestAnimationFrame(() =>
          scroller.current
            ?.querySelector<HTMLElement>(
              `[data-change-row="${next}"] [role="checkbox"]`
            )
            ?.focus()
        )
      }}
    >
      <div style={{ height: rows.length * ROW_HEIGHT, position: "relative" }}>
        {rows.slice(start, end).map((row, offset) => (
          <div
            key={row.key}
            role="listitem"
            aria-posinset={start + offset + 1}
            aria-setsize={rows.length}
            data-change-row={start + offset}
            style={{
              position: "absolute",
              top: (start + offset) * ROW_HEIGHT,
              height: ROW_HEIGHT,
              width: "100%",
            }}
          >
            {renderRow(row)}
          </div>
        ))}
      </div>
    </div>
  )
}
