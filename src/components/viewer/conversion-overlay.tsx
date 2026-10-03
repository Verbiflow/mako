import { useHarnessLabels } from "@/components/rail/harness-meta"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { useThreads } from "@/state/threads"
import { CheckIcon, MoveRightIcon } from "lucide-react"

/** A non-blocking receipt while Mako prepares a cross-agent handoff. */
export function ConversionOverlay() {
  const labels = useHarnessLabels()
  const harnessLabel = (harness: string) => labels[harness] ?? harness
  const converting = useThreads((state) => state.converting)
  if (!converting) return null

  return (
    <div className="pointer-events-none fixed bottom-20 left-1/2 z-[70] -translate-x-1/2">
      <div className="overlay-panel animate-enter flex items-center gap-2 rounded-full px-3 py-2 text-label text-muted-foreground">
        <HarnessIcon
          harness={converting.from}
          className="size-3.5 opacity-60"
        />
        {converting.done ? (
          <CheckIcon className="size-3.5 text-positive" />
        ) : (
          <MoveRightIcon className="size-3.5 text-faint" />
        )}
        <HarnessIcon harness={converting.to} className="size-3.5" />
        <span>
          {converting.done
            ? `Ready for ${harnessLabel(converting.to)}`
            : `Preparing for ${harnessLabel(converting.to)}…`}
        </span>
      </div>
    </div>
  )
}
