import { useEffect, useRef, useState } from "react"
import { controlPreviewStream } from "@/state/control-preview"

export function NativeControlPreview({ id, poster, className = "block max-h-64 w-full object-contain" }: { id: string; poster?: string; className?: string }) {
  const video = useRef<HTMLVideoElement>(null)
  const [failed, setFailed] = useState(false)
  const [visible, setVisible] = useState(() => !document.hidden)
  useEffect(() => {
    const changed = () => setVisible(!document.hidden)
    document.addEventListener("visibilitychange", changed)
    return () => document.removeEventListener("visibilitychange", changed)
  }, [])
  useEffect(() => {
    if (!visible) return
    let closed = false
    let release: (() => void) | undefined
    let unlisten = () => {}
    void controlPreviewStream(id)
      .then(async (value) => {
        if (closed) {
          value?.release()
          return
        }
        release = value?.release
        const stream = value?.stream
        const element = video.current
        if (!stream || !element) {
          release?.()
          setFailed(true)
          return
        }
        const ended = () => { if (!closed) setFailed(true) }
        for (const track of stream.getTracks()) track.addEventListener("ended", ended, { once: true })
        unlisten = () => { for (const track of stream.getTracks()) track.removeEventListener("ended", ended) }
        element.srcObject = stream
        await element.play()
      })
      .catch(() => {
        release?.()
        if (!closed) setFailed(true)
      })
    return () => {
      closed = true
      unlisten()
      release?.()
    }
  }, [id, visible])
  if (failed)
    return poster ? (
      <img
        src={poster}
        alt="Latest view of this task's application window"
        className={className}
        decoding="async"
      />
    ) : (
      <span role="status" className="py-6 text-label text-muted-foreground">
        Waiting for a screenshot
      </span>
    )
  return (
    <video
      ref={video}
      muted
      autoPlay
      playsInline
      poster={poster}
      aria-label="Live application window"
      className={className}
    />
  )
}
