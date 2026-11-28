/**
 * The desk's motion tokens for code that animates by the Web Animations API, which can't read a custom property: the
 * two curves, and the durations `index.css` declares (`--duration-*`), read from there so they're written once.
 */

/** `--ease-out`: everything that arrives. */
export const EASE_OUT = "cubic-bezier(0.22, 1, 0.36, 1)"
/** `--ease-swift`: everything that leaves, a little faster than it came. */
export const EASE_SWIFT = "cubic-bezier(0.2, 0, 0, 1)"

export type MotionDuration = "press" | "menu" | "menu-out" | "switch" | "panel" | "panel-out"

const FALLBACK = { press: 120, menu: 160, "menu-out": 120, switch: 140, panel: 240, "panel-out": 200 } satisfies Record<MotionDuration, number>
const read = new Map<MotionDuration, number>()

/** A `--duration-<name>` token in milliseconds. */
export function motionMs(name: MotionDuration): number {
  const known = read.get(name)
  if (known !== undefined) return known
  const value = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(`--duration-${name}`))
  const ms = Number.isFinite(value) && value > 0 ? value : FALLBACK[name]
  read.set(name, ms)
  return ms
}

export function reducedMotion(): boolean {
  return matchMedia("(prefers-reduced-motion: reduce)").matches
}
