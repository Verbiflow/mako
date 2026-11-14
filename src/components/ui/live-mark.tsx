import type { CSSProperties, ReactNode } from "react"
import { observePhaseLockedAnimation } from "@/lib/visible-animation"
import { cn } from "@/lib/utils"
import { liveMarkWord, type LiveMarkKind, type LiveMarkState, type LiveMotion } from "@/lib/live-mark-state"

const FIN = "M4.97 5.01C14.94 6.3 20.86 13.77 27.77 26.99L4.97 26.99C8.16 22.52 10.88 13.84 4.97 5.01Z"
/** The app icon's lit lower face: the part of the fin below the diagonal from its leading edge to its trailing tip. */
const FACE = "M4.97 26.99L27.77 26.99L8.3 14.6C8.2 18.6 6.9 23.2 4.97 26.99Z"

const MOVING: ReadonlySet<LiveMarkState> = new Set(["working", "background", "starting", "needs", "lead"])
/** Work in progress: light crosses the fin itself, the one sign that reads at 20 px across a list. */
const GLINTS: ReadonlySet<LiveMarkState> = new Set(["working", "background", "starting"])

/**
 * Who and how, as Mako's own fin (`MakoMark`'s path): a Thread is the two-tone fin of the app icon, a Fin the plain
 * fin, and the harness it runs on (`children`, its glyph) a small square badge in the corner. The fin itself moves
 * with what it does, one calm gesture a state, as a character would rather than a spinner beside it:
 *
 * - working: a glint of the brand's sea crosses the fin itself, the sign that reads at 20 px down a list, and by
 *   `motion` thinking it bobs, writing it glides side to side, running a tool it braces in two steps;
 *   `background` (its turn done, work it waits on still running) bobs and glints at half speed, dimmer;
 * - needs you: it turns the attention hue over a waterline that breathes, never below 40%;
 * - asking its Apex: it drifts, dimmed; queued: faint and still; starting: it fades in and out;
 * - failed: it lists over in negative; an answer to read: still, with the unread sphere at its shoulder;
 * - idle and open elsewhere: still and dimmed.
 *
 * The motion is `transform` and `opacity` on HTML boxes only, so the compositor runs it with no style or layout pass
 * and no React render; each moving layer runs on the shared clock and rests off screen
 * (`observePhaseLockedAnimation`), keyed by state and motion so a change starts in step with every other mark. `lit`
 * is the open Thread: its face takes the brand's sea, the pane's one accent moment. `cut` is the colour behind the
 * mark, which the badge and the dot are cut out of.
 */
export function LiveMark({
  state,
  kind = "thread",
  motion = "thinking",
  lit,
  fresh,
  cut,
  size,
  label,
  className,
  children,
}: {
  state: LiveMarkState
  kind?: LiveMarkKind
  /** What a working agent is doing, for the gesture it makes. */
  motion?: LiveMotion
  lit?: boolean
  /** An answer seconds old: its dot arrives instead of being painted still. */
  fresh?: boolean
  cut?: string
  /** The mark's box in px; the fin and badge scale with it. 20 by default. */
  size?: number
  /** What the mark says to a screen reader, when the state's own word isn't enough ("Working in Cursor"). */
  label?: string
  className?: string
  /** The harness's glyph, drawn as the corner badge. */
  children?: ReactNode
}) {
  // SAFETY: custom properties pass through React's style as named; CSSProperties lists only the standard ones.
  const style = { ...(size && { "--lm-size": `${size}px` }), ...(cut && { "--lm-cut": cut }) } as CSSProperties
  const moving = MOVING.has(state)
  const gesture = state === "working" ? motion : state
  return (
    <span
      role="img"
      aria-label={label ?? liveMarkWord(state)}
      data-live-mark={state}
      data-motion={state === "working" ? motion : undefined}
      data-kind={kind}
      data-lit={lit || undefined}
      className={cn("live-mark", className)}
      style={style}
    >
      {state === "needs" || (kind === "thread" && (state === "working" || state === "background")) ? (
        <span key={`water:${state}`} aria-hidden ref={state === "needs" ? observePhaseLockedAnimation : undefined} className="live-mark-water" />
      ) : null}
      <span key={`body:${gesture}`} aria-hidden ref={moving ? observePhaseLockedAnimation : undefined} className="live-mark-body">
        <svg viewBox="2 2 28 28" aria-hidden>
          <path d={FIN} fill="currentColor" />
          {kind === "thread" ? <path d={FACE} className="live-mark-face" /> : null}
        </svg>
        {GLINTS.has(state) ? (
          <span className="live-mark-glint">
            <i />
          </span>
        ) : null}
      </span>
      {children ? (
        <span aria-hidden className="live-mark-badge">
          {children}
        </span>
      ) : null}
      {state === "unread" ? (
        <span aria-hidden className="live-mark-dot">
          <span className="review-dot" data-new={fresh || undefined} />
        </span>
      ) : null}
    </span>
  )
}
