import { z } from "zod"
import { imageSize } from "image-size"
import type { BrowserFocus } from "./browser-focus.js"
import type { BrowserConnection } from "./browser-connection.js"

export type CaptureConnection = Pick<
  BrowserConnection,
  "send" | "onEvent" | "onClose"
>
export interface BrowserFrame {
  data: string
  width: number
  height: number
  viewportWidth: number
  viewportHeight: number
  pageScaleFactor: number
  offsetTop: number
  capturedAt: number
}
const frameSchema = z.object({
  sessionId: z.number(),
  data: z.string().max(12_000_000),
  metadata: z.object({
    deviceWidth: z.number().positive(),
    deviceHeight: z.number().positive(),
    pageScaleFactor: z.number().positive(),
    offsetTop: z.number().finite(),
    timestamp: z.number().finite().optional(),
  }),
})
interface Subscriber {
  frame: (frame: BrowserFrame) => void
  ended: (reason: string) => void
}

/** A tab has one screencast, shared by recording and visible previews. */
export class BrowserCapture {
  private readonly subscribers = new Set<Subscriber>()
  private tail: Promise<void> = Promise.resolve()
  private running = false
  private closed = false
  private suspended = false
  private latest: BrowserFrame | undefined
  private readonly unlisten: () => void
  private readonly unclose: () => void
  private readonly connection: CaptureConnection
  private readonly sessionId: string
  private releaseFocus?: () => Promise<void>
  private ending?: Promise<void>
  constructor(connection: CaptureConnection, sessionId: string, private readonly focus?: BrowserFocus) {
    this.connection = connection
    this.sessionId = sessionId
    this.unlisten = connection.onEvent((event) => {
      if (
        event.method === "Target.detachedFromTarget" &&
        event.params.sessionId === sessionId
      ) {
        this.end("Recording target detached")
        return
      }
      if (
        event.sessionId !== sessionId ||
        event.method !== "Page.screencastFrame"
      )
        return
      const parsed = frameSchema.safeParse(event.params)
      // ACK independently of disk, encoding and UI speed. Each consumer bounds its own work.
      const id = z.number().safeParse(event.params.sessionId)
      if (id.success)
        void connection
          .send(
            "Page.screencastFrameAck",
            { sessionId: id.data },
            AbortSignal.timeout(2000),
            sessionId
          )
          .catch(() => {})
      if (!parsed.success) {
        this.end("The browser returned an invalid video frame")
        return
      }
      if (!this.running || this.suspended || this.closed) return
      try {
        const value = parsed.data
        const { width, height } = imageSize(Buffer.from(value.data, "base64"))
        if (width * height > 16_000_000)
          throw new Error("Video frame exceeds the pixel budget")
        this.latest = {
          data: value.data,
          width,
          height,
          viewportWidth: value.metadata.deviceWidth,
          viewportHeight: value.metadata.deviceHeight,
          pageScaleFactor: value.metadata.pageScaleFactor,
          offsetTop: value.metadata.offsetTop,
          capturedAt:
            value.metadata.timestamp === undefined
              ? Date.now()
              : value.metadata.timestamp * 1000,
        }
        for (const subscriber of this.subscribers) {
          try {
            subscriber.frame(this.latest)
          } catch {
            this.subscribers.delete(subscriber)
            this.notifyEnd(
              subscriber,
              "Capture subscription authorization ended"
            )
          }
        }
        if (!this.subscribers.size)
          void this.enqueue(() => this.stop()).catch(() => {})
      } catch {
        this.end("The browser returned invalid video pixels")
      }
    })
    this.unclose = connection.onClose(() =>
      this.end("Browser connection ended")
    )
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation)
    this.tail = result.then(
      () => {},
      () => {}
    )
    return result
  }
  private async start() {
    if (this.closed) throw new Error("Browser capture attachment ended")
    if (this.running || !this.subscribers.size) return
    if (!this.releaseFocus && this.focus) {
      const release = await this.focus.acquire()
      if (this.closed || !this.subscribers.size) {
        await release()
        throw new Error("Browser capture attachment ended")
      }
      this.releaseFocus = release
    }
    this.running = true
    try {
      await this.connection.send(
        "Page.startScreencast",
        {
          format: "jpeg",
          quality: 90,
          // Bound video at the selected 1080p budget without changing the page
          // viewport or the independent full-detail screenshot route.
          maxWidth: 1920,
          maxHeight: 1080,
          everyNthFrame: 1,
        },
        AbortSignal.timeout(5000),
        this.sessionId
      )
    } catch (error) {
      this.end("Capture startup failed")
      throw error
    }
  }
  private async stop() {
    if (!this.running || this.closed) return
    this.running = false
    try {
      await this.connection.send(
        "Page.stopScreencast",
        {},
        AbortSignal.timeout(2000),
        this.sessionId
      )
    } catch {
      // Never leave an unwanted capture running. Release only its exact attachment.
      await this.connection.send(
        "Target.detachFromTarget",
        { sessionId: this.sessionId },
        AbortSignal.timeout(2000)
      ).catch(() => {})
      this.end("Capture stop failed; the exact tab attachment was released")
      throw new Error(
        "Capture stop failed; the exact tab attachment was released"
      )
    } finally {
      if (!this.subscribers.size && !this.suspended) await this.releaseFocusHold()
    }
  }
  private async releaseFocusHold() {
    const release = this.releaseFocus
    this.releaseFocus = undefined
    await release?.()
  }
  async subscribe(subscriber: Subscriber): Promise<() => Promise<void>> {
    if (this.closed) throw new Error("Browser capture attachment ended")
    const cached = this.latest
    this.subscribers.add(subscriber)
    try {
      await this.enqueue(() => this.start())
      if (this.closed) throw new Error("Browser capture attachment ended")
      if (cached && this.latest === cached) subscriber.frame(cached)
    } catch (error) {
      this.subscribers.delete(subscriber)
      await this.ending
      await this.enqueue(async () => {
        if (!this.subscribers.size) await this.stop()
      })
      throw error
    }
    let released = false
    return async () => {
      if (released) return
      released = true
      this.subscribers.delete(subscriber)
      await this.enqueue(async () => {
        if (!this.subscribers.size) {
          await this.stop()
          this.latest = undefined
        }
      })
    }
  }
  /** CDP clipped screenshots can resize the compositor. Never admit those transient frames. */
  screenshot<T>(capture: () => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      if (this.closed) throw new Error("Browser capture attachment ended")
      this.suspended = true
      this.latest = undefined
      try {
        await this.stop()
        return await capture()
      } finally {
        try {
          if (this.subscribers.size && !this.closed) {
            // Full-page/raw CDP clips temporarily resize the surface. Restore a
            // full-view capture before resuming; ordinary crops never use this path.
            await this.connection.send("Page.captureScreenshot", {
              format: "png", optimizeForSpeed: true, captureBeyondViewport: false,
            }, AbortSignal.timeout(5000), this.sessionId)
          }
          this.suspended = false
          if (!this.subscribers.size) await this.releaseFocusHold()
          await this.start()
        } catch {
          this.suspended = false
          this.end("Capture could not resume after the screenshot")
        }
      }
    })
  }
  private notifyEnd(subscriber: Subscriber, reason: string) {
    try {
      subscriber.ended(reason)
    } catch {
      /* One consumer cannot strand another. */
    }
  }
  end(reason: string) {
    if (this.closed) return
    this.closed = true
    const stop = this.running
      ? this.connection.send("Page.stopScreencast", {}, AbortSignal.timeout(2000), this.sessionId)
          .catch(() => this.connection.send("Target.detachFromTarget", { sessionId: this.sessionId }, AbortSignal.timeout(2000)).catch(() => {}))
      : Promise.resolve()
    this.ending = stop.then(() => {}).finally(() => this.releaseFocusHold()).catch(() => {})
    this.running = false
    this.latest = undefined
    this.unlisten()
    this.unclose()
    for (const subscriber of this.subscribers)
      this.notifyEnd(subscriber, reason)
    this.subscribers.clear()
  }
}
