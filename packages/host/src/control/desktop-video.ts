import { randomUUID } from "node:crypto"
import type {
  VideoSource,
  LiveEncoder,
  LiveEncoderFactory,
  VideoSourceFrame,
} from "@mako/control-runtime/browser"
import { decodeControlVideo } from "@mako/control-runtime/contracts"
import type { DesktopMethod, DesktopParams, DesktopResult } from "../contracts/desktop-channel.js"
import type { LiveVideoSource } from "../contracts/live-video.js"
import { hostLog, hostWarn } from "../base/host-log.js"
import type { LiveVideoListener } from "./desktop-channel.js"
import type { PreviewCapture } from "./previews.js"

/** What live video needs of the desktop channel (`DesktopChannel`). */
export interface LiveVideoChannel {
  answers(method: DesktopMethod): boolean
  ask<Method extends DesktopMethod>(method: Method, params: DesktopParams<Method>): Promise<DesktopResult<Method>>
  liveVideo(session: string, listener: LiveVideoListener): () => void
}

/** Pictures a `frames` session holds between the host and its encoder; the page's encoder bounds its own. */
const FRAMES_IN_FLIGHT = 4
/** After the desktop couldn't open an encoder, `fallback` encodes for this long before it's asked again. */
const UNAVAILABLE_MS = 60_000

/**
 * The screencast's JPEGs encoded by the desktop app's WebCodecs (`contracts/live-video.ts`), hardware first: where
 * there's no video helper to encode them (Windows). A desktop that isn't attached, or can't open an encoder, leaves the
 * encode to `fallback`, which the video never hears about: the encoder it was given still sends its units.
 */
export function desktopLiveEncoder(channel: LiveVideoChannel, fallback: LiveEncoderFactory): LiveEncoderFactory {
  let unavailableUntil = 0
  return (size, fps, unit, drained, failed) => {
    if (!channel.answers("live-video-open") || performance.now() < unavailableUntil) return fallback(size, fps, unit, drained, failed)
    return new DesktopFramesEncoder(channel, size, fps, { unit, drained, failed }, (reason) => {
      unavailableUntil = performance.now() + UNAVAILABLE_MS
      hostWarn("control", "the desktop's live video encoder didn't open", { reason })
      return fallback(size, fps, unit, drained, failed)
    })
  }
}

interface EncoderEvents {
  unit: Parameters<LiveEncoderFactory>[2]
  drained: () => void
  failed: (reason: string) => void
}

class DesktopFramesEncoder implements LiveEncoder {
  readonly #session = randomUUID()
  readonly #channel: LiveVideoChannel
  readonly #events: EncoderEvents
  /** Sequences sent and not yet back as a unit or a drop. */
  readonly #inFlight = new Set<number>()
  readonly #unlisten: () => void
  #opened = false
  #closed = false
  /** The desktop ended the session itself. */
  #ended = false
  /** The encoder that took over when the desktop's didn't open. */
  #fallback?: LiveEncoder

  constructor(
    channel: LiveVideoChannel,
    size: { width: number; height: number },
    fps: number,
    events: EncoderEvents,
    fallback: (reason: string) => LiveEncoder
  ) {
    this.#channel = channel
    this.#events = events
    this.#unlisten = channel.liveVideo(this.#session, {
      packet: (bytes) => {
        if (this.#closed) return
        let packet
        try {
          packet = decodeControlVideo(bytes)
        } catch (error) {
          return this.#fail(error instanceof Error ? error.message : String(error))
        }
        if (!this.#inFlight.delete(packet.sequence)) return
        events.unit(packet)
        events.drained()
      },
      dropped: (sequence) => {
        if (!this.#closed && this.#inFlight.delete(sequence)) events.drained()
      },
      ended: (reason) => {
        this.#ended = true
        this.#fail(reason)
      },
    })
    channel.ask("live-video-open", { session: this.#session, source: { kind: "frames" }, fps, box: null }).then(
      ({ encoder }) => {
        if (this.#closed) return
        this.#opened = true
        hostLog("control", "the desktop encodes live video", { encoder, width: size.width, height: size.height })
        events.drained()
      },
      (error: Error) => {
        if (this.#closed) return
        this.#unlisten()
        this.#fallback = fallback(error.message)
        events.drained()
      }
    )
  }

  ready(): boolean {
    if (this.#fallback) return this.#fallback.ready()
    return this.#opened && !this.#closed && this.#inFlight.size < FRAMES_IN_FLIGHT
  }

  submit(frame: VideoSourceFrame): void {
    if (this.#fallback) return this.#fallback.submit(frame)
    if (this.#closed) return
    this.#inFlight.add(frame.sequence)
    this.#channel.ask("live-video-frame", {
      session: this.#session,
      data: frame.bytes.toString("base64"),
      sequence: frame.sequence,
      capturedAt: frame.capturedAt,
    }).then(
      () => {},
      (error: Error) => this.#fail(error.message)
    )
  }

  close(): void {
    this.#fallback?.close()
    if (this.#closed) return
    this.#closed = true
    this.#unlisten()
    if (!this.#fallback && !this.#ended) void this.#channel.ask("live-video-close", { session: this.#session }).catch(() => {})
  }

  #fail(reason: string): void {
    if (this.#closed) return
    this.close()
    this.#events.failed(reason)
  }
}

/**
 * A capture the desktop app encodes where its pixels are: a desk window as a tab, or an app's window or a display
 * through the system's capturer. Nothing crosses to the host but units.
 */
export function desktopCapture(channel: LiveVideoChannel, source: LiveVideoSource): VideoSource {
  return async (consumer) => {
    if (!channel.answers("live-video-open")) throw new Error("Mako's desktop app isn't open to capture this.")
    const session = randomUUID()
    const box = () => consumer.size() ?? null
    const unlisten = channel.liveVideo(session, {
      packet: (bytes) => {
        let packet
        try {
          packet = decodeControlVideo(bytes)
        } catch (error) {
          return consumer.ended(error instanceof Error ? error.message : String(error))
        }
        consumer.unit(packet)
      },
      dropped: () => {},
      ended: (reason) => consumer.ended(reason),
    })
    try {
      const { encoder } = await channel.ask("live-video-open", { session, source, fps: consumer.fps, box: box() })
      hostLog("control", "the desktop captures live video", { source: source.kind, encoder })
    } catch (error) {
      unlisten()
      throw error
    }
    return {
      key: () => void channel.ask("live-video-key", { session }).catch(() => {}),
      // A desktop older than the ask keeps the rate it chose.
      rate: (bitrate) => void channel.ask("live-video-rate", { session, bitrate: Math.round(bitrate) }).catch(() => {}),
      resized: async () => {
        await channel.ask("live-video-resize", { session, box: box() })
      },
      stop: async () => {
        unlisten()
        await channel.ask("live-video-close", { session }).catch(() => {})
      },
    }
  }
}

/**
 * The captures a preview's remote viewers get from the desktop app: Mako's own desk windows (`deskPage` names the
 * desktop's page for a tab of the desk browser) and any app's window. None while no desktop app answers.
 */
export function desktopPreviewCapture(channel: LiveVideoChannel, deskPage: (browser: string, tab: string) => string | undefined): PreviewCapture {
  return {
    tab(target) {
      const page = deskPage(target.browser, target.tab)
      return page && channel.answers("live-video-open") ? desktopCapture(channel, { kind: "page", page }) : undefined
    },
    window(target) {
      return channel.answers("live-video-open") ? desktopCapture(channel, { kind: "window", windowId: target.windowId }) : undefined
    },
  }
}
