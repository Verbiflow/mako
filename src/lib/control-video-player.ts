import { controlVideoCodec, decodeControlVideo, type ControlVideoPacket } from "@mako/control-runtime/contracts"

export interface ControlVideoStats {
  decoded: number
  /** Units dropped while waiting for a key frame. */
  skipped: number
  /** Source frames this viewer was not sent: paced out, or skipped while it was behind. */
  unsent: number
  /** The machine's capture time of the picture last drawn. */
  capturedAt?: number
}

type Picture = VideoFrame | ImageBitmap

/** Decodes a remote preview's H.264 units with WebCodecs and hands each
 * picture to `draw`, which must use it before returning; it is closed after.
 * A poster JPEG is drawn only until the first decoded frame. Every key unit
 * carries its configuration, so a new size or a recovered viewer reconfigures
 * without asking the sender for anything. */
export class ControlVideoPlayer {
  readonly stats: ControlVideoStats = { decoded: 0, skipped: 0, unsent: 0 }
  private decoder?: VideoDecoder
  private configured?: string
  private awaitingKey = true
  private lastSequence?: number
  private readonly captured = new Map<number, number>()
  private readonly draw: (picture: Picture, width: number, height: number, capturedAt: number) => void
  private readonly failed: (reason: string) => void

  constructor(
    draw: (picture: Picture, width: number, height: number, capturedAt: number) => void,
    failed: (reason: string) => void
  ) {
    this.draw = draw
    this.failed = failed
  }

  push(bytes: Uint8Array) {
    const packet = decodeControlVideo(bytes)
    if (packet.kind === "poster") {
      if (!this.stats.decoded) void this.poster(packet)
      return
    }
    if (this.lastSequence !== undefined && packet.sequence > this.lastSequence + 1)
      this.stats.unsent += packet.sequence - this.lastSequence - 1
    this.lastSequence = packet.sequence
    if (packet.kind === "key") {
      const codec = controlVideoCodec(packet.description)
      const identity = `${codec}:${packet.width}x${packet.height}:${packet.description.join(",")}`
      if (identity !== this.configured || this.decoder?.state !== "configured") {
        this.decoder?.close()
        this.decoder = new VideoDecoder({
          output: (frame) => this.present(frame),
          error: (error) => {
            this.configured = undefined
            this.awaitingKey = true
            this.failed(error.message)
          },
        })
        this.decoder.configure({
          codec,
          description: packet.description,
          codedWidth: packet.width,
          codedHeight: packet.height,
          optimizeForLatency: true,
        })
        this.configured = identity
      }
      this.awaitingKey = false
    }
    if (this.awaitingKey || !this.decoder) {
      this.stats.skipped++
      return
    }
    // The chunk's timestamp is the source sequence; the capture time travels beside it.
    this.captured.set(packet.sequence, packet.capturedAt)
    this.decoder.decode(new EncodedVideoChunk({
      type: packet.kind,
      timestamp: packet.sequence,
      data: packet.data,
    }))
  }

  private async poster(packet: ControlVideoPacket) {
    const bitmap = await createImageBitmap(new Blob([packet.data.slice()], { type: "image/jpeg" }))
    try {
      if (!this.stats.decoded) this.draw(bitmap, bitmap.width, bitmap.height, packet.capturedAt)
    } finally {
      bitmap.close()
    }
  }

  private present(frame: VideoFrame) {
    const capturedAt = this.captured.get(frame.timestamp) ?? Date.now()
    for (const sequence of this.captured.keys())
      if (sequence <= frame.timestamp) this.captured.delete(sequence)
    try {
      this.stats.decoded++
      this.stats.capturedAt = capturedAt
      this.draw(frame, frame.displayWidth, frame.displayHeight, capturedAt)
    } finally {
      frame.close()
    }
  }

  close() {
    if (this.decoder?.state !== "closed") this.decoder?.close()
    this.decoder = undefined
    this.captured.clear()
  }
}
