import { GitBranchIcon } from "lucide-react"
import type { ThreadWorktree, WorktreeStartReceipt } from "../../../electron/contracts/thread-worktrees.ts"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

function readyIn(ms: number): string {
  const seconds = ms / 1000
  return seconds < 10 ? `${seconds.toFixed(1)} s` : `${Math.round(seconds)} s`
}

function details(worktree: ThreadWorktree, start: WorktreeStartReceipt): string[] {
  const at = worktree.base.slice(0, 7)
  return [
    start.from === null
      ? `A branch that already existed, at ${at}. It stays when the worktree goes.`
      : `A new branch from ${start.from}, at ${at}.`,
    ...(start.copied > 0 ? [`${start.copied} ${start.copied === 1 ? "file" : "files"} copied from your project folder.`] : []),
    ...(start.spare ? ["Made ahead of time, so it was ready at once."] : []),
  ]
}

/** The first line of a Thread that started in its own worktree: where it works and how long that took. */
export function WorktreeOpening({ worktree, start }: { worktree: ThreadWorktree; start: WorktreeStartReceipt }) {
  return (
    <>
      <span aria-hidden className="h-px min-w-0 flex-1 bg-hairline" />
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0} className="animate-enter flex min-w-0 max-w-[80%] items-center gap-1.5 rounded-md px-1 outline-none focus-visible:ring-1 focus-visible:ring-ring">
            <GitBranchIcon aria-hidden className="size-3 shrink-0" />
            <span className="min-w-0 truncate">
              On <span className="text-muted-foreground">{worktree.branch}</span>
              {start.from !== null && <> from {start.from}</>}
            </span>
            <span aria-hidden>·</span>
            <span className="tabular shrink-0">ready in {readyIn(start.tookMs)}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-72">
          <div className="flex flex-col gap-1">
            {details(worktree, start).map((line) => (
              <p key={line}>{line}</p>
            ))}
          </div>
        </TooltipContent>
      </Tooltip>
      <span aria-hidden className="h-px min-w-0 flex-1 bg-hairline" />
    </>
  )
}
