import { CONTROL_VIDEO_SIZE_LIMIT, liveVideoBitrate, type ControlVideoPacket } from "@mako/control-runtime/contracts"

/** A frame's place in its capture, carried to the unit made of it. */
export interface LiveFrameTag {
  sequence: number
  /** When the frame was captured, in milliseconds since 1970. */
  capturedAt: number
}

export interface LiveVideoEncoderEvents {
  /** A frame left as a unit. Every key unit carries the `avcC` its encoder gave, which WebCodecs sends only once. */
  unit(packet: ControlVideoPacket): void
  /** A frame is out of the encoder, as a unit or dropped (by rate control, a newer frame or a restart): room for another. */
  drained(tag: LiveFrameTag, sent: boolean): void
  /** No encoder here can go on. */
  failed(reason: string): void
}

/** The parts of an `EncodedVideoChunk` the encoder reads. */
export interface LiveVideoChunk {
  readonly type: EncodedVideoChunkType
  readonly timestamp: number
  readonly byteLength: number
  copyTo(destination: Uint8Array): void
}

/** The parts of a frame the encoder reads: a `VideoFrame`, or a test's. */
export interface LiveFrame {
  readonly displayWidth: number
  readonly displayHeight: number
  readonly visibleRect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } | null
  close(): void
}

/** The parts of a `VideoEncoder` the encoder drives. */
export interface LiveVideoCodec<Frame extends LiveFrame = VideoFrame> {
  configure(config: VideoEncoderConfig): void
  encode(frame: Frame, options: VideoEncoderEncodeOptions): void
  flush(): Promise<void>
  close(): void
}

/** The WebCodecs it runs on: the browser's, or a test's. */
export interface LiveVideoCodecs<Frame extends LiveFrame = VideoFrame> {
  supported(config: VideoEncoderConfig): Promise<boolean>
  create(output: (chunk: LiveVideoChunk, metadata?: EncodedVideoChunkMetadata) => void, error: (error: Error) => void): LiveVideoCodec<Frame>
  /** `frame` as a new frame of `width`×`height` from its top left, stamped `timestamp`; the caller closes both. */
  wrap(frame: Frame, width: number, height: number, timestamp: number): Frame
}

export const browserCodecs: LiveVideoCodecs = {
  supported: async (config) => (await VideoEncoder.isConfigSupported(config)).supported === true,
  create: (output, error) => new VideoEncoder({ output, error }),
  wrap: (frame, width, height, timestamp) => new VideoFrame(frame, {
    timestamp,
    visibleRect: { x: frame.visibleRect?.x ?? 0, y: frame.visibleRect?.y ?? 0, width, height },
  }),
}

/**
 * What it tries, in order: the platform's hardware encoder (VideoToolbox, Media Foundation, VA-API) at High, then
 * Baseline, then Chromium's own software encoder (OpenH264, Baseline only). Chromium refuses `prefer-hardware` where
 * there is none, so a supported config is the hardware.
 */
const ATTEMPTS = [
  { codec: "avc1.640034", hardwareAcceleration: "prefer-hardware" },
  { codec: "avc1.42e034", hardwareAcceleration: "prefer-hardware" },
  { codec: "avc1.42e034", hardwareAcceleration: "prefer-software" },
] as const satisfies readonly { codec: string; hardwareAcceleration: HardwareAcceleration }[]

/** Which encoder a live video would use here, as `codec acceleration`; none where WebCodecs has no H.264 encoder. */
export async function liveVideoEncoderAvailable(fps: number, given?: LiveVideoCodecs<LiveFrame>["supported"]): Promise<string | undefined> {
  if (!given && !("VideoEncoder" in globalThis)) return undefined
  const supported = given ?? browserCodecs.supported
  for (const attempt of ATTEMPTS) {
    const config = { codec: attempt.codec, width: 1280, height: 720, hardwareAcceleration: attempt.hardwareAcceleration, framerate: fps, latencyMode: "realtime", avc: { format: "avc" } } satisfies VideoEncoderConfig
    if (await supported(config).catch(() => false)) return `${attempt.codec} ${attempt.hardwareAcceleration}`
  }
  return undefined
}

/**
 * Frames inside the encoder at once. A hardware encoder pipelines a few (FFmpeg's VideoToolbox held about six and
 * deadlocked at two); OpenH264 returns each before the next.
 */
const IN_FLIGHT = { hardware: 4, software: 2 }
/** An encoder that holds a full queue this long without a unit is flushed, so it can't wait for frames never sent. */
const STALL_MS = 250

interface Configured<Frame extends LiveFrame> {
  codec: LiveVideoCodec<Frame>
  width: number
  height: number
  attempt: number
  /** The `avcC` it gave with its first key frame. */
  description?: Uint8Array
}

/**
 * Live H.264 with WebCodecs, frames in and `ControlVideoPacket`s out, for one capture whose size may change. It
 * encodes at most `IN_FLIGHT` frames at once and holds only the newest of any it couldn't start yet. Its first unit,
 * the first after a size change or an encoder failure, and the next after `key()` are key units.
 */
export class LiveVideoEncoder<Frame extends LiveFrame = VideoFrame> {
  readonly #fps: number
  readonly #events: LiveVideoEncoderEvents
  readonly #codecs: LiveVideoCodecs<Frame>
  readonly #stallMs: number
  /** The first attempt worth trying; one that failed while encoding isn't tried again. */
  #floor = 0
  #encoder?: Configured<Frame>
  /** The size being configured, while `supported` runs. */
  #configuring?: { width: number; height: number }
  /** The newest frame that couldn't start yet. */
  #held?: { frame: Frame; tag: LiveFrameTag }
  #inFlight: { timestamp: number; tag: LiveFrameTag }[] = []
  #key = true
  /** The bits a second its viewers take, when they take less than the size's own (`liveVideoBitrate`). */
  #bitrate?: number
  #timestamp = 0
  /** Counts encoders made; a closed one's late output and errors are ignored. */
  #generation = 0
  #stall?: ReturnType<typeof setTimeout>
  #closed = false

  constructor(fps: number, events: LiveVideoEncoderEvents, codecs: LiveVideoCodecs<Frame>, stallMs = STALL_MS) {
    this.#fps = fps
    this.#events = events
    this.#codecs = codecs
    this.#stallMs = stallMs
  }

  /** What it encodes with: the codec and whether hardware was asked for, once configured. */
  get encoder(): string | undefined {
    const attempt = this.#encoder && ATTEMPTS[this.#encoder.attempt]
    return attempt && `${attempt.codec} ${attempt.hardwareAcceleration}`
  }

  /** Whether `encode` would start the frame now rather than hold it. */
  ready(): boolean {
    return !this.#closed && !this.#configuring && this.#inFlight.length < this.#limit()
  }

  /** The next frame encodes as a key unit. */
  key(): void {
    this.#key = true
  }

  /** Encodes at no more than `bitrate` from the next frame, in the encoder it has: no key frame, no new encoder. */
  rate(bitrate: number): void {
    this.#bitrate = bitrate
    const encoder = this.#encoder
    if (!encoder || this.#closed) return
    try {
      encoder.codec.configure(this.#config(encoder.attempt, encoder.width, encoder.height))
    } catch {
      // An encoder that won't take a new rate keeps its old one until it's made again.
    }
  }

  /** Takes `frame`: encodes it, or holds it in place of an older held one until there's room. The frame is closed for the caller. */
  encode(frame: Frame, tag: LiveFrameTag): void {
    if (this.#closed) return frame.close()
    const width = even(frame.visibleRect?.width ?? frame.displayWidth)
    const height = even(frame.visibleRect?.height ?? frame.displayHeight)
    if (width < 2 || height < 2 || width > CONTROL_VIDEO_SIZE_LIMIT || height > CONTROL_VIDEO_SIZE_LIMIT) {
      frame.close()
      return this.#fail(`A ${width}×${height} picture is outside what live video sends`)
    }
    const encoder = this.#encoder
    if (this.#configuring || !encoder || encoder.width !== width || encoder.height !== height || !this.ready()) {
      this.#hold(frame, tag)
      if (!this.#configuring && (!encoder || encoder.width !== width || encoder.height !== height)) this.#configure(width, height)
      return
    }
    this.#submit(encoder, frame, tag)
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#discard()
    const held = this.#held
    this.#held = undefined
    held?.frame.close()
  }

  #limit(): number {
    const attempt = ATTEMPTS[this.#encoder?.attempt ?? this.#floor]
    return attempt?.hardwareAcceleration === "prefer-hardware" ? IN_FLIGHT.hardware : IN_FLIGHT.software
  }

  #hold(frame: Frame, tag: LiveFrameTag): void {
    const replaced = this.#held
    this.#held = { frame, tag }
    if (replaced) {
      replaced.frame.close()
      this.#events.drained(replaced.tag, false)
    }
  }

  #submit(encoder: Configured<Frame>, frame: Frame, tag: LiveFrameTag): void {
    // Strictly increasing, in microseconds: outputs are matched to their frames by it, and rate control reads it.
    this.#timestamp = Math.max(this.#timestamp + 1, Math.round(performance.now() * 1000))
    const timestamp = this.#timestamp
    const key = this.#key
    this.#key = false
    let input: Frame
    try {
      input = this.#codecs.wrap(frame, encoder.width, encoder.height, timestamp)
    } catch (error) {
      this.#events.drained(tag, false)
      return this.#fail(error instanceof Error ? error.message : String(error))
    } finally {
      frame.close()
    }
    this.#inFlight.push({ timestamp, tag })
    try {
      encoder.codec.encode(input, { keyFrame: key })
    } catch (error) {
      return this.#broke(this.#generation, error instanceof Error ? error : new Error(String(error)))
    } finally {
      input.close()
    }
    this.#watchStall(encoder)
  }

  /** Each attempt from the floor until one is supported and configures; the held frame then starts with a key. */
  #configure(width: number, height: number): void {
    // Set first: frames the discard drains may be answered with new ones at once, which are held, not configured again.
    this.#configuring = { width, height }
    this.#discard()
    const generation = this.#generation
    void (async () => {
      for (let attempt = this.#floor; attempt < ATTEMPTS.length; attempt++) {
        const config = this.#config(attempt, width, height)
        const supported = await this.#codecs.supported(config).catch(() => false)
        if (generation !== this.#generation || this.#closed) return
        if (!supported) continue
        let codec: LiveVideoCodec<Frame>
        try {
          codec = this.#codecs.create(
            (chunk, metadata) => this.#output(generation, chunk, metadata),
            (error) => this.#broke(generation, error)
          )
          codec.configure(config)
        } catch {
          continue
        }
        this.#encoder = { codec, width, height, attempt }
        this.#configuring = undefined
        this.#key = true
        this.#next()
        return
      }
      this.#configuring = undefined
      this.#fail(`No H.264 encoder here takes a ${width}×${height} picture`)
    })()
  }

  #config(attempt: number, width: number, height: number): VideoEncoderConfig {
    const { codec, hardwareAcceleration } = ATTEMPTS[attempt]!
    return {
      codec,
      width,
      height,
      hardwareAcceleration,
      bitrate: Math.min(this.#bitrate ?? Infinity, liveVideoBitrate({ width, height }, this.#fps)),
      bitrateMode: "variable",
      framerate: this.#fps,
      latencyMode: "realtime",
      avc: { format: "avc" },
    }
  }

  /** Starts the held frame if there's room. */
  #next(): void {
    const held = this.#held
    const encoder = this.#encoder
    if (!held || !encoder || !this.ready()) return
    this.#held = undefined
    this.encode(held.frame, held.tag)
  }

  #output(generation: number, chunk: LiveVideoChunk, metadata?: EncodedVideoChunkMetadata): void {
    const encoder = this.#encoder
    if (generation !== this.#generation || this.#closed || !encoder) return
    clearTimeout(this.#stall)
    this.#stall = undefined
    const description = metadata?.decoderConfig?.description
    if (description) encoder.description = copyBytes(description)
    // Outputs come in order: frames before this one that never came out were dropped.
    while (this.#inFlight.length && this.#inFlight[0]!.timestamp < chunk.timestamp)
      this.#events.drained(this.#inFlight.shift()!.tag, false)
    if (this.#inFlight[0]?.timestamp !== chunk.timestamp) return
    const { tag } = this.#inFlight.shift()!
    const data = new Uint8Array(chunk.byteLength)
    chunk.copyTo(data)
    const common = { width: encoder.width, height: encoder.height, sequence: tag.sequence, capturedAt: tag.capturedAt, data }
    if (chunk.type === "key") {
      if (!encoder.description) return this.#fail("The encoder sent a key frame without its configuration")
      this.#events.unit({ ...common, kind: "key", description: encoder.description })
    } else this.#events.unit({ ...common, kind: "delta" })
    this.#events.drained(tag, true)
    this.#next()
  }

  /** The encoder in use failed: the next attempt takes over at the same size, from a key frame. */
  #broke(generation: number, error: Error): void {
    const encoder = this.#encoder
    if (generation !== this.#generation || this.#closed || !encoder) return
    this.#floor = encoder.attempt + 1
    if (this.#floor >= ATTEMPTS.length) return this.#fail(error.message)
    this.#configure(encoder.width, encoder.height)
  }

  /** A full queue with no unit for `stallMs` is flushed; what the flush doesn't return was dropped. */
  #watchStall(encoder: Configured<Frame>): void {
    if (this.#stall || this.#inFlight.length < this.#limit()) return
    const generation = this.#generation
    this.#stall = setTimeout(() => {
      this.#stall = undefined
      if (generation !== this.#generation || this.#closed) return
      encoder.codec.flush().then(() => {
        if (generation !== this.#generation || this.#closed) return
        for (const { tag } of this.#inFlight.splice(0)) this.#events.drained(tag, false)
        this.#next()
      }, () => {})
    }, this.#stallMs)
  }

  /** Closes the encoder in use; the frames inside it are dropped. */
  #discard(): void {
    this.#generation++
    clearTimeout(this.#stall)
    this.#stall = undefined
    const encoder = this.#encoder
    this.#encoder = undefined
    try {
      encoder?.codec.close()
    } catch {
      // Already closed by its own error.
    }
    for (const { tag } of this.#inFlight.splice(0)) this.#events.drained(tag, false)
  }

  #fail(reason: string): void {
    if (this.#closed) return
    this.close()
    this.#events.failed(reason)
  }
}

function even(value: number): number {
  return Math.floor(value / 2) * 2
}

function copyBytes(source: AllowSharedBufferSource): Uint8Array {
  return ArrayBuffer.isView(source)
    ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength).slice()
    : new Uint8Array(source).slice()
}
