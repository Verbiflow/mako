import type { CSSProperties, ReactNode } from "react"
import { observePhaseLockedAnimation } from "@/lib/visible-animation"
import { cn } from "@/lib/utils"
import { liveMarkWord, type LiveMarkState } from "@/lib/live-mark-state"

const MOVING: ReadonlySet<LiveMarkState> = new Set(["working", "background", "starting", "needs", "lead"])

/**
 * One mark for who and how: the agent's own glyph (`children`), and around it its state. Rows, tabs, the crew card,
 * the Inbox and the phone draw this one mark, so a state reads the same everywhere.
 *
 * The motion is CSS on `transform` and `opacity` alone, which the compositor runs without a style or layout pass, so a
 * hundred working rows cost no main-thread time per frame and no React render. Each moving layer runs on the shared
 * clock and rests off screen (`observePhaseLockedAnimation`): it is keyed by state, so a change of state starts it in
 * step with every other mark. `lit` is the open Thread's working comet, the pane's one accent moment. `cut` is the
 * colour behind the mark, which its dot is cut out of.
 */
export function LiveMark({
  state,
  lit,
  fresh,
  cut,
  size,
  label,
  className,
  children,
}: {
  state: LiveMarkState
  lit?: boolean
  /** An answer seconds old: its dot arrives instead of being painted still. */
  fresh?: boolean
  cut?: string
  /** The mark's box in px; the glyph and ring scale with it. 20 by default. */
  size?: number
  /** What the mark says to a screen reader, when the state's own word isn't enough ("Working in Cursor"). */
  label?: string
  className?: string
  children: ReactNode
}) {
  // SAFETY: custom properties pass through React's style as named; CSSProperties lists only the standard ones.
  const style = { ...(size && { "--lm-size": `${size}px` }), ...(cut && { "--lm-cut": cut }) } as CSSProperties
  return (
    <span role="img" aria-label={label ?? liveMarkWord(state)} data-live-mark={state} data-lit={lit || undefined} className={cn("live-mark", className)} style={style}>
      {MOVING.has(state) || state === "queued" || state === "open" ? <Ring key={state} state={state} /> : null}
      <span aria-hidden className="live-mark-glyph">
        {children}
      </span>
      {state === "failed" ? <span aria-hidden className="live-mark-dot" /> : null}
      {state === "unread" ? (
        <span aria-hidden className="live-mark-dot">
          <span className="review-dot" data-new={fresh || undefined} />
        </span>
      ) : null}
    </span>
  )
}

function Ring({ state }: { state: LiveMarkState }) {
  const moving = MOVING.has(state)
  // The dotted and dashed rings are drawn once; a turn is the HTML box round them, which the compositor can move.
  if (state === "lead" || state === "queued")
    return (
      <span aria-hidden className="live-mark-ring" ref={moving ? observePhaseLockedAnimation : undefined}>
        <svg viewBox="0 0 20 20" className="live-mark-dots">
          <circle cx="10" cy="10" r="9.25" />
        </svg>
      </span>
    )
  return (
    <span aria-hidden className="live-mark-ring" ref={state === "needs" ? observePhaseLockedAnimation : undefined}>
      {state === "needs" || state === "open" ? null : <span ref={observePhaseLockedAnimation} className="live-mark-comet" />}
    </span>
  )
}
