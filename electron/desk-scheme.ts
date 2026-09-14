import type { CustomScheme } from "electron"
import { resolve, sep } from "node:path"

/**
 * The packaged desk document is served from `mako-app://desk/`, not opened
 * as a `file:` URL. Chromium never keeps a V8 code cache for `file:` scripts,
 * so every window — the desk, each preview, each hidden agent view — parsed
 * and compiled the whole renderer bundle again on every launch. A privileged
 * standard scheme with `codeCache` keeps the compiled bytecode beside the
 * profile's other caches and reuses it until the bundle's bytes change.
 *
 * The scheme is also a real origin. Under `file:` the renderer's localStorage
 * (drafts, preferences, review notes) lived in the opaque `file://` origin;
 * `renderer-storage.ts` moves it across once per profile. Only files under
 * `dist/` are ever served, and only the exact `index.html` counts as the desk
 * for the hidden agent windows (`desk-browser-policy.ts`). This module is
 * pure so tests can run it under Node; `desk-protocol.ts` binds it to
 * Electron's protocol module.
 */
export const DESK_SCHEME = "mako-app"
export const DESK_HOST = "desk"
export const DESK_ORIGIN = `${DESK_SCHEME}://${DESK_HOST}`
export const DESK_DOCUMENT = `${DESK_ORIGIN}/index.html`
/** The page `renderer-storage.ts` uses to read and write an origin's storage. */
export const STORAGE_BRIDGE_DOCUMENT = `${DESK_ORIGIN}/storage-bridge.html`
/** `--shell` in `src/index.css`; the window paints this until the renderer does. */
export const DESK_BACKGROUND = "#140f0d"

/**
 * Where macOS puts the traffic lights in a `hiddenInset` desk window.
 *
 * Centred in the 38px title strip rather than eyeballed: the button group is
 * 12px tall, so `(38 - 12) / 2` puts it on the same line as the panel toggle
 * and the new-session button beside it, and `x` leaves the group clear of the
 * title bar's `pl-[86px]` inset. Every window that hides its title bar reads
 * it from here — the host's own window and the desktop client's each had
 * their own numbers, and the client's sat three pixels low, which is enough
 * to make the whole row look broken.
 */
export const DESK_TRAFFIC_LIGHTS = { x: 14, y: 13 } as const

/**
 * Every scheme Mako's renderers reach, for `protocol.registerSchemesAsPrivileged`.
 * Electron accepts that call once per process, before `app` is ready, so the
 * host and the client each register this whole list.
 */
export function privilegedSchemes(): CustomScheme[] {
  return [
    {
      scheme: "mako-file",
      privileges: { secure: true, standard: true, supportFetchAPI: true, stream: true },
    },
    {
      scheme: DESK_SCHEME,
      privileges: {
        secure: true,
        standard: true,
        supportFetchAPI: true,
        stream: true,
        codeCache: true,
      },
    },
  ]
}

/** The desk document with a query, as a window loads it. */
export function deskUrl(query: Record<string, string> = {}): string {
  const url = new URL(DESK_DOCUMENT)
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
  return url.href
}

/** The bundle file a desk URL names, or null when it names nothing servable. */
export function deskFile(root: string, url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== `${DESK_SCHEME}:` || parsed.host !== DESK_HOST) return null
  let pathname: string
  try {
    pathname = decodeURIComponent(parsed.pathname)
  } catch {
    return null
  }
  if (pathname === "/" || pathname === "") pathname = "/index.html"
  if (pathname.includes("\0")) return null
  const file = resolve(root, `.${pathname}`)
  return file.startsWith(root + sep) ? file : null
}
