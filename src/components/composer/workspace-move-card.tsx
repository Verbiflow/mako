import { GitBranchIcon } from "lucide-react"
import type { WorkspaceMoveRequest } from "@mako/host/contracts/workspace-moves"
import { NoticeAction } from "@/components/ui/notice"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { useHarnessLabels } from "@/lib/harness-label"
import type { ComposerNotice } from "@/extend/notices"
import { useAcp } from "@/state/acp"
import { UNSURE_LABEL } from "@/lib/turn-changes"
import {
  projectName,
  splitLine,
  stayingLine,
  unsure,
  useWorkspaceMoves,
  workspaceMoveFor,
  workspaceMoves,
} from "@/state/workspace-moves"

/**
 * The agent on screen asked, through Mako's workspace tools, to go on on
 * its Thread's own branch. Allowed, once or for the project, it moves with
 * the Thread's other sessions in that checkout when all their turns end; the
 * notice stays until then so the move can still be called off. A notice
 * producer (`registerNotice`).
 */
export function useWorkspaceMoveNotice(): ComposerNotice | null {
  const labels = useHarnessLabels()
  const harnessLabel = (harness: string) => labels[harness] ?? harness
  const activeKey = useAcp((state) => state.activeKey)
  const request = useWorkspaceMoves((moves) =>
    workspaceMoveFor(moves, activeKey)
  )
  if (!request) return null
  const project = projectName(request.project)
  const target = request.joins ? request.joins : "its own branch"

  if (request.state === "allowed")
    return {
      id: "workspace-move",
      tone: "progress",
      icon: <GitBranchIcon className="text-muted-foreground" />,
      title: request.waiting ? `Waiting to move to ${target}` : `Moves to ${target} when ${request.companions ? "the thread's turns end" : "this turn ends"}`,
      description: request.waiting,
      actions: [{ label: "Stay here", onClick: () => void workspaceMoves.answer(request.id, "deny") }],
      data: { "data-workspace-move": "allowed" },
    }

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
  return {
    id: "workspace-move",
    tone: "caution",
    priority: 0,
    icon: <HarnessIcon harness={request.harness} />,
    title: `${harnessLabel(request.harness)} wants to work on ${request.joins ? `this thread's branch, ${request.joins}` : "its own branch"}`,
    description: `taking ${taking}`,
    detail: (
      <div className="flex flex-col gap-2">
        <p>
          {where}, taking {taking} along. The move happens when{" "}
          {request.companions ? "every session's turn ends" : "this turn ends"}.
        </p>
        {staying || split ? (
          <p data-workspace-move-stays className="text-faint" title={stayingPaths(shares).join("\n")}>
            {[staying, split].filter(Boolean).join(". ")}
          </p>
        ) : null}
        <span className="flex flex-wrap items-center gap-1.5">
          {bringable ? (
            <NoticeAction quiet onClick={() => void workspaceMoves.bring(request.id, !request.bring)}>
              {request.bring ? "Leave them" : "Bring these"}
            </NoticeAction>
          ) : null}
          <span title={`Agents in ${project} move to their own branch without asking. Settings › Worktrees lists the projects that allow it.`}>
            <NoticeAction onClick={() => void workspaceMoves.answer(request.id, "always")}>
              Always allow in {project}
            </NoticeAction>
          </span>
        </span>
      </div>
    ),
    actions: [
      { label: "Allow", primary: true, onClick: () => void workspaceMoves.answer(request.id, "allow") },
      { label: "Don't allow", onClick: () => void workspaceMoves.answer(request.id, "deny") },
    ],
    data: { "data-workspace-move": "asking" },
  }
}

/** What stays, path by path, for the line's tooltip. */
function stayingPaths(shares: WorkspaceMoveRequest["shares"]): string[] {
  if (!shares) return []
  const listed = (label: string, share: { files: number; paths: string[] }) =>
    share.files ? [`${label}: ${share.paths.join(", ")}${share.files > share.paths.length ? `, and ${share.files - share.paths.length} more` : ""}`] : []
  return [
    ...(shares.likely ? listed("Coming on a best guess (only this thread was working)", shares.likely) : []),
    ...listed(UNSURE_LABEL, shares.uncertain),
    ...listed("Not attributed", shares.unattributed),
    ...listed("Other threads'", shares.others),
    ...listed("Yours", shares.person),
  ]
}
