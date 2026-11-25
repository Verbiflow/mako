import { useEffect, useState } from "react"
import { CheckIcon, ChevronRightIcon, XIcon } from "lucide-react"
import { FIN_WORD } from "@mako/host/contracts/agents"
import { approvalWords, askWords } from "@mako/host/contracts/children"
import { answerFin, type FinAnswer, type PersonAsk } from "@/state/fin-asks"
export { LimitContinueCard } from "./limit-wait"
import { WebHarnessIcon } from "./harness-icon"
import { LiveMark } from "@/components/ui/live-mark"
import { ApexMark } from "@/components/ui/apex-mark"
import { FinTypedAnswer } from "@/components/composer/fin-typed-answer"
import { ASK_TOUCH } from "@/lib/ask-card"
import { cn } from "@/lib/utils"
import { webHarnessLabel } from "./labels"
import { noteAnswered } from "./install"

/**
 * In an Apex's dock, where its own ask would be: what one of its Fins asks the person, in the desk's Inbox card's
 * anatomy (`inbox-view.tsx`): the Fin's mark, where it is and its harness, the question, and its answers in a row, the
 * one it recommends filled, each a thumb's height. Words typed in the composer answer it too, so a word from the phone
 * is enough. The answer is the person's own, and reaches the Fin as its next step. In the Inbox (`from`, its Apex's
 * name) the same card sits in the page, the Apex named before the Fin, with its own field and Open, as on the desk.
 */
export function FinAskCard(props: Parameters<typeof AnswerableFinAskCard>[0]) {
  if (props.ask.limit?.waiting) return props.from ? <div className="web-ask flex flex-col gap-2 px-3.5 py-3" data-limit-inbox={props.ask.ask.id}>
    <p className="text-ui text-foreground">{props.ask.question}</p>
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <span className="text-label text-muted-foreground">Continues automatically. Open the Thread to use another account or harness now.</span>
      <span className="flex-1" />
      {props.onOpen ? <button type="button" data-fin-open className={cn("pressable flex items-center px-1.5 py-1 text-label text-faint", ASK_TOUCH)} onClick={props.onOpen}>Open</button> : null}
    </div>
  </div> : null
  return <AnswerableFinAskCard {...props} />
}

function AnswerableFinAskCard({ apex, ask, more, answerTyped, from, onOpen }: { apex: string; ask: PersonAsk; more: number; answerTyped: (answer: ((text: string) => boolean) | null) => void; from?: string; onOpen?: () => void }) {
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
  const busy = Boolean(sent)
  return (
    <div className="web-ask" data-ask="fin" data-fin-ask={ask.ask.kind} data-fin={ask.fin} data-in-inbox={from ? true : undefined}>
      <div className="flex flex-col gap-2 px-3.5 py-3" aria-busy={busy || undefined} data-busy={busy || undefined}>
        <div data-ask-head className="flex h-5 min-w-0 items-center gap-2">
          <LiveMark kind="fin" state="needs" size={18}>
            <WebHarnessIcon harness={ask.harness} />
          </LiveMark>
          <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden text-label text-faint">
            {from ? (
              <>
                <ApexMark className="size-3 shrink-0" />
                <span className="min-w-0 shrink truncate">{from}</span>
                <ChevronRightIcon aria-hidden className="size-3 shrink-0 opacity-60" />
              </>
            ) : null}
            <span className="min-w-0 flex-1 truncate font-medium text-foreground/90">{ask.title}</span>
            <span aria-hidden className="shrink-0 opacity-60">·</span>
            <span className="shrink-0">{webHarnessLabel(ask.harness)}</span>
          </span>
          {more ? <span className="shrink-0 text-label text-faint">{more === 1 ? `1 more ${FIN_WORD} asks` : `${more} more ${FIN_WORD}s ask`}</span> : null}
        </div>
        <p data-ask-question className="pl-7 text-ui break-words text-foreground">{askWords(ask)}</p>
        {ask.ask.action ? <p className="-mt-1 max-h-40 overflow-y-auto pl-7 text-label text-muted-foreground">{ask.ask.action}</p> : null}
        <div data-ask-answers className="flex min-w-0 flex-wrap items-center gap-1.5 pl-7" role="group" aria-label="Answers">
          {ask.ask.review ? (
            // An automation proposal: approved only where its change is shown, in Automations on the Mac.
            <>
              <p data-fin-review className="w-full text-label text-muted-foreground">Approve it in Automations or the Inbox on your Mac, where its change is shown.</p>
              <button type="button" data-fin-answer="refuse" disabled={busy} data-chosen={sent?.allow === false || undefined} onClick={() => send({ allow: false })} className={cn(ASK_BUTTON, ASK_TOUCH, ASK_QUIET)}>
                <XIcon className="size-3" />
                Decline
              </button>
            </>
          ) : approval ? (
            <>
              <button type="button" data-fin-answer="allow" data-primary disabled={busy} data-chosen={sent?.allow === true || undefined} onClick={() => send({ allow: true })} className={cn(ASK_BUTTON, ASK_TOUCH, ASK_PRIMARY)}>
                <CheckIcon className="size-3" />
                {approvalWords(ask.ask).allow}
              </button>
              <button type="button" data-fin-answer="refuse" disabled={busy} data-chosen={sent?.allow === false || undefined} onClick={() => send({ allow: false })} className={cn(ASK_BUTTON, ASK_TOUCH, ASK_QUIET)}>
                <XIcon className="size-3" />
                {approvalWords(ask.ask).refuse}
              </button>
            </>
          ) : (
            options.map((option, index) => {
              const recommended = index === ask.ask.recommended
              return (
                <button
                  key={`${index}:${option.label}`}
                  type="button"
                  data-fin-answer={index}
                  data-primary={recommended || undefined}
                  data-chosen={sent?.option === index || undefined}
                  disabled={busy}
                  onClick={() => send({ option: index })}
                  className={cn(ASK_BUTTON, ASK_TOUCH, recommended ? ASK_PRIMARY : ASK_QUIET, option.detail && "h-auto min-h-11 flex-wrap py-2 text-left [@media(pointer:coarse)]:h-auto")}
                >
                  {option.label}
                  {recommended ? <span className="opacity-60">Recommended</span> : null}
                  {/* The desk says an option's detail in its tooltip; a finger has none, so it's under the label. */}
                  {option.detail ? <span className="w-full opacity-70">{option.detail}</span> : null}
                </button>
              )
            })
          )}
          {/* In the Inbox there's no dock composer under the card: its own field, as the desk's Inbox has. */}
          {from && !approval && !ask.ask.review ? <FinTypedAnswer title={ask.title} options={options.length} disabled={busy} onAnswer={(words) => send({ answer: words })} className="min-w-40" /> : null}
          {from && onOpen ? (
            <>
              <span className="flex-1" />
              <button type="button" data-fin-open onClick={onOpen} className={cn("pressable flex items-center px-1.5 py-1 text-label text-faint", ASK_TOUCH)}>
                Open
              </button>
            </>
          ) : null}
        </div>
      </div>
    </div>
  )
}

/**
 * The desk's Inbox answers (`inbox-view.tsx`): the one to take filled with the text colour, the rest quiet, Refuse as
 * neutral as any other answer; `ASK_TOUCH` makes each a thumb's 44 px under a finger.
 */
const ASK_BUTTON = "pressable flex h-7 items-center gap-1.5 px-2.5 text-label transition-colors disabled:opacity-50"
const ASK_PRIMARY = "bg-foreground text-background data-[chosen]:opacity-100"
const ASK_QUIET = "bg-fill-hover text-foreground"
