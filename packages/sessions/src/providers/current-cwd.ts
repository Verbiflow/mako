import type { ThreadRef } from "../format.js"

/** macOS reaches /tmp, /var and /etc through /private, and a harness may record either spelling of one folder. */
function samePlace(a: string, b: string): boolean {
  const plain = (path: string) => (path.startsWith("/private/") ? path.slice("/private".length) : path)
  return plain(a) === plain(b)
}

/** The folder a harness recorded for the session's latest turn: `currentCwd` when it isn't where the session started. */
export function followCurrentCwd(ref: ThreadRef, cwd: string | undefined): void {
  if (cwd === undefined || !ref.cwd) return
  if (samePlace(cwd, ref.cwd)) delete ref.currentCwd
  else ref.currentCwd = cwd
}
