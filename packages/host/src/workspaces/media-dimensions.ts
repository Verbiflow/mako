import type { FileHandle } from "node:fs/promises"

/** An image's or a video's pixel size, as its header states it. */
export interface MediaDimensions {
  width: number
  height: number
}

/** How far into a JPEG the size is looked for: EXIF and colour profiles come first, rarely past this. */
const JPEG_SCAN_LIMIT = 512 * 1024
/** How many MP4 boxes are walked before giving up on a file that never names a track's size. */
const MP4_BOX_LIMIT = 4_096
/** Larger than any real picture; a header claiming more is not believed. */
const MAX_SIDE = 1 << 16

/**
 * The size an image or video says it has, from its header alone: never a
 * decode. `head` is the file's first bytes, already read; JPEG markers and
 * MP4 boxes past it are found with positioned reads of a few bytes each.
 * Unknown containers and anything malformed answer undefined, never throw.
 */
export async function mediaDimensions(file: FileHandle, head: Buffer, size: number, mimeType: string | undefined): Promise<MediaDimensions | undefined> {
  try {
    const found = mimeType?.startsWith("video/") || mimeType === "image/avif" || mimeType === "image/heic"
      ? await isoDimensions(file, size)
      : imageDimensions(head) ?? (isJpeg(head) ? await jpegDimensions(file, size) : undefined)
    return found && found.width > 0 && found.height > 0 && found.width <= MAX_SIDE && found.height <= MAX_SIDE ? found : undefined
  } catch {
    return undefined
  }
}

/** PNG, GIF, WebP, BMP and SVG state their size in the first bytes; a JPEG whose size is in `head` too. */
export function imageDimensions(head: Buffer): MediaDimensions | undefined {
  if (head.length >= 24 && head.readUInt32BE(0) === 0x89504e47 && head.toString("ascii", 12, 16) === "IHDR")
    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) }
  if (head.length >= 10 && (head.toString("ascii", 0, 6) === "GIF87a" || head.toString("ascii", 0, 6) === "GIF89a"))
    return { width: head.readUInt16LE(6), height: head.readUInt16LE(8) }
  if (head.length >= 30 && head.toString("ascii", 0, 4) === "RIFF" && head.toString("ascii", 8, 12) === "WEBP") {
    const chunk = head.toString("ascii", 12, 16)
    if (chunk === "VP8X") return { width: 1 + head.readUIntLE(24, 3), height: 1 + head.readUIntLE(27, 3) }
    if (chunk === "VP8L" && head[20] === 0x2f) {
      const bits = head.readUInt32LE(21)
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) }
    }
    if (chunk === "VP8 " && head.readUIntBE(23, 3) === 0x9d012a)
      return { width: head.readUInt16LE(26) & 0x3fff, height: head.readUInt16LE(28) & 0x3fff }
    return undefined
  }
  if (head.length >= 26 && head.toString("ascii", 0, 2) === "BM")
    return { width: head.readInt32LE(18), height: Math.abs(head.readInt32LE(22)) }
  if (isJpeg(head)) return jpegFrom(head)
  return svgDimensions(head)
}

const isJpeg = (head: Buffer) => head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff

/** A start-of-frame marker carries the size; every other marker is skipped by its length. */
function jpegFrom(bytes: Buffer): MediaDimensions | undefined {
  let at = 2
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) return undefined
    const marker = bytes[at + 1]!
    if (marker === 0xff) { at += 1; continue }
    if (isStartOfFrame(marker)) return { height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7) }
    at += 2 + bytes.readUInt16BE(at + 2)
  }
  return undefined
}

const isStartOfFrame = (marker: number) => marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc

async function jpegDimensions(file: FileHandle, size: number): Promise<MediaDimensions | undefined> {
  const header = Buffer.alloc(9)
  let at = 2
  while (at + 9 <= Math.min(size, JPEG_SCAN_LIMIT)) {
    const { bytesRead } = await file.read(header, 0, 9, at)
    if (bytesRead < 9 || header[0] !== 0xff) return undefined
    const marker = header[1]!
    if (marker === 0xff) { at += 1; continue }
    if (isStartOfFrame(marker)) return { height: header.readUInt16BE(5), width: header.readUInt16BE(7) }
    at += 2 + header.readUInt16BE(2)
  }
  return undefined
}

/** `<svg width="640" height="320">` or its `viewBox`, in plain numbers or px only. */
function svgDimensions(head: Buffer): MediaDimensions | undefined {
  const text = head.toString("utf8")
  const tag = /<svg\b[^>]*>/i.exec(text)?.[0]
  if (!tag) return undefined
  const attribute = (name: string) => new RegExp(`\\s${name}\\s*=\\s*["']\\s*([\\d.]+)(?:px)?\\s*["']`, "i").exec(tag)?.[1]
  const width = Number(attribute("width"))
  const height = Number(attribute("height"))
  if (width > 0 && height > 0) return { width: Math.round(width), height: Math.round(height) }
  const box = /\sviewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*["']/i.exec(tag)
  return box ? { width: Math.round(Number(box[1])), height: Math.round(Number(box[2])) } : undefined
}

/**
 * The first video track's size in an MP4, MOV or other ISO-BMFF file:
 * `moov › trak › tkhd`, whose last eight bytes are the presented width and
 * height in 16.16 fixed point. Recorders write `moov` at the end unless told
 * otherwise, so boxes are walked by their headers rather than read whole.
 * A track rotated a quarter turn says so in its matrix; its sides swap.
 */
async function isoDimensions(file: FileHandle, size: number): Promise<MediaDimensions | undefined> {
  const header = Buffer.alloc(16)
  let budget = MP4_BOX_LIMIT
  const boxes = async function* (start: number, end: number) {
    let at = start
    while (at + 8 <= end && budget-- > 0) {
      const { bytesRead } = await file.read(header, 0, 16, at)
      if (bytesRead < 8) return
      let length = header.readUInt32BE(0)
      const type = header.toString("ascii", 4, 8)
      let body = at + 8
      if (length === 1) {
        if (bytesRead < 16) return
        length = Number(header.readBigUInt64BE(8))
        body = at + 16
      } else if (length === 0) length = end - at
      if (length < 8 || at + length > end) return
      yield { type, body, end: at + length }
      at += length
    }
  }
  for await (const top of boxes(0, size)) {
    if (top.type !== "moov") continue
    for await (const track of boxes(top.body, top.end)) {
      if (track.type !== "trak") continue
      for await (const box of boxes(track.body, track.end)) {
        if (box.type !== "tkhd") continue
        const tkhd = Buffer.alloc(box.end - box.body)
        if (tkhd.length < 84 || tkhd.length > 128) break
        await file.read(tkhd, 0, tkhd.length, box.body)
        const width = tkhd.readUInt32BE(tkhd.length - 8) / 65_536
        const height = tkhd.readUInt32BE(tkhd.length - 4) / 65_536
        if (!width || !height) break
        // The matrix sits before the size: a, b, u, c, d, v, x, y, w. A quarter turn has a = d = 0.
        const matrix = tkhd.length - 8 - 36
        const quarter = tkhd.readInt32BE(matrix) === 0 && tkhd.readInt32BE(matrix + 16) === 0
        return quarter ? { width: Math.round(height), height: Math.round(width) } : { width: Math.round(width), height: Math.round(height) }
      }
    }
    return undefined
  }
  return undefined
}
