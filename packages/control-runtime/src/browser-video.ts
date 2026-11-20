import type { BrowserFrame, CaptureSize } from "./browser-capture.js"
import { encodeControlVideo, liveVideoBitrate, type ControlVideoPacket } from "./contracts/control-video.js"
import { helperLiveEncoder, videoHelperExecutable } from "./video-helper.js"

/**
 * A live video's pictures: a capture that encodes for itself and hands over `ControlVideoPacket`s (a desk window or an
 * app's window in the desktop app, a machine browser's tab, the video helper's display or window, or a screencast
 * through an encoder here: `screencastVideo`). Its first unit is a key frame. It may send posters (a picture as it
 * is, JPEG) for viewers that have painted nothing yet.
 */
export type VideoSource = (consumer: VideoSourceConsumer) => Promise<VideoCapture>

export interface VideoSourceConsumer {
  unit(packet: ControlVideoPacket): void
  ended(reason: string): void
  /** The largest picture its viewers draw; none for its own size. */
  size(): CaptureSize | undefined
  fps: number
}

export interface VideoCapture {
  stop(): Promise<void>
  /** Its viewers draw another size (`size`). */
  resized(): Promise<void>
  /** The next unit comes as a key frame: of the next picture, or, while nothing changes, of the one shown now. */
  key(): void
  /** The bits a second its viewers' links take now; a capture that can't change its rate keeps its own. */
  rate?(bitrate: number): void
}

/** A frame as an encoder takes it: the screencast's JPEG and its place in the capture. */
export interface VideoSourceFrame {
  bytes: Buffer
  width: number
  height: number
  sequence: number
  capturedAt: number
}

/** One encoder for one frame size. `submit` is called only while `ready()`; a unit comes back for each frame it
 * doesn't drop, in order, the first a key frame, and `drained` says it has room again. */
export interface LiveEncoder {
  ready(): boolean
  submit(frame: VideoSourceFrame): void
  close(): void
  /** The next frame encodes as a key frame; without it, a key frame takes a new encoder. */
  key?(): void
  rate?(bitrate: number): void
}
export type LiveEncoderFactory = (
  size: CaptureSize,
  fps: number,
  unit: (packet: ControlVideoPacket) => void,
  drained: () => void,
  failed: (reason: string) => void
) => LiveEncoder

/** The tab's shared screencast, as `BrowserService.previewStream` and `previewResized` provide it. */
export type ScreencastSource = (consumer: {
  frame: (frame: BrowserFrame) => void
  ended: (reason: string) => void
  size: () => CaptureSize | undefined
}) => Promise<{ stop: () => Promise<void>; resized: () => Promise<void> }>

/** Where no encoder was given: the video helper's, or a failure that says what's missing. */
const defaultEncoder: LiveEncoderFactory = (size, fps, unit, drained, failed) => {
  const executable = videoHelperExecutable()
  if (executable) return helperLiveEncoder(executable)(size, fps, unit, drained, failed)
  queueMicrotask(() => failed("Live video of this tab needs Mako's video helper (mako-video) or desktop app, and this machine has neither"))
  return { ready: () => false, submit() {}, close() {} }
}

/** Encoder failures in a row that end a screencast's video. */
const FAILURES = 3

/**
 * A screencast's JPEGs as a video source: each frame a poster for viewers that have painted nothing, and, paced to
 * the rate, the newest frame into `encoder`, one encoder per frame size. A key frame asked for comes from the encoder
 * (`key`) or a new one, of the newest frame, even while the page is still.
 */
export function screencastVideo(frames: ScreencastSource, encoder: LiveEncoderFactory = defaultEncoder): VideoSource {
  return async (consumer) => {
    let latest: VideoSourceFrame | undefined
    let pending: VideoSourceFrame | undefined
    let current: { instance: LiveEncoder; size: CaptureSize; keyed: boolean } | undefined
    let generation = 0
    let sequence = 0
    let nextAt = 0
    let paceTimer: NodeJS.Timeout | undefined
    let failures = 0
    let bitrate: number | undefined
    let stopped = false
    const restart = (size: CaptureSize) => {
      current?.instance.close()
      const mine = ++generation
      const live = () => mine === generation && !stopped
      const made: NonNullable<typeof current> = {
        size,
        keyed: false,
        instance: encoder(size, consumer.fps,
          (packet) => {
            if (!live()) return
            failures = 0
            if (packet.kind === "key") made.keyed = true
            consumer.unit(packet)
          },
          () => { if (live()) pump() },
          (reason) => {
            if (!live()) return
            generation++
            current = undefined
            if (++failures >= FAILURES) return consumer.ended(reason)
            pending ??= latest
            pump()
          }),
      }
      if (bitrate !== undefined) made.instance.rate?.(bitrate)
      current = made
    }
    /** Sends the newest waiting frame when the encoder can take it and its slot has come. */
    const pump = () => {
      const frame = pending
      if (!frame || stopped || paceTimer) return
      if (!current || current.size.width !== frame.width || current.size.height !== frame.height)
        restart({ width: frame.width, height: frame.height })
      if (!current?.instance.ready()) return
      const wait = nextAt - performance.now()
      if (wait > 0) {
        paceTimer = setTimeout(() => {
          paceTimer = undefined
          pump()
        }, Math.ceil(wait))
        paceTimer.unref()
        return
      }
      nextAt = Math.max(nextAt + 1000 / consumer.fps, performance.now())
      pending = undefined
      current.instance.submit(frame)
    }
    const subscription = await frames({
      frame: (frame) => {
        if (stopped) return
        latest = pending = { bytes: frame.bytes, width: frame.width, height: frame.height, sequence: ++sequence, capturedAt: frame.capturedAt }
        consumer.unit({ kind: "poster", width: frame.width, height: frame.height, sequence, capturedAt: frame.capturedAt, data: frame.bytes })
        pump()
      },
      ended: consumer.ended,
      size: consumer.size,
    })
    return {
      key() {
        // Without a frame yet, or with an encoder that hasn't sent its first, the key frame is already coming.
        if (stopped || !latest || (current && !current.keyed)) return
        // An encoder that keys on request encodes the picture it has again; another is replaced and given the newest.
        if (current?.instance.key) return current.instance.key()
        restart({ width: latest.width, height: latest.height })
        pending ??= latest
        nextAt = 0
        pump()
      },
      rate(next) {
        bitrate = next
        current?.instance.rate?.(next)
      },
      resized: () => subscription.resized(),
      async stop() {
        stopped = true
        clearTimeout(paceTimer)
        generation++
        current?.instance.close()
        current = latest = pending = undefined
        await subscription.stop()
      },
    }
  }
}

/** One remote viewer. `backlog` is what it has been sent and not yet taken, in bytes (a WebSocket's
 * `bufferedAmount`, or bytes sent past the last acknowledgement). */
export interface BrowserVideoViewer {
  /** The largest frame it draws, in device pixels; none for full size. */
  size(): CaptureSize | undefined
  backlog(): number
  send(packet: Uint8Array): void
  ended(reason: string): void
}

/**
 * Where a live video's pictures come from, tried in order: a capture that encodes where its pixels are, then the
 * screencast through the encoder. One that can't start, or ends while viewers watch, gives way to the next. `poster`
 * paints a viewer while a capture with no frames here makes its first key frame.
 */
export interface BrowserVideoSources {
  encoded?: VideoSource
  frames?: ScreencastSource
  poster?: (size: () => CaptureSize | undefined) => Promise<BrowserFrame>
}

export interface BrowserVideoOptions {
  /** The most frames a second sent to viewers. */
  fps?: number
  /** Bytes a viewer may leave untaken before it skips to the next key frame. */
  backlog?: number
  /** What encodes a screencast's frames: the video helper, where none is given. */
  encoder?: LiveEncoderFactory
}

/** How long a key frame asked of a capture is waited for before it's asked again. */
const KEY_WAIT_MS = 2000
/** The least time between key frames made for viewers that fell behind. */
const RECOVERY_MS = 1000
/** How often the bitrate follows the viewers' links, and the least it goes to. */
const RATE_MS = 1000
const RATE_FLOOR = 250_000

interface ViewerState {
  awaitingKey: boolean
  /** It has painted something: a poster or a key frame. */
  painted: boolean
}

/**
 * A browser tab or a window as live H.264 for remote viewers: one encode for every viewer, running only while one
 * watches. A viewer that joins paints the newest picture at once as a poster, then gets a key frame of the current
 * picture, even while the page is still. One that falls behind skips to a fresh key frame instead of queueing old
 * ones, and the bitrate follows what the slowest viewer takes.
 */
export class BrowserVideo {
  private readonly viewers = new Map<BrowserVideoViewer, ViewerState>()
  private readonly fps: number
  private readonly backlogLimit: number
  private readonly order: VideoSource[]
  /** The first source worth trying; one that ended or couldn't start isn't tried again. */
  private floor = 0
  private opening?: Promise<VideoCapture>
  private capture?: VideoCapture
  /** Counts captures started; a replaced capture's late units and endings are ignored. */
  private captures = 0
  /** The newest poster, painted at once for a viewer that joins or lost its picture. A fetched one is a picture of a
   * moment, kept only until the video's own key frame shows a newer one. */
  private latestPoster?: ControlVideoPacket
  private posterFetched = false
  /** When a key frame was last asked for and hasn't come. */
  private keyAskedAt?: number
  private keyedAt = -Infinity
  private recoverTimer?: NodeJS.Timeout
  private rateTimer?: NodeJS.Timeout
  private bitrate?: number
  private calm = 0
  private closed = false

  constructor(private readonly sources: BrowserVideoSources, options: BrowserVideoOptions = {}) {
    this.fps = options.fps ?? 30
    this.backlogLimit = options.backlog ?? 512 * 1024
    this.order = [
      ...(sources.encoded ? [sources.encoded] : []),
      ...(sources.frames ? [screencastVideo(sources.frames, options.encoder)] : []),
    ]
  }

  async join(viewer: BrowserVideoViewer): Promise<() => Promise<void>> {
    if (this.closed) throw new Error("Live video ended")
    this.viewers.set(viewer, { awaitingKey: true, painted: false })
    // Asked beside the capture's start, so the viewer paints while its first key frame is made.
    this.fetchPoster()
    try {
      const capture = await (this.opening ??= this.open())
      await capture.resized()
    } catch (error) {
      this.viewers.delete(viewer)
      if (!this.viewers.size) await this.stop()
      throw error
    }
    this.sendPoster()
    this.requestKey()
    this.watchRate()
    let left = false
    return async () => {
      if (left) return
      left = true
      this.viewers.delete(viewer)
      if (!this.viewers.size) await this.stop()
      else await (await this.opening)?.resized()
    }
  }

  /** The first source from the floor that starts; one that can't is passed over for good. */
  private async open(): Promise<VideoCapture> {
    const generation = ++this.captures
    const current = () => this.captures === generation
    let failure = new Error("This live video has no source")
    for (; this.floor < this.order.length; this.floor++) {
      try {
        const capture = await this.order[this.floor]!({
          unit: (packet) => { if (current()) this.unit(packet) },
          ended: (reason) => { if (current()) this.sourceEnded(reason) },
          size: () => this.demand(),
          fps: this.fps,
        })
        if (current()) {
          this.capture = capture
          // Its first unit is a key frame: a viewer joining now needs no other.
          this.keyAskedAt = this.keyedAt = performance.now()
          if (this.bitrate !== undefined) capture.rate?.(this.bitrate)
        }
        return capture
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error))
      }
    }
    throw failure
  }

  /** The source stopped while viewers watch: the next takes over, or the video ends without one. */
  private sourceEnded(reason: string) {
    if (this.closed || this.floor + 1 >= this.order.length) return this.end(reason)
    this.floor++
    const previous = this.opening
    this.capture = this.keyAskedAt = undefined
    void previous?.then((capture) => capture.stop()).catch(() => {})
    for (const state of this.viewers.values()) state.awaitingKey = true
    const next = (this.opening = this.open())
    next.then((capture) => capture.resized()).then(
      () => this.requestKey(),
      (error: Error) => { if (this.opening === next) this.end(error.message) }
    )
  }

  /** A viewer now draws another size. */
  async resized() {
    await (await this.opening)?.resized()
  }

  /** A viewer that lost what it had painted starts again: the newest picture as a poster, then a key frame. */
  refresh(viewer: BrowserVideoViewer) {
    const state = this.viewers.get(viewer)
    if (!state) return
    state.awaitingKey = true
    state.painted = false
    this.sendPoster()
    this.fetchPoster()
    this.recover()
  }

  private demand(): CaptureSize | undefined {
    let width = 0, height = 0
    for (const viewer of this.viewers.keys()) {
      const size = viewer.size()
      if (!size) return undefined
      width = Math.max(width, size.width)
      height = Math.max(height, size.height)
    }
    return width && height ? { width, height } : undefined
  }

  /** A capture with no frames here has its poster fetched for viewers that have painted nothing. */
  private fetchPoster() {
    const fetch = this.sources.poster
    if (!fetch || this.latestPoster) return
    void fetch(() => this.demand()).then((frame) => {
      if (this.closed || this.latestPoster) return
      this.latestPoster = { kind: "poster", width: frame.width, height: frame.height, sequence: 0, capturedAt: frame.capturedAt, data: frame.bytes }
      this.posterFetched = true
      this.sendPoster()
    }, () => {
      // No poster: the viewer paints at the first key frame instead.
    })
  }

  /** Viewers that have painted nothing get the newest picture as it is, while its key frame is encoded. */
  private sendPoster() {
    const poster = this.latestPoster
    if (!poster) return
    let bytes: Uint8Array | undefined
    for (const [viewer, state] of this.viewers) {
      if (state.painted || viewer.backlog() > this.backlogLimit) continue
      bytes ??= encodeControlVideo(poster)
      try { viewer.send(bytes) } catch { continue }
      state.painted = true
    }
  }

  private unit(packet: ControlVideoPacket) {
    if (packet.kind === "poster") {
      this.latestPoster = packet
      this.posterFetched = false
      return this.sendPoster()
    }
    const key = packet.kind === "key"
    if (key) this.keyAskedAt = undefined
    if (key && this.posterFetched) this.latestPoster = undefined
    let bytes: Uint8Array | undefined
    for (const [viewer, state] of this.viewers) {
      if (state.awaitingKey && !key) continue
      if (viewer.backlog() > this.backlogLimit) {
        state.awaitingKey = true
        continue
      }
      bytes ??= encodeControlVideo(packet)
      try { viewer.send(bytes) } catch { state.awaitingKey = true; continue }
      state.awaitingKey = false
      state.painted = true
    }
    this.recover()
  }

  /** A viewer that fell behind gets a key frame once it can take one; at most one a second, since each costs a whole
   * picture. */
  private recover() {
    clearTimeout(this.recoverTimer)
    this.recoverTimer = undefined
    let waiting = false, ready = false
    for (const [viewer, state] of this.viewers)
      if (state.awaitingKey) {
        waiting = true
        ready ||= viewer.backlog() <= this.backlogLimit
      }
    if (!waiting) return
    const wait = ready ? this.keyedAt + RECOVERY_MS - performance.now() : 100
    if (ready && wait <= 0) return this.requestKey()
    this.recoverTimer = setTimeout(() => this.recover(), Math.max(1, Math.ceil(wait)))
    this.recoverTimer.unref()
  }

  /** Asks the capture for a key frame, and again if it doesn't come: a still picture sends nothing else that would. */
  private requestKey() {
    const capture = this.capture
    if (this.closed || !capture) return
    const now = performance.now()
    const waited = this.keyAskedAt === undefined ? Infinity : now - this.keyAskedAt
    if (waited >= KEY_WAIT_MS) {
      this.keyAskedAt = this.keyedAt = now
      capture.key()
    }
    clearTimeout(this.recoverTimer)
    this.recoverTimer = setTimeout(() => this.recover(), Math.max(1, Math.ceil(KEY_WAIT_MS - Math.min(waited, KEY_WAIT_MS))))
    this.recoverTimer.unref()
  }

  /**
   * The bitrate follows the slowest viewer: down by a third when one holds more than a quarter of its allowance
   * untaken, back up a quarter at a time after three calm seconds, never above what the picture's size and rate get
   * (`liveVideoBitrate`) and never below `RATE_FLOOR`.
   */
  private watchRate() {
    if (this.rateTimer) return
    this.rateTimer = setInterval(() => {
      const capture = this.capture
      if (!capture?.rate || !this.viewers.size) return
      const ceiling = liveVideoBitrate(this.demand() ?? { width: 4096, height: 4096 }, this.fps)
      const current = Math.min(this.bitrate ?? ceiling, ceiling)
      let backlog = 0
      for (const viewer of this.viewers.keys()) backlog = Math.max(backlog, viewer.backlog())
      let next = current
      if (backlog > this.backlogLimit / 4) {
        next = Math.max(RATE_FLOOR, Math.round(current * 0.67))
        this.calm = 0
      } else if (backlog < this.backlogLimit / 32 && ++this.calm >= 3) {
        next = Math.min(ceiling, Math.round(current * 1.25))
        this.calm = 0
      }
      if (next === (this.bitrate ?? ceiling)) return
      this.bitrate = next
      capture.rate(next)
    }, RATE_MS)
    this.rateTimer.unref()
  }

  private async stop() {
    clearTimeout(this.recoverTimer)
    clearInterval(this.rateTimer)
    this.recoverTimer = this.rateTimer = undefined
    this.latestPoster = this.bitrate = undefined
    this.calm = 0
    const opening = this.opening
    this.opening = this.capture = this.keyAskedAt = undefined
    this.captures++
    await (await opening?.catch(() => undefined))?.stop()
  }

  private end(reason: string) {
    if (this.closed) return
    this.closed = true
    const viewers = [...this.viewers.keys()]
    this.viewers.clear()
    void this.stop().catch(() => {})
    for (const viewer of viewers) {
      try { viewer.ended(reason) } catch { /* One viewer cannot strand another. */ }
    }
  }

  close(reason = "Live video ended") {
    this.end(reason)
  }
}
