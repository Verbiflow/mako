import type { Frame } from "./grade.ts"

/*
 * What runs in the page under test, on any target: a frame sampler over the open Thread's transcript, and a listener
 * for the web client's own readings. Each is a self-contained function, so a target that evaluates source (WebKit's
 * inspector on a simulator) runs the same code as one that evaluates functions (the stand-in).
 */

interface Sampled {
  frames: Frame[]
  running: boolean
}

declare global {
  interface Window {
    __mobileFrames?: Sampled
    /** Each `detail` the web client's probe said, in order. */
    __mobileReadings?: unknown[]
  }
}

/** Reads every animation frame of the transcript in `live` into `window.__mobileFrames` until `stopSampler`. */
export function startSampler(live: string): void {
  const scroller = document.querySelector<HTMLElement>(`${live} [data-transcript-viewport]`)
  if (!scroller) throw new Error(`no transcript under ${live} to sample`)
  const sampled: Sampled = { frames: [], running: true }
  window.__mobileFrames = sampled
  const tick = () => {
    if (!sampled.running) return
    const top = scroller.getBoundingClientRect().top
    const height = scroller.clientHeight
    const rows: Array<[string, number]> = []
    for (const row of scroller.querySelectorAll<HTMLElement>("[data-exchange]")) {
      const box = row.getBoundingClientRect()
      if (box.bottom - top > 0 && box.top - top < height) rows.push([row.dataset["exchange"] ?? "", box.top - top])
    }
    sampled.frames.push({ at: performance.now(), fromEnd: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight, rows })
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

export function stopSampler(): Frame[] {
  const sampled = window.__mobileFrames
  if (!sampled) return []
  sampled.running = false
  return sampled.frames
}

/**
 * A finger dragging the transcript `dy` points down (negative is up) over `ms`, where the target can't scroll by touch
 * itself: as iOS's pan is to the page, a touch down, the browser's own pan cancelling the pointer, the scroller moved a
 * step at a time in tasks of its own (where a stream may land between a step and its scroll event), and one
 * `scrollend` after the finger lifts, none between its steps.
 */
export function swipeInPage({ live, dy, ms }: { live: string; dy: number; ms: number }): Promise<void> {
  const node = document.querySelector<HTMLElement>(`${live} [data-transcript-viewport]`)
  if (!node) throw new Error(`no transcript under ${live} to swipe`)
  const box = node.getBoundingClientRect()
  const finger = { identifier: 1, target: node, clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 }
  const touch = (type: "touchstart" | "touchend") => {
    const event = new Event(type, { bubbles: true, cancelable: true })
    const down = type === "touchend" ? [] : [finger]
    Object.defineProperties(event, { touches: { value: down }, targetTouches: { value: down }, changedTouches: { value: [finger] } })
    node.dispatchEvent(event)
  }
  const own = (event: Event) => {
    if (event.target === node) event.stopImmediatePropagation()
  }
  return new Promise((done) => {
    addEventListener("scrollend", own, true)
    touch("touchstart")
    node.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch", isPrimary: true }))
    node.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerType: "touch", isPrimary: true }))
    const steps = Math.max(4, Math.round(ms / 16))
    let left = steps
    const step = () => {
      node.scrollTop -= dy / steps
      if (--left > 0) {
        requestAnimationFrame(() => setTimeout(step, 8))
        return
      }
      touch("touchend")
      setTimeout(() => {
        removeEventListener("scrollend", own, true)
        node.dispatchEvent(new Event("scrollend"))
        done()
      }, 100)
    }
    step()
  })
}

/** Run before the page's own scripts: keeps every reading the web client's probe says, from its first. */
export function listenForReadings(event: string): void {
  const readings: unknown[] = []
  window.__mobileReadings = readings
  window.addEventListener(event, (said) => {
    if (said instanceof CustomEvent) readings.push(said.detail)
  })
}

/** Each reading said so far, unparsed: the runner parses them, outside the page. */
export function takeReadings(): string[] {
  return (window.__mobileReadings ?? []).map((said) => JSON.stringify(said))
}
