import { cn } from "@/lib/utils"

/**
 * A transcript being opened with nothing of it to show yet: its code still arriving, or its turns being read from
 * their owner for the first time on this page. Never drawn over turns already on screen.
 */
export function TranscriptLoading({ className }: { className?: string }) {
  return (
    <div className={cn("flex min-h-0 flex-1 flex-col gap-4 px-5 pt-8", className)} aria-busy aria-label="Opening the conversation">
      <span className="skeleton ml-auto h-12 w-3/5" />
      <span className="skeleton h-3.5 w-4/5" />
      <span className="skeleton h-3.5 w-2/3" />
      <span className="skeleton h-3.5 w-3/4" />
    </div>
  )
}
