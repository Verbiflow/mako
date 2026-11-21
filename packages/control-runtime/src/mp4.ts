import { open, rm, type FileHandle } from "node:fs/promises"
import type { ControlVideoPacket } from "./contracts/control-video.js"
import { heavy } from "./heavy-packages.js"

/**
 * H.264 in MP4 without FFmpeg: recordings written here as fragmented MP4 as their units come, so a crash leaves every
 * unit but the newest playable; and, through Mediabunny (MPL-2.0, pure JavaScript), files read back to check them and
 * to learn a native video's size, length and packet times, and a video's packets written again at other times, with
 * no decode.
 */

/** Time in the file's track, in ticks a second. */
const TIMESCALE = 90_000

function box(type: string, ...parts: Uint8Array[]): Uint8Array {
  const size = parts.reduce((total, part) => total + part.byteLength, 8)
  const out = new Uint8Array(size)
  const view = new DataView(out.buffer)
  view.setUint32(0, size)
  for (let index = 0; index < 4; index++) out[4 + index] = type.charCodeAt(index)
  let at = 8
  for (const part of parts) {
    out.set(part, at)
    at += part.byteLength
  }
  return out
}
/** Big-endian fields: [bytes, value] pairs. */
function fields(...values: [1 | 2 | 4 | 8, number][]): Uint8Array {
  const out = new Uint8Array(values.reduce((total, [bytes]) => total + bytes, 0))
  const view = new DataView(out.buffer)
  let at = 0
  for (const [bytes, value] of values) {
    if (bytes === 1) view.setUint8(at, value)
    else if (bytes === 2) view.setUint16(at, value)
    else if (bytes === 4) view.setUint32(at, value >>> 0)
    else view.setBigUint64(at, BigInt(Math.max(0, Math.round(value))))
    at += bytes
  }
  return out
}
const ascii = (text: string) => Uint8Array.from(text, (character) => character.charCodeAt(0))
const zeros = (count: number) => new Uint8Array(count)
const MATRIX = fields([4, 0x10000], [4, 0], [4, 0], [4, 0], [4, 0x10000], [4, 0], [4, 0], [4, 0], [4, 0x40000000])

/** The file's start: its brands, and one H.264 track of `width`×`height` whose samples all come in fragments. */
function header(width: number, height: number, description: Uint8Array): Uint8Array {
  const ftyp = box("ftyp", ascii("isom"), fields([4, 0x200]), ascii("isomiso6avc1mp41"))
  const mvhd = box("mvhd", fields([4, 0], [4, 0], [4, 0], [4, 1000], [4, 0], [4, 0x10000], [2, 0x100]), zeros(10), MATRIX, zeros(24), fields([4, 2]))
  const tkhd = box("tkhd", fields([4, 3], [4, 0], [4, 0], [4, 1], [4, 0], [4, 0]), zeros(8), fields([2, 0], [2, 0], [2, 0], [2, 0]), MATRIX, fields([4, width * 0x10000], [4, height * 0x10000]))
  const mdhd = box("mdhd", fields([4, 0], [4, 0], [4, 0], [4, TIMESCALE], [4, 0], [2, 0x55c4], [2, 0]))
  const hdlr = box("hdlr", fields([4, 0], [4, 0]), ascii("vide"), zeros(12), ascii("VideoHandler\0"))
  const avc1 = box("avc1", zeros(6), fields([2, 1]), zeros(16), fields([2, width], [2, height], [4, 0x480000], [4, 0x480000], [4, 0], [2, 1]), zeros(32), fields([2, 0x18], [2, 0xffff]), box("avcC", description))
  const stbl = box("stbl",
    box("stsd", fields([4, 0], [4, 1]), avc1),
    box("stts", fields([4, 0], [4, 0])),
    box("stsc", fields([4, 0], [4, 0])),
    box("stsz", fields([4, 0], [4, 0], [4, 0])),
    box("stco", fields([4, 0], [4, 0])))
  const minf = box("minf", box("vmhd", fields([4, 1], [2, 0], [2, 0], [2, 0], [2, 0])), box("dinf", box("dref", fields([4, 0], [4, 1]), box("url ", fields([4, 1])))), stbl)
  const trak = box("trak", tkhd, box("mdia", mdhd, hdlr, minf))
  const mvex = box("mvex", box("trex", fields([4, 0], [4, 1], [4, 1], [4, 0], [4, 0], [4, 0])))
  const moov = box("moov", mvhd, trak, mvex)
  const out = new Uint8Array(ftyp.byteLength + moov.byteLength)
  out.set(ftyp)
  out.set(moov, ftyp.byteLength)
  return out
}

/** One sample as its own fragment: written the moment its duration is known. */
function fragment(sequence: number, decodeTime: number, duration: number, key: boolean, data: Uint8Array): Uint8Array {
  // As FFmpeg writes a one-sample fragment, which every reader takes (FFmpeg 5.1 lost the duration of a sample given
  // in trun alone): tfhd gives base-is-moof and the sample's duration, size and flags; trun its data offset.
  const flags = key ? 0x02000000 : 0x01010000
  const tfhd = box("tfhd", fields([4, 0x020038], [4, 1], [4, duration], [4, data.byteLength], [4, flags]))
  const tfdt = box("tfdt", fields([4, 0x01000000], [8, decodeTime]))
  const mfhd = box("mfhd", fields([4, 0], [4, sequence]))
  const trunBody = (offset: number) => fields([4, 0x000005], [4, 1], [4, offset], [4, flags])
  const moofSize = 8 + mfhd.byteLength + 8 + tfhd.byteLength + tfdt.byteLength + box("trun", trunBody(0)).byteLength
  const moof = box("moof", mfhd, box("traf", tfhd, tfdt, box("trun", trunBody(moofSize + 8))))
  const mdat = box("mdat", data)
  const out = new Uint8Array(moof.byteLength + mdat.byteLength)
  out.set(moof)
  out.set(mdat, moof.byteLength)
  return out
}

/**
 * A recording's file: fragmented MP4 written as its H.264 units come, each unit its own fragment written once the
 * next gives its duration, so a crash keeps every unit but the newest. A still picture's unit is written at the end,
 * or when the next comes. Every key unit of one recording carries the same `avcC`.
 */
export class Mp4Writer {
  readonly #path: string
  readonly #frameMs: number
  #file?: FileHandle
  #description?: Uint8Array
  #held?: { packet: ControlVideoPacket; at: number }
  #origin = 0
  #fragments = 0

  constructor(path: string, frameMs: number) {
    this.#path = path
    this.#frameMs = frameMs
  }

  /** Units written so far. */
  get frames(): number {
    return this.#fragments
  }

  /** A unit presented at `at` milliseconds into the video. The first must be a key frame. */
  async add(packet: ControlVideoPacket, at: number): Promise<void> {
    if (packet.kind === "poster") return
    if (!this.#file && !this.#held) {
      if (packet.kind !== "key") throw new Error("A recording's first unit must be a key frame")
      this.#description = Uint8Array.from(packet.description)
      this.#origin = at
      this.#file = await open(this.#path, "wx", 0o600)
      await this.#file.write(header(packet.width, packet.height, this.#description))
    } else if (packet.kind === "key" && !sameBytes(packet.description, this.#description!)) {
      throw new Error("A recording's encoder changed its configuration")
    }
    const held = this.#held
    this.#held = { packet, at }
    if (held) await this.#write(held.packet, held.at, Math.max(1, at - held.at))
  }

  /** Writes the last unit, shown until `end` (milliseconds into the video) when that is later than one frame, and closes the file. */
  async finish(end?: number): Promise<void> {
    const held = this.#held
    this.#held = undefined
    if (held) await this.#write(held.packet, held.at, Math.max(this.#frameMs, (end ?? 0) - held.at))
    await this.#file?.close()
    this.#file = undefined
  }

  /** Closes the file where it is: every fragment written stays readable. */
  async cancel(): Promise<void> {
    this.#held = undefined
    await this.#file?.close().catch(() => {})
    this.#file = undefined
  }

  async #write(packet: ControlVideoPacket, at: number, durationMs: number): Promise<void> {
    const ticks = (ms: number) => Math.round((ms * TIMESCALE) / 1000)
    const start = ticks(at - this.#origin)
    await this.#file!.write(fragment(++this.#fragments, start, Math.max(1, ticks(at - this.#origin + durationMs) - start), packet.kind === "key", packet.data))
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
}

export interface Mp4Packet {
  /** Presentation time, in seconds. */
  timestamp: number
  duration: number
  key: boolean
}

export interface Mp4Video {
  codec: string | null
  width: number
  height: number
  /** Seconds, from the first presentation to the last packet's end. */
  duration: number
  packets: Mp4Packet[]
}

/** A file's video track as Mediabunny reads it: none when it has no video or isn't a readable MP4. */
export async function readMp4(path: string, limit = 100_000): Promise<Mp4Video | undefined> {
  const { Input, FilePathSource, MP4, EncodedPacketSink } = await heavy.mediabunny.load("reading a video")
  const input = new Input({ source: new FilePathSource(path), formats: [MP4] })
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track) return undefined
    const packets: Mp4Packet[] = []
    for await (const packet of new EncodedPacketSink(track).packets(undefined, undefined, { metadataOnly: true })) {
      packets.push({ timestamp: packet.timestamp, duration: packet.duration, key: packet.type === "key" })
      if (packets.length > limit) throw new Error(`The video has more than ${limit} packets`)
    }
    return {
      codec: await track.getCodecParameterString(),
      width: await track.getCodedWidth(),
      height: await track.getCodedHeight(),
      duration: await track.computeDuration(),
      packets,
    }
  } catch (error) {
    if (error instanceof Error && /packets/.test(error.message)) throw error
    return undefined
  } finally {
    input.dispose()
  }
}

/** One unit of a file's video track: its presentation time in seconds, its bytes and, on a key unit, the avcC. */
export interface Mp4Unit {
  timestamp: number
  key: boolean
  data: Uint8Array
  description?: Uint8Array
}

/** A file's video units in decode order, with their bytes, as Mediabunny reads them: for a decoder to draw over. */
export async function* mp4Units(path: string): AsyncGenerator<Mp4Unit, void, undefined> {
  const { Input, FilePathSource, MP4, EncodedPacketSink } = await heavy.mediabunny.load("reading a video")
  const input = new Input({ source: new FilePathSource(path), formats: [MP4] })
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track) throw new Error("The video has no video track")
    const config = await track.getDecoderConfig()
    const description = config?.description ? new Uint8Array(ArrayBuffer.isView(config.description) ? config.description.buffer.slice(config.description.byteOffset, config.description.byteOffset + config.description.byteLength) : config.description) : undefined
    for await (const packet of new EncodedPacketSink(track).packets()) {
      const key = packet.type === "key"
      yield { timestamp: packet.timestamp, key, data: packet.data, ...(key && description && { description }) }
    }
  } finally {
    input.dispose()
  }
}

/**
 * The video track of `source` written to `output` with each packet's time moved by `shift` (seconds before it to take
 * away), packets unchanged. `last` limits the last packet's duration. The output is removed if anything fails.
 */
export async function retimeMp4(source: string, output: string, shift: (timestamp: number) => number, last?: number): Promise<void> {
  const mediabunny = await heavy.mediabunny.load("trimming a video")
  const input = new mediabunny.Input({ source: new mediabunny.FilePathSource(source), formats: [mediabunny.MP4] })
  const writer = new mediabunny.Output({ format: new mediabunny.Mp4OutputFormat({ fastStart: "in-memory" }), target: new mediabunny.FilePathTarget(output) })
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track) throw new Error("The video has no video track")
    const config = await track.getDecoderConfig()
    if (!config) throw new Error("The video's codec isn't one this reads")
    const codec = await track.getCodec()
    if (!codec) throw new Error("The video's codec isn't one this reads")
    const sink = new mediabunny.EncodedPacketSink(track)
    const target = new mediabunny.EncodedVideoPacketSource(codec)
    writer.addVideoTrack(target)
    await writer.start()
    let first = true
    const end = await track.computeDuration()
    for await (const packet of sink.packets()) {
      const timestamp = packet.timestamp - shift(packet.timestamp)
      let duration = packet.duration
      if (last !== undefined && packet.timestamp + packet.duration >= end - 1e-6) duration = Math.min(duration, last)
      await target.add(new mediabunny.EncodedPacket(packet.data, packet.type, timestamp, duration), first ? { decoderConfig: config } : undefined)
      first = false
    }
    await writer.finalize()
  } catch (error) {
    await writer.cancel().catch(() => {})
    await rm(output, { force: true })
    throw error
  } finally {
    input.dispose()
  }
}
