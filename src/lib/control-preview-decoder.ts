import type { ControlPreview } from "@/lib/types"

type Frame = NonNullable<ControlPreview["frame"]>
export interface Size {
  width: number
  height: number
}
interface Pixels extends Size {
  source: CanvasImageSource
}
interface Decoding {
  ready: Promise<Pixels>
  close: () => void
  users: number
}
const decoders = new WeakMap<Frame, Map<number, Decoding>>()
const sizes = new WeakMap<Frame, Size | null>()
/** Device-pixel boxes of every live viewer; one decode serves the largest. */
const demands = new Set<Size>()
let jpegSupport: Promise<boolean> | undefined

function jpegSize(bytes: Uint8Array): Size | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  let at = 2
  while (at + 8 < bytes.length) {
    if (bytes[at] !== 0xff) return null
    const marker = bytes[at + 1]!
    if (marker === 0xff) { at++; continue }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { at += 2; continue }
    // Every SOF marker except DHT (C4), JPG (C8) and DAC (CC) carries the frame size.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
      return { height: (bytes[at + 5]! << 8) | bytes[at + 6]!, width: (bytes[at + 7]! << 8) | bytes[at + 8]! }
    const length = (bytes[at + 2]! << 8) | bytes[at + 3]!
    if (marker === 0xda || length < 2) return null
    at += 2 + length
  }
  return null
}

/** Encoded dimensions from the image header, without decoding. */
export function controlPreviewSize(frame: Frame): Size | null {
  if (sizes.has(frame)) return sizes.get(frame)!
  const bytes = frame.image.bytes
  let size: Size | null = null
  if (frame.image.mimeType === "image/jpeg") size = jpegSize(bytes)
  else if (bytes.length >= 24 && bytes[12] === 0x49 && bytes[13] === 0x48 && bytes[14] === 0x44 && bytes[15] === 0x52) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    size = { width: view.getUint32(16), height: view.getUint32(20) }
  }
  if (size && (!size.width || !size.height || size.width * size.height > 16_000_000)) size = null
  sizes.set(frame, size)
  return size
}

/** Displayed pixels: the source fitted into the box, never enlarged. */
export function fitControlPreview(source: Size, box: Size): Size {
  const scale = Math.min(box.width / source.width, box.height / source.height, 1)
  return {
    width: Math.max(1, Math.round(source.width * scale)),
    height: Math.max(1, Math.round(source.height * scale)),
  }
}

/** JPEG decoders scale by eighths: the smallest eighth that still covers `target`. */
export function controlPreviewEighths(source: Size, target: Size): number {
  for (let eighths = 1; eighths < 8; eighths++)
    if (Math.ceil((source.width * eighths) / 8) >= target.width && Math.ceil((source.height * eighths) / 8) >= target.height)
      return eighths
  return 8
}

/** Unmeasured viewers (negative box) need full pixels; zero-sized ones need none. */
function demanded(size: Size | null): number {
  if (!size) return 8
  let eighths = 1
  for (const box of demands) {
    if (box.width < 0 || box.height < 0) return 8
    if (box.width && box.height) eighths = Math.max(eighths, controlPreviewEighths(size, fitControlPreview(size, box)))
  }
  return eighths
}

function begin(frame: Frame, eighths: number, size: Size | null): Decoding {
  let closed = false
  let dispose = () => {}
  const ready = (async (): Promise<Pixels> => {
    // JPEG VideoFrames preserve the image decoder's pixels while avoiding a
    // Blob URL fetch per frame. Other formats and older viewers keep HTMLImage.
    if (
      frame.image.mimeType === "image/jpeg" &&
      "ImageDecoder" in globalThis &&
      await (jpegSupport ??= ImageDecoder.isTypeSupported("image/jpeg").catch(() => false))
    ) {
      if (closed) throw new Error("Preview decoding cancelled")
      // Chromium answers an exact eighth of the source with exactly that size.
      const scaled = size && eighths < 8
        ? { desiredWidth: Math.ceil((size.width * eighths) / 8), desiredHeight: Math.ceil((size.height * eighths) / 8) }
        : {}
      const decoder = new ImageDecoder({ data: frame.image.bytes, type: frame.image.mimeType, ...scaled })
      let image: VideoFrame | undefined
      dispose = () => { decoder.close(); image?.close() }
      try {
        image = (await decoder.decode({ frameIndex: 0, completeFramesOnly: true })).image
        if (closed) { image.close(); throw new Error("Preview decoding cancelled") }
        return { source: image, width: image.displayWidth, height: image.displayHeight }
      } finally { decoder.close() }
    }
    if (closed) throw new Error("Preview decoding cancelled")
    const image = new Image()
    const url = URL.createObjectURL(new Blob([frame.image.bytes], { type: frame.image.mimeType }))
    dispose = () => { image.src = ""; URL.revokeObjectURL(url) }
    image.src = url
    await image.decode()
    if (closed) throw new Error("Preview decoding cancelled")
    return { source: image, width: image.naturalWidth, height: image.naturalHeight }
  })()
  return { ready, users: 0, close() { closed = true; dispose() } }
}

/** A viewer's current device-pixel box; unmeasured until its first `set`. */
export function demandControlPreview() {
  const box: Size = { width: -1, height: -1 }
  demands.add(box)
  return {
    set(width: number, height: number) { box.width = width; box.height = height },
    release() { demands.delete(box) },
  }
}

/** Inspector and overlay share an immutable frame's decode, sized for the
 * largest live viewer. A viewer needing more than a running decode provides
 * starts its own. The last consumer releases decoder resources, including
 * completion after that consumer leaves. */
export function decodeControlPreview(frame: Frame, needed = 8) {
  const size = controlPreviewSize(frame)
  let byScale = decoders.get(frame)
  if (!byScale) decoders.set(frame, (byScale = new Map()))
  let eighths = [...byScale.keys()].find((value) => value >= needed)
  if (eighths === undefined) {
    eighths = Math.max(needed, demanded(size))
    byScale.set(eighths, begin(frame, eighths, size))
  }
  const owned = byScale.get(eighths)!
  const scale = eighths
  owned.users++
  let released = false
  return {
    ready: owned.ready,
    release() {
      if (released) return
      released = true
      if (--owned.users !== 0) return
      byScale.delete(scale)
      if (!byScale.size) decoders.delete(frame)
      owned.close()
    },
  }
}
