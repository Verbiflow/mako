import { useEffect, useRef } from "react"
import { createPortal } from "react-dom"
import { Spinner } from "@/components/ui/spinner"
import { bindAppshotShortcut, endFlight, useAppshotShortcut, type Flight } from "@/state/appshot-shortcut"

/**
 * The Appshot shortcut's place in the desk, mounted once per window
 * (`titlebar.trailing`): it holds the shortcut while the window is open,
 * and, when the person pressed it with Mako in front, shows the capture
 * arriving. A pill says which app is being read; then the picture appears
 * where they are looking and flies into the draft's attachments, where its
 * tile already waits. Entrances stay under 250 ms on `--ease-out`, the
 * flight leaves on `--ease-swift`, and with reduced motion the picture only
 * fades.
 */
export function AppshotShortcutHost() {
  useEffect(() => bindAppshotShortcut(), [])
  const flight = useAppshotShortcut((state) => state.flight)
  if (!flight) return null
  return createPortal(
    flight.phase === "capturing" ? <CapturingPill flight={flight} /> : <Landing key={flight.id} flight={flight} />,
    document.body
  )
}

function CapturingPill({ flight }: { flight: Extract<Flight, { phase: "capturing" }> }) {
  return (
    <div
      role="status"
      className="overlay-panel pointer-events-none fixed top-12 left-1/2 z-[60] flex -translate-x-1/2 items-center gap-2 rounded-full px-3 py-1.5 text-ui text-foreground duration-200 ease-(--ease-out) motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-1"
    >
      <Spinner className="size-3.5 text-muted-foreground" />
      Taking an Appshot of {flight.app}…
    </div>
  )
}

/** The desk's two curves, read from `src/index.css` so a flight moves like everything else. */
function curve(name: "--ease-out" | "--ease-swift"): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "ease-out"
}

/** Where the capture lands: the draft's newest attachment tile, else the composer. */
function landingRect(): DOMRect | null {
  const tile = document.querySelector(".attachment-strip")?.lastElementChild
  const target = tile ?? document.querySelector("[data-composer-input], textarea")
  return target?.getBoundingClientRect() ?? null
}

function Landing({ flight }: { flight: Extract<Flight, { phase: "landing" }> }) {
  const ref = useRef<HTMLImageElement>(null)
  useEffect(() => {
    const node = ref.current
    if (!node) return
    let cancelled = false
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches
    const EASE_OUT = curve("--ease-out")
    const EASE_SWIFT = curve("--ease-swift")
    const run = async () => {
      await node.decode().catch(() => undefined)
      if (cancelled) return
      node.style.visibility = "visible"
      if (reduced) {
        await node.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120, easing: EASE_OUT, fill: "forwards" }).finished
        await new Promise((resolve) => setTimeout(resolve, 450))
        await node.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 150, easing: EASE_SWIFT, fill: "forwards" }).finished
        return
      }
      await node.animate(
        [
          { opacity: 0, transform: "scale(0.94)" },
          { opacity: 1, transform: "scale(1)" },
        ],
        { duration: 220, easing: EASE_OUT, fill: "forwards" }
      ).finished
      await new Promise((resolve) => setTimeout(resolve, 260))
      if (cancelled) return
      const from = node.getBoundingClientRect()
      const to = landingRect()
      if (!to || to.width === 0) {
        await node.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 150, easing: EASE_SWIFT, fill: "forwards" }).finished
        return
      }
      const scale = Math.min(to.width / from.width, to.height / from.height)
      const dx = to.left + to.width / 2 - (from.left + from.width / 2)
      const dy = to.top + to.height / 2 - (from.top + from.height / 2)
      await node.animate(
        [
          { opacity: 1, transform: "translate(0, 0) scale(1)" },
          { opacity: 1, offset: 0.8, transform: `translate(${dx * 0.92}px, ${dy * 0.92}px) scale(${scale * 1.15})` },
          { opacity: 0, transform: `translate(${dx}px, ${dy}px) scale(${scale})` },
        ],
        { duration: 380, easing: EASE_SWIFT, fill: "forwards" }
      ).finished
    }
    void run().finally(() => {
      if (!cancelled) endFlight(flight.id)
    })
    return () => {
      cancelled = true
    }
  }, [flight.id])
  return (
    <img
      ref={ref}
      src={flight.image}
      alt={`Appshot of ${flight.app}`}
      style={{ visibility: "hidden" }}
      className="pointer-events-none fixed top-1/2 left-1/2 z-[60] max-h-[45vh] w-[min(28rem,45vw)] -translate-x-1/2 -translate-y-1/2 rounded-[var(--radius-asset)] object-contain shadow-[var(--elevation-overlay)] ring-1 ring-border"
    />
  )
}
