import { useEffect, useRef, useState } from "react"
import { z } from "zod"
import { PAGE_HEIGHT_MESSAGE } from "@mako/host/contracts/page-frame"
import { useVisible } from "@/components/transcript/use-visible"

/** The tallest a page grows inline; past it the page scrolls inside its frame, and the lightbox shows it whole. */
export const HTML_FRAME_INLINE_MAX = 960
/** The frame's height before the page reports its own. */
const HTML_FRAME_INITIAL = 360

const HeightMessage = z.object({ type: z.literal(PAGE_HEIGHT_MESSAGE), height: z.number().finite().nonnegative() })

/**
 * A page the agent wrote, loaded by its signed URL in a sandbox: its own
 * styles, scripts, pictures and fonts load from beside it, and it runs in
 * an opaque origin with no Mako bridge, cookie or storage. Mounted only near
 * the viewport. Inline it fits the height its page reports, up to
 * `HTML_FRAME_INLINE_MAX`; expanded it fills the lightbox. Its first URL
 * stays, so a re-signed URL for the same page doesn't reload it.
 */
export function HtmlFrame({ url, name, expanded = false }: { url: string; name: string; expanded?: boolean }) {
  const { ref, visible } = useVisible()
  const frame = useRef<HTMLIFrameElement>(null)
  const [source] = useState(url)
  const [height, setHeight] = useState<number>()
  useEffect(() => {
    if (!visible) return
    const listener = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return
      const message = HeightMessage.safeParse(event.data)
      if (message.success) setHeight(Math.ceil(message.data.height))
    }
    window.addEventListener("message", listener)
    return () => window.removeEventListener("message", listener)
  }, [visible])
  const fitted = Math.max(120, Math.min(height ?? HTML_FRAME_INITIAL, HTML_FRAME_INLINE_MAX))
  return (
    <div ref={ref} data-html-frame className={expanded ? "h-full min-h-96" : "w-full"} style={expanded ? undefined : { height: fitted }}>
      {visible ? (
        <iframe
          ref={frame}
          title={`Page ${name}`}
          src={source}
          sandbox="allow-scripts allow-forms allow-popups"
          referrerPolicy="no-referrer"
          className="html-frame block size-full border-0"
        />
      ) : null}
    </div>
  )
}
