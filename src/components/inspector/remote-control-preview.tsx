import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { ControlVideoPlayer } from "@/lib/control-video-player"
import { fitControlPreview, type Size } from "@/lib/control-preview-decoder"
import { createControlPreviewRate, type ControlPreviewRate } from "@/lib/control-preview-painter"
import { watchControlVideo } from "@/state/control-preview"
import { cn } from "@/lib/utils"

/**
 * A cloud machine's tab as live video, decoded with WebCodecs and painted at the canvas's device size. A viewer whose
 * decoder fails starts over with a fresh picture.
 */
export function RemoteControlPreview({
  id,
  label,
  className,
  onRate,
}: {
  id: string
  label: string
  className?: string
  onRate?: (rate: ControlPreviewRate | null) => void
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [painted, setPainted] = useState(false)
  const rate = useRef(onRate)
  useLayoutEffect(() => {
    rate.current = onRate
  })
  useEffect(() => {
    const element = canvas.current
    const context = element?.getContext("2d")
    if (!element || !context) return
    let closed = false
    let box: Size | undefined
    let received = 0
    let paints = 0
    const rates = createControlPreviewRate((next) => rate.current?.(next))
    const player = new ControlVideoPlayer((picture, width, height, capturedAt) => {
      if (closed) return
      const size = box ? fitControlPreview({ width, height }, box) : { width, height }
      if (element.width !== size.width) element.width = size.width
      if (element.height !== size.height) element.height = size.height
      const ratio = `${width} / ${height}`
      if (element.style.aspectRatio !== ratio) element.style.aspectRatio = ratio
      context.imageSmoothingQuality = size.width * 2 < width ? "high" : "low"
      context.drawImage(picture, 0, 0, size.width, size.height)
      rates.painted({ id: String(++paints), sequence: received, capturedAt })
      if (paints === 1) setPainted(true)
    }, () => watch.restart())
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return
      const device = entry.devicePixelContentBoxSize?.[0]
      const ratio = globalThis.devicePixelRatio || 1
      const width = Math.round(device ? device.inlineSize : entry.contentRect.width * ratio)
      const height = Math.round(device ? device.blockSize : entry.contentRect.height * ratio)
      box = width && height ? { width, height } : undefined
    })
    try {
      observer.observe(element, { box: "device-pixel-content-box" })
    } catch {
      observer.observe(element)
    }
    const watch = watchControlVideo(id, {
      box: () => box,
      packet(bytes) {
        received++
        player.push(bytes)
      },
    })
    return () => {
      closed = true
      watch.stop()
      observer.disconnect()
      player.close()
      rates.close()
      rate.current?.(null)
    }
  }, [id])
  return (
    <span className="relative block">
      <canvas
        ref={canvas}
        role="img"
        aria-label={label}
        className={cn(className, !painted && "aspect-[16/10]")}
      />
      {painted ? null : (
        <span role="status" className="absolute inset-0 flex items-center justify-center text-label text-faint">
          Connecting to the machine’s tab…
        </span>
      )}
    </span>
  )
}
