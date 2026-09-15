import { memo, useEffect, useState, useRef, type ReactNode } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { cn } from "@/lib/utils"
import type { Exchange } from "@/lib/exchanges"
import { promptLabel } from "@/lib/exchanges"

/**
 * Width of the scroller's own overlay scrollbar track at the pane edge. The
 * ticks sit inward of it: the gutter is padding inside the scroller, so the
 * scrollbar paints in the same column, and a `nav` laid over the track took
 * every pointer event meant for the thumb — it could not be grabbed for the
 * middle of the pane, and hovering it opened the flyout instead.
 */
const SCROLLBAR_TRACK = 12

/** Width of the tick column, inward of the scrollbar track. */
const TICKS_WIDTH = 26

/** Width of the reserved gutter. The scroller pads by this, so nothing overlaps. */
export const NAVIGATOR_WIDTH = SCROLLBAR_TRACK + TICKS_WIDTH

/**
 * Below this the pane is too tight to give up a gutter, and the navigator
 * would be sitting on top of the prose instead of beside it.
 */
const MIN_PANE_WIDTH = 360

/**
 * The turn navigator.
 *
 * A tick per question, in a gutter the scroller reserves for it. It is the
 * fastest way to answer "where did I ask about X" in a long session: the whole
 * conversation is legible as a shape, hovering reads a question back without
 * moving the view, and clicking jumps to it.
 *
 * It occupies reserved space rather than floating over the transcript, and it
 * withdraws entirely on a narrow pane — a navigation aid that covers the thing
 * being navigated is worse than no aid at all.
 */
export const TurnNavigator = memo(function TurnNavigator({
  exchanges,
  activeId,
  onJump,
  paneRef,
}: {
  exchanges: Exchange[]
  activeId: string | null
  onJump: (id: string) => void
  /** The pane the navigator sits in, watched for available width. */
  paneRef: React.RefObject<HTMLElement | null>
}) {
  const [hovered, setHovered] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [wide, setWide] = useState(true)

  // The pane's width changes when either side panel opens, not only when the
  // window resizes — so observe the element rather than the viewport.
  useEffect(() => {
    const node = paneRef.current
    if (!node) return
    const observer = new ResizeObserver(([entry]) => {
      setWide(entry.contentRect.width >= MIN_PANE_WIDTH)
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [paneRef])

  // One or two turns is not a session worth navigating.
  if (exchanges.length < 3 || !wide) return null

  return (
    <nav
      aria-label="Previous prompts"
      onFocus={() => setOpen(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setOpen(false)
          setHovered(null)
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          setOpen(false)
          setHovered(null)
        }
      }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => {
        setOpen(false)
        setHovered(null)
      }}
      style={{ width: TICKS_WIDTH, right: SCROLLBAR_TRACK }}
      className="absolute top-[15%] bottom-[15%] z-10 flex items-center justify-end"
    >
      <NavigatorItems
        exchanges={exchanges}
        estimate={14}
        gap={2}
        className="max-h-full [scrollbar-width:none] overflow-y-auto py-2 pr-2.5"
        render={(exchange) => {
          const active = exchange.id === activeId
          const isHovered = exchange.id === hovered
          return (
            <button
              key={exchange.id}
              type="button"
              aria-label={promptLabel(exchange)}
              aria-current={active ? "true" : undefined}
              onMouseEnter={() => setHovered(exchange.id)}
              onClick={() => onJump(exchange.id)}
              className="pressable group/tick flex h-3 shrink-0 items-center justify-end focus-visible:outline focus-visible:outline-ring"
            >
              <span
                className={cn(
                  "block h-[2px] w-3.5 origin-right rounded-full",
                  // Width is the only channel doing work here: length reads as
                  // position without adding another colour to the window.
                  "bg-foreground [transition:transform_160ms_var(--ease-out),opacity_120ms_var(--ease-swift)]",
                  active
                    ? "scale-x-100 opacity-80"
                    : isHovered
                      ? "scale-x-100 opacity-60"
                      : open
                        ? "scale-x-75 opacity-40"
                        : "scale-x-50 opacity-30"
                )}
              />
            </button>
          )
        }}
      />

      {open ? (
        <Flyout
          exchanges={exchanges}
          activeId={hovered ?? activeId}
          onJump={onJump}
          onHover={setHovered}
        />
      ) : null}
    </nav>
  )
})

function Flyout({
  exchanges,
  activeId,
  onJump,
  onHover,
}: {
  exchanges: Exchange[]
  activeId: string | null
  onJump(id: string): void
  onHover(id: string): void
}) {
  return (
    <div
      className={cn(
        // Opens inward, and is clamped so it can never reach past the
        // transcript's own column into the pane beside it.
        "absolute top-1/2 right-6 flex max-h-full w-[min(20rem,45vw)] -translate-y-1/2 flex-col overflow-hidden",
        "overlay-panel rounded-lg bg-popover p-1.5"
      )}
    >
      <div className="px-2 py-1.5 text-label text-faint">
        {exchanges.length} prompts
      </div>
      <NavigatorItems
        exchanges={exchanges}
        estimate={44}
        className="min-h-0 overflow-y-auto"
        render={(exchange, index) => (
          <button
            key={exchange.id}
            type="button"
            onMouseEnter={() => onHover(exchange.id)}
            onFocus={() => onHover(exchange.id)}
            onClick={() => onJump(exchange.id)}
            aria-current={exchange.id === activeId ? "true" : undefined}
            className={cn(
              "pressable flex w-full items-baseline gap-2 rounded px-2 py-2 text-left text-ui hover:bg-fill-hover focus-visible:outline focus-visible:outline-ring",
              exchange.id === activeId && "bg-fill-selected"
            )}
          >
            <span
              aria-hidden
              className="tabular w-5 shrink-0 text-label text-faint"
            >
              {index + 1}
            </span>
            <span className="line-clamp-2 min-w-0 leading-snug">
              {promptLabel(exchange)}
            </span>
          </button>
        )}
      />
    </div>
  )
}

function NavigatorItems({
  exchanges,
  estimate,
  gap = 0,
  className,
  render,
}: {
  exchanges: Exchange[]
  estimate: number
  gap?: number
  className: string
  render(exchange: Exchange, index: number): ReactNode
}) {
  "use no memo"
  const scroller = useRef<HTMLDivElement>(null)
  const large = exchanges.length > 100
  const rows = useVirtualizer({
    count: exchanges.length,
    enabled: large,
    getScrollElement: () => scroller.current,
    estimateSize: () => estimate,
    getItemKey: (index) => exchanges[index]!.id,
    overscan: 6,
    useAnimationFrameWithResizeObserver: true,
  })
  const items = large
    ? rows.getVirtualItems()
    : exchanges.map((entry, index) => ({ index, key: entry.id, start: 0 }))
  return (
    <div
      ref={scroller}
      className={className}
      onKeyDown={(event) => {
        const target = event.target
        if (!(target instanceof HTMLElement)) return
        const item = target.closest<HTMLElement>("[data-navigator-index]")
        if (!item) return
        const index = Number(item.dataset.navigatorIndex)
        const direction =
          event.key === "ArrowDown"
            ? 1
            : event.key === "ArrowUp"
              ? -1
              : event.key === "Tab"
                ? event.shiftKey
                  ? -1
                  : 1
                : 0
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? exchanges.length - 1
              : index + direction
        if (
          (!direction && event.key !== "Home" && event.key !== "End") ||
          next < 0 ||
          next >= exchanges.length
        )
          return
        if (
          event.key === "Tab" &&
          (!large ||
            scroller.current?.querySelector(`[data-navigator-index="${next}"]`))
        )
          return
        event.preventDefault()
        if (large) rows.scrollToIndex(next, { align: "auto" })
        requestAnimationFrame(() =>
          scroller.current
            ?.querySelector<HTMLButtonElement>(
              `[data-navigator-index="${next}"] button`
            )
            ?.focus()
        )
      }}
    >
      <div
        style={
          large
            ? { height: rows.getTotalSize(), position: "relative" }
            : undefined
        }
      >
        {items.map((item) => (
          <div
            key={item.key}
            data-navigator-index={item.index}
            data-index={item.index}
            ref={large ? rows.measureElement : undefined}
            style={
              large
                ? {
                    paddingBottom: item.index < exchanges.length - 1 ? gap : 0,
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${item.start}px)`,
                  }
                : { paddingBottom: item.index < exchanges.length - 1 ? gap : 0 }
            }
          >
            {render(exchanges[item.index]!, item.index)}
          </div>
        ))}
      </div>
    </div>
  )
}
