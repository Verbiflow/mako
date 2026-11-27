import { useState } from "react"
import { FinTypedAnswer } from "@/components/composer/fin-typed-answer"
import { cn } from "@/lib/utils"
import { answerPlan } from "@/state/apexes"

/**
 * A question the Apex's plan asks the person, answered where it stands: its offered answers one tap each, the first
 * filled, and their own words beside them (Enter sends). The answer goes to the Apex as theirs, and the line leaves
 * Needs you once the host has it.
 */
export function PlanQuestionAnswers({ thread, apexName, section, index, options, compact = false, className }: {
  thread: string
  apexName: string
  section: string
  index: number
  options: readonly string[]
  compact?: boolean
  className?: string
}) {
  const [sent, setSent] = useState<string | null>(null)
  const send = async (answer: string) => {
    setSent(answer)
    if (!(await answerPlan(thread, section, index, answer))) setSent(null)
  }
  return (
    <div data-plan-answers className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {options.map((option, at) => (
        <button
          key={option}
          type="button"
          data-plan-answer={option}
          disabled={sent !== null}
          data-chosen={sent === option || undefined}
          onClick={() => void send(option)}
          className={cn(
            "pressable flex items-center px-2.5 text-label font-medium disabled:opacity-50",
            compact ? "h-9" : "h-7",
            at === 0 ? "bg-foreground text-background hover:bg-foreground/90" : "bg-raised text-foreground/85 hover:bg-fill-selected"
          )}
        >
          {option}
        </button>
      ))}
      <FinTypedAnswer title={apexName} options={options.length} disabled={sent !== null} onAnswer={(words) => void send(words)} />
    </div>
  )
}
