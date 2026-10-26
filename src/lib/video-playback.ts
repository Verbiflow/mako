/** What the rules below need of a video element; a test hands in a stand-in. */
export interface PlayableVideo {
  readonly paused: boolean
  preload: string
  pause(): void
}

/** What the rules below need of the document: whether it's hidden, and what's fullscreen (an element contains itself). */
export interface PlaybackDocument<Video extends PlayableVideo> {
  readonly hidden: boolean
  readonly fullscreenElement: { contains(video: Video): boolean } | null
  addEventListener(type: "visibilitychange", listener: () => void): void
  removeEventListener(type: "visibilitychange", listener: () => void): void
}

/** One player's handle on the rules; each returns nothing and does no React work. */
export interface VideoPlayer {
  /** Within 200px of the viewport: load the metadata, so its size and length are known before play. */
  near(): void
  /** It entered or left the viewport: leaving pauses it. */
  shown(visible: boolean): void
  /** It started playing: any other playing video pauses. */
  playing(): void
  /** Unmounted: it pauses and is forgotten. */
  release(): void
}

/** Whether `video` is, or sits inside, what is fullscreen now. */
function fullscreen<Video extends PlayableVideo>(document: PlaybackDocument<Video>, video: Video): boolean {
  return document.fullscreenElement?.contains(video) ?? false
}

/**
 * When a transcript's videos play and stop, for every place one is drawn
 * (inline, a grid, the lightbox, a turn's media): one plays at a time; one
 * scrolled out of view, in a hidden window (unless it's fullscreen) or
 * unmounted pauses; none loads anything until it's near the viewport, and
 * then only its metadata. A video the person paused stays paused; nothing
 * here ever starts one.
 */
export class VideoPlayback<Video extends PlayableVideo> {
  private readonly document: PlaybackDocument<Video>
  private readonly players = new Set<Video>()
  private current: Video | null = null
  private listening = false

  constructor(document: PlaybackDocument<Video>) {
    this.document = document
  }

  private readonly hiddenChanged = () => {
    if (!this.document.hidden) return
    for (const video of this.players) if (!video.paused && !fullscreen(this.document, video)) video.pause()
  }

  attach(video: Video): VideoPlayer {
    video.preload = "none"
    this.players.add(video)
    if (!this.listening) {
      this.document.addEventListener("visibilitychange", this.hiddenChanged)
      this.listening = true
    }
    return {
      near: () => {
        if (video.preload === "none") video.preload = "metadata"
      },
      shown: (visible) => {
        if (!visible && !video.paused && !fullscreen(this.document, video)) video.pause()
      },
      playing: () => {
        if (this.current && this.current !== video && !this.current.paused) this.current.pause()
        this.current = video
      },
      release: () => {
        if (!video.paused) video.pause()
        if (this.current === video) this.current = null
        this.players.delete(video)
        if (!this.players.size && this.listening) {
          this.document.removeEventListener("visibilitychange", this.hiddenChanged)
          this.listening = false
        }
      },
    }
  }
}
