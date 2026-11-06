import { useState } from "react"
import { CheckIcon, ChevronLeftIcon, XIcon } from "lucide-react"
import { childStateOf } from "@mako/host/contracts/children"
import { FinMark } from "@/components/stage/child-tabs"
import { LiveMark } from "@/components/ui/live-mark"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { harnessLabel } from "@/components/rail/harness-meta"
import { formatRelative } from "@/lib/format"
import { cn } from "@/lib/utils"
import { acpStore } from "@/state/acp-state"
import { answerFin, type FinAnswer } from "@/state/fin-asks"
import { answerApproval, sameItems, useInbox, type ApprovalInboxItem, type FinInboxItem, type InboxAsk, type ReadInboxItem } from "@/state/inbox"

/**
 * The Inbox on a phone or a tablet: the same items as the desk's, with the
 * chosen ask's answers in a dock at the foot, in thumb's reach. Answering is
 * the same call the desk's Inbox makes, so the ask leaves every surface.
 */
export function InboxScreen({ onBack, onOpen }: { onBack?: () => void; onOpen: (threadId: string) => void }) {
  const model = useInbox((next) => next, (left, right) => sameItems(left.asks, right.asks) && sameItems(left.toRead, right.toRead))
  const [picked, setPicked] = useState<string | null>(null)
  const chosen = model.asks.find((item) => item.key === picked) ?? model.asks[0]
  const empty = model.asks.length === 0 && model.toRead.length === 0
  return (
    <div data-inbox className="flex min-h-0 flex-1 flex-col bg-surface">
      <header className={cn("web-bar flex shrink-0 items-center gap-1", onBack ? "px-1.5" : "px-5")}>
        {onBack ? (
          <button type="button" aria-label="Back to threads" onClick={onBack} className="web-icon-button">
            <ChevronLeftIcon className="size-6" strokeWidth={2} />
          </button>
        ) : null}
        <h1 className="min-w-0 flex-1 truncate text-ui font-semibold">Inbox</h1>
      </header>
      <div className="web-scroll min-h-0 flex-1 overflow-y-auto">
        {empty ? (
          <p data-inbox-empty className="px-8 pt-24 text-center text-ui text-faint">
            Nothing needs you. Asks from every Thread and Fin land here.
          </p>
        ) : null}
        {model.asks.length ? (
          <section aria-label="Needs you" data-inbox-section="needs" className="web-section">
            <h2 className="web-section-label text-caution">Needs you</h2>
            <ul role="list">
              {model.asks.map((item) => (
                <li key={item.key}>
                  <AskRow item={item} selected={item === chosen} onSelect={() => setPicked(item.key)} />
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {model.toRead.length ? (
          <section aria-label="To read" data-inbox-section="read" className="web-section">
            <h2 className="web-section-label">To read</h2>
            <ul role="list">
              {model.toRead.map((item) => (
                <li key={item.key}>
                  <ReadRow item={item} onOpen={() => openItem(item, onOpen)} />
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
      {chosen ? <AnswerDock item={chosen} onOpen={() => openItem(chosen, onOpen)} /> : null}
    </div>
  )
}

function openItem(item: InboxAsk | ReadInboxItem, onOpen: (threadId: string) => void): void {
  const thread = threadOf(item)
  if (thread) onOpen(thread)
}

function threadOf(item: InboxAsk | ReadInboxItem): string | undefined {
  if (item.kind === "fin") return item.apex.thread
  if (item.kind === "approval") return acpStore.get().conversations[item.conversation]?.threadId
  const target = item.open
  if (target.kind === "ref") return target.ref.threadId
  return acpStore.get().conversations[target.key]?.threadId
}

function AskRow({ item, selected, onSelect }: { item: InboxAsk; selected: boolean; onSelect: () => void }) {
  const where = item.kind === "fin" ? `${item.apex.title} · ${item.question}` : item.question
  return (
    <button
      type="button"
      data-inbox-item={item.key}
      data-inbox-kind={item.kind}
      data-fin={item.kind === "fin" ? item.ask.fin : undefined}
      aria-current={selected ? "true" : undefined}
      aria-label={`${item.title}. ${where}`}
      onClick={onSelect}
      className={cn("web-row flex w-full items-center text-left", selected && "bg-fill-selected")}
    >
      <span className="web-row-mark">
        <AskMark item={item} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-ui font-medium text-foreground">{item.title}</span>
          <span className="tabular shrink-0 text-label text-faint">{formatRelative(item.since)}</span>
        </span>
        <span className="truncate text-label text-caution">{where}</span>
      </span>
    </button>
  )
}

function AskMark({ item }: { item: InboxAsk }) {
  if (item.kind === "fin") return <FinMark agent={item.agent} state={childStateOf(item.agent)} read />
  return (
    <LiveMark state="needs" label={`Needs you in ${harnessLabel(item.harness)}`}>
      <HarnessIcon harness={item.harness} />
    </LiveMark>
  )
}

function ReadRow({ item, onOpen }: { item: ReadInboxItem; onOpen: () => void }) {
  return (
    <button type="button" data-inbox-item={item.key} data-inbox-kind={item.kind} onClick={onOpen} className="web-row flex w-full items-center text-left">
      <span className="web-row-mark">
        <LiveMark state={item.kind === "failed" ? "failed" : "unread"} label={item.kind === "failed" ? "Failed" : "Answer to read"}>
          <HarnessIcon harness={item.harness} />
        </LiveMark>
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-ui font-medium text-foreground">{item.title}</span>
        <span className={cn("truncate text-label", item.kind === "failed" ? "text-negative" : "text-faint")}>{item.kind === "failed" ? (item.detail ?? "Failed") : "Finished"}</span>
      </span>
    </button>
  )
}

/** The chosen ask's answers, full width, sitting above the home indicator. */
function AnswerDock({ item, onOpen }: { item: InboxAsk; onOpen: () => void }) {
  const [sending, setSending] = useState(false)
  const send = (landed: Promise<boolean>) => {
    setSending(true)
    void landed.then((ok) => {
      if (!ok) setSending(false)
    })
  }
  const answerable = item.kind === "fin" || (item.kind === "approval" && item.answerable)
  if (!answerable) return null
  return (
    <div data-inbox-dock className="shrink-0 bg-shell px-4 pt-3 pb-[max(12px,env(safe-area-inset-bottom))]">
      <p className="truncate text-label text-faint">{item.kind === "fin" ? `${item.apex.title} · ${item.title}` : item.title}</p>
      <div className="mt-2.5 flex flex-col gap-2">
        {item.kind === "fin" ? (
          <FinButtons item={item} sending={sending} send={(answer) => send(answerFin(item.apex.conversation, item.ask, answer))} />
        ) : item.kind === "approval" ? (
          <ApprovalButtons item={item} sending={sending} send={(option) => send(answerApproval(item, option))} />
        ) : null}
        <button type="button" data-inbox-open onClick={onOpen} className="web-quiet-button w-full">
          Open
        </button>
      </div>
    </div>
  )
}

function FinButtons({ item, sending, send }: { item: FinInboxItem; sending: boolean; send: (answer: FinAnswer) => void }) {
  if (item.ask.ask.kind === "approval")
    return (
      <>
        <button type="button" data-inbox-answer="allow" disabled={sending} onClick={() => send({ allow: true })} className="web-button w-full">
          <CheckIcon className="size-4" />
          Allow once
        </button>
        <button type="button" data-inbox-answer="refuse" disabled={sending} onClick={() => send({ allow: false })} className="web-quiet-button w-full gap-2 bg-fill-hover">
          <XIcon className="size-4" />
          Refuse
        </button>
      </>
    )
  return (
    <>
      {(item.ask.ask.options ?? []).map((option, index) => {
        const recommended = index === item.ask.ask.recommended
        return (
          <button key={`${index}:${option.label}`} type="button" data-inbox-answer={index} disabled={sending} onClick={() => send({ option: index })} className={recommended ? "web-button w-full" : "web-quiet-button w-full bg-fill-hover"}>
            {option.label}
            {recommended ? <span className="text-label opacity-70">Recommended</span> : null}
          </button>
        )
      })}
    </>
  )
}

function ApprovalButtons({ item, sending, send }: { item: ApprovalInboxItem; sending: boolean; send: (option: string) => void }) {
  const primary = item.permission.options.find((option) => option.kind === "allow_once") ?? item.permission.options[0]
  return (
    <>
      {item.permission.options.map((option) => (
        <button key={option.optionId} type="button" data-inbox-answer={option.kind ?? option.optionId} disabled={sending} onClick={() => send(option.optionId)} className={option === primary ? "web-button w-full" : "web-quiet-button w-full bg-fill-hover"}>
          {option.name}
        </button>
      ))}
    </>
  )
}
