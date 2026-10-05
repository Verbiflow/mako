import { useState } from "react"
import { formatBytes } from "@/lib/format"
import { binarySizes } from "@/lib/git-binary"
import { cn } from "@/lib/utils"
import type { GitBinarySide, GitDiff } from "@/lib/types"

/** Light and dark squares behind an image, so transparent pixels read as transparent. */
const CHECKER = "bg-[length:12px_12px] bg-[position:0_0,6px_6px] bg-[image:linear-gradient(45deg,var(--color-fill-hover)_25%,transparent_25%,transparent_75%,var(--color-fill-hover)_75%),linear-gradient(45deg,var(--color-fill-hover)_25%,transparent_25%,transparent_75%,var(--color-fill-hover)_75%)]"

/** Both sides of an image as small squares, for a header row. */
export function ImageThumbs({ diff }: { diff: Pick<GitDiff, "before" | "after"> }) {
  const sides = [diff.before, diff.after].filter((side): side is GitBinarySide => Boolean(side?.image))
  if (sides.length === 0) return null
  return (
    <span className="flex shrink-0 items-center gap-0.5" aria-hidden>
      {sides.map((side, index) => (
        <img key={index} src={side.image} alt="" className={cn("size-5 rounded-sm object-contain ring-1 ring-hairline", CHECKER)} />
      ))}
    </span>
  )
}

/**
 * A binary file in a diff: an image before and after, side by side at their
 * own size up to the pane's width, or its sizes when it isn't an image.
 */
export function BinaryDiff({ diff }: { diff: GitDiff }) {
  const images = diff.before?.image || diff.after?.image
  const sizes = binarySizes(diff)
  if (!images) {
    return (
      <div data-binary-diff className="flex h-9 items-center gap-2 border-b border-hairline px-3 text-ui">
        <span className="min-w-0 flex-1 truncate font-mono text-label text-muted-foreground">{diff.path}</span>
        <span className="shrink-0 text-label text-faint">{sizes ? `Binary · ${sizes}` : "Binary"}</span>
      </div>
    )
  }
  return (
    <figure data-binary-diff data-image-diff className="border-b border-hairline">
      <figcaption className="flex h-9 items-center gap-2 px-3">
        <span className="min-w-0 flex-1 truncate font-mono text-label text-muted-foreground">{diff.path}</span>
        {sizes ? <span className="shrink-0 text-label text-faint">{sizes}</span> : null}
      </figcaption>
      <div className="grid grid-cols-2 gap-3 px-3 pb-3">
        <ImageSide label="Before" side={diff.before} />
        <ImageSide label="After" side={diff.after} />
      </div>
    </figure>
  )
}

function ImageSide({ label, side }: { label: string; side: GitBinarySide | null | undefined }) {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="flex items-center gap-2 text-label text-faint">
        <span className="font-medium text-muted-foreground">{label}</span>
        {side ? <span className="tabular">{[size ? `${size.width} × ${size.height}` : null, formatBytes(side.bytes)].filter(Boolean).join(" · ")}</span> : null}
      </span>
      <div className={cn("flex min-h-24 items-center justify-center overflow-hidden rounded-md ring-1 ring-hairline", side?.image && CHECKER)}>
        {side?.image ? (
          <img
            src={side.image}
            alt={`${label}: ${size ? `${size.width} by ${size.height}` : "image"}`}
            onLoad={(event) => setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
            className="max-h-[60vh] max-w-full object-contain [image-rendering:auto]"
          />
        ) : (
          <span className="px-3 py-6 text-label text-faint">{side ? "Too large to show" : label === "Before" ? "Added" : "Deleted"}</span>
        )}
      </div>
    </div>
  )
}
