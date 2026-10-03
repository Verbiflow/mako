import { fileMimeTypeForPath } from "../../../electron/contracts/file-preview"
import { z } from "zod"
import { TranscriptAttachments } from "./attachment-collection"
import { markdownMedia } from "@/lib/transcript-media"
import { markdownFileTarget } from "@/lib/file-citations"
import type { AttachmentContent } from "@mako/sessions"
import { FilePreviewCollection } from "./attachment-collection"
import { inlineFileLinks } from "@/lib/inline-file-links"
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
  if (node?.properties.dataAssetGroup) {
    const attachments: AttachmentContent[] = []
    const seen = new Set<string>()
    for (const entry of node.children) {
      if (entry.type !== "element") continue
      const properties = z.object({ src: z.string().optional(), href: z.string().optional(), alt: z.string().optional() }).safeParse(entry.properties)
      if (!properties.success) continue
      const href = entry.tagName === "img" ? properties.data.src : properties.data.href
      if (!href || seen.has(href)) continue
      seen.add(href)
      if (entry.tagName === "img") attachments.push(markdownMedia(href, properties.data.alt))
      else {
        const target = markdownFileTarget(href)
        if (target) attachments.push({ type: "attachment", id: target.path, name: target.path.split("/").at(-1) ?? target.path, mimeType: fileMimeTypeForPath(target.path) ?? "application/octet-stream", source: { kind: "file", path: target.path } })
      }
    }
    return <TranscriptAttachments attachments={attachments} />
  }
  const targets = inlineFileLinks(node)
  if (targets.length)
    return (
      <div className={props.className}>
        {child?.type === "element" && child.tagName === "a" ? null : (
          <p>{children}</p>
        )}
        <FilePreviewCollection paths={targets} />
      </div>
    )
  if (
    node?.children.some(
      (entry) => entry.type === "element" && entry.tagName === "img"
    )
  )
    return <div className={props.className}>{children}</div>
  return (
    <p {...props} ref={ref}>
      {children}
    </p>
  )
}
