import { useState } from "react"
import { ChevronRightIcon } from "lucide-react"
import { AgentGroup } from "@/components/transcript/agent-group"
import { CompactPresentationContext, type CompactSteps } from "@/components/transcript/compact-presentation"
import { ToolRow } from "@/components/transcript/tool-row"
import { Shimmer } from "@/components/ui/shimmer"
import { groupAgentCalls } from "@/lib/agent-groups"
import { formatDuration } from "@/lib/format"
import { cn } from "@/lib/utils"
import { Sheet, SheetScroll } from "./sheet"
import { freshStep, stepsLine } from "./steps-words"

/**
 * A run of steps on a phone: one line, "3 steps · ran node test/payments.mjs", its newest step in the present tense and
 * sweeping while it runs, red when it failed. Tapped, the steps open in a sheet as the desk draws them, at half the
 * screen and pulled up to all of it; a step that began in the last three seconds rises in, the rest are simply there.
 */
export function PhoneSteps({ run }: { run: CompactSteps }) {
  const [open, setOpen] = useState(false)
  // Steps that began after this line was drawn, or just before, are new; a transcript opened later has none.
  const [drawnAt] = useState(() => Date.now())
  const line = stepsLine(run.calls, run.live)
  const failed = line.failed || (run.failed && !run.live)
  const newest = run.calls.at(-1)
  const fresh = newest ? freshStep(newest, drawnAt) : false
  const worked = run.worked !== undefined ? formatDuration(run.worked) : undefined
  return (
    <>
      <button
        type="button"
        data-steps-line={run.live ? "live" : failed ? "failed" : run.interrupted ? "stopped" : "done"}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className={cn("web-steps-line pressable", failed ? "text-negative" : run.interrupted ? "text-caution" : "text-muted-foreground")}
      >
        {line.count ? <span className="shrink-0">{line.count}</span> : null}
        {line.newest ? (
          <>
            {line.count ? (
              <span aria-hidden className="shrink-0 opacity-60">
                ·
              </span>
            ) : null}
            <span key={line.newest} className={cn("min-w-0 truncate", fresh && "web-steps-new", !failed && !run.interrupted && line.count && "text-faint")}>
              {line.running ? <Shimmer className="min-w-0 truncate">{line.newest}</Shimmer> : line.newest}
            </span>
          </>
        ) : null}
        <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-faint" />
      </button>
      <Sheet open={open} onDismiss={() => setOpen(false)} label="Steps" expandable>
        <h3 className="web-sheet-title flex items-baseline gap-2">
          <span>{`${run.calls.length} ${run.calls.length === 1 ? "step" : "steps"}`}</span>
          {worked ? <span className="text-label font-normal text-faint">worked {worked}</span> : run.live ? <span className="text-label font-normal text-faint">working</span> : null}
        </h3>
        <SheetScroll className="web-steps-sheet">
          {/* Inside the sheet the steps are the desk's own rows: nothing folds a second time. */}
          <CompactPresentationContext value={null}>
            {run.body ?? <StepRows calls={run.calls} provider={run.provider} />}
          </CompactPresentationContext>
        </SheetScroll>
      </Sheet>
    </>
  )
}

/** A run's calls as the desk's rows, agents started together as one group; only steps begun just now rise in. */
function StepRows({ calls, provider }: { calls: CompactSteps["calls"]; provider: string | undefined }) {
  const [now] = useState(() => Date.now())
  return (
    <div data-work-log className="flex flex-col">
      {groupAgentCalls(calls).map((item) =>
        item.kind === "agents" ? (
          <div key={item.id} className={cn(item.calls.some((call) => freshStep(call, now)) && "web-step-in")}>
            <AgentGroup calls={item.calls} provider={provider} />
          </div>
        ) : (
          <div key={item.call.id} className={cn(freshStep(item.call, now) && "web-step-in")}>
            <ToolRow call={item.call} />
          </div>
        )
      )}
    </div>
  )
}
