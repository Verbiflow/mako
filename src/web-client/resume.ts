import { z } from "zod"

/**
 * Coming back to the app. A phone hides a page without ending it (the app switcher, the lock screen, another app in
 * front) and freezes it within seconds; when it's shown again its sockets may be dead without having closed, what it
 * shows may be minutes old, and iOS may bring a Home Screen app back with its drawn layers thrown away, painting black
 * until something on the page changes.
 */

/** Away at least this long, what the page shows is taken as stale: read again, not only checked (T3's long background). */
export const LONG_AWAY_MS = 10_000
/** Several signs of one return (focus, pageshow, visibilitychange) arrive together: they count once within this. */
const ONE_RETURN_MS = 1_000

/** How a return is met: a check of the connection (`probe`), or that and a fresh read of everything shown (`long`). */
export type ReturnKind = "probe" | "long"

/** How long a page was away decides how it's met: a glance away is checked, a real absence is read again. */
export function returnKind(hiddenAt: number | undefined, now: number): ReturnKind {
  return hiddenAt !== undefined && now - hiddenAt >= LONG_AWAY_MS ? "long" : "probe"
}

export interface ReturnHandlers {
  /** The page went out of view: keep what's worth keeping, let go of what's cheap to read again. */
  hidden(): void
  /** The page is back in front: `away` is how long it was hidden, 0 when it never was (focus, the network back). */
  returned(kind: ReturnKind, away: number): void
}

/**
 * Follows the page's comings and goings: hidden on `visibilitychange`/`pagehide`, and back on `visibilitychange`,
 * `pageshow` (a page restored from the back-forward cache, or a Home Screen app brought forward), `focus` and `online`.
 * Every return repaints the page whole first. Returns how to stop.
 */
export function watchReturns(handlers: ReturnHandlers): () => void {
  let hiddenAt: number | undefined = document.visibilityState === "hidden" ? Date.now() : undefined
  let lastReturn = 0
  const hide = () => {
    hiddenAt ??= Date.now()
    handlers.hidden()
  }
  const back = (restored = false) => {
    if (document.visibilityState !== "visible") return
    repaint()
    const now = Date.now()
    const away = hiddenAt === undefined ? 0 : now - hiddenAt
    const kind = restored ? "long" : returnKind(hiddenAt, now)
    hiddenAt = undefined
    // Focus right behind a visibilitychange is the same return: one check, unless this one found the page away long.
    if (kind === "probe" && now - lastReturn < ONE_RETURN_MS) return
    lastReturn = now
    handlers.returned(kind, away)
  }
  const visibility = () => (document.visibilityState === "hidden" ? hide() : back())
  const shown = (event: PageTransitionEvent) => back(event.persisted)
  const focused = () => back()
  const online = () => back()
  const left = () => hide()
  document.addEventListener("visibilitychange", visibility)
  window.addEventListener("pageshow", shown)
  window.addEventListener("pagehide", left)
  window.addEventListener("focus", focused)
  window.addEventListener("online", online)
  return () => {
    document.removeEventListener("visibilitychange", visibility)
    window.removeEventListener("pageshow", shown)
    window.removeEventListener("pagehide", left)
    window.removeEventListener("focus", focused)
    window.removeEventListener("online", online)
  }
}

let repaintFrame = 0

/**
 * Lays the page out and paints it whole once more: iOS can bring a Home Screen app back with its layers thrown away,
 * an all-black screen until something changes. A near-opaque body for two frames is a change of every layer.
 */
export function repaint(): void {
  const root = document.documentElement
  cancelAnimationFrame(repaintFrame)
  root.classList.add("web-repaint")
  void root.offsetHeight
  repaintFrame = requestAnimationFrame(() => {
    repaintFrame = requestAnimationFrame(() => root.classList.remove("web-repaint"))
  })
}

/** Said on `window` once the page is back in front, for screens that meet a return themselves (the transcript's end). */
export const RETURNED_EVENT = "mako:returned"
/** What `RETURNED_EVENT` carries: how the return was met, and how long the page was hidden (0 for a focus or the network). */
export type Returned = { kind: ReturnKind; away: number }
const ReturnedSchema = z.object({ kind: z.enum(["probe", "long"]), away: z.number() }) satisfies z.ZodType<Returned>

/** The return an event says, when it's a `RETURNED_EVENT`. */
export function returnedOf(event: Event): Returned | undefined {
  return event instanceof CustomEvent ? ReturnedSchema.safeParse(event.detail).data : undefined
}
