import type { OrbSize, OrbState } from "thinking-orbs/engine"
import type { OrbTint } from "./orb-protocol"

/*
 * The main thread's half of the orb worker: it hands each orb's canvas over
 * once, then sends only what changes — its state, its ink, whether it is on
 * screen — and never paints.
 */

let worker: Worker | null = null
let unavailable = false
let nextId = 1
const visibility = new Map<Element, number>()
let observer: IntersectionObserver | null = null

function supported(): boolean {
  return (
    "Worker" in globalThis &&
    "OffscreenCanvas" in globalThis &&
    "transferControlToOffscreen" in HTMLCanvasElement.prototype
  )
}

function reducedMotion(): boolean {
  return matchMedia("(prefers-reduced-motion: reduce)").matches
}

function postPage() {
  worker?.postMessage({
    type: "page",
    hidden: document.visibilityState === "hidden",
    reduced: reducedMotion(),
  })
}

function start(): Worker | null {
  if (worker || unavailable) return worker
  if (!supported()) {
    unavailable = true
    return null
  }
  try {
    worker = new Worker(new URL("./orb.worker.ts", import.meta.url), { type: "module" })
  } catch (error) {
    console.error("Orb worker could not start:", error)
    unavailable = true
    return null
  }
  worker.onerror = (event) => console.error("Orb worker failed:", event.message)
  document.addEventListener("visibilitychange", postPage)
  matchMedia("(prefers-reduced-motion: reduce)").addEventListener("change", postPage)
  observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const id = visibility.get(entry.target)
      if (id) worker?.postMessage({ type: "visible", id, visible: entry.isIntersecting })
    }
  })
  postPage()
  return worker
}

/** Whether orbs can be drawn off the main thread in this renderer. */
export function orbWorkerAvailable(): boolean {
  return start() !== null
}

export interface OrbSettings {
  state: OrbState
  dark: boolean
  tint?: OrbTint
  paused: boolean
}

export interface OrbHandle {
  update(settings: OrbSettings): void
  remove(): void
}

export function mountOrb(
  canvas: HTMLCanvasElement,
  size: OrbSize,
  settings: OrbSettings
): OrbHandle | null {
  const target = start()
  if (!target || !observer) return null
  const id = nextId++
  const offscreen = canvas.transferControlToOffscreen()
  target.postMessage(
    {
      type: "add",
      id,
      canvas: offscreen,
      size,
      dpr: Math.min(2, devicePixelRatio || 1),
      ...settings,
    },
    [offscreen]
  )
  visibility.set(canvas, id)
  observer.observe(canvas)
  return {
    update: (next) => target.postMessage({ type: "update", id, ...next }),
    remove: () => {
      observer?.unobserve(canvas)
      visibility.delete(canvas)
      target.postMessage({ type: "remove", id })
    },
  }
}

const tints = new Map<string, OrbTint | undefined>()
let probe: CanvasRenderingContext2D | null = null

/**
 * A CSS colour as the orb's ink. Computed colours can be `oklch()`, which
 * the orb cannot parse, so the colour is painted once and read back.
 */
export function tintOf(color: string): OrbTint | undefined {
  if (tints.has(color)) return tints.get(color)
  probe ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true })
  if (!probe) return undefined
  probe.clearRect(0, 0, 1, 1)
  probe.fillStyle = color
  probe.fillRect(0, 0, 1, 1)
  const [r = 0, g = 0, b = 0, a = 0] = probe.getImageData(0, 0, 1, 1).data
  const tint = a ? { r, g, b } : undefined
  tints.set(color, tint)
  return tint
}
