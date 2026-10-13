import { GitBranchIcon } from "lucide-react"
import type { WorkspaceMoveRequest } from "@mako/host/contracts/workspace-moves"
import { NoticeAction } from "@/components/ui/notice"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { useHarnessLabels } from "@/lib/harness-label"
import { cn } from "@/lib/utils"
import { useAcp } from "@/state/acp"
import {
  projectName,
  splitLine,
  stayingLine,
  unsure,
  useWorkspaceMoves,
  workspaceMoveFor,
  workspaceMoves,
} from "@/state/workspace-moves"

const CARD =
  "mx-2 mt-2 shrink-0 rounded-xl bg-popover text-ui text-foreground [box-shadow:inset_0_0_0_0.5px_var(--hairline)] motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1 motion-safe:duration-200 motion-safe:ease-[var(--ease-out)]"

/**
 * The agent on screen asked, through Mako's workspace tools, to go on on
 * its Thread's own branch. Allowed, once or for the project, it moves with
 * the Thread's other sessions in that checkout when all their turns end; the
 * card stays until then so the move can still be called off. Registered on
 * `composer.above`.
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
        <p
          className="min-w-0 flex-1 truncate text-muted-foreground"
          title={request.waiting}
        >
          {request.waiting ? (
            <>
              Waiting to move to {request.joins ? request.joins : "its own branch"}:{" "}
              {request.waiting}
            </>
          ) : (
            <>
              Moves to {request.joins ? request.joins : "its own branch"} when{" "}
              {request.companions ? "the thread's turns end" : "this turn ends"}
            </>
          )}
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
  const along = ["the conversation"]
  if (request.companions)
    along.push(request.companions === 1 ? "the thread's other session" : `the thread's ${request.companions} other sessions`)
  const { shares } = request
  // With the journal's word only the thread's own changes come; without it, every uncommitted file is named.
  const own = shares ? shares.thread.files : request.changed
  if (own && !request.joins)
    along.push(shares ? (own === 1 ? "its changed file" : `its ${own} changed files`) : own === 1 ? "the uncommitted file" : `the ${own} uncommitted files`)
  const staying = shares && !request.joins ? stayingLine(shares, request.bring) : ""
  const split = shares && !request.joins ? splitLine(shares.split) : undefined
  const bringable = shares && !request.joins ? unsure(shares) : 0
  const taking = along.length > 2 ? `${along.slice(0, -1).join(", ")} and ${along.at(-1)}` : along.join(" and ")
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
            {where}, taking {taking} along. The move happens when{" "}
            {request.companions ? "every session's turn ends" : "this turn ends"}.
          </p>
          {staying || split ? (
            <p
              data-workspace-move-stays
              className="mt-1 flex min-w-0 items-baseline gap-1.5 text-label text-faint"
            >
              <span
                className="min-w-0 truncate"
                title={[staying, split, ...stayingPaths(shares)].filter(Boolean).join("\n")}
              >
                {[staying, split].filter(Boolean).join(". ")}
              </span>
              {bringable ? (
                <button
                  type="button"
                  data-workspace-move-bring={request.bring ? "on" : "off"}
                  onClick={() => void workspaceMoves.bring(request.id, !request.bring)}
                  className="pressable shrink-0 rounded text-label text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                >
                  {request.bring ? "Leave them" : "Bring these"}
                </button>
              ) : null}
            </p>
          ) : null}
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

/** What stays, path by path, for the line's tooltip. */
function stayingPaths(shares: WorkspaceMoveRequest["shares"]): string[] {
  if (!shares) return []
  const listed = (label: string, share: { files: number; paths: string[] }) =>
    share.files ? [`${label}: ${share.paths.join(", ")}${share.files > share.paths.length ? `, and ${share.files - share.paths.length} more` : ""}`] : []
  return [
    ...listed("Might be its", shares.uncertain),
    ...listed("Not attributed", shares.unattributed),
    ...listed("Other threads'", shares.others),
    ...listed("Yours", shares.person),
  ]
}
