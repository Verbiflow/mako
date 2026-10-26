import { useSyncExternalStore } from "react"

/**
 * Device pixels per CSS pixel, as the window's display has them now: it
 * changes when the window moves to another display or the page zooms, which
 * a `resolution` query for the current ratio hears.
 */
export function useDevicePixelRatio(): number {
  return useSyncExternalStore(subscribe, current, () => 1)
}

const current = () => globalThis.devicePixelRatio || 1

function subscribe(changed: () => void): () => void {
  let query: MediaQueryList | undefined
  const listen = () => {
    query?.removeEventListener("change", heard)
    query = globalThis.matchMedia?.(`(resolution: ${current()}dppx)`)
    query?.addEventListener("change", heard)
  }
  const heard = () => {
    listen()
    changed()
  }
  listen()
  return () => query?.removeEventListener("change", heard)
}
