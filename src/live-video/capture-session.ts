/**
 * One capture's frames encoded as they come, for the desktop's live video page (`page.ts`) and the machine browser's
 * capture extension (`machine-capture.ts`): a `MediaStreamTrack` in, `ControlVideoPacket`s out.
 */
import { CONTROL_VIDEO_SIZE_LIMIT, encodeControlVideo } from "@mako/control-runtime/contracts"
import type { LiveVideoPageEvent } from "@mako/host/contracts/live-video"
import { browserCodecs, LiveVideoEncoder, type LiveFrameTag, type LiveVideoEncoderEvents } from "@/lib/live-video-encoder"
import { ChangeGate, gpuSampler } from "@/lib/live-video-gate"

/** Chromium's reader of a track's frames, which the DOM library doesn't declare. */
declare const MediaStreamTrackProcessor: new (init: { track: MediaStreamTrack }) => { readable: ReadableStream<VideoFrame> }

export type Box = { width: number; height: number } | null
export type Emit = (event: LiveVideoPageEvent) => void

export interface Session {
  frame?(data: Uint8Array<ArrayBuffer>, tag: LiveFrameTag): Promise<void>
  key(): void
  rate(bitrate: number): void
  resize(box: Box): void
  close(): void
}

export function encoderEvents(session: string, emit: Emit, drained: (tag: LiveFrameTag, sent: boolean) => void): LiveVideoEncoderEvents {
  return {
    unit: (packet) => emit({ type: "unit", session, packet: encodeControlVideo(packet) }),
    drained,
    failed: (reason) => emit({ type: "ended", session, reason }),
  }
}

/**
 * A capture's frames, paced to `fps`, encoded as they come. A tab sends a frame only when it paints; a system
 * capturer repeats a still picture, so its frames pass the change gate first. The last picture encoded is kept, so a
 * key frame asked for while nothing changes shows it.
 */
export class CaptureSession implements Session {
  readonly #session: string
  readonly #emit: Emit
  readonly #fps: number
  readonly #track: MediaStreamTrack
  readonly #encoder: LiveVideoEncoder
  readonly #gate: ChangeGate | undefined
  #last?: VideoFrame
  #pending?: VideoFrame
  #nextAt = 0
  #timer?: ReturnType<typeof setTimeout>
  #sequence = 0
  #closed = false

  constructor(session: string, fps: number, track: MediaStreamTrack, gate: boolean, emit: Emit) {
    this.#session = session
    this.#emit = emit
    this.#fps = fps
    this.#track = track
    this.#encoder = new LiveVideoEncoder(fps, encoderEvents(session, emit, () => this.#pump()), browserCodecs)
    const sample = gate ? gpuSampler() : undefined
    this.#gate = sample && new ChangeGate(sample)
    track.addEventListener("ended", () => this.#end("The capture ended: its window or tab closed"))
    void this.#read()
  }

  async #read(): Promise<void> {
    const reader = new MediaStreamTrackProcessor({ track: this.#track }).readable.getReader()
    try {
      for (;;) {
        const { value: frame, done } = await reader.read()
        if (done || this.#closed) {
          frame?.close()
          break
        }
        if (this.#gate && !this.#gate.admit(frame)) {
          frame.close()
          continue
        }
        this.#pending?.close()
        this.#pending = frame
        this.#pump()
      }
    } catch (error) {
      this.#end(error instanceof Error ? error.message : String(error))
    } finally {
      reader.releaseLock()
    }
  }

  /** Starts the newest frame once the encoder has room and its slot has come. */
  #pump(): void {
    if (this.#closed || this.#timer || !this.#pending || !this.#encoder.ready()) return
    const now = performance.now()
    const wait = this.#nextAt - now
    if (wait > 0) {
      this.#timer = setTimeout(() => {
        this.#timer = undefined
        this.#pump()
      }, Math.ceil(wait))
      return
    }
    this.#nextAt = Math.max(this.#nextAt + 1000 / this.#fps, now)
    const frame = this.#pending
    this.#pending = undefined
    this.#last?.close()
    this.#last = frame.clone()
    this.#encoder.encode(frame, { sequence: ++this.#sequence, capturedAt: Date.now() })
  }

  rate(bitrate: number): void {
    this.#encoder.rate(bitrate)
  }

  key(): void {
    this.#encoder.key()
    if (!this.#pending && this.#last) this.#pending = this.#last.clone()
    this.#pump()
  }

  resize(box: Box): void {
    this.#track.applyConstraints(captureLimits(box)).catch(() => {
      // A capture that can't be rescaled keeps its size; the viewer scales it.
    })
  }

  #end(reason: string): void {
    if (this.#closed) return
    this.close()
    this.#emit({ type: "ended", session: this.#session, reason })
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    clearTimeout(this.#timer)
    this.#track.stop()
    this.#encoder.close()
    this.#pending?.close()
    this.#last?.close()
    this.#pending = this.#last = undefined
  }
}

/** At most `box`, at least 2×2: a floor below the ceiling keeps the source's own size and shape (see `captureTrack`). */
export function captureLimits(box: Box): MediaTrackConstraints {
  return {
    width: { min: 2, max: Math.min(box?.width ?? CONTROL_VIDEO_SIZE_LIMIT, CONTROL_VIDEO_SIZE_LIMIT) },
    height: { min: 2, max: Math.min(box?.height ?? CONTROL_VIDEO_SIZE_LIMIT, CONTROL_VIDEO_SIZE_LIMIT) },
  }
}

/** Chromium's own constraints for a tab or a system capture source, which `getUserMedia`'s types don't declare. */
interface ChromeCaptureConstraints {
  mandatory: {
    chromeMediaSource: "tab" | "desktop"
    chromeMediaSourceId: string
    maxWidth: number
    maxHeight: number
    /** Without a floor below the ceiling Chromium scales a tab to the ceiling and letterboxes it; with one, frames
     * keep the tab's own size and shape, scaled down only to fit the ceiling. */
    minWidth: number
    minHeight: number
    maxFrameRate: number
  }
}

/** A tab or a system capture source Chromium named (`chromeMediaSourceId`), at most `box`'s size. */
export async function captureTrack(media: "tab" | "desktop", id: string, fps: number, box: Box): Promise<MediaStreamTrack> {
  const limits = captureLimits(box)
  const video: ChromeCaptureConstraints = {
    mandatory: {
      chromeMediaSource: media,
      chromeMediaSourceId: id,
      maxWidth: Math.min(box?.width ?? CONTROL_VIDEO_SIZE_LIMIT, CONTROL_VIDEO_SIZE_LIMIT),
      maxHeight: Math.min(box?.height ?? CONTROL_VIDEO_SIZE_LIMIT, CONTROL_VIDEO_SIZE_LIMIT),
      minWidth: 2,
      minHeight: 2,
      maxFrameRate: fps,
    },
  }
  // SAFETY: Chromium reads `mandatory` from a video constraint (its tab and desktop capture predate the standard
  // constraints, and still need it to name the source); the DOM library declares only the standard fields.
  const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: video as MediaTrackConstraints })
  const track = stream.getVideoTracks()[0]
  if (!track) throw new Error("The capture gave no video")
  await track.applyConstraints(limits).catch(() => {})
  return track
}
