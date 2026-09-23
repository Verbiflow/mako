import { useEffect, useRef } from "react"
import type { ControlPreview } from "@/lib/types"
import { createControlPreviewPainter } from "@/lib/control-preview-painter"

/** Full source pixels; CSS alone fits the preview to its available space. */
export function ControlPreviewImage({ frame, label, className }: {
  frame: NonNullable<ControlPreview["frame"]>
  label: string
  className?: string
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const painter = useRef<ReturnType<typeof createControlPreviewPainter> | null>(null)
  useEffect(() => {
    if (!canvas.current) return
    const value = createControlPreviewPainter(canvas.current)
    painter.current = value
    return () => { value.close(); painter.current = null }
  }, [])
  useEffect(() => { painter.current?.update(frame) }, [frame])
  return <canvas ref={canvas} role="img" aria-label={label} className={className} />
}
