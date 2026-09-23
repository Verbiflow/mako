import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react"
import { ThinkingOrb, type OrbSize, type OrbState } from "thinking-orbs"
import { useOrbTheme } from "@/components/ui/use-orb-theme"
import { cn } from "@/lib/utils"
import { mountOrb, orbWorkerAvailable, tintOf, type OrbHandle } from "./orb-client"

interface OrbProps {
  state: OrbState
  size: OrbSize
  paused?: boolean
  className?: string
  style?: CSSProperties
  "data-size"?: number
  "data-state"?: string
}

/**
 * A thinking orb in the colour of the text around it. It is painted by the
 * shared orb worker so it keeps its pace while the page is busy, and a
 * change of state crossfades from one motion to the next instead of cutting.
 */
export function Orb({ state, size, paused = false, className, style, ...data }: OrbProps) {
  const [offThread] = useState(orbWorkerAvailable)
  const theme = useOrbTheme()
  const host = useRef<HTMLSpanElement>(null)
  const handle = useRef<OrbHandle | null>(null)
  const settings = useRef({ state, paused, theme })
  useLayoutEffect(() => {
    settings.current = { state, paused, theme }
  })

  // A fresh canvas per mount: a canvas handed to the worker cannot be taken
  // back, and a remount under StrictMode must not reuse one.
  useLayoutEffect(() => {
    const element = host.current
    if (!offThread || !element) return
    const canvas = document.createElement("canvas")
    canvas.style.width = `${size}px`
    canvas.style.height = `${size}px`
    canvas.style.display = "block"
    element.append(canvas)
    const current = settings.current
    handle.current = mountOrb(canvas, size, {
      state: current.state,
      paused: current.paused,
      dark: current.theme === "dark",
      tint: tintOf(getComputedStyle(element).color),
    })
    return () => {
      handle.current?.remove()
      handle.current = null
      canvas.remove()
    }
  }, [offThread, size])

  useEffect(() => {
    const element = host.current
    if (!element) return
    handle.current?.update({
      state,
      paused,
      dark: theme === "dark",
      tint: tintOf(getComputedStyle(element).color),
    })
  }, [state, paused, theme, className])

  if (!offThread)
    return (
      <ThinkingOrb
        state={state}
        size={size}
        theme={theme}
        paused={paused}
        aria-hidden
        className={cn("activity-orb shrink-0", className)}
        style={style}
        {...data}
      />
    )
  return (
    <span
      ref={host}
      aria-hidden
      {...data}
      className={cn("activity-orb inline-block shrink-0", className)}
      style={{ width: size, height: size, ...style }}
    />
  )
}
