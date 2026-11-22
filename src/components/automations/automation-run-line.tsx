import { useEffect } from "react"
import { WorkflowIcon } from "lucide-react"
import { causeWords, localTime, nextRunOf, nextRunTitle, whenAheadIn } from "@/lib/automation-words"
import { activeAcp, useAcp } from "@/state/acp"
import { automations, automationView, useAutomations } from "@/state/automations"
import { showAutomation } from "@/state/automations-view"
import { localWords } from "@mako/protocol/computer-words"

/**
 * Over a Thread an automation started: "Run of Nightly triage · <what started it> · next tomorrow 7:00", the
 * automation a press away. The runs this window heard of answer at once (`byConversation`); any other Thread is asked
 * of the host once (`mako:automations-run-of`), however old its run.
 */
export function AutomationRunLine() {
  const key = useAcp((state) => activeAcp(state)?.key)
  const heard = useAutomations((state) => (key ? state.byConversation[key] : undefined))
  const asked = useAutomations((state) => (key ? state.runOf[key] : undefined))
  useEffect(() => {
    if (key && !heard) void automations.runOf(key)
  }, [key, heard])
  const run = heard ? { project: heard.project, id: heard.automation } : asked ? { project: asked.project, id: asked.id } : undefined
  const view = useAutomations((state) => (run ? automationView(state, run.project, run.id) : undefined))
  if (!run) return null
  const name = view?.definition.name ?? asked?.name ?? run.id
  const next = view ? nextRunOf(view) : undefined
  const local = next ? localTime(next.at, next.zone) : undefined
  return (
    <nav aria-label="Automation" data-automation-run-line={run.id} className="flex h-8 shrink-0 items-center gap-2 px-3 text-label whitespace-nowrap text-faint">
      <button
        type="button"
        data-automation-run-link
        onClick={() => showAutomation(run.project, run.id)}
        title={`Open ${name} in Automations`}
        className="pressable flex h-6 min-w-0 items-center gap-1.5 px-1.5 text-muted-foreground hover:bg-fill-hover hover:text-foreground"
      >
        <WorkflowIcon aria-hidden className="size-3 shrink-0" />
        <span className="truncate">
          Run of <span className="font-medium text-foreground">{name}</span>
        </span>
      </button>
      {heard ? <span className="min-w-0 truncate">{causeWords(heard.cause)}</span> : null}
      {next ? (
        <>
          {heard ? <span aria-hidden>·</span> : null}
          <span className="shrink-0 tabular" title={nextRunTitle(next)}>
            next {whenAheadIn(next.at, next.zone)}
            {local ? ` (${local})` : ""}
          </span>
        </>
      ) : view && !view.local.enabled ? (
        <>
          {heard ? <span aria-hidden>·</span> : null}
          <span className="shrink-0">{localWords("off on this Mac")}</span>
        </>
      ) : null}
    </nav>
  )
}
