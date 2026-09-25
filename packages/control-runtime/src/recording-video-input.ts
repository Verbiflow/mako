/** Private RGB24 streaming MOV framing. Explicit presentation times let the
 * encoder hold an image during contention instead of speeding up the video.
 * Only headers are allocated here; the caller writes its owned pixels directly.
 * The bundled MOV demuxer/rawvideo decoder already support this input format. */
const uint16 = (value: number) => {
  const bytes = Buffer.alloc(2)
  bytes.writeUInt16BE(value)
  return bytes
}
const uint32 = (value: number) => {
  const bytes = Buffer.alloc(4)
  bytes.writeUInt32BE(value)
  return bytes
}
const zeros = (size: number) => Buffer.alloc(size)
const word = (value: string) => Buffer.from(value, "ascii")
const box = (type: string, ...parts: Buffer[]) => {
  const size = parts.reduce((total, part) => total + part.length, 8)
  return Buffer.concat([uint32(size), word(type), ...parts], size)
}
const full = (type: string, flags: number, ...parts: Buffer[]) =>
  box(type, uint32(flags), ...parts)
const matrix = Buffer.concat(
  [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000].map(uint32)
)
const timescale = 1_000_000

export class RecordingVideoInput {
  /** An explicit ratio; FFmpeg 5.1 (Debian bookworm) cannot parse `demux`. */
  readonly timeBase = `1:${timescale}`
  readonly header: Buffer
  readonly frameBytes: number
  private readonly fragment: Buffer
  private readonly sequenceOffset: number
  private readonly timeOffset: number
  private sequence = 0
  private previousTime = -1

  constructor(width: number, height: number, fps: number) {
    if (![width, height].every(value => Number.isInteger(value) && value >= 2 && value <= 2560) ||
      !Number.isInteger(fps) || fps < 1 || fps > 60)
      throw new Error("Invalid recording input dimensions or frame rate")
    this.frameBytes = width * height * 3
    const duration = Math.round(timescale / fps)
    const stsd = full("stsd", 0, uint32(1), box("raw ", zeros(6), uint16(1),
      zeros(16), uint16(width), uint16(height), uint32(0x480000), uint32(0x480000),
      zeros(4), uint16(1), zeros(32), uint16(24), uint16(65535)))
    const stbl = box("stbl", stsd, full("stts", 0, uint32(0)),
      full("stsc", 0, uint32(0)), full("stsz", 0, uint32(0), uint32(0)),
      full("stco", 0, uint32(0)))
    const dinf = box("dinf", full("dref", 0, uint32(1), full("url ", 1)))
    const minf = box("minf", full("vmhd", 1, zeros(8)), dinf, stbl)
    const mdia = box("mdia", full("mdhd", 0, zeros(8), uint32(timescale),
      uint32(0), uint16(0x55c4), uint16(0)), full("hdlr", 0, uint32(0),
      word("vide"), zeros(12), word("Video\0")), minf)
    const trak = box("trak", full("tkhd", 7, zeros(8), uint32(1), uint32(0),
      uint32(0), zeros(8), zeros(8), matrix, uint32(width * 65536),
      uint32(height * 65536)), mdia)
    const moov = box("moov", full("mvhd", 0, zeros(8), uint32(timescale),
      uint32(0), uint32(65536), uint16(256), zeros(10), matrix, zeros(24),
      uint32(2)), trak, box("mvex", full("trex", 0, uint32(1), uint32(1),
      uint32(duration), uint32(this.frameBytes), uint32(0x02000000))))
    this.header = Buffer.concat([box("ftyp", word("qt  "), uint32(0), word("qt  ")), moov])
    const moof = box("moof", full("mfhd", 0, uint32(0)), box("traf",
      full("tfhd", 0x020000, uint32(1)), full("tfdt", 0, uint32(0)),
      full("trun", 0x301, uint32(1), uint32(0), uint32(duration), uint32(this.frameBytes))))
    // One independent sample per fragment, with its own decoding/presentation
    // time; raw input and encoded output both have no reordered B frames.
    moof.writeUInt32BE(moof.length + 8, moof.indexOf("trun") + 12)
    this.sequenceOffset = moof.indexOf("mfhd") + 8
    this.timeOffset = moof.indexOf("tfdt") + 8
    this.fragment = Buffer.concat([moof, uint32(this.frameBytes + 8), word("mdat")])
  }

  frame(atMs: number, size: number) {
    const time = Math.round(atMs * 1000)
    // Current recordings are limited to ten minutes; reject rather than wrap
    // the 32-bit microsecond clock (about 71 minutes).
    if (!Number.isSafeInteger(time) || time < 0 || time > 0xffffffff ||
      time <= this.previousTime || size !== this.frameBytes)
      throw new Error("Invalid recording frame timestamp or pixel size")
    const header = Buffer.from(this.fragment)
    header.writeUInt32BE(++this.sequence, this.sequenceOffset)
    header.writeUInt32BE(time, this.timeOffset)
    this.previousTime = time
    return header
  }
}
