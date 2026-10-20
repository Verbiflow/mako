import { spawn } from "node:child_process"
import type { BrowserFrame, CaptureSize } from "./browser-capture.js"
import { liveVideoEncoding, mediaExecutable } from "./control-media.js"
import { encodeControlVideo, type ControlVideoPacket } from "./contracts/control-video.js"
import { MovVideoInput } from "./mov-video-input.js"

/** A frame as the encoder takes it: the screencast's JPEG and its place in the capture. */
export interface VideoSourceFrame {
  bytes: Buffer
  width: number
  height: number
  sequence: number
  capturedAt: number
}

/** One encoder for one frame size. `submit` is called only while `ready()`;
 * every submitted frame comes back as exactly one unit, in order. */
export interface LiveEncoder {
  ready(): boolean
  submit(frame: VideoSourceFrame): void
  close(): void
}
export type LiveEncoderFactory = (
  size: CaptureSize,
  fps: number,
  unit: (packet: ControlVideoPacket) => void,
  drained: () => void,
  failed: (reason: string) => void
) => LiveEncoder

/** At most this many frames are inside the encoder; a newer frame waits and replaces an older waiting one. */
const IN_FLIGHT = 2
/** The least time between key frames made for viewers that fell behind. */
const RECOVERY_MS = 1000

/** FFmpeg reading the screencast's JPEGs as streaming MOV and writing FLV,
 * whose tags carry each unit's length, its key flag and the decoder
 * configuration, so a unit is complete the moment it arrives. */
export const ffmpegLiveEncoder: LiveEncoderFactory = (size, fps, unit, drained, failed) => {
  const input = new MovVideoInput(size.width, size.height, fps, "jpeg")
  const child = spawn(mediaExecutable("ffmpeg"), [
    "-hide_banner", "-loglevel", "error", "-nostdin",
    "-probesize", "32", "-analyzeduration", "0",
    "-f", "mov", "-i", "pipe:0", "-an",
    "-fps_mode", "passthrough",
    // 4:2:0 needs even dimensions; drop an odd edge row or column rather than resample the frame.
    "-vf", "crop=trunc(iw/2)*2:trunc(ih/2)*2:0:0",
    ...liveVideoEncoding(size, fps),
    "-flvflags", "no_duration_filesize", "-flush_packets", "1", "-f", "flv", "pipe:1",
  ], { stdio: ["pipe", "pipe", "pipe"] })
  const waiting: VideoSourceFrame[] = []
  let writing = false
  let closed = false
  let description: Uint8Array | undefined
  let tail = ""
  const fail = (reason: string) => {
    if (closed) return
    closed = true
    child.kill("SIGKILL")
    failed(reason)
  }
  const reader = new FlvReader((tag) => {
    if (closed) return
    if (tag.config) {
      description = tag.data
      return
    }
    const frame = waiting.shift()
    if (!frame) return fail("The live encoder returned a frame it was never given")
    if (tag.key && !description) return fail("The live encoder sent a key frame before its configuration")
    const common = {
      width: frame.width - (frame.width % 2),
      height: frame.height - (frame.height % 2),
      sequence: frame.sequence,
      capturedAt: frame.capturedAt,
      data: tag.data,
    }
    unit(tag.key && description ? { ...common, kind: "key", description } : { ...common, kind: "delta" })
    drained()
  })
  child.stdout.on("data", (chunk: Buffer) => {
    try { reader.push(chunk) } catch (error) { fail(error instanceof Error ? error.message : String(error)) }
  })
  child.stderr.on("data", (data: Buffer) => { tail = (tail + data.toString()).slice(-2048) })
  child.stdin.on("error", (error: Error) => fail(`Live encoder input failed: ${error.message}`))
  child.on("error", (error: Error) => fail(`Live encoder failed: ${error.message}`))
  child.once("close", (code) => fail(`Live encoder ended: ${tail.trim() || `exit ${code}`}`))
  child.stdin.write(input.header)
  let origin: number | undefined
  let previous = -1
  return {
    ready: () => !closed && !writing && waiting.length < IN_FLIGHT,
    submit(frame) {
      if (closed) return
      const now = performance.now()
      origin ??= now
      // FLV keeps milliseconds; two frames in one millisecond would collide.
      previous = Math.max(previous + 1, Math.round(now - origin))
      waiting.push(frame)
      writing = true
      child.stdin.cork()
      child.stdin.write(input.frame(previous, frame.bytes.length))
      child.stdin.write(frame.bytes, () => { writing = false; drained() })
      child.stdin.uncork()
    },
    close() {
      if (closed) return
      closed = true
      child.kill("SIGKILL")
    },
  }
}

interface FlvTag { config: boolean; key: boolean; data: Uint8Array }

/** Reads FLV video tags as they arrive, without waiting for the next one. */
export class FlvReader {
  private buffer: Buffer = Buffer.alloc(0)
  private started = false
  constructor(private readonly tag: (tag: FlvTag) => void) {}
  push(chunk: Buffer) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    if (!this.started) {
      if (this.buffer.length < 13) return
      if (this.buffer.toString("latin1", 0, 3) !== "FLV") throw new Error("The live encoder did not write FLV")
      this.buffer = this.buffer.subarray(this.buffer.readUInt32BE(5) + 4)
      this.started = true
    }
    while (this.buffer.length >= 11) {
      const size = this.buffer.readUIntBE(1, 3)
      if (size > 8 * 1024 * 1024) throw new Error("The live encoder wrote an oversized frame")
      if (this.buffer.length < 11 + size + 4) return
      const type = this.buffer[0]!
      const body = this.buffer.subarray(11, 11 + size)
      this.buffer = this.buffer.subarray(11 + size + 4)
      if (type !== 9 || body.length < 5) continue
      if ((body[0]! & 0x0f) !== 7) throw new Error("The live encoder wrote a codec other than H.264")
      if (body[1] === 0) this.tag({ config: true, key: false, data: Uint8Array.from(body.subarray(5)) })
      else if (body[1] === 1) this.tag({ config: false, key: body[0]! >> 4 === 1, data: Uint8Array.from(body.subarray(5)) })
    }
  }
}

/** One remote viewer. `backlog` is what it has been sent and not yet taken,
 * in bytes (a WebSocket's `bufferedAmount`). */
export interface BrowserVideoViewer {
  /** The largest frame it draws, in device pixels; none for full size. */
  size(): CaptureSize | undefined
  backlog(): number
  send(packet: Uint8Array): void
  ended(reason: string): void
}

/** The tab's shared screencast, as `BrowserService.previewStream` and `previewResized` provide it. */
export type BrowserVideoSource = (consumer: {
  frame: (frame: BrowserFrame) => void
  ended: (reason: string) => void
  size: () => CaptureSize | undefined
}) => Promise<{ stop: () => Promise<void>; resized: () => Promise<void> }>

export interface BrowserVideoOptions {
  /** The most frames a second sent to viewers. */
  fps?: number
  /** Bytes a viewer may leave untaken before it skips to the next key frame. */
  backlog?: number
  encoder?: LiveEncoderFactory
}

interface ViewerState {
  awaitingKey: boolean
  /** It has painted something: a poster or a key frame. */
  painted: boolean
}

/** A browser tab as live H.264 for remote viewers: one encode for every
 * viewer, running only while one watches. A viewer that joins paints the
 * newest frame at once as a poster, then gets a key frame of the current
 * picture, even while the page is still. One that falls behind skips to a
 * fresh key frame instead of queueing old ones. */
export class BrowserVideo {
  private readonly viewers = new Map<BrowserVideoViewer, ViewerState>()
  private readonly fps: number
  private readonly backlogLimit: number
  private readonly createEncoder: LiveEncoderFactory
  private source?: Promise<{ stop: () => Promise<void>; resized: () => Promise<void> }>
  private encoder?: { instance: LiveEncoder; size: CaptureSize; keyed: boolean }
  /** Counts encoders started, failed and stopped; a replaced encoder's late callbacks are ignored. */
  private generation = 0
  private latest?: VideoSourceFrame
  private pending?: VideoSourceFrame
  private sequence = 0
  private nextAt = 0
  private paceTimer?: NodeJS.Timeout
  private recoverTimer?: NodeJS.Timeout
  private keyedAt = -Infinity
  private failures = 0
  private closed = false

  constructor(private readonly subscribe: BrowserVideoSource, options: BrowserVideoOptions = {}) {
    this.fps = options.fps ?? 30
    this.backlogLimit = options.backlog ?? 512 * 1024
    this.createEncoder = options.encoder ?? ffmpegLiveEncoder
  }

  async join(viewer: BrowserVideoViewer): Promise<() => Promise<void>> {
    if (this.closed) throw new Error("Live video ended")
    this.viewers.set(viewer, { awaitingKey: true, painted: false })
    try {
      if (!this.source) {
        this.source = this.subscribe({
          frame: (frame) => this.frame(frame),
          ended: (reason) => this.end(reason),
          size: () => this.demand(),
        })
      }
      const source = await this.source
      await source.resized()
    } catch (error) {
      this.viewers.delete(viewer)
      if (!this.viewers.size) await this.stop()
      throw error
    }
    this.poster()
    this.requestKey()
    let left = false
    return async () => {
      if (left) return
      left = true
      this.viewers.delete(viewer)
      if (!this.viewers.size) await this.stop()
      else await (await this.source)?.resized()
    }
  }

  /** A viewer now draws another size. */
  async resized() {
    await (await this.source)?.resized()
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

  private frame(frame: BrowserFrame) {
    if (this.closed || !this.viewers.size) return
    this.latest = { bytes: frame.bytes, width: frame.width, height: frame.height, sequence: ++this.sequence, capturedAt: frame.capturedAt }
    this.pending = this.latest
    this.poster()
    this.pump()
  }

  /** Viewers that have painted nothing get the newest frame as it is, while its key frame is encoded. */
  private poster() {
    const frame = this.latest
    if (!frame) return
    let bytes: Uint8Array | undefined
    for (const [viewer, state] of this.viewers) {
      if (state.painted || viewer.backlog() > this.backlogLimit) continue
      bytes ??= encodeControlVideo({ kind: "poster", width: frame.width, height: frame.height, sequence: frame.sequence, capturedAt: frame.capturedAt, data: frame.bytes })
      try { viewer.send(bytes) } catch { continue }
      state.painted = true
    }
  }

  /** Sends the newest waiting frame when the encoder can take it and its slot has come. */
  private pump() {
    const frame = this.pending
    if (!frame || this.closed || this.paceTimer) return
    if (!this.encoder || this.encoder.size.width !== frame.width || this.encoder.size.height !== frame.height)
      this.restart({ width: frame.width, height: frame.height })
    const encoder = this.encoder
    if (!encoder?.instance.ready()) return
    const wait = this.nextAt - performance.now()
    if (wait > 0) {
      this.paceTimer = setTimeout(() => { this.paceTimer = undefined; this.pump() }, Math.ceil(wait))
      this.paceTimer.unref()
      return
    }
    this.nextAt = Math.max(this.nextAt + 1000 / this.fps, performance.now())
    this.pending = undefined
    encoder.instance.submit(frame)
  }

  private restart(size: CaptureSize) {
    this.encoder?.instance.close()
    const generation = ++this.generation
    const current = () => this.generation === generation
    const instance = this.createEncoder(size, this.fps,
      (packet) => { if (current()) this.unit(packet) },
      () => { if (current()) this.pump() },
      (reason) => { if (current()) this.failed(reason) })
    this.encoder = { instance, size, keyed: false }
  }

  private unit(packet: ControlVideoPacket) {
    this.failures = 0
    const key = packet.kind === "key"
    if (key && this.encoder) this.encoder.keyed = true
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

  /** A viewer that fell behind gets a key frame from the newest frame once it
   * can take one; at most one a second, since each costs a whole picture. */
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

  /** A new encoder's first unit is a key frame. Without a frame yet, or with an
   * encoder that hasn't sent its first, that key frame is already coming. */
  private requestKey() {
    if (this.closed || !this.latest || (this.encoder && !this.encoder.keyed)) return
    this.keyedAt = performance.now()
    this.restart({ width: this.latest.width, height: this.latest.height })
    this.pending ??= this.latest
    this.nextAt = 0
    this.pump()
  }

  private failed(reason: string) {
    this.generation++
    this.encoder = undefined
    if (++this.failures >= 3) return this.end(reason)
    this.pending ??= this.latest
    this.pump()
  }

  private async stop() {
    clearTimeout(this.paceTimer)
    clearTimeout(this.recoverTimer)
    this.paceTimer = this.recoverTimer = undefined
    this.generation++
    this.encoder?.instance.close()
    this.encoder = undefined
    this.latest = this.pending = undefined
    const source = this.source
    this.source = undefined
    await (await source?.catch(() => undefined))?.stop()
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
