import { useLayoutEffect, useRef } from "react"

/**
 * One line under the selected tab of the dock, across the app's outputs and
 * the shells alike, so switching between them reads as one motion. It
 * measures against its parent, which must be positioned.
 */
export function DockTabIndicator() {
  const line = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const bar = line.current
    const root = bar?.parentElement
    if (!bar || !root) return
    let placed = false
    const place = () => {
      const tab = root.querySelector('[role="tab"][aria-selected="true"]')?.closest("[data-dock-tab]")
      if (!tab) {
        bar.style.opacity = "0"
        placed = false
        return
      }
      const box = root.getBoundingClientRect()
      const rect = tab.getBoundingClientRect()
      // The first placement lands; every later one travels from the last tab.
      bar.toggleAttribute("data-instant", !placed)
      bar.style.width = `${Math.max(0, rect.width - 16)}px`
      bar.style.transform = `translateX(${rect.left - box.left + 8}px)`
      bar.style.opacity = "1"
      placed = true
    }
    place()
    const resize = new ResizeObserver(place)
    resize.observe(root)
    const changes = new MutationObserver(place)
    changes.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-selected"] })
    root.addEventListener("scroll", place, true)
    return () => {
      resize.disconnect()
      changes.disconnect()
      root.removeEventListener("scroll", place, true)
    }
  }, [])
  return <span ref={line} aria-hidden className="dock-tab-indicator" style={{ opacity: 0 }} />
}
