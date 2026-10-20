import { BrowserVideo, type BrowserVideoOptions, type BrowserVideoSource, type BrowserVideoViewer } from "@mako/control-runtime/browser"

/** The largest picture a viewer draws, in device pixels. */
export interface VideoBox {
  width: number
  height: number
}

/** Why a remote viewer's video stopped: no turn drives the tab, the preview ended, or the video failed. */
export type PreviewVideoEnd = { kind: "paused" | "gone" | "failed"; reason: string }

/** One remote viewer's stream, on the Thread's link. */
export interface PreviewVideoSender {
  /** False once the stream ended or its link closed. */
  send(packet: Uint8Array): boolean
  end(why: PreviewVideoEnd): void
}

interface Viewer {
  box: VideoBox | undefined
  sender: PreviewVideoSender
  /** Bytes sent, and the most the viewer said it took: their difference is what's still on the way. */
  sent: number
  acked: number
  /** The video it's in now, and how it's known there; none while the preview shows no tab. */
  joined?: { video: BrowserVideo; port: BrowserVideoViewer; leave?: () => Promise<void> }
}

/** A preview's tab, as the video reads it: `key` names the tab and who drives it, so the same tab isn't joined twice. */
export interface PreviewVideoTab {
  key: string
  source: BrowserVideoSource
}

/** At most this many remote viewers watch one preview. */
const VIEWERS = 8
/** How often a preview with viewers checks whether its turn ended, since a still page sends no frame that would say so. */
const PAUSE_CHECK_MS = 1_000

/**
 * A preview's remote viewers and the one encode they share. Viewers outlive the tab they watch: when the agent moves to
 * another tab they're moved to its video, so a viewer's stream ends only when the turn pauses, the preview ends, or the
 * video fails. Nothing here touches the preview's local frames or the activity windows hear.
 */
export class PreviewVideo {
  readonly #viewers = new Map<string, Viewer>()
  readonly #paused: () => boolean
  readonly #options: BrowserVideoOptions
  #tab?: PreviewVideoTab
  #video?: BrowserVideo
  #pauseCheck?: NodeJS.Timeout

  constructor(paused: () => boolean, options: BrowserVideoOptions = {}) {
    this.#paused = paused
    this.#options = options
  }

  get watched(): boolean {
    return this.#viewers.size > 0
  }

  /** A viewer watches, or watches again: with a new box, and for a fresh picture, since it may have lost its own. */
  watch(stream: string, box: VideoBox | undefined, sender: PreviewVideoSender): void {
    const known = this.#viewers.get(stream)
    if (known) {
      known.box = box
      if (known.joined) {
        void known.joined.video.resized().catch(() => {})
        known.joined.video.refresh(known.joined.port)
      }
      return
    }
    if (this.#viewers.size >= VIEWERS) return sender.end({ kind: "failed", reason: `A preview has at most ${VIEWERS} remote viewers` })
    if (this.#paused()) return sender.end({ kind: "paused", reason: "No turn is driving this tab" })
    const viewer: Viewer = { box, sender, sent: 0, acked: 0 }
    this.#viewers.set(stream, viewer)
    this.#checkPause()
    if (this.#tab) this.#join(stream, viewer)
  }

  acked(stream: string, received: number): void {
    const viewer = this.#viewers.get(stream)
    if (viewer) viewer.acked = Math.max(viewer.acked, Math.min(received, viewer.sent))
  }

  unwatched(stream: string): void {
    const viewer = this.#viewers.get(stream)
    if (!viewer) return
    this.#viewers.delete(stream)
    this.#leave(viewer)
    if (!this.#viewers.size) this.#idle()
  }

  /** The tab the preview shows now, or none while it has none: viewers move with it. */
  show(tab: PreviewVideoTab | undefined): void {
    if (tab?.key === this.#tab?.key) return
    this.#tab = tab
    this.#closeVideo()
    if (tab) for (const [stream, viewer] of this.#viewers) this.#join(stream, viewer)
  }

  /** Every viewer's stream ends with `why`. */
  end(why: PreviewVideoEnd): void {
    const viewers = [...this.#viewers.values()]
    this.#viewers.clear()
    for (const viewer of viewers) {
      this.#leave(viewer)
      viewer.sender.end(why)
    }
    this.#idle()
  }

  #join(stream: string, viewer: Viewer): void {
    const tab = this.#tab
    if (!tab) return
    const video = (this.#video ??= new BrowserVideo(tab.source, this.#options))
    const port: BrowserVideoViewer = {
      size: () => viewer.box,
      backlog: () => viewer.sent - viewer.acked,
      send: (packet) => {
        if (!viewer.sender.send(packet)) throw new Error("This viewer's stream ended")
        viewer.sent += packet.byteLength
      },
      ended: (reason) => this.#videoEnded(video, reason),
    }
    const joined: NonNullable<Viewer["joined"]> = { video, port }
    viewer.joined = joined
    video.join(port).then(
      (leave) => {
        if (viewer.joined === joined && this.#viewers.get(stream) === viewer) joined.leave = leave
        else void leave().catch(() => {})
      },
      (error: Error) => this.#videoEnded(video, error.message)
    )
  }

  #leave(viewer: Viewer): void {
    const leave = viewer.joined?.leave
    viewer.joined = undefined
    void leave?.().catch(() => {})
  }

  /** The tab's video ended for all its viewers at once: its turn paused, or it failed past its retries. */
  #videoEnded(video: BrowserVideo, reason: string): void {
    if (video !== this.#video) return
    this.#video = undefined
    this.#tab = undefined
    this.end(this.#paused() ? { kind: "paused", reason: "No turn is driving this tab" } : { kind: "failed", reason })
  }

  #closeVideo(): void {
    const video = this.#video
    this.#video = undefined
    for (const viewer of this.#viewers.values()) viewer.joined = undefined
    video?.close("The preview moved to another tab")
  }

  #checkPause(): void {
    if (this.#pauseCheck) return
    this.#pauseCheck = setInterval(() => {
      if (this.#paused()) this.end({ kind: "paused", reason: "No turn is driving this tab" })
    }, PAUSE_CHECK_MS)
    this.#pauseCheck.unref()
  }

  #idle(): void {
    clearInterval(this.#pauseCheck)
    this.#pauseCheck = undefined
    this.#closeVideo()
  }
}
