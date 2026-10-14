import { useMemo, useState } from "react"
import { AppWindowMacIcon, ScanSearchIcon } from "lucide-react"
import { outlineLine, type OutlineLine } from "@mako/host/contracts/window-outline"
import { Action } from "@/components/ui/kit"
import type { Attachment } from "@/lib/attachments"
import { useAttachmentPreview } from "@/lib/attachments"
import { useWindowOutline } from "@/lib/window-capture"
import { cn } from "@/lib/utils"

/**
 * A window capture opened: whose window, the picture, and what the agent
 * was told is in it, drawn over the picture on request. Each element's box
 * is where the outline says it is in the image's pixels, so what is drawn is
 * exactly what the agent can point at; hovering one names it in the line
 * the agent read. The composer's tile and the transcript's chip both open
 * this.
 */
export function WindowCapturePreview({
  item,
  app,
  title,
  icon,
  outline,
}: {
  /** The picture: the record, or one made from a sent item's path. */
  item: Attachment
  app: string
  title: string
  icon?: string
  /** The elements while the desk still holds them. */
  outline?: string
}) {
  const loaded = useAttachmentPreview(item)
  const read = useWindowOutline(item.contextPath, outline)
  const [shown, setShown] = useState(false)
  const [hovered, setHovered] = useState<OutlineLine | null>(null)
  const boxes = useMemo(() => {
    const image = read?.image
    if (!image || !read) return []
    const area = image.width * image.height
    // The window and the page that fill it say nothing drawn; smaller boxes go on top.
    return read.elements
      .filter((element): element is OutlineLine & { box: NonNullable<OutlineLine["box"]> } => Boolean(element.box))
      .filter((element) => element.box[2] * element.box[3] < area * 0.9)
      .sort((a, b) => b.box[2] * b.box[3] - a.box[2] * a.box[3])
  }, [read])
  const url = loaded?.kind === "ready" ? loaded.url : undefined
  return (
    <div className="flex flex-col">
      <div className="flex min-h-11 items-center gap-2.5 border-b border-hairline px-3 py-2">
        {icon ? <img src={icon} alt="" className="size-5 shrink-0" /> : <AppWindowMacIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-ui font-medium text-foreground">{app}</span>
          {title ? <span className="block truncate text-label text-muted-foreground">{title}</span> : null}
        </span>
        {boxes.length > 0 ? (
          <Action
            tone="ghost"
            size="xs"
            data-on={shown}
            aria-pressed={shown}
            onClick={() => {
              setShown((value) => !value)
              setHovered(null)
            }}
          >
            <ScanSearchIcon aria-hidden />
            {read?.elements.length ?? 0} elements
          </Action>
        ) : null}
      </div>
      <div className="relative bg-background">
        {url ? (
          <img src={url} alt={`${app}${title ? `: ${title}` : ""}`} decoding="async" className="block h-auto max-h-[60vh] w-full object-contain" />
        ) : (
          <p className="px-4 py-10 text-center text-ui text-muted-foreground">
            {loaded?.kind === "unavailable" ? "The picture is no longer where it was saved." : "Loading the capture…"}
          </p>
        )}
        {url && shown && read?.image ? (
          <svg
            role="img"
            aria-label="Element boxes"
            viewBox={`0 0 ${read.image.width} ${read.image.height}`}
            preserveAspectRatio="xMidYMid meet"
            className="absolute inset-0 size-full"
            onPointerLeave={() => setHovered(null)}
          >
            {boxes.map((element, index) => {
              const active = hovered === element
              const [x, y, width, height] = element.box
              // Two strokes, the shell's colour under the text's, so a box reads on a light window and a dark one.
              return (
                <g key={index} onPointerEnter={() => setHovered(element)}>
                  <rect
                    x={x}
                    y={y}
                    width={width}
                    height={height}
                    vectorEffect="non-scaling-stroke"
                    className={cn("fill-transparent stroke-background [stroke-width:3]", active ? "[stroke-opacity:0.9]" : "[stroke-opacity:0.45]")}
                  />
                  <rect
                    x={x}
                    y={y}
                    width={width}
                    height={height}
                    vectorEffect="non-scaling-stroke"
                    className={cn(
                      "stroke-foreground transition-[stroke-opacity,fill] duration-100 [stroke-width:1]",
                      active ? "fill-foreground/15 [stroke-opacity:1]" : "fill-transparent [stroke-opacity:0.7]"
                    )}
                  />
                </g>
              )
            })}
          </svg>
        ) : null}
      </div>
      {shown ? (
        <p className="min-h-8 truncate border-t border-hairline px-3 py-1.5 font-mono text-code text-muted-foreground">
          {hovered ? outlineLine({ role: hovered.role, name: hovered.name, value: hovered.value, box: hovered.box, states: hovered.flags }) : "Point at a box to see the line the agent reads for it."}
        </p>
      ) : null}
    </div>
  )
}
