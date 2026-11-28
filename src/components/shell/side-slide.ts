import { useLayoutEffect, useRef, useState, type RefObject } from "react"
import { EASE_OUT, EASE_SWIFT, motionMs, reducedMotion } from "@/lib/motion"

/**
 * A sidebar sliding in and out beside a pane, by `transform` alone.
 *
 * The row is laid out once, at the new width, in the frame the sidebar is asked for; nothing lays out again until it
 * rests, so a long transcript reflows once and its virtualizer measures once. What makes it read as one continuous
 * motion is drawn on the compositor:
 *
 * - the sidebar (with its gutter) slides from its edge;
 * - the pane beside it starts where its edge was and follows the sidebar's edge in, a copy of its own background
 *   (a box shadow) filling what the pane's new, narrower box leaves bare on its far side;
 * - what's marked inside the pane (`data-slide-anchor`: `start`, `center` or `end`, the point of it that should
 *   travel smoothly) starts where that point was at the old width and glides to where it is. Where it was is read by
 *   laying the pane out at its old width for one measurement inside the same frame, so a split, a fixed second pane or
 *   a centred column each move as they would have.
 *
 * Leaving, the sidebar is laid over the pane (its caller positions it while `leaving`) and the pane is laid out at its
 * full width at once, under it. A toggle mid-way turns around from where everything is drawn: every part moves on one
 * clock, linear in how much of the sidebar is out, so reading the sidebar's own translation says where the rest are.
 */

export type SlideSide = "left" | "right"
type Anchor = "start" | "center" | "end"

interface Running {
  animations: Animation[]
  restore: () => void
}

const running = new WeakMap<HTMLElement, Running>()

/** How much of a sliding sidebar is out (0 to 1), from where it's drawn this frame; none when it isn't sliding. */
function shownNow(panel: HTMLElement, distance: number): number | undefined {
  if (!running.has(panel)) return undefined
  const transform = getComputedStyle(panel).transform
  const x = transform && transform !== "none" ? new DOMMatrixReadOnly(transform).m41 : 0
  return Math.min(1, Math.max(0, 1 - Math.abs(x) / distance))
}

/** Stops a sidebar's slide where it is and puts back what it borrowed (the pane's shadow). */
export function stopSlide(panel: HTMLElement): void {
  const slide = running.get(panel)
  if (!slide) return
  running.delete(panel)
  for (const animation of slide.animations) animation.cancel()
  slide.restore()
}

function anchorOf(element: HTMLElement): Anchor {
  const value = element.dataset.slideAnchor
  return value === "center" || value === "end" ? value : "start"
}

/** Each marked part's travelling point, from the pane's left edge. */
function points(pane: HTMLElement, parts: HTMLElement[]): number[] {
  const left = pane.getBoundingClientRect().left
  return parts.map((part) => {
    const box = part.getBoundingClientRect()
    const anchor = anchorOf(part)
    return (anchor === "start" ? box.left : anchor === "end" ? box.right : (box.left + box.right) / 2) - left
  })
}

/** The pane's marked parts as they'd stand at `width`: laid out there for this one reading, then put back. */
function pointsAt(pane: HTMLElement, parts: HTMLElement[], width: number): number[] {
  const { flex, width: was } = pane.style
  pane.style.flex = "none"
  pane.style.width = `${width}px`
  try {
    return points(pane, parts)
  } finally {
    pane.style.flex = flex
    pane.style.width = was
  }
}

const shift = (x: number): Keyframe => ({ transform: x ? `translate3d(${x}px, 0, 0)` : "none" })

/**
 * Slides `panel` in (`opening`) or out beside `pane`, which is already laid out for the end of it. Resolves `true`
 * once it rests, `false` if another slide caught it first.
 */
export function slideSide({
  side,
  opening,
  panel,
  pane,
}: {
  side: SlideSide
  opening: boolean
  /** The sidebar and its gutter, as one box: in the row while open, laid over the pane while it leaves. */
  panel: HTMLElement
  /** The pane whose edge meets the sidebar, or none to slide the sidebar alone. */
  pane: HTMLElement | null
}): Promise<boolean> {
  const distance = panel.offsetWidth
  const from = shownNow(panel, distance) ?? (opening ? 0 : 1)
  stopSlide(panel)
  const to = opening ? 1 : 0
  if (reducedMotion() || distance < 1 || Math.abs(to - from) < 0.01) return Promise.resolve(true)

  const off = side === "left" ? -distance : distance
  // The pane's layout runs from its other state (all of the way left to go) to this one; `left` is how much is.
  const leftAt = (shown: number) => (opening ? 1 - shown : shown)
  const animations: Animation[] = []
  const restores: Array<() => void> = []
  const full = motionMs(opening ? "panel" : "panel-out")
  const timing: KeyframeAnimationOptions = {
    duration: Math.max(100, full * Math.abs(to - from)),
    easing: opening ? EASE_OUT : EASE_SWIFT,
  }

  const width = pane?.offsetWidth ?? 0
  if (pane && width > 0) {
    const was = opening ? width + distance : width - distance
    // The pane's left edge: it moves with a sidebar on its left, and stays put beside one on its right.
    const paneShift = side === "left" ? (opening ? -distance : distance) : 0
    const marked = [...pane.querySelectorAll<HTMLElement>("[data-slide-anchor]")].filter((part) => part.getClientRects().length > 0)
    const now = points(pane, marked)
    const then = was > 0 ? pointsAt(pane, marked, was) : now
    const travel = new Map<HTMLElement, number>()
    marked.forEach((part, index) => travel.set(part, paneShift + then[index]! - now[index]!))
    // Parts start up to a sidebar's width past the far edge of the box they'll rest in: let them show there until
    // they do, and nowhere past its near edge, where the sidebar or the rest of the window is.
    const { overflow, clipPath } = pane.style
    pane.style.overflow = "visible"
    pane.style.clipPath = `inset(0 ${-distance}px 0 0)`
    restores.push(() => {
      pane.style.overflow = overflow
      pane.style.clipPath = clipPath
    })
    if (paneShift) animations.push(pane.animate([shift(paneShift * leftAt(from)), shift(0)], timing))
    for (const part of marked) {
      // Transforms nest: each part moves by its own travel less what its nearest marked ancestor (or the pane) does.
      const parent = part.parentElement?.closest<HTMLElement>("[data-slide-anchor]")
      const base = parent && pane.contains(parent) ? (travel.get(parent) ?? paneShift) : paneShift
      const own = travel.get(part)! - base
      if (Math.abs(own) >= 0.5) animations.push(part.animate([shift(own * leftAt(from)), shift(0)], timing))
    }
    if (was > width) {
      // What the narrower box leaves bare on its far side while it catches up: its own colour, under the sidebar.
      // A copy of the box, shifted right and starting below the chrome on its top edge (`data-slide-chrome`, on the
      // shell's own tone, which is what's under it anyway): offset by half the chrome down and shrunk by as much.
      const shadow = pane.style.boxShadow
      const colour = getComputedStyle(pane).backgroundColor
      const chrome = pane.querySelector<HTMLElement>("[data-slide-chrome]")?.getBoundingClientRect()
      const top = pane.getBoundingClientRect().top
      const half = chrome && Math.abs(chrome.top - top) < 1 ? chrome.height / 2 : 0
      pane.style.boxShadow = `${was - width + half}px ${half}px 0 ${-half}px ${colour}`
      restores.push(() => {
        pane.style.boxShadow = shadow
      })
    }
  }
  const sliding = panel.animate([shift(off * (1 - from)), shift(off * (1 - to))], { ...timing, fill: opening ? "none" : "forwards" })
  animations.push(sliding)

  running.set(panel, { animations, restore: () => restores.forEach((restore) => restore()) })
  return sliding.finished.then(
    () => {
      if (running.get(panel)?.animations !== animations) return false
      running.delete(panel)
      // The sidebar stays drawn where it ended until its caller takes it away; the rest is at rest already.
      for (const animation of animations) if (animation !== sliding) animation.cancel()
      restores.forEach((restore) => restore())
      return true
    },
    () => false
  )
}

/** Hides a sidebar leaving without a slide for the moment before it's out of the tree, or shows it again. */
function conceal(panel: HTMLElement, hidden: boolean): void {
  panel.style.visibility = hidden ? "hidden" : ""
}

/** Where a sliding sidebar is: in the tree (`present`), and laid over its pane on its way out (`leaving`). */
export interface SidePresence {
  present: boolean
  leaving: boolean
}

/**
 * A sidebar that slides in when `open` turns on and out when it turns off: `present` while it's in the row or leaving
 * it, `leaving` while it's laid over the pane on its way out. Nothing moves on the first paint, when it comes or goes
 * with a change of `context` (another tab, another Thread), or when `quiet` says nobody asked (a launch restoring it).
 */
export function useSideSlide({
  open,
  side,
  panel,
  pane,
  context = "",
  quiet,
}: {
  open: boolean
  side: SlideSide
  panel: RefObject<HTMLElement | null>
  pane: () => HTMLElement | null
  /** What the sidebar is about (a tab, a Thread): a sidebar that comes or goes with a change of it just stands there. */
  context?: string
  /** Asked as it changes: true when the change is one nobody asked the sidebar for (a launch restoring it). */
  quiet?: () => boolean
}): SidePresence {
  const [present, setPresent] = useState(open)
  if (open && !present) setPresent(true)
  const was = useRef(open)
  const about = useRef(context)
  const generation = useRef(0)
  useLayoutEffect(() => {
    const moved = about.current !== context
    about.current = context
    if (was.current === open) return
    was.current = open
    const turn = ++generation.current
    const element = panel.current
    if (element) conceal(element, false)
    if (!element || moved || quiet?.()) {
      if (!element) return
      stopSlide(element)
      if (open) return
      // Gone this frame, out of the tree as soon as React gets to it.
      conceal(element, true)
      void Promise.resolve().then(() => {
        if (generation.current === turn) setPresent(false)
      })
      return
    }
    void slideSide({ side, opening: open, panel: element, pane: pane() }).then((rested) => {
      if (rested && !open && generation.current === turn) setPresent(false)
    })
  }, [open, context, quiet, side, panel, pane])
  return { present: present || open, leaving: present && !open }
}
