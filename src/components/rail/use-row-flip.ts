import { useLayoutEffect, useRef, type RefObject } from "react"

/**
 * Rows that change place glide there instead of teleporting.
 *
 * Every rail row and header carries a `data-flip-key`. After each commit the
 * rows' positions are read once; a row whose top moved since the previous
 * commit is animated from where it was to where it is, over transform only,
 * so the main thread pays nothing while tokens land next door. A row that
 * was not there before arrives with the same short ease-out the rest of the
 * desk uses. Nothing animates on first fill, on a change of scene (another
 * view, a search) — those arrive, they do not move — offscreen, or under
 * reduced motion.
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

export function useRowFlip(
  scroller: RefObject<HTMLElement | null>,
  scene: string
): void {
  const previous = useRef<{ scene: string; tops: Map<string, number> } | null>(
    null
  )
  useLayoutEffect(() => {
    const root = scroller.current
    if (!root) return
    const nodes = [...root.querySelectorAll<HTMLElement>("[data-flip-key]")]
    // A move still in flight would be measured mid-glide; settle it first.
    for (const node of nodes)
      for (const running of node.getAnimations())
        if (running.id === FLIP) running.cancel()
    const tops = new Map<string, number>()
    for (const node of nodes) {
      const key = node.dataset["flipKey"]
      if (key) tops.set(key, node.getBoundingClientRect().top)
    }
    const before = previous.current
    previous.current = { scene, tops }
    if (!before || before.scene !== scene) return
    if (document.hidden || reducedMotion()) return
    const bounds = root.getBoundingClientRect()
    const near = (top: number) =>
      top >= bounds.top - NEAR_PX && top <= bounds.bottom + NEAR_PX
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
}
