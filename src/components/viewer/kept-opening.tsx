import { ArchiveIcon } from "lucide-react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { KeptSessionText } from "@/lib/kept-session"

/**
 * The first line of a session its harness deleted: who keeps it now
 * (`keptSessionText`), between hairlines like any opening, with what that
 * means in its tip.
 */
export function KeptOpening({ text }: { text: KeptSessionText }) {
  return (
    <>
      <span aria-hidden className="h-px min-w-0 flex-1 bg-hairline" />
      <Tooltip>
        <TooltipTrigger asChild>
          <span data-kept-opening tabIndex={0} className="animate-enter flex min-w-0 max-w-[80%] items-center gap-1.5 rounded-md px-1 outline-none focus-visible:ring-1 focus-visible:ring-ring">
            <ArchiveIcon aria-hidden className="size-3 shrink-0" />
            <span className="min-w-0 truncate">{text.line}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-80">
          <p>{text.detail}</p>
        </TooltipContent>
      </Tooltip>
      <span aria-hidden className="h-px min-w-0 flex-1 bg-hairline" />
    </>
  )
}
