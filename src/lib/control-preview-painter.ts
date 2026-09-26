import {
  controlPreviewEighths,
  controlPreviewSize,
  decodeControlPreview,
  demandControlPreview,
  fitControlPreview,
  type Size,
} from "./control-preview-decoder"
import type { ControlPreview } from "@/lib/types"

type Frame = NonNullable<ControlPreview["frame"]>

/** One decode, one completed image awaiting paint, and the newest source frame.
 * Decoding can proceed while a paint waits for rAF; neither queue can grow.
 * After `resize` the canvas holds the displayed device pixels, decoded at the
 * smallest JPEG scale that covers them; before it, full source pixels. */
export function createControlPreviewPainter(canvas: {
  width: number
  height: number
  style?: { aspectRatio: string }
  getContext(kind: "2d"): Pick<CanvasRenderingContext2D, "drawImage" | "imageSmoothingQuality"> | null
}) {
  const context = canvas.getContext("2d")
  const demand = demandControlPreview()
  let box: Size | undefined
  let latest: Frame | undefined
  let lastId: string | undefined
  let shown: { frame: Frame; width: number; height: number } | undefined
  let decoding: { frame: Frame; value: ReturnType<typeof decodeControlPreview> } | undefined
  let ready: {
    frame: Frame
    image: Awaited<ReturnType<typeof decodeControlPreview>["ready"]>
    source: Size
    release: () => void
  } | undefined
  let painting: number | undefined
  let running = false
  let closed = false

  const hidden = () => box !== undefined && (!box.width || !box.height)
  // Layout follows the source, not the bitmap, so resizing cannot feed back.
  function shape(source: Size) {
    const ratio = `${source.width} / ${source.height}`
    if (canvas.style && canvas.style.aspectRatio !== ratio) canvas.style.aspectRatio = ratio
  }
  function target(frame: Frame, decoded?: Size): Size | undefined {
    const source = controlPreviewSize(frame) ?? decoded
    if (!source) return undefined
    return box ? fitControlPreview(source, box) : source
  }

  function paint() {
    painting = undefined
    const value = ready
    ready = undefined
    if (!value) return
    try {
      if (!closed && context) {
        const { width, height } = target(value.frame, value.image) ?? value.image
        if (canvas.width !== width) canvas.width = width
        if (canvas.height !== height) canvas.height = height
        shape(value.source)
        // Scaled JPEG decodes stay within 2× of the canvas, where bilinear is
        // exact enough; full-size fallbacks shrinking further would alias.
        context.imageSmoothingQuality = width * 2 < value.image.width ? "high" : "low"
        context.drawImage(value.image.source, 0, 0, width, height)
        shown = { frame: value.frame, width, height }
      }
    } finally {
      value.release()
    }
  }

  async function drain() {
    running = true
    try {
      while (latest && !closed && !hidden()) {
        const frame = latest
        latest = undefined
        const wanted = target(frame)
        const size = controlPreviewSize(frame)
        const value = decodeControlPreview(frame, size && wanted ? controlPreviewEighths(size, wanted) : 8)
        decoding = { frame, value }
        let retained = false
        try {
          const image = await value.ready
          if (closed) return
          if (
            !image.width ||
            !image.height ||
            image.width * image.height > 16_000_000
          )
            continue
          const source = size ?? { width: image.width, height: image.height }
          ready?.release()
          ready = { frame, image, source, release: value.release }
          retained = true
          if (painting === undefined) painting = requestAnimationFrame(paint)
        } catch {
          // Keep the last complete canvas on malformed pixels or cancellation.
        } finally {
          if (!retained) value.release()
          if (decoding?.value === value) decoding = undefined
        }
      }
    } finally {
      running = false
    }
  }

  return {
    update(frame: Frame) {
      if (closed || frame.id === lastId) return
      lastId = frame.id
      latest = frame
      const size = controlPreviewSize(frame)
      if (size) shape(size)
      if (!running) void drain()
    },
    /** Displayed device-pixel box; a size change repaints the held frame. */
    resize(width: number, height: number) {
      if (closed) return
      box = { width: Math.max(0, Math.round(width)), height: Math.max(0, Math.round(height)) }
      demand.set(box.width, box.height)
      // The newest frame this viewer holds, so a resize never repaints an older one.
      const held = latest ?? decoding?.frame ?? ready?.frame ?? shown?.frame
      if (!held || hidden()) return
      const wanted = target(held)
      if (held === shown?.frame && wanted?.width === shown.width && wanted.height === shown.height) return
      latest = held
      if (!running) void drain()
    },
    close() {
      if (closed) return
      closed = true
      demand.release()
      latest = undefined
      if (painting !== undefined) cancelAnimationFrame(painting)
      ready?.release()
      ready = undefined
      decoding?.value.release()
      decoding = undefined
    },
  }
}
