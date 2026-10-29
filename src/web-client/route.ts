import { useCallback, useEffect, useState } from "react"
import { z } from "zod"
import { heardPop } from "./back"

/** Where the person is in the web app: the list, a Thread (and which of its Sessions), Settings, or a new Thread over one. */
export type WebRoute = ScreenRoute | { kind: "new"; over?: ScreenRoute }
export type ScreenRoute = { kind: "list" } | { kind: "thread"; thread: string; session?: string } | { kind: "settings" }

/** What a new Thread's sheet was opened over, kept in the history entry: a reload opens it over the list. */
const OverSchema = z.object({ over: z.discriminatedUnion("kind", [z.object({ kind: z.literal("list") }), z.object({ kind: z.literal("thread"), thread: z.string(), session: z.string().optional() }), z.object({ kind: z.literal("settings") })]) })
/** How many of the app's own steps lie behind a history entry: Back goes back only while there's one. */
const DepthSchema = z.object({ depth: z.number().int().nonnegative() })

/** The app's own steps behind the entry the page is on: 0 when it was opened here (a link, a notification, a reload). */
function depthNow(): number {
  return DepthSchema.safeParse("history" in globalThis ? history.state : undefined).data?.depth ?? 0
}

/** The route a path names under `base` (`/` at the root of the app's own host); anything else is the list. */
export function parseRoute(pathname: string, search: string, base: string): WebRoute {
  const rest = pathname.startsWith(base) ? pathname.slice(base.length) : ""
  const [first, second] = rest.split("/").filter(Boolean).map(decodeURIComponent)
  if (first === "t" && second) {
    const session = new URLSearchParams(search).get("s")
    return session ? { kind: "thread", thread: second, session } : { kind: "thread", thread: second }
  }
  if (first === "new") {
    const over = OverSchema.safeParse("history" in globalThis ? history.state : undefined).data?.over
    return over ? { kind: "new", over } : { kind: "new" }
  }
  if (first === "settings") return { kind: "settings" }
  return { kind: "list" }
}

export function routeHref(route: WebRoute, base: string): string {
  switch (route.kind) {
    case "list":
      return base
    case "thread":
      return `${base}t/${encodeURIComponent(route.thread)}${route.session ? `?s=${encodeURIComponent(route.session)}` : ""}`
    case "new":
      return `${base}new`
    case "settings":
      return `${base}settings`
  }
}

/** The route, kept in the address so Back, a reload and a notification's link all land where they should. */
export function useRoute(base: string): [WebRoute, (route: WebRoute, how?: { replace?: boolean }) => void, () => void] {
  const [route, setRoute] = useState(() => parseRoute(location.pathname, location.search, base))
  useEffect(() => {
    const popped = (event: PopStateEvent) => {
      heardPop(event)
      setRoute(parseRoute(location.pathname, location.search, base))
    }
    window.addEventListener("popstate", popped)
    return () => window.removeEventListener("popstate", popped)
  }, [base])
  const navigate = useCallback(
    (next: WebRoute, how: { replace?: boolean } = {}) => {
      const href = routeHref(next, base)
      const depth = how.replace ? depthNow() : depthNow() + 1
      const state = next.kind === "new" && next.over ? { over: next.over, depth } : { depth }
      if (how.replace) history.replaceState(state, "", href)
      else history.pushState(state, "", href)
      setRoute(next)
    },
    [base]
  )
  // Back within the app: the entry before, while the app put one there; else the list, in place, never out of the app
  // (a Thread opened from a notification or a link has nothing of the app's behind it).
  const back = useCallback(() => (depthNow() > 0 ? history.back() : navigate({ kind: "list" }, { replace: true })), [navigate])
  return [route, navigate, back]
}

/** Whether the viewport is wide enough for the list and a Thread side by side: a tablet, or a phone turned. */
export function useWide(): boolean {
  const query = "(min-width: 880px)"
  const [wide, setWide] = useState(() => matchMedia(query).matches)
  useEffect(() => {
    const media = matchMedia(query)
    const changed = () => setWide(media.matches)
    media.addEventListener("change", changed)
    return () => media.removeEventListener("change", changed)
  }, [])
  return wide
}
