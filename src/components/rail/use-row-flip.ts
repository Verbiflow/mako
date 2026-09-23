import { useLayoutEffect, useRef, type RefObject } from "react"

/**
 * Rows that change place glide there instead of teleporting.
 *
 * Every rail row and header carries a `data-flip-key`. After each commit the
 * rows' positions are read once; a row whose place in the list moved since
 * the previous commit is animated from where it was to where it is, over
 * transform only, so the main thread pays nothing while tokens land next
 * door. A row that was not there before arrives with the same short ease-out
 * the rest of the desk uses. Nothing animates on first fill, on a change of
 * scene (another view, a search) — those arrive, they do not move —
 * offscreen, or under reduced motion.
 *
 * **A place is measured inside the scrolled content, never on screen.** The
 * viewport rectangle was the whole bug behind the rail "jumping around":
 * scrolling moves every row's `getBoundingClientRect().top` without moving
 * any row relative to the others, so the next commit for any reason at all —
 * the minute timer, a thread reporting, the pointer entering and freezing the
 * order — read the scroll distance as a move and slid the entire visible list
 * back through it. Scroll the rail, then move the mouse into it, and the
 * whole column lurched. An offset within the content changes only when a row
 * actually changes place, which is the one thing worth animating.
 */
const FLIP = "rail-flip"
const MOVE_MS = 220
const ENTER_MS = 160
/** How far outside the scroller a row may sit and still be worth moving. */
const NEAR_PX = 80

let easeOut: string | null = null

function easing(): string {
  easeOut ??=
    getComputedStyle(document.documentElement).getPropertyValue("--ease-out").trim() ||
    "ease-out"
  return easeOut
}

function reducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

function measure(root: HTMLElement, nodes: HTMLElement[]) {
  const bounds = root.getBoundingClientRect()
  // The row's top within the scrolled content: what the scrollbar reveals,
  // not what the window happens to be showing.
  const origin = bounds.top - root.scrollTop
  const tops = new Map<string, number>()
  for (const node of nodes) {
    const key = node.dataset["flipKey"]
    if (key) tops.set(key, node.getBoundingClientRect().top - origin)
  }
  return { bounds, origin, tops }
}

/**
 * Most commits (a selection, a status pip, the minute timer) leave every
 * row where it was. Reading each row's rectangle forces layout inside the
 * commit, so those commits only note the order, and the places are read
 * again when the frame is idle, ready for the next commit that moves a row.
 */
export function useRowFlip(
  scroller: RefObject<HTMLElement | null>,
  scene: string
): void {
  const previous = useRef<{
    scene: string
    order: string
    tops: Map<string, number>
  } | null>(null)
  const refresh = useRef<number | null>(null)
  useLayoutEffect(() => {
    const root = scroller.current
    if (!root) return
    const nodes = [...root.querySelectorAll<HTMLElement>("[data-flip-key]")]
    const order = nodes.map((node) => node.dataset["flipKey"] ?? "").join("\n")
    if (refresh.current !== null) {
      cancelIdleCallback(refresh.current)
      refresh.current = null
    }
    const before = previous.current
    if (before && before.scene === scene && before.order === order) {
      refresh.current = requestIdleCallback(() => {
        refresh.current = null
        if (previous.current !== before) return
        const gliding = nodes.some((node) =>
          node.getAnimations().some((running) => running.id === FLIP)
        )
        if (gliding) return
        previous.current = { scene, order, tops: measure(root, nodes).tops }
      })
      return
    }
    // A move still in flight would be measured mid-glide; settle it first.
    for (const node of nodes)
      for (const running of node.getAnimations())
        if (running.id === FLIP) running.cancel()
    const { bounds, origin, tops } = measure(root, nodes)
    previous.current = { scene, order, tops }
    if (!before || before.scene !== scene) return
    if (document.hidden || reducedMotion()) return
    // Back to screen coordinates for the "is this worth animating" test: a
    // row nobody can see should not schedule an animation.
    const near = (top: number) =>
      top + origin >= bounds.top - NEAR_PX && top + origin <= bounds.bottom + NEAR_PX
    for (const node of nodes) {
      const key = node.dataset["flipKey"]
      if (!key) continue
      const now = tops.get(key)
      if (now === undefined) continue
      const was = before.tops.get(key)
      if (was === undefined) {
        if (near(now))
          node.animate(
            [
              { opacity: 0, transform: "translateY(4px)" },
              { opacity: 1, transform: "none" },
            ],
            { id: FLIP, duration: ENTER_MS, easing: easing() }
          )
        continue
      }
      const delta = was - now
      if (Math.abs(delta) < 1 || (!near(now) && !near(was))) continue
      node.animate(
        [{ transform: `translateY(${delta}px)` }, { transform: "none" }],
        { id: FLIP, duration: MOVE_MS, easing: easing() }
      )
    }
  })
  useLayoutEffect(
    () => () => {
      if (refresh.current !== null) cancelIdleCallback(refresh.current)
    },
    []
  )
}
