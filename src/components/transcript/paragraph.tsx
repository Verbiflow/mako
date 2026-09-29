import { useContext, useEffect, useRef, type ComponentProps } from "react"
import type { ExtraProps } from "react-markdown"
import { ProseStreamingContext } from "./prose-layout-context"

/** Uses the renderer's parsed tree; styled runs, links, and media stay native. */
export function Paragraph({
  node,
  children,
  ...props
}: ComponentProps<"p"> & ExtraProps) {
  const ref = useRef<HTMLParagraphElement>(null)
  const streaming = useContext(ProseStreamingContext)
  const child = node?.children.length === 1 ? node.children[0] : undefined
  const text = child?.type === "text" ? child.value : undefined
  useEffect(() => {
    const element = ref.current
    if (
      !element ||
      streaming ||
      !text ||
      text.length < 512 ||
      text.length > 8192
    )
      return
    let disposed = false
    let observer: ResizeObserver | undefined
    let frame: number | null = null
    void Promise.all([import("@/lib/paragraph-geometry"), document.fonts.ready])
      .then(([geometry]) => {
        if (disposed) return
        let placedWidth = 0
        let placeholder = { width: 0, height: 0 }
        // Chromium starts tracking a remembered size when `auto` is first set;
        // setting it during observer delivery reports a ResizeObserver loop.
        const place = () => {
          frame = null
          element.style.containIntrinsicInlineSize = `auto ${placeholder.width}px`
          element.style.containIntrinsicBlockSize = `auto ${placeholder.height}px`
          element.setAttribute("data-estimated-paragraph", "")
        }
        observer = new ResizeObserver(([entry]) => {
          if (!entry) return
          const { width } = entry.contentRect
          let { height } = entry.contentRect
          if (width <= 0) return
          // Native layout is exact while rendered. A skipped paragraph reports
          // its placeholder, so only a new width needs an estimate; the inline
          // axis keeps shrink-wrapped prompts from narrowing offscreen.
          if (!element.checkVisibility({ contentVisibilityAuto: true })) {
            if (width === placedWidth) return
            const style = getComputedStyle(element)
            height = Math.ceil(
              geometry.paragraphHeight({
                text,
                width,
                font: `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`,
                lineHeight: Number.parseFloat(style.lineHeight),
                letterSpacing: Number.parseFloat(style.letterSpacing) || 0,
              })
            )
          }
          placedWidth = width
          placeholder = { width, height }
          frame ??= requestAnimationFrame(place)
        })
        observer.observe(element)
      })
      .catch(() => {
        // Loading an optional estimator cannot interrupt a readable answer.
      })
    return () => {
      disposed = true
      observer?.disconnect()
      if (frame !== null) cancelAnimationFrame(frame)
      element.style.removeProperty("contain-intrinsic-inline-size")
      element.style.removeProperty("contain-intrinsic-block-size")
      element.removeAttribute("data-estimated-paragraph")
    }
  }, [streaming, text])
  return (
    <p {...props} ref={ref}>
      {children}
    </p>
  )
}
