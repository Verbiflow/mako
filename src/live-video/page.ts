/**
 * The desktop app's live video page (`contracts/live-video.ts`): a hidden page with no window that encodes what the
 * host asks for with WebCodecs and hands each unit to the main process (`electron/live-video-electron.ts`) through
 * its preload's bridge. A session is one encode: the host's JPEGs, or a capture the main process named.
 */
import type { LiveVideoPageAsk, LiveVideoPageEvent } from "@mako/host/contracts/live-video"
import { browserCodecs, LiveVideoEncoder, liveVideoEncoderAvailable, type LiveFrameTag } from "@/lib/live-video-encoder"
import { CaptureSession, captureTrack, encoderEvents, type Emit, type Session } from "./capture-session"

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

  rate(bitrate: number): void {
    this.#encoder.rate(bitrate)
  }

  resize(): void {}

  close(): void {
    this.#encoder.close()
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
      : new CaptureSession(ask.session, ask.fps, await captureTrack(source.media, source.id, ask.fps, ask.box), source.gate, emit)
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
      case "rate":
        return session?.rate(ask.bitrate)
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
