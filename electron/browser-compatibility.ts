import type { BrowserProtocolEvent } from "./browser-connection.js"

export const asideSelectionGuidance =
  "In Aside, turn off Settings → Lasso → Enable on text selection, then use a new tab. Its selection popup can interrupt extension control."

/** Diagnose only retained events from this exact tab. No browser queries. */
export function tabInterruption(
  events: readonly BrowserProtocolEvent[],
  reason: unknown
): string {
  const extensionIds = new Set<string>()
  for (const event of events) {
    let url: unknown
    if (event.method === "Page.frameStartedNavigating") url = event.params.url
    if (event.method === "Page.frameNavigated") {
      const frame = event.params.frame
      if (frame && typeof frame === "object" && !Array.isArray(frame))
        url = frame.url
    }
    if (typeof url !== "string") continue
    const match = /^chrome-extension:\/\/([a-p]{32})\//.exec(url)
    if (match) extensionIds.add(match[1]!)
  }
  const base =
    reason === "canceled_by_user"
      ? "The browser reported that tab control was canceled by the user."
      : "Tab control disconnected. The tab may still be open."
  const observed =
    reason === "canceled_by_user"
      ? ""
      : extensionIds.has("fjdhphbdlfjogobdofoaagnlnkoibdge")
        ? ` An Aside extension frame was observed in this tab. ${asideSelectionGuidance}`
        : extensionIds.size > 0
          ? " An extension frame was observed in this tab; Chromium can block extension control of pages containing another extension’s frames."
          : ""
  return `${base}${observed} Check the page before repeating the last action; it may already have happened.`
}
