import { CheckIcon, XIcon } from "lucide-react"
import { approvalWords } from "@mako/host/contracts/children"
import type { FinAsk, NativeAgent } from "@mako/host/contracts/native-agents"
import { FinTypedAnswer } from "@/components/composer/fin-typed-answer"
import { cn } from "@/lib/utils"
import type { FinAnswer } from "@/state/fin-asks"

/**
 * An ask's answers as buttons, wherever a Fin's ask is drawn (the crew card, the Overview): an approval's two, or its
 * options with the recommended one first, and the person's own words (`typed`). `hint` adds who else could answer.
 */
export function FinAnswerButtons({
  agent,
  ask,
  apexTitle,
  sent,
  send,
  compact,
  hint,
  typed = true,
  className,
}: {
  agent: NativeAgent
  ask: FinAsk
  apexTitle: string
  sent: FinAnswer | undefined
  send: (answer: FinAnswer) => void
  compact?: boolean
  hint?: boolean
  /** Whether the person's own words are offered beside the options; a narrow list leaves them to the Fin's own page. */
  typed?: boolean
  className?: string
}) {
  const approval = ask.kind === "approval"
  const options = ask.options ?? []
  const order = options
    .map((_, index) => index)
    .sort((left, right) =>
      left === ask.recommended ? -1 : right === ask.recommended ? 1 : 0
    )
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {approval ? (
        <>
          <button
            type="button"
            data-fin-answer="allow"
            disabled={Boolean(sent)}
            data-chosen={sent?.allow === true || undefined}
            onClick={() => send({ allow: true })}
            className={cn(
              "pressable flex items-center gap-1.5 bg-foreground px-2.5 text-label font-medium text-background hover:bg-foreground/90 disabled:opacity-50",
              compact ? "h-9" : "h-7"
            )}
          >
            <CheckIcon className="size-3.5" />
            {approvalWords(ask).allow}
          </button>
          <button
            type="button"
            data-fin-answer="refuse"
            disabled={Boolean(sent)}
            data-chosen={sent?.allow === false || undefined}
            onClick={() => send({ allow: false })}
            className={cn(
              "pressable flex items-center gap-1.5 bg-raised px-2.5 text-label font-medium text-foreground/85 hover:bg-fill-selected disabled:opacity-50",
              compact ? "h-9" : "h-7"
            )}
          >
            <XIcon className="size-3.5" />
            {approvalWords(ask).refuse}
          </button>
        </>
      ) : (
        order.map((index) => {
          const option = options[index]!
          const primary = index === order[0]
          return (
            <button
              key={`${index}:${option.label}`}
              type="button"
              data-fin-answer={index}
              data-recommended={index === ask.recommended || undefined}
              title={option.detail}
              disabled={Boolean(sent)}
              data-chosen={sent?.option === index || undefined}
              onClick={() => send({ option: index })}
              className={cn(
                "pressable flex items-center gap-1.5 px-2.5 text-label font-medium disabled:opacity-50",
                compact ? "h-9" : "h-7",
                primary
                  ? "bg-foreground text-background hover:bg-foreground/90"
                  : "bg-raised text-foreground/85 hover:bg-fill-selected"
              )}
            >
              {option.label}
              {index === ask.recommended ? (
                <span
                  className={cn(
                    "font-normal",
                    primary ? "text-background/70" : "text-faint"
                  )}
                >
                  Recommended
                </span>
              ) : null}
            </button>
          )
        })
      )}
      {approval || !typed ? null : (
        <FinTypedAnswer title={agent.title} options={options.length} disabled={Boolean(sent)} onAnswer={(words) => send({ answer: words })} />
      )}
      {hint ? (
        <span className="ml-auto text-label text-faint">
          {approval
            ? ask.named ? `${agent.title} waits on your answer` : `${agent.title} waits on this command`
            : `Or tell ${apexTitle}`}
        </span>
      ) : null}
    </div>
  )
}
