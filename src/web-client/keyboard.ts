import { useEffect } from "react"

/**
 * Keeps the app the height of what's visible: with the keyboard up, the visual viewport. Android resizes the page for
 * its keyboard (`interactive-widget=resizes-content`); iOS doesn't, and pans the page to the focused field instead, so
 * a composer pinned to the bottom would sit under the keyboard. The app's height follows the visual viewport
 * (`--app-height`), and the page is held at its top, so the composer rides on the keyboard on both.
 */
export function useKeyboardInset(): void {
  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return
    const root = document.documentElement
    let frame = 0
    const update = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        root.style.setProperty("--app-height", `${Math.round(viewport.height)}px`)
        root.style.setProperty("--keyboard", `${Math.max(0, Math.round(innerHeight - viewport.height - viewport.offsetTop))}px`)
        if (viewport.offsetTop > 0 || scrollY > 0) scrollTo(0, 0)
      })
    }
    update()
    viewport.addEventListener("resize", update)
    viewport.addEventListener("scroll", update)
    return () => {
      cancelAnimationFrame(frame)
      viewport.removeEventListener("resize", update)
      viewport.removeEventListener("scroll", update)
    }
  }, [])
}
