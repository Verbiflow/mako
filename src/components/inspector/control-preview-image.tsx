import { useEffect, useLayoutEffect, useRef } from "react"
import type { ControlPreview } from "@/lib/types"
import {
  createControlPreviewPainter,
  type ControlPreviewRate,
} from "@/lib/control-preview-painter"

/** Paints the device pixels the canvas occupies; CSS fits the box to its space. */
export function ControlPreviewImage({
  frame,
  label,
  className,
  onRate,
}: {
  frame: NonNullable<ControlPreview["frame"]>
  label: string
  className?: string
  onRate?: (rate: ControlPreviewRate | null) => void
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const painter = useRef<ReturnType<typeof createControlPreviewPainter> | null>(
    null
  )
  const rate = useRef(onRate)
  useLayoutEffect(() => {
    rate.current = onRate
  })
  useEffect(() => {
    const element = canvas.current
    if (!element) return
    const value = createControlPreviewPainter(element, (next) =>
      rate.current?.(next)
    )
    painter.current = value
    const viewport = globalThis.visualViewport
    let measured: [number, number] | undefined
    // Pinch zoom magnifies the page without resizing it, so it scales the box.
    const apply = () => {
      if (!measured) return
      const pinch = Math.max(1, viewport?.scale ?? 1)
      value.resize(measured[0] * pinch, measured[1] * pinch)
    }
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return
      const device = entry.devicePixelContentBoxSize?.[0]
      const ratio = globalThis.devicePixelRatio || 1
      measured = device
        ? [device.inlineSize, device.blockSize]
        : [entry.contentRect.width * ratio, entry.contentRect.height * ratio]
      apply()
    })
    // The device-pixel box also reports display scale changes; Safari lacks it.
    try {
      observer.observe(element, { box: "device-pixel-content-box" })
    } catch {
      observer.observe(element)
    }
    viewport?.addEventListener("resize", apply)
    return () => {
      observer.disconnect()
      viewport?.removeEventListener("resize", apply)
      value.close()
      painter.current = null
      rate.current?.(null)
    }
  }, [])
  useEffect(() => {
    painter.current?.update(frame)
  }, [frame])
  return (
    <canvas ref={canvas} role="img" aria-label={label} className={className} />
  )
}
