import { useEffect, useRef, useState, type CSSProperties } from "react"
import { VideoPlayback } from "@/lib/video-playback"

/** Every video in this window answers to one set of rules, so starting one pauses the last; made with the first video, so a module load touches no document. */
let playback: VideoPlayback<HTMLVideoElement> | undefined

/** How near the viewport a video starts reading its metadata. */
const NEAR_MARGIN = "200px"

/**
 * The one video player of the transcript: inline, in the lightbox and under
 * an answer. It draws its poster at once and loads nothing else until it's
 * near the viewport; `VideoPlayback` pauses it off screen, in a hidden
 * window and on unmount. Its first URL stays: a re-read that signs a new
 * URL for the same file doesn't restart what's playing.
 */
export function MediaVideo({ url, poster, name, className, style, onError }: {
  url: string
  poster?: string
  name: string
  className?: string
  style?: CSSProperties
  onError?(): void
}) {
  const ref = useRef<HTMLVideoElement>(null)
  const [source] = useState(url)
  useEffect(() => {
    const video = ref.current
    if (!video) return
    playback ??= new VideoPlayback<HTMLVideoElement>(document)
    const player = playback.attach(video)
    const near = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return
      player.near()
      near.disconnect()
    }, { rootMargin: NEAR_MARGIN })
    const shown = new IntersectionObserver((entries) => {
      const entry = entries.at(-1)
      if (entry) player.shown(entry.isIntersecting)
    }, { threshold: 0 })
    near.observe(video)
    shown.observe(video)
    video.addEventListener("play", player.playing)
    return () => {
      near.disconnect()
      shown.disconnect()
      video.removeEventListener("play", player.playing)
      player.release()
    }
  }, [])
  return (
    <video
      ref={ref}
      controls
      playsInline
      preload="none"
      src={source}
      poster={poster}
      aria-label={name}
      onError={onError}
      className={className}
      style={style}
      data-media-video
    />
  )
}
