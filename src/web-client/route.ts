import { useEffect, useState } from "react"

/** Where the person is in the web app: the list, a Thread (and which of its Sessions), a new Thread, or Settings. */
export type WebRoute =
  | { kind: "list" }
  | { kind: "thread"; thread: string; session?: string }
  | { kind: "new" }
  | { kind: "settings" }

/** The route a path names under `base` (`/app/`); anything else is the list. */
export function parseRoute(pathname: string, search: string, base: string): WebRoute {
  const rest = pathname.startsWith(base) ? pathname.slice(base.length) : ""
  const [first, second] = rest.split("/").filter(Boolean).map(decodeURIComponent)
  if (first === "t" && second) {
    const session = new URLSearchParams(search).get("s")
    return session ? { kind: "thread", thread: second, session } : { kind: "thread", thread: second }
  }
  if (first === "new") return { kind: "new" }
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
export function useRoute(base: string): [WebRoute, (route: WebRoute, how?: { replace?: boolean }) => void] {
  const [route, setRoute] = useState(() => parseRoute(location.pathname, location.search, base))
  useEffect(() => {
    const popped = () => setRoute(parseRoute(location.pathname, location.search, base))
    window.addEventListener("popstate", popped)
    return () => window.removeEventListener("popstate", popped)
  }, [base])
  const navigate = (next: WebRoute, how: { replace?: boolean } = {}) => {
    const href = routeHref(next, base)
    if (how.replace) history.replaceState(null, "", href)
    else history.pushState(null, "", href)
    setRoute(next)
  }
  return [route, navigate]
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
