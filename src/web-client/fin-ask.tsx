import { useEffect, useState } from "react"
import { CheckIcon, XIcon } from "lucide-react"
import { FIN_WORD } from "@mako/host/contracts/agents"
import { approvalWords, askWords } from "@mako/host/contracts/children"
import { answerFin, type FinAnswer, type PersonAsk } from "@/state/fin-asks"
import { useLimitContinue } from "@/state/limit-continue"
import { WebHarnessIcon } from "./harness-icon"
import { LiveMark } from "@/components/ui/live-mark"
import { noteAnswered } from "./install"

/**
 * In an Apex's dock, where its own ask would be: what one of its Fins asks the person. Its options are rows a thumb's
 * size, the one it recommends filled; words typed in the composer answer it too, so a word from the phone is enough.
 * The answer is the person's own, and reaches the Fin as its next step. In the Inbox (`from`, its Apex's name) the same
 * card sits in the page, the Apex named before the Fin.
 */
export function FinAskCard({ apex, ask, more, answerTyped, from }: { apex: string; ask: PersonAsk; more: number; answerTyped: (answer: ((text: string) => boolean) | null) => void; from?: string }) {
  const [sent, setSent] = useState<FinAnswer | undefined>(undefined)
  const send = (answer: FinAnswer) => {
    if (sent) return
    setSent(answer)
    noteAnswered()
    void answerFin(apex, ask, answer).then((answered) => {
      if (!answered) setSent(undefined)
    })
  }
  const approval = ask.ask.kind === "approval"
  useEffect(() => {
    if (approval) return
    answerTyped((text) => {
      if (sent) return false
      send({ answer: text })
      return true
    })
    return () => answerTyped(null)
  })
  const options = ask.ask.options ?? []
  return (
    <div className="web-ask" data-ask="fin" data-fin-ask={ask.ask.kind} data-fin={ask.fin} data-in-inbox={from ? true : undefined}>
      <div className="web-ask-body" aria-busy={sent ? true : undefined} data-busy={sent ? true : undefined}>
        <p className="web-ask-asker flex items-center gap-1.5">
          <LiveMark kind="fin" state="needs" size={18}>
            <WebHarnessIcon harness={ask.harness} />
          </LiveMark>
          <span className="min-w-0 truncate">{from ? `${from} › ${ask.title}` : `${ask.title} asks`}</span>
          {more ? <span className="shrink-0 text-faint">· {more === 1 ? `1 more ${FIN_WORD} asks` : `${more} more ${FIN_WORD}s ask`}</span> : null}
        </p>
        <p className="web-ask-title">
          <span className="min-w-0 break-words">{askWords(ask)}</span>
        </p>
        {ask.ask.action ? (
          <div className="web-ask-scroll">
            <p className="web-ask-hint">{ask.ask.action}</p>
          </div>
        ) : null}
        <div className="web-ask-options" role="group" aria-label="Answers">
          {approval ? (
            <>
              <button type="button" data-fin-answer="allow" data-primary disabled={Boolean(sent)} data-chosen={sent?.allow === true || undefined} onClick={() => send({ allow: true })} className="web-ask-option">
                <CheckIcon className="size-4 shrink-0" />
                {approvalWords(ask.ask).allow}
              </button>
              <button type="button" data-fin-answer="refuse" data-refuse={!ask.ask.named || undefined} disabled={Boolean(sent)} data-chosen={sent?.allow === false || undefined} onClick={() => send({ allow: false })} className="web-ask-option">
                <XIcon className="size-4 shrink-0" />
                {approvalWords(ask.ask).refuse}
              </button>
            </>
          ) : (
            options.map((option, index) => (
              <button
                key={`${index}:${option.label}`}
                type="button"
                data-fin-answer={index}
                data-primary={index === ask.ask.recommended || undefined}
                data-chosen={sent?.option === index || undefined}
                disabled={Boolean(sent)}
                onClick={() => send({ option: index })}
                className="web-ask-option web-ask-choice"
              >
                <span className="min-w-0 flex-1 text-left">
                  <span className="block">{option.label}</span>
                  {option.detail ? <span className="block text-label opacity-70">{option.detail}</span> : null}
                </span>
                {index === ask.ask.recommended ? <span className="shrink-0 text-label opacity-70">Recommended</span> : null}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

/** In a Thread's dock, where an ask would be: the one offer of a Thread a limit holds (`useLimitContinue`). */
export function LimitContinueCard() {
  const offer = useLimitContinue()
  if (!offer) return null
  return (
    <div className="web-ask" data-ask="limit" data-limit-continue={offer.to}>
      <div className="web-ask-body" aria-busy={offer.busy || undefined} data-busy={offer.busy || undefined}>
        <p className="web-ask-title">
          <span className="min-w-0 break-words">{offer.to} can take this</span>
        </p>
        <div className="web-ask-options" data-row role="group" aria-label="Answers">
          <button type="button" className="web-ask-option" data-primary disabled={offer.busy} onClick={offer.go}>Continue on {offer.to}</button>
          <button type="button" className="web-ask-option" onClick={offer.notNow}>Not now</button>
        </div>
      </div>
    </div>
  )
}
