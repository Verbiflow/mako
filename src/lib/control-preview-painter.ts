import type { ControlPreview } from "@/lib/types"

type Frame = NonNullable<ControlPreview["frame"]>

/** Complete one decode before accepting the newest waiting frame. Replacing an
 * async <img> src at capture speed can cancel every decode and paint blank. */
export function createControlPreviewPainter(canvas: {
  width: number
  height: number
  getContext(kind: "2d"): Pick<CanvasRenderingContext2D, "drawImage"> | null
}) {
  const context = canvas.getContext("2d")
  let latest: Frame | undefined
  let lastId: string | undefined
  let decoding: HTMLImageElement | undefined
  let painting: number | undefined
  let finishPaint: (() => void) | undefined
  let running = false
  let closed = false

  async function drain() {
    running = true
    try {
      while (latest && !closed) {
        const frame = latest
        latest = undefined
        const image = new Image()
        decoding = image
        image.src = `data:${frame.image.mimeType};base64,${frame.image.data}`
        try {
          await image.decode()
          if (closed) return
          // The source validates dimensions too. Bound this DOM allocation at its boundary.
          if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 16_000_000) continue
          await new Promise<void>(resolve => {
            finishPaint = resolve
            painting = requestAnimationFrame(() => {
              painting = undefined
              finishPaint = undefined
              if (!closed && context) {
                if (canvas.width !== image.naturalWidth) canvas.width = image.naturalWidth
                if (canvas.height !== image.naturalHeight) canvas.height = image.naturalHeight
                context.drawImage(image, 0, 0)
              }
              resolve()
            })
          })
        } catch {
          // Retain the last complete frame on malformed pixels or cancellation.
        } finally {
          if (decoding === image) decoding = undefined
        }
      }
    } finally { running = false }
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
      finishPaint?.()
      if (decoding) decoding.src = ""
    },
  }
}
