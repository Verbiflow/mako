import { DESK_HOST, DESK_SCHEME } from "./desk-scheme.js"

/**
 * Which URLs a hidden desk window may show. The window carries Mako's
 * privileged preload, so only the desk document itself qualifies: the dev
 * server's exact origin, or the packaged bundle's own `mako-app://desk/index.html`.
 * The scheme is served by this process alone and only from the bundle, so
 * the exact document path is the whole rule; no other host, path or scheme
 * borrows the host bridge.
 */
export function deskUrlPolicy(options: {
  devServerUrl: string | null
}): (url: string) => boolean {
  const devOrigin = options.devServerUrl
    ? new URL(options.devServerUrl).origin
    : null
  return (url) => {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return false
    }
    if (parsed.href === "about:blank") return true
    if (devOrigin !== null) return parsed.origin === devOrigin
    return (
      parsed.protocol === `${DESK_SCHEME}:` &&
      parsed.host === DESK_HOST &&
      parsed.pathname === "/index.html"
    )
  }
}
