import { useHarnessIdentity } from "@/lib/harness-label"
import { useEffect, useState } from "react"
import { ChevronDownIcon, ClipboardListIcon, CornerRightDownIcon, HammerIcon, SendIcon } from "lucide-react"
import { openPlanTab, usePlanBuilding } from "@/components/transcript/plan-state"
import { Action, IconAction, Keys } from "@/components/ui/kit"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { harnessLabel } from "@/lib/harness-label"
import { proposedPlanTitle } from "@/lib/proposed-plan"
import { acp } from "@/state/acp"
import { keepPlanning, planRejection, type PlanDecision } from "@/state/plan-mode"

/** ⌘⇧↵ builds; ⌘↵ already belongs to the composer's send. */
const BUILD_PLAN_KEYS = ["⌘", "⇧", "↵"]

/**
 * The decision a finished plan waits on, said where the answer is written:
 * build it, hand it to a new session, or type what to change and send.
 */
export function PlanDecisionBar({ decision }: { decision: PlanDecision }) {
  useHarnessIdentity()
  const { plan, source, approval } = decision
  const { building, start } = usePlanBuilding(source, plan)
  const [declining, setDeclining] = useState(false)
  const agent = harnessLabel(decision.harness ?? "") || "the agent"
  const reject = approval ? planRejection(approval) : undefined
  const alternatives = approval?.options.filter(
    (option) => option.kind?.startsWith("allow") && option.optionId !== approval.implementsPlan?.approve
  ) ?? []

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || !event.shiftKey || !(event.metaKey || event.ctrlKey) || event.altKey || event.repeat) return
      event.preventDefault()
      start("here")
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [start])

  return (
    <div
      role="region"
      aria-label="Plan waiting for a decision"
      data-plan-decision={approval ? "approval" : "build"}
      className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-hairline bg-raised/40 px-4 py-2"
    >
      <div className="flex min-w-0 flex-1 basis-72 items-center gap-1.5 text-ui">
        <IconAction label="Open the plan in a tab" size="xs" onClick={() => openPlanTab(source, plan)}>
          <ClipboardListIcon />
        </IconAction>
        <p className="min-w-0 truncate text-muted-foreground" title={proposedPlanTitle(plan.text)}>
          <span className="text-foreground">{approval ? "Approve the plan" : "Build the plan"}</span>
          {` or tell ${agent} what to change`}
          <CornerRightDownIcon aria-hidden className="ml-1 inline size-3.5 align-[-2px] text-faint" />
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {reject ? (
          <Action
            size="sm"
            disabled={building !== null || declining}
            onClick={() => {
              setDeclining(true)
              void keepPlanning(decision).finally(() => setDeclining(false))
            }}
          >
            {reject.name}
          </Action>
        ) : null}
        <Action size="sm" tone="outline" disabled={building !== null} onClick={() => start("new")}>
          <SendIcon />
          {building === "new" ? "Opening…" : "Build in new session"}
        </Action>
        <div className="flex items-center">
          <Action
            size="sm"
            tone="solid"
            disabled={building !== null}
            onClick={() => start("here")}
            className={alternatives.length ? "rounded-r-none" : undefined}
          >
            <HammerIcon />
            {building === "here" ? "Building…" : approval ? "Approve and build" : "Build"}
            <Keys keys={BUILD_PLAN_KEYS} inverted />
          </Action>
          {alternatives.length ? (
            <Popover>
              <PopoverTrigger asChild>
                <Action size="sm" tone="solid" aria-label="Other ways to approve" className="rounded-l-none border-l border-background/20 px-1.5">
                  <ChevronDownIcon />
                </Action>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-72 p-1">
                {alternatives.map((option) => (
                  <button
                    key={option.optionId}
                    type="button"
                    className="pressable block w-full rounded px-2 py-1.5 text-left text-ui hover:bg-fill-hover"
                    onClick={() => acp.answerPermission(option.optionId)}
                  >
                    {option.name}
                  </button>
                ))}
              </PopoverContent>
            </Popover>
          ) : null}
        </div>
      </div>
    </div>
  )
}
