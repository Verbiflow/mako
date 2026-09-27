import { memo, useState } from "react"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { cn } from "@/lib/utils"

/** A mark that mounts this long after its row did joined while you watched. */
const GLYPH_ARRIVAL_MS = 32

/**
 * One Session's agent in a rail row's mark stack. Each mark is cut away where
 * the next one overlaps it, so two of the same agent read as two.
 */
export const FoldGlyph = memo(function FoldGlyph({ harness, live, rowSince }: { harness: string; live: boolean; rowSince: number }) {
  const [arrived] = useState(() => performance.now() - rowSince > GLYPH_ARRIVAL_MS)
  return (
    <span data-new={arrived || undefined} className="thread-glyph flex">
      <HarnessIcon harness={harness} className={cn("size-3", live && "animate-live")} />
    </span>
  )
})
