import { WorkflowIcon } from "lucide-react"
import { causeWords, localTime, nextRunOf, nextRunTitle, whenAheadIn } from "@/lib/automation-words"
import { activeAcp, useAcp } from "@/state/acp"
import { automationView, useAutomations } from "@/state/automations"
import { showAutomation } from "@/state/automations-view"

/**
 * Over a Thread an automation started: "Run of Nightly triage · next tomorrow 9:00", what started this run, and the
 * automation a press away. Drawn from the runs this window heard of (`byConversation`), so it needs nothing of the
 * Thread itself.
 */
export function AutomationRunLine() {
  const key = useAcp((state) => activeAcp(state)?.key)
  const run = useAutomations((state) => (key ? state.byConversation[key] : undefined))
  const view = useAutomations((state) => (run ? automationView(state, run.project, run.automation) : undefined))
  if (!run) return null
  const name = view?.definition.name ?? run.automation
  const next = view ? nextRunOf(view) : undefined
  return (
    <nav aria-label="Automation" data-automation-run-line={run.automation} className="flex h-8 shrink-0 items-center gap-2 px-3 text-label whitespace-nowrap text-faint">
      <button
        type="button"
        data-automation-run-link
        onClick={() => showAutomation(run.project, run.automation)}
        title={`Open ${name} in Automations`}
        className="pressable flex h-6 min-w-0 items-center gap-1.5 px-1.5 text-muted-foreground hover:bg-fill-hover hover:text-foreground"
      >
        <WorkflowIcon aria-hidden className="size-3 shrink-0" />
        <span className="truncate">
          Run of <span className="font-medium text-foreground">{name}</span>
        </span>
      </button>
      <span className="min-w-0 truncate">{causeWords(run.cause)}</span>
      {next ? (
        <>
          <span aria-hidden>·</span>
          <span className="shrink-0 tabular" title={nextRunTitle(next)}>
            next {whenAheadIn(next.at, next.zone)}
            {localTime(next.at, next.zone) ? ` (${localTime(next.at, next.zone)})` : ""}
          </span>
        </>
      ) : view && !view.local.enabled ? (
        <>
          <span aria-hidden>·</span>
          <span className="shrink-0">off on this Mac</span>
        </>
      ) : null}
    </nav>
  )
}
