import { z } from "zod"
import {
  BrowserConnection,
  type BrowserProtocolEvent,
} from "./browser-connection.js"
import { BrowserFault } from "./contracts/browser-control.js"
import type { JsonObject } from "./codex-app-json.js"

const rectangle = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
})
const viewport = z.object({
  pageX: z.number(),
  pageY: z.number(),
  clientWidth: z.number().positive(),
  clientHeight: z.number().positive(),
})
const LayoutMetricsSchema = z.object({
  cssContentSize: rectangle,
  cssVisualViewport: viewport,
})
export type LayoutMetrics = z.infer<typeof LayoutMetricsSchema>
export interface ElementBox {
  x: number
  y: number
  width: number
  height: number
}

export async function pageMetrics(
  connection: BrowserConnection,
  sessionId: string,
  signal: AbortSignal
): Promise<LayoutMetrics> {
  return LayoutMetricsSchema.parse(
    await connection.send("Page.getLayoutMetrics", {}, signal, sessionId)
  )
}

/**
 * Choose a capture clip whose longest side stays within `maxSide` device
 * pixels. The clip scale multiplies CSS pixels by the device pixel ratio, so
 * `1 / ratio` yields one image pixel per CSS pixel; further scaling only ever
 * shrinks the image, never upsamples it.
 */
export async function screenshotGeometry(
  connection: BrowserConnection,
  sessionId: string,
  options: {
    fullPage: boolean
    maxSide: number
    box?: ElementBox
    region?: ElementBox
  },
  signal: AbortSignal
) {
  const metrics = await pageMetrics(connection, sessionId, signal)
  const visible = metrics.cssVisualViewport
  const content = metrics.cssContentSize
  if (
    options.region &&
    (options.region.x + options.region.width > visible.clientWidth ||
      options.region.y + options.region.height > visible.clientHeight)
  )
    throw new BrowserFault({
      code: "invalid-request",
      message:
        "The screenshot region extends outside the current viewport. Capture the viewport again and choose a rectangle within its width and height.",
      outcome: "not-dispatched",
    })
  const area = options.box
    ? {
        x: Math.max(content.x, options.box.x),
        y: Math.max(content.y, options.box.y),
        width: Math.max(1, Math.min(options.box.width, content.width)),
        height: Math.max(1, Math.min(options.box.height, content.height)),
      }
    : options.region
      ? {
          x: visible.pageX + options.region.x,
          y: visible.pageY + options.region.y,
          width: options.region.width,
          height: options.region.height,
        }
      : options.fullPage
        ? content
        : {
            x: visible.pageX,
            y: visible.pageY,
            width: visible.clientWidth,
            height: visible.clientHeight,
          }
  const density = z
    .object({ result: z.object({ value: z.number().positive().max(16) }) })
    .parse(
      await connection.send(
        "Runtime.evaluate",
        { expression: "window.devicePixelRatio", returnByValue: true },
        signal,
        sessionId
      )
    ).result.value
  const longest = Math.max(area.width, area.height)
  const scale = Math.min(
    1 / density,
    options.maxSide / (longest * density),
    Math.sqrt(16_000_000 / (area.width * area.height)) / density
  )
  return {
    clip: { ...area, scale },
    viewport: visible,
    content,
    devicePixelRatio: density,
  }
}

export type NavigationWait = "load" | "domcontentloaded" | "commit"

/** Subscribe before navigation so even a cached document cannot outrun the waiter. */
export async function navigatePage(
  connection: BrowserConnection,
  sessionId: string,
  url: string,
  signal: AbortSignal,
  waitUntil: NavigationWait = "load",
  timeoutMs = 30_000
): Promise<JsonObject> {
  await connection.send(
    "Page.setLifecycleEventsEnabled",
    { enabled: true },
    signal,
    sessionId
  )
  const events: BrowserProtocolEvent[] = []
  let wake: (() => void) | undefined
  const unsubscribe = connection.onEvent((event) => {
    if (event.sessionId !== sessionId || event.method !== "Page.lifecycleEvent")
      return
    events.push(event)
    wake?.()
  })
  const disconnected = new AbortController()
  const removeClose = connection.onClose(() => disconnected.abort())
  try {
    // Lifecycle events buffered before the command is sent belong to the
    // previous document. The reply and the new document's events can arrive
    // in one chunk, so the boundary is taken before dispatch, not after.
    const first = events.length
    const result = await connection.send(
      "Page.navigate",
      { url },
      AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      sessionId
    )
    const navigation = z
      .object({
        frameId: z.string(),
        loaderId: z.string().optional(),
        errorText: z.string().optional(),
        isDownload: z.boolean().optional(),
      })
      .parse(result)
    if (navigation.errorText)
      throw new BrowserFault({
        code: "protocol-error",
        message: navigation.errorText,
        outcome: "rejected",
      })
    if (!navigation.loaderId || navigation.isDownload)
      return {
        ...result,
        completion: navigation.isDownload ? "download" : "same-document",
      }
    if (waitUntil === "commit") return { ...result, completion: "commit" }
    const wanted = waitUntil === "load" ? "load" : "DOMContentLoaded"
    // A redirect replaces the loader, so any later lifecycle event for this
    // frame counts; the frame identity and event order are the evidence.
    const reached = () =>
      events
        .slice(first)
        .some(
          (event) =>
            event.params.frameId === navigation.frameId &&
            event.params.name === wanted
        )
    const waiting = AbortSignal.any([
      signal,
      AbortSignal.timeout(timeoutMs),
      disconnected.signal,
    ])
    const completion = await new Promise<
      "load" | "domcontentloaded" | "timeout"
    >((resolve, reject) => {
      const abort = () => {
        waiting.removeEventListener("abort", abort)
        if (signal.aborted || disconnected.signal.aborted)
          reject(
            new BrowserFault({
              code: "outcome-unknown",
              message:
                "Navigation was dispatched but its completion was not observed. Observe the target before continuing.",
              outcome: "unknown",
            })
          )
        else resolve("timeout")
      }
      wake = () => {
        if (reached()) {
          waiting.removeEventListener("abort", abort)
          resolve(waitUntil)
        }
      }
      waiting.addEventListener("abort", abort, { once: true })
      if (waiting.aborted) abort()
      else wake()
    })
    const value: JsonObject = { ...result, completion }
    if (completion === "timeout")
      value.note = `The navigation committed but ${wanted} was not observed within ${timeoutMs} ms. Observe the tab before acting on it.`
    return value
  } finally {
    unsubscribe()
    removeClose()
  }
}
