import { useMemo, useState } from "react"
import { CheckIcon, XIcon } from "lucide-react"
import { approvalWords, childGroup, childLine, childStateOf, childWord, DONE_NEEDS_YOU } from "@mako/host/contracts/children"
import { isLimitAsk } from "@mako/host/contracts/fin-fallback"
import { FinMark } from "@/components/stage/child-tabs"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { LiveMark } from "@/components/ui/live-mark"
import { cn } from "@/lib/utils"
import { activeAcp, useAcp } from "@/state/acp"
import { apexConversation, useApexView, useThreadAsks, useThreadChildren } from "@/state/apex-fins"
import { useOnScreen } from "@/state/thread-sessions"
import {
  scrollCrewNeedsIntoView,
  useCrewCardVisible,
} from "@/state/crew-card-view"
import { answerFin, type FinAnswer, type PersonAsk } from "@/state/fin-asks"

/**
 * One line while the crew card is scrolled away and Fins need the person:
 * their marks and the count. It brings the card's Needs you group back.
 * Nothing while the card is in view, since the asks live there. A Thread
 * with no card doesn't render this; its dock keeps the asks themselves.
 */
export function FinsNeedYou({
  thread,
  compact = false,
}: {
  thread: string | undefined
  compact?: boolean
}) {
  const visible = useCrewCardVisible(thread)
  const children = useThreadChildren(thread)
  const needs = useMemo(
    () =>
      children.filter((agent) => childGroup(childStateOf(agent)) === "needs"),
    [children]
  )
  const notice = useThreadAsks(thread).some((ask) => isLimitAsk(ask.ask.id))
  if (visible !== false || (!needs.length && !notice)) return null
  const word = !needs.length
    ? "Usage needs you"
    : needs.length === 1
      ? "1 Fin needs you"
      : `${needs.length} Fins need you`
  return (
    <div className={cn(!compact && "bg-surface/60")}>
      <button
        type="button"
        data-crew-away
        data-compact={compact || undefined}
        onClick={scrollCrewNeedsIntoView}
        className={cn(
          "pressable flex w-full items-center gap-2 text-left text-ui text-foreground",
          compact ? "min-h-11 px-3" : "px-4 py-2"
        )}
      >
        <span aria-hidden className="flex shrink-0 items-center gap-1">
          {needs.slice(0, 5).map((agent) => (
            <FinMark
              key={agent.nativeId}
              agent={agent}
              state={childStateOf(agent)}
              cut="var(--surface)"
            />
          ))}
        </span>
        <span className="min-w-0 truncate">{word}</span>
      </button>
    </div>
  )
}

/**
 * Over an Apex's composer: what its Fins ask the person, each answered here
 * in a click or a few words, as the person's own answer. The Fin goes on as
 * its next step, and the card leaves every device once the Apex's host
 * hears the answer.
 */
export function FinAsks() {
  const key = useAcp((state) => activeAcp(state)?.key)
  const thread = useAcp((state) => activeAcp(state)?.threadId)
  const card = useCrewCardVisible(thread)
  const asks = useThreadAsks(thread)
  const shown = useShownFinAsks()
  // A Fin opened in its Apex says what it waits on above its own composer: the "Needs you" that opened it answers here.
  if (shown.apex && shown.asks.length)
    return (
      <div data-fin-asks={shown.asks.length} data-own-asks className="mx-3 flex shrink-0 flex-col gap-2.5 bg-surface/60 py-2.5">
        {shown.asks.map((ask) => (
          <FinAskRow key={`${ask.fin}:${ask.ask.id}`} apex={shown.apex!} ask={ask} />
        ))}
      </div>
    )
  // One that needs the person with nothing to answer here (it waits in its own terminal, say) still says on what.
  if (shown.waits)
    return (
      <p data-own-waits className="mx-3 flex shrink-0 items-center gap-1.5 bg-surface/60 py-2.5 text-label">
        <span className="shrink-0 font-medium text-attention">Needs you</span>
        <span className="min-w-0 text-foreground">{shown.waits}</span>
      </p>
    )
  if (card !== null) return <FinsNeedYou thread={thread} />
  if (!key || !asks.length) return null
  return (
    <div data-fin-asks={asks.length} className="mx-3 flex shrink-0 flex-col gap-2.5 bg-surface/60 py-2.5">
      {asks.map((ask) => (
        <FinAskRow key={`${ask.fin}:${ask.ask.id}`} apex={key} ask={ask} />
      ))}
    </div>
  )
}

/**
 * The Fin on screen, when it's opened in its Apex's Thread: what it asks of the person, read from its Apex's roster as
 * the crew card reads it, and the Apex's conversation that answers it.
 */
function useShownFinAsks(): { apex: string | undefined; asks: readonly PersonAsk[]; waits?: string } {
  const here = useOnScreen().thread
  const open = useApexView((state) => (state.open && state.open.child === here ? state.open : null))
  const apex = useAcp((state) => (open ? apexConversation(state, open.apex)?.key : undefined))
  const asks = useThreadAsks(open?.apex)
  const children = useThreadChildren(open?.apex)
  // An approval its own conversation holds is drawn there already, by its own card above this composer.
  const approving = useAcp((state) => { const active = activeAcp(state); return Boolean(active && "permission" in active && active.permission) })
  const child = open?.child
  return useMemo(() => {
    const own = child ? asks.filter((ask) => ask.fin === child && !(approving && ask.ask.kind === "approval")) : NO_ASKS
    const agent = child ? children.find((entry) => entry.child?.thread === child) : undefined
    const state = agent ? childStateOf(agent) : undefined
    const waits = !own.length && !approving && state && childGroup(state) === "needs" ? childLine(state) : undefined
    return { apex, asks: own, ...(waits && { waits }) }
  }, [apex, asks, children, child, approving])
}

const NO_ASKS: readonly PersonAsk[] = []

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
    <div
      data-fin-ask={ask.ask.kind}
      data-fin={ask.fin}
      aria-busy={sending || undefined}
      className="flex flex-col gap-1.5"
    >
      <p className="flex min-w-0 items-center gap-1.5 text-label">
        <LiveMark kind="fin" state="needs" size={18} cut="var(--surface)">
          <HarnessIcon harness={ask.harness} />
        </LiveMark>
        <span className="min-w-0 truncate font-medium text-foreground">
          {ask.title}
        </span>
        <span className="shrink-0 text-attention">
          {ask.done
            ? DONE_NEEDS_YOU
            : childWord({
                kind: "blocked",
                question: ask.question,
                on: approval ? "approval" : "person",
              })}
        </span>
      </p>
      <p className="max-w-prose text-ui text-foreground/90">{ask.question}</p>
      {ask.ask.action ? (
        <p className="max-w-prose text-label text-muted-foreground">
          {ask.ask.action}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-1.5">
        {approval ? (
          <>
            <button
              type="button"
              data-fin-answer="allow"
              disabled={sending}
              onClick={() => send({ allow: true })}
              className="pressable flex items-center gap-1.5 border border-hairline bg-foreground px-2 py-1 text-label text-background hover:opacity-90 disabled:opacity-50"
            >
              <CheckIcon className="size-3" />
              {approvalWords(ask.ask).allow}
            </button>
            <button
              type="button"
              data-fin-answer="refuse"
              disabled={sending}
              onClick={() => send({ allow: false })}
              className={cn(
                "pressable flex items-center gap-1.5 border border-hairline px-2 py-1 text-label disabled:opacity-50",
                ask.ask.named ? "text-foreground hover:bg-fill-hover" : "text-negative/80 hover:bg-negative/10 hover:text-negative"
              )}
            >
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
                data-recommended={recommended || undefined}
                title={option.detail}
                disabled={sending}
                onClick={() => send({ option: index })}
                className={cn(
                  "pressable flex items-center gap-1.5 border px-2 py-1 text-label transition-colors disabled:opacity-50",
                  recommended
                    ? "border-hairline bg-foreground text-background hover:opacity-90"
                    : "border-hairline text-foreground hover:bg-fill-hover"
                )}
              >
                {option.label}
                {recommended ? (
                  <span className="opacity-70">· recommended</span>
                ) : null}
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
              placeholder={
                options.length ? "Or answer in your own words" : "Your answer"
              }
              className="h-7 w-full border border-hairline bg-transparent px-2 text-label text-foreground placeholder:text-faint focus:border-foreground/30 focus:outline-none"
            />
          </form>
        )}
      </div>
    </div>
  )
}
