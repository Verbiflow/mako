import { posix, win32 } from "node:path"

/** The scheme Mako registers for itself on Windows (`app.setAsDefaultProtocolClient`). */
export const DEEP_LINK_SCHEME = "mako"

/**
 * What a `mako:` link asks the desktop for:
 *
 *   `mako://open?path=<folder>`  open a folder as a project, as a folder dropped on the app does
 *   `mako://thread/<subject>`    open a Thread, as clicking its notification does
 *   anything else, `mako://`     bring Mako forward
 */
export type DeepLink =
  | { kind: "open-project"; path: string }
  | { kind: "open-thread"; subject: string }
  | { kind: "focus" }

/** The link a `mako:` URL names, or undefined for one that isn't Mako's. */
export function parseDeepLink(url: string): DeepLink | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (parsed.protocol !== `${DEEP_LINK_SCHEME}:`) return undefined
  if (parsed.hostname === "open") {
    const path = parsed.searchParams.get("path")
    return path && (win32.isAbsolute(path) || posix.isAbsolute(path)) ? { kind: "open-project", path } : { kind: "focus" }
  }
  if (parsed.hostname === "thread") {
    const subject = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""))
    return subject ? { kind: "open-thread", subject } : { kind: "focus" }
  }
  return { kind: "focus" }
}

/**
 * The `mako:` link Windows started this app with, or handed a second launch (`second-instance`): it comes as an argument
 * of its own, after Chromium's switches.
 */
export function deepLinkInArgv(argv: readonly string[]): DeepLink | undefined {
  for (const argument of argv) {
    if (!argument.toLowerCase().startsWith(`${DEEP_LINK_SCHEME}:`)) continue
    const link = parseDeepLink(argument)
    if (link) return link
  }
  return undefined
}
