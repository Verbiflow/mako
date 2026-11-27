import { CheckIcon } from "lucide-react"
import { ApexMark } from "@/components/ui/apex-mark"
import { PlanQuestionAnswers } from "@/components/apexes/plan-question"
import { planQuestion } from "@mako/host/contracts/apexes"
import { acp } from "@/state/acp"
import { checkPlan, useApexPlanAsks, type PlanAsk } from "@/state/apexes"
import { inboxView } from "@/state/inbox"

/**
 * What the person's Apexes wait on them for that no Fin asks: the lines of each plan under "Waiting on you". Done
 * here checks the line off, and it leaves every Apex's digest at once. Fins' own questions are the Inbox's asks.
 */
export function ApexInboxSection({ spaced }: { spaced: boolean }) {
  const asks = useApexPlanAsks()
  if (!asks.length) return null
  return <PlanAsks asks={asks} spaced={spaced} />
}

function PlanAsks({ asks, spaced }: { asks: PlanAsk[]; spaced: boolean }) {
  return (
    <section aria-label="Your Apexes wait on you" data-inbox-section="apexes" className={spaced ? "pt-5" : undefined}>
      <h2 className="flex h-7 items-center text-label font-medium text-attention">Your Apexes wait on you</h2>
      <ul className="flex flex-col gap-2">
        {asks.map((ask) => {
          const asked = planQuestion(ask.text)
          return (
          <li key={`${ask.apex.thread}:${ask.section}:${ask.index}`} data-inbox-plan={ask.apex.name} data-inbox-plan-kind={asked ? "question" : "to-do"} className="flex flex-col gap-2 bg-raised px-3 py-2.5">
            <span className="flex min-w-0 items-center gap-1.5 text-label text-faint">
              <ApexMark className="size-3 shrink-0" />
              <span className="min-w-0 truncate font-medium text-foreground/90">{ask.apex.name}</span>
              <span aria-hidden className="opacity-60">·</span>
              <span>{asked ? "asks you" : "Your to-do"}</span>
            </span>
            <span className="text-ui text-foreground">{asked?.question ?? ask.text}</span>
            {asked ? <PlanQuestionAnswers thread={ask.apex.thread} apexName={ask.apex.name} section={ask.section} index={ask.index} options={asked.options} /> : null}
            <span className="flex items-center gap-1.5">
              {asked ? null : (
                <button type="button" data-inbox-plan-done onClick={() => void checkPlan(ask.apex.thread, ask.section, ask.index, true)} className="pressable flex h-7 items-center gap-1.5 bg-foreground px-2.5 text-label text-background hover:opacity-90">
                  <CheckIcon className="size-3" />Mark done
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  if (!ask.apex.conversation) return
                  inboxView.close()
                  acp.open(ask.apex.conversation)
                }}
                className="pressable flex h-7 items-center px-2.5 text-label text-foreground hover:bg-fill-hover"
              >
                Open {ask.apex.name}
              </button>
            </span>
          </li>
          )
        })}
      </ul>
    </section>
  )
}
