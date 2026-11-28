import type { AutomationProposal, AutomationView } from "@mako/host/contracts/automations"
import { runLine, runStatus, standingNote, PROPOSAL_CHANGE_WORDS } from "@/lib/automation-words"
import { automations, openRunThread } from "@/state/automations"
import { editAutomation, showAutomation } from "@/state/automations-view"

/** What an automation waits on the person for, in a line, and the one thing that fixes it. */
export interface AutomationFix {
  text: string
  tone: "negative" | "attention" | "caution"
  action: { kind: "review" | "open" | "turn-on" | "open-thread" | "run" | "edit"; label: string; run: () => void }
}

/**
 * Why an automation needs the person, if it does: a proposal to decide, a registration the cloud refused, a pause
 * after failures, a failed or blocked last run, an issue in its definition. Each with the one action that fixes it;
 * `review` opens its pending proposals where it's drawn. Nothing else is said on its row: the rest is its page's.
 */
export function automationFix(view: AutomationView, proposals: readonly AutomationProposal[], review: () => void): AutomationFix | undefined {
  const { project } = view
  const { id } = view.definition
  const pending = proposals.filter((proposal) => proposal.status === "pending")
  if (pending.length)
    return { text: pending.length === 1 ? PROPOSAL_CHANGE_WORDS[pending[0]!.change] : `${pending.length} changes proposed`, tone: "attention", action: { kind: "review", label: "Review proposal", run: review } }
  if (view.local.cloudIssue) return { text: standingNote(view)?.text ?? view.local.cloudIssue, tone: "negative", action: { kind: "open", label: "Open", run: () => showAutomation(project, id) } }
  if (view.standing === "paused" && view.local.paused) return { text: view.local.paused.reason, tone: "caution", action: { kind: "turn-on", label: "Turn on", run: () => void automations.setEnabled(project, id, true) } }
  const last = view.lastRun
  if (last && (last.status === "failed" || last.status === "failed-to-start"))
    return {
      text: last.why ?? "Its last run failed",
      tone: "negative",
      action: last.thread ? { kind: "open-thread", label: "Open its Thread", run: () => void openRunThread(last) } : { kind: "run", label: "Run now", run: () => void automations.runNow(project, id) },
    }
  if (last?.status === "completed" && last.result && last.result.status !== "done")
    return {
      text: runLine(last) ?? runStatus(last).label,
      tone: last.result.status === "needs-input" ? "attention" : "caution",
      action: last.thread ? { kind: "open-thread", label: "Open its Thread", run: () => void openRunThread(last) } : { kind: "open", label: "Open", run: () => showAutomation(project, id) },
    }
  if (view.issues.length) return { text: view.issues.join(" "), tone: "caution", action: { kind: "edit", label: "Edit", run: () => editAutomation(project, id) } }
  return undefined
}
