import { Skeleton } from "@/components/ui/skeleton"

/**
 * Opening a conversation, before a word of it is known: the transcript's own
 * geometry — prompt bubbles, the work line, prose at its measure and rhythm —
 * so the real turns land where their placeholders stood. The newest turn
 * settles first, above the composer, and older history recedes upward.
 */
const TRANSCRIPT_SKETCH = [
  { prompt: ["w-64", "w-40"], prose: [["w-full", "w-11/12", "w-full", "w-3/5"]] },
  { prompt: ["w-52"], prose: [["w-full", "w-10/12", "w-2/3"], ["w-full", "w-4/5"]] },
  { prompt: ["w-72", "w-56"], prose: [["w-11/12", "w-1/2"]] },
]

export function ConversationSkeleton() {
  return (
    <div aria-hidden className="skeleton-transcript skeleton-rows mx-auto flex h-full w-full max-w-content flex-col justify-end gap-7 overflow-hidden px-6 py-6">
      {TRANSCRIPT_SKETCH.flatMap((turn, index) => [
        <div key={`prompt-${index}`} className="flex justify-end">
          <div className="flex flex-col items-end gap-3 bg-raised px-3.5 py-3.5">
            {turn.prompt.map((width) => (
              <Skeleton key={width} className={`h-2 ${width}`} />
            ))}
          </div>
        </div>,
        <div key={`work-${index}`} className="flex h-7 items-center gap-2">
          <Skeleton className="size-3.5 rounded-full" />
          <Skeleton className="h-2 w-48 opacity-70" />
        </div>,
        ...turn.prose.map((lines, paragraph) => (
          <div key={`prose-${index}-${paragraph}`} className="flex flex-col gap-4 py-1">
            {lines.map((width, line) => (
              <Skeleton key={line} className={`h-2.5 ${width}`} />
            ))}
          </div>
        )),
      ])}
    </div>
  )
}
