import { ArrowRightLeftIcon } from "lucide-react"
import type { NativeAgent } from "@mako/host/contracts/native-agents"
import { finMoved } from "@/state/fin-moved"

/**
 * A Fin's row: where it went on when its harness's account ran out, and why ("Moved to Claude (work): personal is at
 * its limit until 3:10 PM PST"), on two lines at most, since a phone has no hover to read the rest.
 */
export function FinMovedLine({ agent }: { agent: NativeAgent }) {
  const moved = finMoved(agent)
  if (!moved) return null
  return (
    <span data-fin-moved className="flex min-w-0 items-start gap-1 text-label text-muted-foreground" title={moved}>
      <ArrowRightLeftIcon aria-hidden className="mt-0.5 size-3 shrink-0" />
      <span className="line-clamp-2">{moved}</span>
    </span>
  )
}
