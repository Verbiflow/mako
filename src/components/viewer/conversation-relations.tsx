import { useState } from "react"
import { GitForkIcon } from "lucide-react"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { acp, useAcp, activeLiveAcp } from "@/state/acp"

/**
 * Where this conversation came from and what came back to it: the
 * conversation it forked from, and forks' findings waiting for its next turn.
 */
export function ConversationRelations() {
  const [open, setOpen] = useState(false)
  const parentId = useAcp((state) => activeLiveAcp(state)?.control?.ancestry?.parentId)
  const pendingMerges = useAcp(
    (state) =>
      activeLiveAcp(state)?.control?.merges.filter(
        (merge) => merge.status === "pending"
      ).length ?? 0
  )
  const answered = useAcp((state) =>
    Boolean(activeLiveAcp(state)?.requests?.some((request) => request.status === "completed"))
  )
  if (!parentId && pendingMerges === 0) return null
  const act = (action: () => Promise<void>) => {
    setOpen(false)
    void action()
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="pressable flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-ui text-faint hover:bg-fill-hover hover:text-foreground"
        >
          <GitForkIcon className="size-3" />
          {parentId ? "Forked" : "Fork findings"}
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" sideOffset={8} className="w-72 p-1">
        {parentId ? (
          <button
            type="button"
            onClick={() => act(() => acp.openRelated(parentId))}
            className="pressable flex w-full flex-col gap-0.5 rounded-md px-2 py-2 text-left hover:bg-fill-hover"
          >
            <span className="text-ui">Open the original</span>
            <span className="text-label text-faint">The conversation this one forked from</span>
          </button>
        ) : null}
        {parentId && answered ? (
          <button
            type="button"
            onClick={() => act(() => acp.mergeFork())}
            className="pressable flex w-full flex-col gap-0.5 rounded-md px-2 py-2 text-left hover:bg-fill-hover"
          >
            <span className="text-ui">Return findings</span>
            <span className="text-label text-faint">
              The original reads what this fork found in its next turn
            </span>
          </button>
        ) : null}
        {pendingMerges > 0 ? (
          <p className="px-2 py-2 text-label text-faint">
            {pendingMerges === 1 ? "A fork's findings join" : `${pendingMerges} forks' findings join`} the next
            turn. Files are unchanged.
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
