import { CheckIcon, CircleDotIcon, XIcon } from "lucide-react"
import type { ToolStep, ToolSteps } from "@mako/host/contracts/tool-steps"

function stepWords(step: ToolStep): string {
  return step.times ? `${step.call} ×${step.times}` : step.call
}

/**
 * The step a running program is on, and how many calls it made, beside its row's words: "· activate e12 · 7 calls".
 * Inline words in the row's one line, so it stays one line, and it changes only as the frames do.
 */
export function RunningStep({ steps }: { steps: ToolSteps }) {
  const current = steps.steps.findLast((step) => step.phase === "running") ?? steps.steps.at(-1)
  return (
    <span className="min-w-0 shrink truncate text-faint" data-tool-step>
      {current ? ` · ${stepWords(current)}` : null}
      {` · ${steps.total} ${steps.total === 1 ? "call" : "calls"}`}
    </span>
  )
}

/** The running program's newest steps, oldest first, each with where it stands, in its row's body. */
export function StepList({ steps }: { steps: ToolSteps }) {
  const earlier = steps.total - steps.steps.reduce((sum, step) => sum + (step.times ?? 1), 0)
  return (
    <ol className="space-y-0.5 text-ui" data-tool-steps>
      {earlier > 0 ? <li className="pl-5 text-faint">{earlier} earlier {earlier === 1 ? "call" : "calls"}</li> : null}
      {steps.steps.map((step, index) => (
        <li key={index} className="flex min-w-0 items-center gap-2">
          {step.phase === "running" ? (
            <CircleDotIcon className="size-3 shrink-0 text-foreground" />
          ) : step.phase === "failed" ? (
            <XIcon className="size-3 shrink-0 text-negative" />
          ) : (
            <CheckIcon className="size-3 shrink-0 text-faint" />
          )}
          <span className="sr-only">{step.phase}: </span>
          <span className={step.phase === "running" ? "min-w-0 truncate font-mono text-label" : "min-w-0 truncate font-mono text-label text-muted-foreground"}>
            {stepWords(step)}
          </span>
        </li>
      ))}
    </ol>
  )
}
