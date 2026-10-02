import { useLayoutEffect, useRef, useState } from "react"
import type { ProposedPlan } from "@mako/sessions/content"
import { ChevronDownIcon, ClipboardListIcon, Maximize2Icon, SendIcon } from "lucide-react"
import { Prose } from "./markdown"
import { CopyPlanAction, PlanMenu } from "./plan-actions"
import { openPlanTab, usePlanBuilding, usePlanState, type PlanState } from "./plan-state"
import { useTranscriptSource } from "./source-context"
import { Action, Chip, IconAction } from "@/components/ui/kit"
import { cn } from "@/lib/utils"
import { acp } from "@/state/acp"

/** Taller plans show this much, faded, until opened in full or in a tab. */
const CLAMP_PX = 440

/**
 * A plan the agent proposed, as the document it is: its own heading is the
 * title, and the decision to build it sits above the composer, where the
 * reply to it is written. Earlier revisions fold to one line.
 */
export function ProposedPlanCard({ plan, streaming }: { plan: ProposedPlan; streaming?: boolean }) {
  const source = useTranscriptSource()
  const state = usePlanState(source, plan, streaming)
  const { building, start } = usePlanBuilding(source, plan)
  const [opened, setOpened] = useState<boolean | null>(null)
  const folded = !(opened ?? !state.superseded)
  return (
    <section aria-label={`Plan: ${state.title}`} className="group/plan flex flex-col gap-1.5">
      <PlanLead state={state} folded={folded} onFold={state.superseded ? () => setOpened(folded) : undefined} />
      {folded ? null : (
        <div className="relative rounded-lg border border-hairline bg-card">
          <div
            className={cn(
              "absolute top-2 right-2 z-10 flex items-center gap-0.5 rounded-md bg-card p-0.5 ring-1 ring-hairline",
              "opacity-0 transition-opacity duration-150 group-hover/plan:opacity-100 focus-within:opacity-100 has-[[data-state=open]]:opacity-100"
            )}
          >
            <IconAction label="Open in a tab" size="xs" onClick={() => openPlanTab(source, plan)}>
              <Maximize2Icon />
            </IconAction>
            <CopyPlanAction plan={plan} />
            {!state.superseded && state.ready ? (
              <IconAction
                label={building === "new" ? "Opening…" : "Build in a new session"}
                size="xs"
                disabled={building !== null}
                onClick={() => start("new")}
              >
                <SendIcon />
              </IconAction>
            ) : null}
            <PlanMenu plan={plan} state={state} onBuild={start} building={building !== null} />
          </div>
          <ClampedPlan plan={plan} streaming={Boolean(streaming) && !state.complete} onOpen={() => openPlanTab(source, plan)} />
          {plan.truncated ? (
            <p className="border-t border-hairline px-5 py-2.5 text-label text-faint">
              The plan exceeded the capture limit. Export includes the saved portion; ask for a shorter plan before building.
            </p>
          ) : null}
        </div>
      )}
    </section>
  )
}

function PlanLead({ state, folded, onFold }: { state: PlanState; folded: boolean; onFold?: () => void }) {
  const status = state.built ? (
    <Chip tone="positive">{state.builtHere ? "Built" : "Built in another session"}</Chip>
  ) : null
  const lead = (
    <>
      <ClipboardListIcon className="size-3.5 shrink-0" />
      <span className="shrink-0">{state.complete ? "Plan" : state.label}</span>
      {state.superseded ? <span className="min-w-0 truncate text-faint">· Earlier revision · {state.title}</span> : null}
    </>
  )
  return (
    <div className="flex min-h-5 items-center gap-1.5 text-label text-muted-foreground">
      {onFold ? (
        <button
          type="button"
          aria-expanded={!folded}
          onClick={onFold}
          className="pressable -mx-1 flex min-w-0 items-center gap-1.5 rounded px-1 hover:text-foreground"
        >
          <ChevronDownIcon className={cn("size-3.5 shrink-0 transition-transform", folded && "-rotate-90")} />
          {lead}
        </button>
      ) : (
        lead
      )}
      {status}
      {state.openBuild ? (
        <button
          type="button"
          onClick={() => acp.activate(state.openBuild!)}
          className="pressable rounded px-1 text-faint underline-offset-2 hover:text-foreground hover:underline"
        >
          Open that session
        </button>
      ) : null}
    </div>
  )
}

/**
 * The plan's Markdown, clipped to `CLAMP_PX` when longer. While it is being
 * written the clipped window follows the newest lines; once complete it
 * shows the top, faded at the bottom.
 */
function ClampedPlan({ plan, streaming, onOpen }: { plan: ProposedPlan; streaming: boolean; onOpen: () => void }) {
  const frame = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const [overflows, setOverflows] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const clamped = overflows && !expanded

  useLayoutEffect(() => {
    const node = content.current
    if (!node) return
    const measure = () => setOverflows(node.offsetHeight > CLAMP_PX + 48)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => {
    const node = frame.current
    if (!node) return
    node.scrollTop = clamped && streaming ? node.scrollHeight : 0
  }, [clamped, streaming, plan.text])

  return (
    <>
      <div
        ref={frame}
        data-clamped={clamped ? (streaming ? "tail" : "head") : undefined}
        className="plan-frame overflow-hidden"
        style={clamped ? { maxHeight: CLAMP_PX } : undefined}
      >
        <div ref={content} className="px-5 pt-4 pb-5">
          <Prose text={plan.text} streaming={streaming} />
        </div>
      </div>
      {overflows && !streaming ? (
        <div className={cn("flex items-center justify-center gap-1 px-3 pb-2.5", clamped && "-mt-9 relative")}>
          <Action size="xs" tone="quiet" className="bg-card" onClick={() => setExpanded(!expanded)}>
            <ChevronDownIcon className={cn("transition-transform", expanded && "rotate-180")} />
            {expanded ? "Show less" : "Show full plan"}
          </Action>
          <Action size="xs" tone="quiet" className="bg-card" onClick={onOpen}>
            <Maximize2Icon />
            Open in a tab
          </Action>
        </div>
      ) : null}
    </>
  )
}
