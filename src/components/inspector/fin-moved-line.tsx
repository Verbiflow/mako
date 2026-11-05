import { ArrowRightLeftIcon } from "lucide-react"
import type { NativeAgent } from "@mako/host/contracts/native-agents"

/** A Fin's row: where it went on when its harness's account ran out, and why ("Moved to Claude (work): personal is at its limit until 3:10 PM PST"). */
export function FinMovedLine({ agent }: { agent: NativeAgent }) {
  const moved = agent.child?.moved
  if (!moved) return null
  return (
    <span data-fin-moved className="flex min-w-0 items-center gap-1 text-label text-muted-foreground" title={moved}>
      <ArrowRightLeftIcon aria-hidden className="size-3 shrink-0" />
      <span className="truncate">{moved}</span>
    </span>
  )
}
