/**
 * Only what a person can see moves. A running turn's live row, a compaction
 * under way and every loading label sweep their words, in every pane that
 * shows them; scrolled out of view, in a hidden window or for a reader who
 * asked for reduced motion, they would still be repainting.
 *
 * One `IntersectionObserver` serves every animated element. Each gets
 * `--visible-animation-state` (`running` or `paused`), which CSS animations
 * read as their `animation-play-state` and descendants inherit, and
 * `--visible-animation-will-change`, so a layer is promoted only while it
 * moves. An element starts paused until the observer has seen it. (The
 * orbs, painted on a canvas by their worker, pause the same way in
 * `orb-client.ts`.)
 */

type Animated = HTMLElement | SVGElement

interface Observed {
  element: Animated
  intersecting: boolean
}

const observed = new Map<Element, Observed>()
let observer: IntersectionObserver | null = null
let reducedMotion: MediaQueryList | null = null

function apply(entry: Observed, running: boolean) {
  entry.element.style.setProperty("--visible-animation-state", running ? "running" : "paused")
  entry.element.style.setProperty("--visible-animation-will-change", running ? "transform" : "auto")
}

function update(entry: Observed) {
  apply(entry, entry.intersecting && document.visibilityState === "visible" && !reducedMotion?.matches)
}

function updateAll() {
  for (const entry of observed.values()) update(entry)
}

/**
 * Starts pausing `element`'s animations whenever it is off screen, its
 * window hidden, or motion reduced. Usable as a React ref callback: the
 * returned function stops observing and leaves the element paused.
 */
export function observeVisibleAnimation(element: Animated | null): (() => void) | undefined {
  if (element === null) return undefined
  const entry: Observed = { element, intersecting: false }
  apply(entry, false)
  if (observer === null) {
    reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)")
    reducedMotion.addEventListener("change", updateAll)
    document.addEventListener("visibilitychange", updateAll)
    observer = new IntersectionObserver((records, source) => {
      if (source !== observer) return
      for (const record of records) {
        const found = observed.get(record.target)
        if (!found) continue
        found.intersecting = record.isIntersecting
        update(found)
      }
    })
  }
  observed.set(element, entry)
  observer.observe(element)
  return () => {
    if (observed.get(element) !== entry) return
    observed.delete(element)
    observer?.unobserve(element)
    apply(entry, false)
    if (observed.size > 0) return
    observer?.disconnect()
    observer = null
    reducedMotion?.removeEventListener("change", updateAll)
    reducedMotion = null
    document.removeEventListener("visibilitychange", updateAll)
  }
}
