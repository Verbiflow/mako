import { CircleDashedIcon, CornerLeftUpIcon, GitForkIcon, UserRoundIcon } from "lucide-react"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { lineWords, writerLabel, type WriterNote } from "@/lib/turn-writers"
import { cn } from "@/lib/utils"
import { useThreadTitles } from "@/state/thread-titles"

/**
 * Who wrote the stretch of changed lines just above, in the diff's own
 * annotation slot so it moves with the lines: the turn's agent, the
 * person, another Thread, or a writer only timing names. Only the files a
 * turn shares with another writer get these rows.
 */
export function WriterRow({ note, harness }: { note: WriterNote; harness?: string }) {
  const title = useThreadTitles((state) => (note.thread ? state.byThread[note.thread]?.title : undefined))
  const mine = note.writer === "turn" || note.writer === "thread"
  return (
    <div data-writer={note.writer} className="flex h-6 items-center gap-1.5 bg-surface pl-3 font-sans text-label select-none">
      <CornerLeftUpIcon aria-hidden className="size-3 shrink-0 text-faint/70" />
      <span aria-hidden className={cn("flex size-3.5 shrink-0 items-center justify-center [&_svg]:size-3", mine ? "text-muted-foreground" : note.writer === "person" || note.writer === "other" ? "text-foreground" : "text-faint")}>
        {mine ? harness ? <HarnessIcon harness={harness} /> : <CircleDashedIcon /> : note.writer === "person" ? <UserRoundIcon /> : note.writer === "other" ? <GitForkIcon /> : <CircleDashedIcon />}
      </span>
      <span className={cn("min-w-0 truncate", note.writer === "person" || note.writer === "other" ? "font-medium text-foreground" : mine ? "text-muted-foreground" : "text-faint")}>{writerLabel(note, title)}</span>
      <span className="shrink-0 text-faint">· {lineWords(note.lines)}</span>
    </div>
  )
}
