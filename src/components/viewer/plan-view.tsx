import { lazy, Suspense, useEffect } from "react"
import { BookOpenIcon, Code2Icon, HammerIcon, SendIcon } from "lucide-react"
import { GitLoading } from "@/components/inspector/git-loading"
import { Prose } from "@/components/transcript/markdown"
import { CopyPlanAction, PlanMenu } from "@/components/transcript/plan-actions"
import { openPlanTab, usePlanBuilding, usePlanState } from "@/components/transcript/plan-state"
import { TranscriptSourceContext } from "@/components/transcript/source-context"
import { Action, Chip } from "@/components/ui/kit"
import { proposedPlanFilename, proposedPlanTitle } from "@/lib/proposed-plan"
import { useLatestPlan, useSourcePlan } from "@/state/plan-mode"
import { viewer, type PlanOf, type ViewerDocument } from "@/state/viewer"

const View = lazy(() =>
  import("@/components/viewer/file-view").then((module) => ({ default: module.FileView }))
)

/**
 * A plan open as a tab: the same document as its card, at reading width,
 * with its Markdown source a click away. It follows the plan while its
 * conversation is open, and keeps the last version it saw after that.
 */
export function PlanDocumentView({ document, of }: { document: ViewerDocument; of: PlanOf }) {
  const current = useSourcePlan(of.source, of.id)
  const plan = current ?? of.snapshot
  const title = proposedPlanTitle(plan.text)
  useEffect(() => {
    if (current) viewer.updatePlan(document.id, current, title)
  }, [current, document.id, title])
  const state = usePlanState(of.source, plan)
  const { building, start } = usePlanBuilding(of.source, plan)
  const latestId = useLatestPlan(of.source)
  const latest = useSourcePlan(of.source, latestId ?? "")
  const build = (where: "here" | "new") => {
    viewer.showAgent()
    start(where)
  }
  const preview = document.renderMode === "preview"
  return (
    <TranscriptSourceContext value={of.source}>
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-hairline px-2">
        <span className="min-w-0 flex-1 truncate px-1 text-label text-faint" title={title}>
          {state.awaiting && !state.built ? "Proposed plan" : state.label}
        </span>
        {state.awaiting && !state.built ? <Chip tone="caution">Waiting for your approval</Chip> : null}
        <Action size="xs" aria-pressed={preview} onClick={() => viewer.setRenderMode(document.id, preview ? "source" : "preview")}>
          {preview ? <Code2Icon /> : <BookOpenIcon />}
          <span>{preview ? "Source" : "Preview"}</span>
        </Action>
        <CopyPlanAction plan={plan} />
        <PlanMenu plan={plan} state={state} onBuild={build} building={building !== null} />
        {!state.superseded && state.ready ? (
          <>
            <Action size="xs" tone="outline" disabled={building !== null} onClick={() => build("new")}>
              <SendIcon />
              {building === "new" ? "Opening…" : "Build in new session"}
            </Action>
            {!state.built ? (
              <Action size="xs" tone="solid" disabled={building !== null} onClick={() => build("here")}>
                <HammerIcon />
                {building === "here" ? "Building…" : state.awaiting ? "Approve and build" : "Build"}
              </Action>
            ) : null}
          </>
        ) : null}
      </div>
      {state.superseded && latest ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-hairline bg-raised/50 px-3 py-1.5 text-label text-muted-foreground">
          <span className="min-w-0 flex-1 truncate">A newer revision of this plan follows: {proposedPlanTitle(latest.text)}</span>
          <Action size="xs" tone="quiet" onClick={() => openPlanTab(of.source, latest)}>
            Open newest
          </Action>
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto">
        {preview ? (
          <article className="mx-auto w-full max-w-3xl px-8 pt-8 pb-16">
            <Prose text={plan.text} streaming={plan.status !== "proposed"} />
          </article>
        ) : (
          <Suspense fallback={<GitLoading kind="diff" label={`Opening ${title}`} />}>
            <View
              mode="source"
              file={{ path: proposedPlanFilename(plan.text), contents: plan.text, size: plan.text.length, binary: false, truncated: false }}
            />
          </Suspense>
        )}
      </div>
    </TranscriptSourceContext>
  )
}
