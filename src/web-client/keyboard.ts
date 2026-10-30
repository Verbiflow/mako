import { useEffect } from "react"

/** After a field lets go, iOS may still pan the page back for a moment: the page is put back again this much later. */
const SETTLE_AFTER_BLUR_MS = 350

/**
 * Keeps the app the height of what's visible: with the keyboard up, the visual viewport. Android resizes the page for
 * its keyboard (`interactive-widget=resizes-content`); iOS doesn't, and pans the page to the focused field instead, so
 * a composer pinned to the bottom would sit under the keyboard. The app's height follows the visual viewport
 * (`--app-height`), and while a field is focused its top follows the visual viewport's (`--app-top`), so the app sits
 * on the rectangle iOS shows and the composer rides on the keyboard on both.
 *
 * The page is put back at its top only as a field lets go of the keyboard, and once more after iOS's own pan settles,
 * never on each of the viewport's scrolls: putting it back while the keyboard is up fights iOS's own pan, a jump on
 * every scroll of the transcript. A page pinched into a zoom is left where the person put it.
 */
export function useKeyboardInset(): void {
  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return
    const root = document.documentElement
    let frame = 0
    let settle: ReturnType<typeof setTimeout> | undefined
    const update = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (viewport.scale > 1.01) return
        root.style.setProperty("--app-height", `${Math.round(viewport.height)}px`)
        root.style.setProperty("--app-top", `${typing() ? Math.max(0, Math.round(viewport.offsetTop)) : 0}px`)
        root.style.setProperty("--keyboard", `${Math.max(0, Math.round(innerHeight - viewport.height - viewport.offsetTop))}px`)
      })
    }
    const putBack = () => {
      if (typing() || viewport.scale > 1.01) return
      if (viewport.offsetTop > 0 || scrollY > 0) scrollTo(0, 0)
      update()
    }
    const blurred = () => {
      clearTimeout(settle)
      // Asked once focus has moved: a tap from one field to the next keeps the keyboard, and the page where iOS put it.
      requestAnimationFrame(putBack)
      settle = setTimeout(putBack, SETTLE_AFTER_BLUR_MS)
    }
    update()
    viewport.addEventListener("resize", update)
    viewport.addEventListener("scroll", update)
    document.addEventListener("focusin", update)
    document.addEventListener("focusout", blurred)
    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(settle)
      viewport.removeEventListener("resize", update)
      viewport.removeEventListener("scroll", update)
      document.removeEventListener("focusin", update)
      document.removeEventListener("focusout", blurred)
    }
  }, [])
}

/** Whether a field that raises the keyboard has focus now: asked of the document, never of a flag kept on the way. */
export function typing(): boolean {
  const focused = document.activeElement
  return focused instanceof HTMLTextAreaElement || (focused instanceof HTMLInputElement && !["button", "checkbox", "radio", "range", "submit"].includes(focused.type)) || (focused instanceof HTMLElement && focused.isContentEditable)
}
