import { decodeControlPreview } from "./control-preview-decoder"
import type { ControlPreview } from "@/lib/types"

type Frame = NonNullable<ControlPreview["frame"]>

/** One decode, one completed image awaiting paint, and the newest source frame.
 * Decoding can proceed while a paint waits for rAF; neither queue can grow. */
export function createControlPreviewPainter(canvas: {
  width: number
  height: number
  getContext(kind: "2d"): Pick<CanvasRenderingContext2D, "drawImage"> | null
}) {
  const context = canvas.getContext("2d")
  let latest: Frame | undefined
  let lastId: string | undefined
  let decoding: ReturnType<typeof decodeControlPreview> | undefined
  let ready: { image: Awaited<ReturnType<typeof decodeControlPreview>["ready"]>; release: () => void } | undefined
  let painting: number | undefined
  let running = false
  let closed = false

  function paint() {
    painting = undefined
    const value = ready
    ready = undefined
    if (!value) return
    try {
      if (!closed && context) {
        if (canvas.width !== value.image.width)
          canvas.width = value.image.width
        if (canvas.height !== value.image.height)
          canvas.height = value.image.height
        context.drawImage(value.image.source, 0, 0)
      }
    } finally {
      value.release()
    }
  }

  async function drain() {
    running = true
    try {
      while (latest && !closed) {
        const frame = latest
        latest = undefined
        const value = decodeControlPreview(frame)
        decoding = value
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
          ready?.release()
          ready = { image, release: value.release }
          retained = true
          if (painting === undefined) painting = requestAnimationFrame(paint)
        } catch {
          // Keep the last complete canvas on malformed pixels or cancellation.
        } finally {
          if (!retained) value.release()
          if (decoding === value) decoding = undefined
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
      if (!running) void drain()
    },
    close() {
      if (closed) return
      closed = true
      latest = undefined
      if (painting !== undefined) cancelAnimationFrame(painting)
      ready?.release()
      ready = undefined
      decoding?.release()
      decoding = undefined
    },
  }
}
