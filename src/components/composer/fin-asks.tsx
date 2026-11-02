import { useState } from "react"
import { CheckIcon, XIcon } from "lucide-react"
import { childWord } from "@mako/host/contracts/children"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { cn } from "@/lib/utils"
import { activeAcp, useAcp } from "@/state/acp"
import { useThreadAsks } from "@/state/apex-fins"
import { answerFin, type FinAnswer, type PersonAsk } from "@/state/fin-asks"

/**
 * Over an Apex's composer: what its Fins ask the person, each answered here
 * in a click or a few words, as the person's own answer. The Fin goes on as
 * its next step, and the card leaves every device once the Apex's host
 * hears the answer.
 */
export function FinAsks() {
  const key = useAcp((state) => activeAcp(state)?.key)
  const thread = useAcp((state) => activeAcp(state)?.threadId)
  const asks = useThreadAsks(thread)
  if (!key || !asks.length) return null
  return (
    <div data-fin-asks={asks.length} className="flex shrink-0 flex-col gap-2.5 border-t border-hairline bg-surface/60 px-4 py-2.5">
      {asks.map((ask) => (
        <FinAskRow key={`${ask.fin}:${ask.ask.id}`} apex={key} ask={ask} />
      ))}
    </div>
  )
}

function FinAskRow({ apex, ask }: { apex: string; ask: PersonAsk }) {
  const [sending, setSending] = useState(false)
  const [words, setWords] = useState("")
  const send = (answer: FinAnswer) => {
    if (sending) return
    setSending(true)
    void answerFin(apex, ask, answer).then((answered) => {
      if (!answered) setSending(false)
    })
  }
  const approval = ask.ask.kind === "approval"
  const options = ask.ask.options ?? []
  return (
    <div data-fin-ask={ask.ask.kind} data-fin={ask.fin} aria-busy={sending || undefined} className="flex flex-col gap-1.5">
      <p className="flex min-w-0 items-center gap-1.5 text-label">
        <HarnessIcon harness={ask.harness} className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate font-medium text-foreground">{ask.title}</span>
        <span className="shrink-0 text-caution">{childWord({ kind: "blocked", question: ask.question, on: approval ? "approval" : "person" })}</span>
      </p>
      <p className="max-w-prose text-ui text-foreground/90">{ask.question}</p>
      {ask.ask.action ? <p className="max-w-prose text-label text-muted-foreground">{ask.ask.action}</p> : null}
      <div className="flex flex-wrap items-center gap-1.5">
        {approval ? (
          <>
            <button type="button" data-fin-answer="allow" disabled={sending} onClick={() => send({ allow: true })} className="pressable flex items-center gap-1.5 rounded-md border border-hairline bg-foreground px-2 py-1 text-label text-background hover:opacity-90 disabled:opacity-50">
              <CheckIcon className="size-3" />
              Allow once
            </button>
            <button type="button" data-fin-answer="refuse" disabled={sending} onClick={() => send({ allow: false })} className="pressable flex items-center gap-1.5 rounded-md border border-hairline px-2 py-1 text-label text-negative/80 hover:bg-negative/10 hover:text-negative disabled:opacity-50">
              <XIcon className="size-3" />
              Refuse
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
                data-recommended={recommended || undefined}
                title={option.detail}
                disabled={sending}
                onClick={() => send({ option: index })}
                className={cn(
                  "pressable flex items-center gap-1.5 rounded-md border px-2 py-1 text-label transition-colors disabled:opacity-50",
                  recommended ? "border-hairline bg-foreground text-background hover:opacity-90" : "border-hairline text-foreground hover:bg-fill-hover"
                )}
              >
                {option.label}
                {recommended ? <span className="opacity-70">· recommended</span> : null}
              </button>
            )
          })
        )}
        {approval ? null : (
          <form
            className="flex min-w-48 flex-1"
            onSubmit={(event) => {
              event.preventDefault()
              if (words.trim()) send({ answer: words.trim() })
            }}
          >
            <input
              value={words}
              onChange={(event) => setWords(event.target.value)}
              disabled={sending}
              aria-label={`Answer ${ask.title} in your own words`}
              placeholder={options.length ? "Or answer in your own words" : "Your answer"}
              className="h-7 w-full rounded-md border border-hairline bg-transparent px-2 text-label text-foreground placeholder:text-faint focus:border-foreground/30 focus:outline-none"
            />
          </form>
        )}
      </div>
    </div>
  )
}
