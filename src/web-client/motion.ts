/**
 * The phone's motion: springs that start from where a thing is and at the finger's speed, a velocity read from the
 * finger's last moments, and resistance past an edge. Everything moves by `transform` through the Web Animations API,
 * so the main thread only lays out at the start and the end; a moving thing can be caught again at any frame
 * (`presentY`/`presentX`) and is never locked. Under reduced motion every animation is a short fade or nothing.
 */

/** The desk's two curves (`--ease-out`, `--ease-swift`) for the Web Animations API, which can't read a custom property. */
export const EASE_OUT = "cubic-bezier(0.22, 1, 0.36, 1)"
export const EASE_SWIFT = "cubic-bezier(0.2, 0, 0, 1)"

export function reducedMotion(): boolean {
  return matchMedia("(prefers-reduced-motion: reduce)").matches
}

/** How a spring settles: `response` is roughly the seconds it takes, `damping` 1 for no overshoot, under 1 for some. */
export interface Spring {
  response: number
  damping: number
}

/** A sheet or a screen let go: critically damped, quick. */
export const SETTLE: Spring = { response: 0.38, damping: 1 }
/** Thrown by a flick: a hair of overshoot, as the gesture carried momentum. */
export const THROWN: Spring = { response: 0.34, damping: 0.86 }

const STEP_S = 1 / 120

/**
 * The positions a spring passes through from `from` to `to`, starting at `velocity` (px/ms), sampled at 120 Hz until
 * it rests within half a pixel. Integrated, not solved, so any damping works the same way.
 */
export function springPath(from: number, to: number, velocity: number, spring: Spring): number[] {
  const stiffness = (2 * Math.PI / spring.response) ** 2
  const friction = (4 * Math.PI * spring.damping) / spring.response
  let x = from - to
  let v = velocity * 1000
  const path = [from]
  for (let step = 0; step < 240; step++) {
    // Semi-implicit Euler: stable at this step for the springs above.
    v += (-stiffness * x - friction * v) * STEP_S
    x += v * STEP_S
    path.push(to + x)
    if (Math.abs(x) < 0.5 && Math.abs(v) < 12) break
  }
  path[path.length - 1] = to
  return path
}

/** Where an element is moved to, in pixels. */
export interface Translation {
  x: number
  y: number
}

/** An element's translation as drawn this frame, mid-animation or not. */
export function presentTranslate(element: Element): Translation {
  const transform = getComputedStyle(element).transform
  if (!transform || transform === "none") return { x: 0, y: 0 }
  const matrix = new DOMMatrixReadOnly(transform)
  return { x: matrix.m41, y: matrix.m42 }
}

const SPRING_ID = "web-spring"

/** Stops what moves an element, leaving it where it's drawn now, and says where that is. */
export function catchElement(element: HTMLElement): Translation {
  const at = presentTranslate(element)
  for (const running of element.getAnimations()) if (running.id === SPRING_ID) running.cancel()
  return at
}

/**
 * Springs an element's translation on one axis from where it is to `to`, carrying `velocity` (px/ms), and leaves it
 * there. `also` moves companions on the same clock (the list under a screen, a backdrop's opacity) by the fraction of
 * the way gone. Resolves when it rests; a caught animation never resolves, and its catcher goes on from there.
 */
export function springTo(
  element: HTMLElement,
  axis: "x" | "y",
  to: number,
  options: { velocity?: number; spring?: Spring; also?: Array<{ element: HTMLElement; frame: (progress: number) => Keyframe }>; from?: number } = {}
): Promise<void> {
  const at = catchElement(element)
  const from = options.from ?? (axis === "x" ? at.x : at.y)
  const translate = (value: number) => (axis === "x" ? `translate3d(${value}px, 0, 0)` : `translate3d(0, ${value}px, 0)`)
  const settled = () => {
    element.style.transform = to === 0 ? "" : translate(to)
  }
  if (reducedMotion() || Math.abs(to - from) < 0.5) {
    settled()
    for (const companion of options.also ?? []) settle(companion.element, companion.frame(1))
    return Promise.resolve()
  }
  const path = springPath(from, to, options.velocity ?? 0, options.spring ?? SETTLE)
  const duration = (path.length - 1) * STEP_S * 1000
  const span = to - from
  const animation = element.animate(path.map((value) => ({ transform: translate(value) })), { id: SPRING_ID, duration, easing: "linear" })
  for (const companion of options.also ?? []) {
    for (const running of companion.element.getAnimations()) if (running.id === SPRING_ID) running.cancel()
    companion.element.animate(path.map((value) => companion.frame(span === 0 ? 1 : (value - from) / span)), { id: SPRING_ID, duration, easing: "linear", fill: "forwards" })
  }
  return animation.finished.then(
    () => {
      settled()
      for (const companion of options.also ?? []) {
        settle(companion.element, companion.frame(1))
        for (const running of companion.element.getAnimations()) if (running.id === SPRING_ID) running.cancel()
      }
    },
    // Caught mid-way: whoever caught it has it now.
    () => new Promise<void>(() => undefined)
  )
}

/** An element left as a frame draws it: each of the frame's properties set as its style. */
export function settle(element: HTMLElement, frame: Keyframe): void {
  for (const [key, value] of Object.entries(frame)) if (key !== "offset" && key !== "easing" && key !== "composite" && value !== undefined && value !== null) element.style.setProperty(key, String(value))
}

/** A finger's speed along one axis, in px/ms, from its last 100 ms: a release is judged by how it was moving, not where. */
export class Velocity {
  readonly #samples: Array<{ at: number; value: number }> = []

  add(value: number, at = performance.now()): void {
    this.#samples.push({ at, value })
    while (this.#samples.length > 2 && at - this.#samples[0]!.at > 100) this.#samples.shift()
  }

  get(): number {
    const first = this.#samples[0]
    const last = this.#samples.at(-1)
    if (!first || !last || last.at - first.at < 1) return 0
    return (last.value - first.value) / (last.at - first.at)
  }
}

/** Past an edge, the further it's pulled the less it moves, never stopping dead (as iOS scrolls past its end). */
export function rubberband(overshoot: number, dimension: number, constant = 0.55): number {
  const sign = Math.sign(overshoot)
  const distance = Math.abs(overshoot)
  return (sign * (distance * dimension * constant)) / (dimension + constant * distance)
}

/** A finger that moved this far before the gesture is decided is a scroll or a drag, not a tap. */
export const SLOP_PX = 8
