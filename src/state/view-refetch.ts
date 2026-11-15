import { REFETCH_BATCH_MS, ViewRefetch } from "@/lib/view-refetch"

let page: ViewRefetch | undefined
/** One visibility owner for desktop, local browser and the signed-in web/phone readers. */
export function pageRefetch(): ViewRefetch {
  if (page) return page
  const current = page = new ViewRefetch()
  let returnedAt = -Infinity
  const shown = () => {
    const visible = document.visibilityState === "visible"
    if (visible && !current.visible) returnedAt = performance.now()
    current.setVisible(visible)
  }
  const focused = () => {
    if (document.visibilityState !== "visible") return
    const alreadyVisible = current.visible
    shown()
    // A focus-only return matters too. Visibility/pageshow may already have caught up this same return.
    if (alreadyVisible && performance.now() - returnedAt >= REFETCH_BATCH_MS) current.reset()
  }
  document.addEventListener("visibilitychange", shown)
  window.addEventListener("pagehide", () => current.setVisible(false))
  window.addEventListener("pageshow", shown)
  window.addEventListener("focus", focused)
  shown()
  return current
}
