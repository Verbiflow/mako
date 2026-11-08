import { randomInt } from "node:crypto"
import { CONTROL_VIDEO_DATA_LIMIT, CONTROL_VIDEO_DESCRIPTION_LIMIT, controlVideoCodec, type ControlVideoPacket } from "@mako/control-runtime/contracts"
import { hostLog, hostWarn } from "../../base/host-log.js"
import type { SimulatorFrameSink, SimulatorFrameSource } from "./host.js"

/*
 * A simulator's screen as this Mac's serve-sim captures it, read from the hub on loopback and turned into the packets
 * `SimulatorStreams` shares among viewers (`ControlVideoPacket`). No client is ever given the hub's port.
 *
 * serve-sim's `stream.avcc` is a run of envelopes, `[u32 BE length, the tag included][u8 tag][payload]`: the avcC
 * record (1), a key frame (2) or a delta (3) as length-prefixed NAL units, or the JPEG it last captured (4), sent
 * first so a viewer paints at once. Each request starts its own capture subscription, beginning at a key frame.
 * `stream.mjpeg` is `multipart/x-mixed-replace` with the boundary `frame`, for a capture that sends no H.264 a viewer
 * can decode.
 */

const TAG_DESCRIPTION = 1
const TAG_KEY = 2
const TAG_DELTA = 3
const TAG_SEED = 4
/** One envelope larger than this is a stream out of step, not a frame. */
const ENVELOPE_LIMIT = 8 * 1024 * 1024
/** A fresh key frame is asked of the capture at most this often. */
const RESTART_MS = 250
/** A capture that ended is opened again after this, doubling to the most, until it's stopped. */
const RETRY_MS = 500
const RETRY_MAX_MS = 8_000
/** With no picture a viewer decoded this long after its first unit, a capture falls back to JPEGs: H.264 nobody can show paints nothing. */
export const FIRST_KEY_MS = 5_000
/** An AVCC route silent this long falls back too; a simulator's capture can take seconds to start on a busy Mac. */
export const FIRST_UNIT_MS = 15_000
/**
 * Where a capture's sequences start, at random below this: a capture made after another stopped counts the old one's
 * pictures as its own only by a chance of about one in ten million, and a 32-bit sequence has two billion frames to go.
 */
const SEQUENCE_START_LIMIT = 2 ** 31

export interface AvccUnit {
  tag: number
  payload: Uint8Array
}

/** serve-sim's AVCC envelopes, from chunks cut wherever the network cut them. */
export class AvccReader {
  #buffer: Uint8Array = new Uint8Array(0)
  readonly #unit: (unit: AvccUnit) => void

  constructor(unit: (unit: AvccUnit) => void) {
    this.#unit = unit
  }

  push(chunk: Uint8Array): void {
    this.#buffer = this.#buffer.byteLength ? concat(this.#buffer, chunk) : chunk
    let offset = 0
    while (this.#buffer.byteLength - offset >= 5) {
      const view = new DataView(this.#buffer.buffer, this.#buffer.byteOffset + offset, 5)
      const length = view.getUint32(0)
      if (length < 1 || length > ENVELOPE_LIMIT) throw new Error(`An AVCC envelope said it was ${length} bytes`)
      if (this.#buffer.byteLength - offset < 4 + length) break
      this.#unit({ tag: view.getUint8(4), payload: this.#buffer.slice(offset + 5, offset + 4 + length) })
      offset += 4 + length
    }
    this.#buffer = offset ? this.#buffer.slice(offset) : this.#buffer
  }
}

/** The JPEGs of serve-sim's `stream.mjpeg`: each part's headers say its length, so its body is never searched. */
export class MjpegReader {
  #buffer: Uint8Array = new Uint8Array(0)
  /** The blank line that ends a part's headers. */
  readonly #headersEnd = new Uint8Array([13, 10, 13, 10])
  readonly #jpeg: (jpeg: Uint8Array) => void

  constructor(jpeg: (jpeg: Uint8Array) => void) {
    this.#jpeg = jpeg
  }

  push(chunk: Uint8Array): void {
    this.#buffer = this.#buffer.byteLength ? concat(this.#buffer, chunk) : chunk
    for (;;) {
      const headersEnd = indexOf(this.#buffer, this.#headersEnd)
      if (headersEnd === -1) {
        if (this.#buffer.byteLength > 64 * 1024) throw new Error("An MJPEG part's headers never ended")
        return
      }
      const headers = new TextDecoder().decode(this.#buffer.subarray(0, headersEnd))
      const length = /content-length:\s*(\d+)/i.exec(headers)?.[1]
      if (!length) throw new Error("An MJPEG part had no Content-Length")
      const start = headersEnd + 4
      const end = start + Number(length)
      if (Number(length) > ENVELOPE_LIMIT) throw new Error(`An MJPEG part said it was ${length} bytes`)
      if (this.#buffer.byteLength < end) return
      this.#jpeg(this.#buffer.slice(start, end))
      this.#buffer = this.#buffer.slice(end)
    }
  }
}

/** A JPEG's size, from its first start-of-frame marker. */
export function jpegSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined
  let offset = 2
  while (offset + 9 < bytes.byteLength) {
    if (bytes[offset] !== 0xff) return undefined
    const marker = bytes[offset + 1]!
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!
    // SOF0–SOF15, less DHT (C4), JPG (C8) and DAC (CC), carry the frame's size.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
      return { height: (bytes[offset + 5]! << 8) | bytes[offset + 6]!, width: (bytes[offset + 7]! << 8) | bytes[offset + 8]! }
    offset += 2 + length
  }
  return undefined
}

function concat(first: Uint8Array, second: Uint8Array): Uint8Array {
  const joined = new Uint8Array(first.byteLength + second.byteLength)
  joined.set(first)
  joined.set(second, first.byteLength)
  return joined
}

function indexOf(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let at = 0; at + needle.byteLength <= haystack.byteLength; at++) {
    for (let index = 0; index < needle.byteLength; index++) if (haystack[at + index] !== needle[index]) continue outer
    return at
  }
  return -1
}

/** What a capture reads from the hub: a route's bytes as they come, ended by `signal`, and the screen's size. */
export interface CaptureSource {
  open(udid: string, route: "stream.avcc" | "stream.mjpeg", signal: AbortSignal): Promise<AsyncIterable<Uint8Array>>
  size(udid: string): Promise<{ width: number; height: number } | undefined>
}

/**
 * One simulator's screen from serve-sim, while `SimulatorStreams` watches it: H.264 from its AVCC stream, or its JPEGs
 * for good once no viewer's decoder draws a picture from it within `FIRST_KEY_MS` of its first unit, or it sends nothing
 * at all within `FIRST_UNIT_MS`. A capture that ends is opened
 * again, backing off, until it's stopped or ended.
 */
export class ServeSimCapture implements SimulatorFrameSource {
  readonly #source: CaptureSource
  readonly #udid: string
  readonly #sink: SimulatorFrameSink
  readonly #now: () => number
  #route: "stream.avcc" | "stream.mjpeg" = "stream.avcc"
  #abort: AbortController | undefined
  #retry: NodeJS.Timeout | undefined
  #retryMs = 0
  #restartedAt = 0
  #size: { width: number; height: number } | undefined
  #description: Uint8Array | undefined
  /** This subscription sent a key frame with a whole avcC record, so its deltas have something to follow. */
  #keyed = false
  /** A viewer's decoder drew a picture from this subscription's H.264: a record that only looks whole proves nothing. */
  #decoded = false
  /** The sequence of this subscription's first key frame: a picture decoded before it came from an earlier one. */
  #firstKey: number | undefined
  #sequence = randomInt(SEQUENCE_START_LIMIT)
  #stopped = false

  constructor(source: CaptureSource, udid: string, sink: SimulatorFrameSink, now: () => number = Date.now) {
    this.#source = source
    this.#udid = udid
    this.#sink = sink
    this.#now = now
    void this.#open()
  }

  get route(): "stream.avcc" | "stream.mjpeg" {
    return this.#route
  }

  /** A new subscription starts at a key frame, for whoever asked; JPEGs need none. */
  keyFrame(): void {
    if (this.#stopped || this.#route === "stream.mjpeg" || this.#now() - this.#restartedAt < RESTART_MS) return
    this.#abort?.abort()
    this.#abort = undefined
    void this.#open()
  }

  /** serve-sim encodes the screen at its own size; the panel scales it. */
  resize(): void {}

  decoded(sequence: number): void {
    if (this.#route === "stream.avcc" && this.#firstKey !== undefined && sequence >= this.#firstKey && sequence < this.#sequence) this.#decoded = true
  }

  async stop(): Promise<void> {
    this.#stopped = true
    clearTimeout(this.#retry)
    this.#retry = undefined
    this.#abort?.abort()
    this.#abort = undefined
  }

  /** The simulator went down: nothing more comes, and its viewers are told why. */
  end(reason: string): void {
    if (this.#stopped) return
    void this.stop()
    this.#sink.ended(reason)
  }

  async #open(): Promise<void> {
    if (this.#abort || this.#stopped) return
    const abort = new AbortController()
    this.#abort = abort
    this.#restartedAt = this.#now()
    this.#keyed = false
    this.#decoded = false
    this.#firstKey = undefined
    this.#description = undefined
    const route = this.#route
    let silent = false
    let heard = false
    let fallback: NodeJS.Timeout | undefined
    const giveUpIn = (ms: number) => {
      clearTimeout(fallback)
      fallback = setTimeout(() => {
        if (this.#decoded) return
        silent = true
        abort.abort()
      }, ms)
    }
    try {
      this.#size = (await this.#source.size(this.#udid)) ?? this.#size
      const body = await this.#source.open(this.#udid, route, abort.signal)
      const reader =
        route === "stream.avcc"
          ? new AvccReader((unit) => {
              if (!heard) giveUpIn(FIRST_KEY_MS)
              heard = true
              this.#unit(unit)
            })
          : new MjpegReader((jpeg) => this.#poster(jpeg))
      if (route === "stream.avcc") giveUpIn(FIRST_UNIT_MS)
      try {
        for await (const chunk of body) {
          if (abort.signal.aborted) break
          reader.push(chunk)
          this.#retryMs = 0
        }
      } finally {
        clearTimeout(fallback)
      }
    } catch (error) {
      if (!abort.signal.aborted) hostWarn("simulators", "screen capture failed", { simulator: this.#udid, route, error: error instanceof Error ? error.message : String(error) })
    }
    if (this.#abort !== abort) return
    this.#abort = undefined
    if (this.#stopped) return
    if (silent) {
      hostWarn("simulators", "no viewer decoded the capture's H.264; showing its JPEGs instead", { simulator: this.#udid, waitedMs: heard ? FIRST_KEY_MS : FIRST_UNIT_MS })
      this.#route = "stream.mjpeg"
      return void this.#open()
    }
    this.#retryMs = Math.min(RETRY_MAX_MS, this.#retryMs ? this.#retryMs * 2 : RETRY_MS)
    hostLog("simulators", "screen capture ended; opening it again", { simulator: this.#udid, route, afterMs: this.#retryMs })
    this.#retry = setTimeout(() => {
      this.#retry = undefined
      void this.#open()
    }, this.#retryMs)
    this.#retry.unref()
  }

  #unit(unit: AvccUnit): void {
    switch (unit.tag) {
      case TAG_DESCRIPTION:
        this.#description = decodable(unit.payload) ? unit.payload : undefined
        // A capture just started may not say its screen yet, and serve-sim sends no seed then: the record says its size.
        if (this.#description) this.#size = avccSize(this.#description) ?? this.#size
        return
      case TAG_SEED:
        return this.#poster(unit.payload)
      case TAG_KEY: {
        if (!this.#description) return
        const packet = this.#packet("key", unit.payload)
        if (!packet) return
        this.#keyed = true
        this.#firstKey ??= packet.sequence
        return this.#sink.packet(packet)
      }
      case TAG_DELTA: {
        if (!this.#keyed) return
        const packet = this.#packet("delta", unit.payload)
        if (packet) this.#sink.packet(packet)
        return
      }
    }
  }

  #poster(jpeg: Uint8Array): void {
    const size = jpegSize(jpeg)
    if (size && (!this.#size || this.#route === "stream.mjpeg")) this.#size = size
    const packet = this.#packet("poster", jpeg)
    if (packet) this.#sink.packet(packet)
  }

  #packet(kind: ControlVideoPacket["kind"], data: Uint8Array): ControlVideoPacket | undefined {
    const size = this.#size ?? (kind === "poster" ? jpegSize(data) : undefined)
    if (!size || !data.byteLength || data.byteLength > CONTROL_VIDEO_DATA_LIMIT) return undefined
    const width = Math.min(4096, Math.max(2, Math.round(size.width)))
    const height = Math.min(4096, Math.max(2, Math.round(size.height)))
    const common = { width, height, sequence: kind === "poster" ? this.#sequence : this.#sequence++, capturedAt: this.#now(), data }
    if (kind === "key") return this.#description ? { ...common, kind, description: this.#description } : undefined
    return { ...common, kind }
  }
}

/**
 * The picture size an avcC record's first sequence parameter set says (ITU-T H.264 7.3.2.1.1), cropped; undefined when
 * it can't be read.
 */
export function avccSize(record: Uint8Array): { width: number; height: number } | undefined {
  if (record.byteLength < 8 || (record[5]! & 0x1f) === 0) return undefined
  const length = (record[6]! << 8) | record[7]!
  const nal = record.subarray(8, 8 + length)
  if (nal.byteLength !== length || length < 4 || (nal[0]! & 0x1f) !== 7) return undefined
  const rbsp: number[] = []
  for (let at = 1; at < nal.byteLength; at++) {
    if (at >= 3 && nal[at] === 3 && nal[at - 1] === 0 && nal[at - 2] === 0) continue
    rbsp.push(nal[at]!)
  }
  const bits = new SpsBits(rbsp)
  try {
    const profile = bits.u(8)
    bits.u(16)
    bits.ue()
    let chroma = 1
    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
      chroma = bits.ue()
      if (chroma === 3) bits.u(1)
      bits.ue()
      bits.ue()
      bits.u(1)
      if (bits.u(1))
        for (let list = 0; list < (chroma === 3 ? 12 : 8); list++) {
          if (!bits.u(1)) continue
          let last = 8
          let next = 8
          for (let entry = 0; entry < (list < 6 ? 16 : 64); entry++) {
            if (next !== 0) next = (last + bits.se() + 256) % 256
            last = next === 0 ? last : next
          }
        }
    }
    bits.ue()
    const pocType = bits.ue()
    if (pocType === 0) bits.ue()
    else if (pocType === 1) {
      bits.u(1)
      bits.se()
      bits.se()
      for (let cycle = bits.ue(); cycle > 0; cycle--) bits.se()
    }
    bits.ue()
    bits.u(1)
    const widthMbs = bits.ue() + 1
    const heightUnits = bits.ue() + 1
    const frameMbsOnly = bits.u(1)
    if (!frameMbsOnly) bits.u(1)
    bits.u(1)
    const crop = bits.u(1) ? { left: bits.ue(), right: bits.ue(), top: bits.ue(), bottom: bits.ue() } : { left: 0, right: 0, top: 0, bottom: 0 }
    const cropX = chroma === 0 || chroma === 3 ? 1 : 2
    const cropY = (chroma === 0 || chroma === 3 ? 1 : chroma === 2 ? 1 : 2) * (2 - frameMbsOnly)
    const width = widthMbs * 16 - cropX * (crop.left + crop.right)
    const height = (2 - frameMbsOnly) * heightUnits * 16 - cropY * (crop.top + crop.bottom)
    return width > 0 && height > 0 ? { width, height } : undefined
  } catch {
    return undefined
  }
}

/** A sequence parameter set's bits, read in order; reading past its end throws. */
class SpsBits {
  readonly #bytes: readonly number[]
  #at = 0

  constructor(bytes: readonly number[]) {
    this.#bytes = bytes
  }

  u(count: number): number {
    let value = 0
    for (let bit = 0; bit < count; bit++) {
      const byte = this.#bytes[this.#at >> 3]
      if (byte === undefined) throw new Error("The sequence parameter set ended early")
      value = value * 2 + ((byte >> (7 - (this.#at & 7))) & 1)
      this.#at++
    }
    return value
  }

  ue(): number {
    let zeros = 0
    while (this.u(1) === 0) if (++zeros > 31) throw new Error("A sequence parameter set's number is too long")
    return 2 ** zeros - 1 + this.u(zeros)
  }

  se(): number {
    const code = this.ue()
    return code % 2 ? (code + 1) / 2 : -code / 2
  }
}

/**
 * A whole AVCDecoderConfigurationRecord (ISO/IEC 14496-15 5.3.3.1), with a sequence parameter set that reads and a
 * picture parameter set: what WebCodecs needs to configure a decoder. A viewer's decoder may still refuse it.
 */
export function decodable(description: Uint8Array): boolean {
  if (description.byteLength > CONTROL_VIDEO_DESCRIPTION_LIMIT || !avccSize(description)) return false
  try {
    controlVideoCodec(description)
  } catch {
    return false
  }
  let at = 6
  const sets = (count: number, type: number): boolean => {
    for (let set = 0; set < count; set++) {
      if (at + 2 > description.byteLength) return false
      const length = (description[at]! << 8) | description[at + 1]!
      if (length < 1 || at + 2 + length > description.byteLength || (description[at + 2]! & 0x1f) !== type) return false
      at += 2 + length
    }
    return true
  }
  if (!sets(description[5]! & 0x1f, 7) || at >= description.byteLength) return false
  const pictures = description[at++]!
  return pictures > 0 && sets(pictures, 8)
}
