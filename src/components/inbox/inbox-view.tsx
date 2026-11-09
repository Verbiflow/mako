import { approvalWords } from "@mako/host/contracts/children"
import { memo, useEffect, useRef, useState } from "react"
import { CheckIcon, ChevronRightIcon, XIcon } from "lucide-react"
import { childStateOf } from "@mako/host/contracts/children"
import { ApexMark } from "@/components/ui/apex-mark"
import { LiveMark } from "@/components/ui/live-mark"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { FinMark } from "@/components/stage/child-tabs"
import { RoomSection } from "@/components/rail/room-section"
import { harnessLabel } from "@/components/rail/harness-meta"
import { formatRelative } from "@/lib/format"
import { useHarnessIdentity } from "@/lib/harness-label"
import { cn } from "@/lib/utils"
import { agentAskCard } from "@/state/agent-asks"
import { answerFin, type FinAnswer } from "@/state/fin-asks"
import { ASK_TOUCH, runChoice, type AskCard as AskWords } from "@/lib/ask-card"
import { setupAskCard } from "@/state/setup"
import {
  answerApproval,
  inboxView,
  openInboxItem,
  sameItems,
  useInbox,
  useInboxView,
  type ApprovalInboxItem,
  type FinInboxItem,
  type InboxAsk,
  type InboxModel,
  type ReadInboxItem,
} from "@/state/inbox"

function sameModel(left: InboxModel, right: InboxModel): boolean {
  return sameItems(left.asks, right.asks) && sameItems(left.toRead, right.toRead)
}

/** Ages in minutes: the Inbox repaints once a minute, never per token. */
function useMinute(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])
  return now
}

function summary(model: InboxModel): string {
  const reviews = model.toRead.filter((item) => item.kind === "review").length
  const failed = model.toRead.length - reviews
  const parts = [
    model.asks.length ? `${model.asks.length} need${model.asks.length === 1 ? "s" : ""} you` : undefined,
    reviews ? `${reviews} ${reviews === 1 ? "answer" : "answers"} to read` : undefined,
    failed ? `${failed} failed` : undefined,
  ].filter(Boolean)
  return parts.length ? parts.join(" · ") : "Nothing waits on you"
}

/**
 * Everything waiting on the person, from every Thread and Fin, answerable
 * where it stands; then what's to read. Escape goes back to the conversation.
 */
export function InboxView() {
  const open = useInboxView((state) => state.open)
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return
      event.preventDefault()
      inboxView.close()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open])
  if (!open) return null
  return <InboxPane />
}

function InboxPane() {
  useHarnessIdentity()
  const model = useInbox((next) => next, sameModel)
  useMinute()
  const empty = !model.asks.length && !model.toRead.length
  return (
    <section data-inbox aria-label="Inbox" className="absolute inset-0 z-30 flex min-h-0 flex-col bg-surface">
      <header className="shrink-0 px-5 pt-3.5 pb-3">
        <h1 className="text-title font-semibold text-foreground">Inbox</h1>
        <p data-inbox-summary className="text-label text-faint">{summary(model)}</p>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto flex w-full max-w-[560px] flex-col px-5 pt-4 pb-10">
          {empty ? (
            <p data-inbox-empty className="pt-16 text-center text-ui text-faint">
              Nothing needs you. Asks from every Thread and Fin land here.
            </p>
          ) : null}
          {model.asks.length ? (
            <section aria-label="Needs you" data-inbox-section="needs">
              <h2 className="flex h-7 items-center text-label font-medium text-attention">Needs you</h2>
              <ul className="flex flex-col gap-2">
                {model.asks.map((item) => (
                  <li key={item.key}>
                    <AskCard item={item} />
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {model.toRead.length ? (
            <section aria-label="To read" data-inbox-section="read" className={cn(model.asks.length && "pt-5")}>
              <h2 className="flex h-7 items-center text-label font-medium text-faint">To read</h2>
              <ul className="-mx-2 flex flex-col">
                {model.toRead.map((item) => (
                  <li key={item.key}>
                    <ReadRow item={item} />
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <div className="-mx-1.5 pt-5">
            <RoomSection />
          </div>
        </div>
      </div>
    </section>
  )
}

function Crumb({ item }: { item: InboxAsk }) {
  const apex = item.kind === "fin" || item.kind === "approval" ? item.apex : undefined
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden text-label text-faint">
      {apex ? (
        <>
          <ApexMark className="size-3 shrink-0" />
          <span className="min-w-0 shrink truncate">{apex.title}</span>
          <ChevronRightIcon aria-hidden className="size-3 shrink-0 opacity-60" />
        </>
      ) : null}
      <span className="min-w-0 flex-1 truncate font-medium text-foreground/90">{item.title}</span>
      <span aria-hidden className="shrink-0 opacity-60">·</span>
      {item.harness ? <span className="shrink-0">{harnessLabel(item.harness)}</span> : null}
    </span>
  )
}

/**
 * An ask's answers as the Inbox draws every ask (`AskCard`): what can't be given here said first, the one to take
 * filled. An answer that didn't land frees them again (`runChoice`).
 */
function AskChoices({ card, sending, setSending }: { card: AskWords; sending: boolean; setSending: (held: boolean) => void }) {
  return (
    <>
      {card.note ? <span className="text-label text-muted-foreground">{card.note}</span> : null}
      {card.choices.map((choice) => (
        <button key={choice.answer} type="button" data-inbox-answer={choice.answer} disabled={sending} onClick={() => void runChoice(choice, setSending)} className={cn(BUTTON, ASK_TOUCH, choice.primary ? PRIMARY : QUIET)}>
          {choice.label}
        </button>
      ))}
    </>
  )
}

const BUTTON = "pressable flex h-7 items-center gap-1.5 px-2.5 text-label transition-colors disabled:opacity-50"
const PRIMARY = "bg-foreground text-background hover:opacity-90"
const QUIET = "bg-fill-hover text-foreground hover:bg-fill-selected"

/** One ask: where it is, its mark and age, the question, and its answers in place. */
const AskCard = memo(function AskCard({ item }: { item: InboxAsk }) {
  const [sending, setSending] = useState(false)
  const card = useRef<HTMLDivElement>(null)
  const settle = (sent: Promise<boolean>) => {
    setSending(true)
    void sent.then((landed) => {
      if (!landed) setSending(false)
    })
  }
  return (
    <div
      ref={card}
      tabIndex={0}
      data-inbox-item={item.key}
      data-inbox-kind={item.kind}
      data-fin={item.kind === "fin" ? item.ask.fin : undefined}
      aria-busy={sending || undefined}
      aria-label={`${item.title}: ${item.question}`}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget || event.key !== "Enter") return
        event.preventDefault()
        openInboxItem(item)
      }}
      className="flex flex-col gap-2 bg-raised px-3.5 py-3 outline-none focus-visible:ring-2 focus-visible:ring-foreground/20"
    >
      <div className="flex h-5 min-w-0 items-center gap-2">
        <AskMark item={item} />
        <Crumb item={item} />
        <span className="tabular shrink-0 text-label text-faint">{formatRelative(item.since)}</span>
      </div>
      <p className="pl-7 text-ui text-foreground">{item.question}</p>
      {item.kind === "fin" && item.ask.ask.action ? <p className="-mt-1 pl-7 text-label text-muted-foreground">{item.ask.ask.action}</p> : null}
      <div className="flex min-w-0 flex-wrap items-center gap-1.5 pl-7">
        {item.kind === "fin" ? (
          <FinAnswers item={item} sending={sending} send={(answer) => settle(answerFin(item.apex.conversation, item.ask, answer))} />
        ) : item.kind === "approval" && item.answerable ? (
          <ApprovalAnswers item={item} sending={sending} send={(option) => settle(answerApproval(item, option))} />
        ) : item.kind === "agent-ask" ? (
          <AskChoices card={agentAskCard(item.conversation, item.ask, harnessLabel(item.harness))} sending={sending} setSending={setSending} />
        ) : item.kind === "setup" ? (
          <AskChoices card={setupAskCard(item.folder, item.ask, item.away)} sending={sending} setSending={setSending} />
        ) : null}
        <span className="flex-1" />
        <button type="button" data-inbox-open onClick={() => openInboxItem(item)} className="pressable px-1.5 py-1 text-label text-faint hover:bg-fill-hover hover:text-foreground">
          Open
        </button>
      </div>
    </div>
  )
})

function AskMark({ item }: { item: InboxAsk }) {
  if (item.kind === "fin") return <FinMark agent={item.agent} state={childStateOf(item.agent)} read />
  if (item.kind === "setup")
    return (
      <LiveMark state="needs" kind={item.ask.by.fin ? "fin" : "thread"} label="Needs you">
        {item.harness ? <HarnessIcon harness={item.harness} /> : null}
      </LiveMark>
    )
  return (
    <LiveMark state="needs" label={`Needs you in ${harnessLabel(item.harness)}`}>
      <HarnessIcon harness={item.harness} />
    </LiveMark>
  )
}

function FinAnswers({ item, sending, send }: { item: FinInboxItem; sending: boolean; send: (answer: FinAnswer) => void }) {
  if (item.ask.ask.kind === "approval")
    return (
      <>
        <button type="button" data-inbox-answer="allow" disabled={sending} onClick={() => send({ allow: true })} className={cn(BUTTON, PRIMARY)}>
          <CheckIcon className="size-3" />
          {approvalWords(item.ask.ask).allow}
        </button>
        <button type="button" data-inbox-answer="refuse" disabled={sending} onClick={() => send({ allow: false })} className={cn(BUTTON, QUIET)}>
          <XIcon className="size-3" />
          {approvalWords(item.ask.ask).refuse}
        </button>
      </>
    )
  return (
    <>
      {(item.ask.ask.options ?? []).map((option, index) => {
        const recommended = index === item.ask.ask.recommended
        return (
          <button key={`${index}:${option.label}`} type="button" data-inbox-answer={index} title={option.detail} disabled={sending} onClick={() => send({ option: index })} className={cn(BUTTON, recommended ? PRIMARY : QUIET)}>
            {option.label}
            {recommended ? <span className="opacity-60">Recommended</span> : null}
          </button>
        )
      })}
    </>
  )
}

function ApprovalAnswers({ item, sending, send }: { item: ApprovalInboxItem; sending: boolean; send: (option: string) => void }) {
  const primary = item.permission.options.find((option) => option.kind === "allow_once") ?? item.permission.options[0]
  return (
    <>
      {item.permission.options.map((option) => (
        <button key={option.optionId} type="button" data-inbox-answer={option.kind ?? option.optionId} disabled={sending} onClick={() => send(option.optionId)} className={cn(BUTTON, option === primary ? PRIMARY : QUIET)}>
          {option.name}
        </button>
      ))}
    </>
  )
}

function ReadRow({ item }: { item: ReadInboxItem }) {
  return (
    <button
      type="button"
      data-inbox-item={item.key}
      data-inbox-kind={item.kind}
      onClick={() => openInboxItem(item)}
      className="pressable flex h-8 w-full min-w-0 items-center gap-2.5 px-2 text-left transition-colors duration-100 hover:bg-fill-hover"
    >
      <LiveMark state={item.kind === "failed" ? "failed" : "unread"} label={item.kind === "failed" ? "Failed" : "Answer to read"}>
        <HarnessIcon harness={item.harness} />
      </LiveMark>
      <span className="min-w-0 shrink-0 truncate text-ui text-foreground">{item.title}</span>
      <span className={cn("min-w-0 flex-1 truncate text-label", item.kind === "failed" ? "text-negative/90" : "text-faint")}>
        {item.kind === "failed" ? (item.detail ?? "Failed") : "Finished"}
      </span>
      <span className="tabular shrink-0 text-label text-faint">{formatRelative(item.at)}</span>
    </button>
  )
}
