import { GitBranchIcon } from "lucide-react"
import { NoticeAction } from "@/components/ui/notice"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { useHarnessLabels } from "@/lib/harness-label"
import { cn } from "@/lib/utils"
import { useAcp } from "@/state/acp"
import {
  projectName,
  useWorkspaceMoves,
  workspaceMoveFor,
  workspaceMoves,
} from "@/state/workspace-moves"

const CARD =
  "mx-2 mt-2 shrink-0 rounded-xl bg-popover text-ui text-foreground [box-shadow:inset_0_0_0_0.5px_var(--hairline)] motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1 motion-safe:duration-200 motion-safe:ease-[var(--ease-out)]"

/**
 * The agent on screen asked, through Mako's workspace tools, to go on on
 * its Thread's own branch. Allowed, once or for the project, it moves when
 * its turn ends; the card stays until then so the move can still be called
 * off. Registered on `composer.above`.
 */
export function WorkspaceMoveCard() {
  const labels = useHarnessLabels()
  const harnessLabel = (harness: string) => labels[harness] ?? harness
  const activeKey = useAcp((state) => state.activeKey)
  const request = useWorkspaceMoves((moves) =>
    workspaceMoveFor(moves, activeKey)
  )
  if (!request) return null
  const project = projectName(request.project)

  if (request.state === "allowed")
    return (
      <section
        role="status"
        data-workspace-move="allowed"
        className={cn(CARD, "flex items-center gap-2.5 py-1.5 pr-1.5 pl-3")}
      >
        <GitBranchIcon
          aria-hidden
          className="size-3.5 shrink-0 text-muted-foreground"
        />
        <p className="min-w-0 flex-1 truncate text-muted-foreground">
          Moves to {request.joins ? request.joins : "its own branch"} when this
          turn ends
        </p>
        <NoticeAction
          quiet
          onClick={() => void workspaceMoves.answer(request.id, "deny")}
        >
          Stay here
        </NoticeAction>
      </section>
    )

  const where = request.joins
    ? `It would join this thread's branch, ${request.joins}`
    : `It would leave the ${project} folder for a worktree on a new branch`
  const taking = request.changed
    ? `the conversation and ${request.changed === 1 ? "the uncommitted file" : `the ${request.changed} uncommitted files`}`
    : "the conversation"
  return (
    <section
      role="group"
      aria-label="Move to its own branch"
      data-workspace-move="asking"
      className={CARD}
    >
      <div className="flex items-start gap-3 px-3 py-2.5">
        <span
          aria-hidden
          className="relative mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg bg-fill-hover"
        >
          <GitBranchIcon className="size-3.5 text-foreground" />
          <span className="absolute -right-1 -bottom-1 grid size-4 place-items-center rounded-full bg-popover">
            <HarnessIcon harness={request.harness} className="size-3" />
          </span>
        </span>
        <div className="min-w-0 flex-1">
          <p className="leading-5">
            {harnessLabel(request.harness)} wants to work on its own branch
          </p>
          <p className="mt-0.5 text-label leading-relaxed text-muted-foreground">
            {where}, taking {taking} along. The move happens when this turn
            ends.
          </p>
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => void workspaceMoves.answer(request.id, "allow")}
              className="pressable h-6 rounded-md bg-foreground px-2.5 text-label font-medium text-background transition-opacity duration-100 hover:opacity-90"
            >
              Allow
            </button>
            <span
              title={`Agents in ${project} move to their own branch without asking. Settings › Worktrees lists the projects that allow it.`}
            >
              <NoticeAction
                onClick={() => void workspaceMoves.answer(request.id, "always")}
              >
                Always allow in {project}
              </NoticeAction>
            </span>
            <NoticeAction
              quiet
              onClick={() => void workspaceMoves.answer(request.id, "deny")}
            >
              Don't allow
            </NoticeAction>
          </div>
        </div>
      </div>
    </section>
  )
}
