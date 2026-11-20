/**
 * The desktop app's live video page (`contracts/live-video.ts`): a hidden page with no window that encodes what the
 * host asks for with WebCodecs and hands each unit to the main process (`electron/live-video-electron.ts`) through
 * its preload's bridge. A session is one encode: the host's JPEGs, or a capture the main process named.
 */
import { CONTROL_VIDEO_SIZE_LIMIT, encodeControlVideo } from "@mako/control-runtime/contracts"
import type { LiveVideoPageAsk, LiveVideoPageEvent, LiveVideoPageSource } from "@mako/host/contracts/live-video"
import { browserCodecs, LiveVideoEncoder, liveVideoEncoderAvailable, type LiveFrameTag, type LiveVideoEncoderEvents } from "@/lib/live-video-encoder"
import { ChangeGate, gpuSampler } from "@/lib/live-video-gate"

/** What the preload gives the page (`electron/live-video-preload.ts`). */
export interface LiveVideoBridge {
  send(event: LiveVideoPageEvent): void
  listen(handler: (ask: LiveVideoPageAsk) => void): void
}

declare global {
  interface Window {
    makoLiveVideo?: LiveVideoBridge
  }
}

/** Chromium's reader of a track's frames, which the DOM library doesn't declare. */
declare const MediaStreamTrackProcessor: new (init: { track: MediaStreamTrack }) => { readable: ReadableStream<VideoFrame> }

type Box = { width: number; height: number } | null
export type Emit = (event: LiveVideoPageEvent) => void

export interface Session {
  frame?(data: Uint8Array<ArrayBuffer>, tag: LiveFrameTag): Promise<void>
  key(): void
  resize(box: Box): void
  close(): void
}

function encoderEvents(session: string, emit: Emit, drained: (tag: LiveFrameTag, sent: boolean) => void): LiveVideoEncoderEvents {
  return {
    unit: (packet) => emit({ type: "unit", session, packet: encodeControlVideo(packet) }),
    drained,
    failed: (reason) => emit({ type: "ended", session, reason }),
  }
}

/**
 * The host's JPEGs, decoded here and encoded: a unit back for each, or word that it was dropped. A picture is taken
 * as it arrives, so the host can send the next while this one decodes; pictures decode one at a time, in order, and
 * one that waits is replaced by a newer one. `ImageDecoder` decodes a JPEG to the YUV the encoder takes, with no RGB
 * between.
 */
export class FramesSession implements Session {
  readonly #session: string
  readonly #emit: Emit
  readonly #encoder: LiveVideoEncoder
  #decoding = false
  #waiting?: { data: Uint8Array<ArrayBuffer>; tag: LiveFrameTag }

  constructor(session: string, fps: number, emit: Emit) {
    this.#session = session
    this.#emit = emit
    this.#encoder = new LiveVideoEncoder(fps, encoderEvents(session, emit, (tag, sent) => {
      if (!sent) emit({ type: "dropped", session, sequence: tag.sequence })
    }), browserCodecs)
  }

  async frame(data: Uint8Array<ArrayBuffer>, tag: LiveFrameTag): Promise<void> {
    this.#emit({ type: "accepted", session: this.#session, sequence: tag.sequence })
    const replaced = this.#waiting
    this.#waiting = { data, tag }
    if (replaced) this.#emit({ type: "dropped", session: this.#session, sequence: replaced.tag.sequence })
    if (this.#decoding) return
    this.#decoding = true
    try {
      await this.#decodeWaiting()
    } finally {
      this.#decoding = false
    }
  }

  async #decodeWaiting(): Promise<void> {
    for (;;) {
      const next = this.#waiting
      if (!next) return
      this.#waiting = undefined
      const frame = await decodeJpeg(next.data).catch(() => undefined)
      if (frame) this.#encoder.encode(frame, next.tag)
      else this.#emit({ type: "dropped", session: this.#session, sequence: next.tag.sequence })
    }
  }

  key(): void {
    this.#encoder.key()
  }

  resize(): void {}

  close(): void {
    this.#encoder.close()
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

async function decodeJpeg(data: Uint8Array<ArrayBuffer>): Promise<VideoFrame> {
  if ("ImageDecoder" in globalThis) {
    const decoder = new ImageDecoder({ data, type: "image/jpeg" })
    try {
      return (await decoder.decode()).image
    } finally {
      decoder.close()
    }
  }
  const bitmap = await createImageBitmap(new Blob([data], { type: "image/jpeg" }))
  try {
    return new VideoFrame(bitmap, { timestamp: 0 })
  } finally {
    bitmap.close()
  }
}

function captureLimits(box: Box): MediaTrackConstraints {
  return {
    width: { max: Math.min(box?.width ?? CONTROL_VIDEO_SIZE_LIMIT, CONTROL_VIDEO_SIZE_LIMIT) },
    height: { max: Math.min(box?.height ?? CONTROL_VIDEO_SIZE_LIMIT, CONTROL_VIDEO_SIZE_LIMIT) },
  }
}

/** Chromium's own constraints for a tab or a system capture source, which `getUserMedia`'s types don't declare. */
interface ChromeCaptureConstraints {
  mandatory: {
    chromeMediaSource: "tab" | "desktop"
    chromeMediaSourceId: string
    maxWidth: number
    maxHeight: number
    maxFrameRate: number
  }
}

async function captureTrack(source: Extract<LiveVideoPageSource, { kind: "capture" }>, fps: number, box: Box): Promise<MediaStreamTrack> {
  const limits = captureLimits(box)
  const video: ChromeCaptureConstraints = {
    mandatory: {
      chromeMediaSource: source.media,
      chromeMediaSourceId: source.id,
      maxWidth: Math.min(box?.width ?? CONTROL_VIDEO_SIZE_LIMIT, CONTROL_VIDEO_SIZE_LIMIT),
      maxHeight: Math.min(box?.height ?? CONTROL_VIDEO_SIZE_LIMIT, CONTROL_VIDEO_SIZE_LIMIT),
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

/** Answers the main process's asks on `bridge` until the page closes. */
export function serveLiveVideo(bridge: LiveVideoBridge): void {
  const sessions = new Map<string, Session>()
  const emit: Emit = (event) => {
    if (event.type === "ended") {
      sessions.get(event.session)?.close()
      sessions.delete(event.session)
    }
    bridge.send(event)
  }
  /** Sessions opening, and those of them closed before they opened. */
  const opening = new Set<string>()
  const closed = new Set<string>()
  const open = async (ask: Extract<LiveVideoPageAsk, { type: "open" }>) => {
    const encoder = await liveVideoEncoderAvailable(ask.fps)
    if (!encoder) throw new Error("No H.264 encoder in this browser")
    const source = ask.source
    const made = source.kind === "frames"
      ? new FramesSession(ask.session, ask.fps, emit)
      : new CaptureSession(ask.session, ask.fps, await captureTrack(source, ask.fps, ask.box), source.gate, emit)
    if (closed.delete(ask.session)) {
      made.close()
      throw new Error("The session closed while it opened")
    }
    sessions.set(ask.session, made)
    return encoder
  }
  bridge.listen((ask) => {
    const session = sessions.get(ask.session)
    switch (ask.type) {
      case "open":
        opening.add(ask.session)
        void open(ask).finally(() => opening.delete(ask.session)).then(
          (encoder) => bridge.send({ type: "opened", session: ask.session, encoder }),
          (error: Error) => bridge.send({ type: "ended", session: ask.session, reason: error.message })
        )
        return
      case "frame":
        if (!session?.frame) return bridge.send({ type: "ended", session: ask.session, reason: "No such session" })
        void session.frame(ask.data, { sequence: ask.sequence, capturedAt: ask.capturedAt })
        return
      case "key":
        return session?.key()
      case "resize":
        return session?.resize(ask.box)
      case "close":
        if (opening.has(ask.session)) closed.add(ask.session)
        session?.close()
        sessions.delete(ask.session)
        return
    }
  })
}

if (window.makoLiveVideo) serveLiveVideo(window.makoLiveVideo)
