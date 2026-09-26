import { useEffect, useRef } from "react"
import type { ControlPreview } from "@/lib/types"
import { createControlPreviewPainter } from "@/lib/control-preview-painter"

/** Paints the device pixels the canvas occupies; CSS fits the box to its space. */
export function ControlPreviewImage({
  frame,
  label,
  className,
}: {
  frame: NonNullable<ControlPreview["frame"]>
  label: string
  className?: string
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const painter = useRef<ReturnType<typeof createControlPreviewPainter> | null>(
    null
  )
  useEffect(() => {
    const element = canvas.current
    if (!element) return
    const value = createControlPreviewPainter(element)
    painter.current = value
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return
      const device = entry.devicePixelContentBoxSize?.[0]
      const ratio = globalThis.devicePixelRatio || 1
      if (device) value.resize(device.inlineSize, device.blockSize)
      else value.resize(entry.contentRect.width * ratio, entry.contentRect.height * ratio)
    })
    // The device-pixel box also reports display scale changes; Safari lacks it.
    try {
      observer.observe(element, { box: "device-pixel-content-box" })
    } catch {
      observer.observe(element)
    }
    return () => {
      observer.disconnect()
      value.close()
      painter.current = null
    }
  }, [])
  useEffect(() => {
    painter.current?.update(frame)
  }, [frame])
  return (
    <canvas ref={canvas} role="img" aria-label={label} className={className} />
  )
}
