import { useEffect, useRef } from "react"
import { usePrefs, type OceanTone } from "@/state/prefs"
import { OceanFin } from "./ocean-fin"
import oceanEngraving from "/artwork/mako-ocean-engraving.webp?url"

/**
 * How long the water moves after the person last touched the window. Moving, it keeps the GPU
 * compositing every frame: about 15% of a core on a Mac for a scene nobody is looking at.
 */
const OCEAN_REST_MS = 30_000
const WAKING_INPUT = ["pointermove", "pointerdown", "keydown", "wheel"] as const

/**
 * The engraving stays still. A small, blended light layer moves over the water while the window
 * is in front and in use, and rests when it's in the background or nobody has touched it a while.
 */
export function OceanScene({
  tone,
  animated,
}: {
  tone?: OceanTone
  animated?: boolean
}) {
  const preference = usePrefs((prefs) => prefs.oceanTone)
  const motionPreference = usePrefs((prefs) => prefs.oceanMotion)
  const motion = animated ?? motionPreference
  const scene = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const element = scene.current
    if (!element) return
    const media = matchMedia("(prefers-reduced-motion: reduce)")
    let visible = false
    let resting = false
    let lastInput = performance.now()
    let rest: ReturnType<typeof setTimeout> | undefined
    const update = () => {
      element.toggleAttribute(
        "data-water-moving",
        motion && visible && !document.hidden && !media.matches && document.hasFocus() && !resting
      )
    }
    const settle = () => {
      const left = OCEAN_REST_MS - (performance.now() - lastInput)
      if (left > 0) {
        rest = setTimeout(settle, left)
        return
      }
      rest = undefined
      resting = true
      update()
    }
    const input = () => {
      lastInput = performance.now()
      rest ??= setTimeout(settle, OCEAN_REST_MS)
      if (!resting) return
      resting = false
      update()
    }
    rest = setTimeout(settle, OCEAN_REST_MS)
    for (const name of WAKING_INPUT) window.addEventListener(name, input, { passive: true })
    window.addEventListener("focus", update)
    window.addEventListener("blur", update)
    const intersection = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? false
      update()
    })
    intersection.observe(element)
    media.addEventListener("change", update)
    document.addEventListener("visibilitychange", update)
    return () => {
      clearTimeout(rest)
      for (const name of WAKING_INPUT) window.removeEventListener(name, input)
      window.removeEventListener("focus", update)
      window.removeEventListener("blur", update)
      intersection.disconnect()
      media.removeEventListener("change", update)
      document.removeEventListener("visibilitychange", update)
    }
  }, [motion])
  return (
    <div
      ref={scene}
      className="ocean-scene"
      data-ocean-tone={tone ?? preference}
      aria-hidden="true"
    >
      <img
        className="ocean-engraving"
        src={oceanEngraving}
        width={1536}
        height={1024}
        alt=""
        decoding="async"
      />
      <span className="ocean-grain" />
      <span className="ocean-water">
        <span className="ocean-light">
          <img
            className="ocean-engraving"
            src={oceanEngraving}
            width={1536}
            height={1024}
            alt=""
            decoding="async"
          />
        </span>
      </span>
      <OceanFin />
    </div>
  )
}
