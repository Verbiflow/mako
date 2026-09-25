import type { ControlPreview } from "@/lib/types"

type Frame = NonNullable<ControlPreview["frame"]>
interface Pixels {
  source: CanvasImageSource
  width: number
  height: number
}
interface Decoding {
  ready: Promise<Pixels>
  close: () => void
  users: number
}
const decoders = new WeakMap<Frame, Decoding>()
let jpegSupport: Promise<boolean> | undefined

function begin(frame: Frame): Decoding {
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
      const decoder = new ImageDecoder({ data: frame.image.bytes, type: frame.image.mimeType })
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

/** Inspector and overlay share an immutable frame's decode. The last consumer
 * releases decoder resources, including completion after that consumer leaves. */
export function decodeControlPreview(frame: Frame) {
  let entry = decoders.get(frame)
  if (!entry) {
    entry = begin(frame)
    decoders.set(frame, entry)
  }
  entry.users++
  const owned = entry
  let released = false
  return {
    ready: owned.ready,
    release() {
      if (released) return
      released = true
      if (--owned.users !== 0) return
      decoders.delete(frame)
      owned.close()
    },
  }
}
