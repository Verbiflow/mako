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
 * the viewport. Inline it fits the height its page reports, up to `max`;
 * expanded it fills the lightbox. Its first URL
 * stays, so a re-signed URL for the same page doesn't reload it.
 */
export function HtmlFrame({ url, name, expanded = false, max = HTML_FRAME_INLINE_MAX, initial = HTML_FRAME_INITIAL, onHeight }: {
  url: string
  name: string
  expanded?: boolean
  /** The tallest it grows inline, and its height before the page reports one. */
  max?: number
  initial?: number
  /** Hears each height the page reports, before `max` bounds it. */
  onHeight?(height: number): void
}) {
  const { ref, visible } = useVisible()
  const frame = useRef<HTMLIFrameElement>(null)
  const [source] = useState(url)
  const [height, setHeight] = useState<number>()
  useEffect(() => {
    if (!visible) return
    const listener = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return
      const message = HeightMessage.safeParse(event.data)
      if (!message.success) return
      const reported = Math.ceil(message.data.height)
      setHeight(reported)
      onHeight?.(reported)
    }
    window.addEventListener("message", listener)
    return () => window.removeEventListener("message", listener)
  }, [visible, onHeight])
  const fitted = Math.max(120, Math.min(height ?? initial, max))
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
