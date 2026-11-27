import { useMemo } from "react"
import { checkWebAnswer, checkWebPlan, useWebApexesOf, useWebPlanAsks } from "./apexes"
import { QuestionLine } from "./apex-digest"
import { planQuestion } from "@mako/host/contracts/apexes"
import { useWebClient } from "./client"
import { ApexMark } from "@/components/ui/apex-mark"
import { CheckIcon, ChevronLeftIcon } from "lucide-react"
import { MakoMark } from "@/components/ui/mako-mark"
import { cn } from "@/lib/utils"
import { useAccountList } from "./account-list"
import { FinAskCard } from "./fin-ask"
import { useWebFinAsks, waitingThreads, asksBesidePlaced } from "./inbox"
import { ThreadRow } from "./list"
import { useArchiving } from "./archive-thread"
import { isUnread, useReadState } from "./read-state"
import { foldThreads, type WebThread } from "./threads"

const noTyped = () => undefined

/**
 * The phone's Inbox: every Fin asking the person, its answers in reach of a thumb and sent through its Apex's host, so
 * the answer leaves the dock, the Shiver and the desk at once; then the Threads waiting on the person, opened to answer;
 * then what's to read, the unread answers and the failures. Back returns to the list; wide, it's the pane beside it.
 */
export function InboxScreen({ onBack, onOpen }: { onBack: (() => void) | undefined; onOpen: (thread: WebThread) => void }) {
  const list = useAccountList((state) => state)
  const folded = useMemo(() => foldThreads(list), [list])
  const hidden = useArchiving((state) => state.hidden)
  const threads = useMemo(() => folded.threads.filter((thread) => !hidden.has(thread.id)), [folded, hidden])
  const read = useReadState((state) => state)
  const asks = useWebFinAsks()
  const fins = asksBesidePlaced(asks, folded.placed)
  const waiting = waitingThreads(threads, asks, folded.placed)
  const toRead = threads.filter((thread) => thread.standing === "failed" || (thread.standing === "idle" && isUnread(read, thread)))
  // The person's Apexes' plan lines that wait on them, read from each Mac their Threads are on.
  const client = useWebClient()
  useWebApexesOf(client, threads)
  const planAsks = useWebPlanAsks(client)
  const count = fins.length + waiting.length + planAsks.length
  const empty = !count && !toRead.length
  // A Fin's ask opens its Apex's Thread, where its Shiver card holds it.
  const openApex = (id: string) => {
    const thread = threads.find((each) => each.id === id)
    return thread ? () => onOpen(thread) : undefined
  }
  const row = (thread: WebThread) => <ThreadRow thread={thread} selected={false} named={false} unread={isUnread(read, thread)} onOpen={() => onOpen(thread)} />
  return (
    <div data-inbox className="flex min-h-0 flex-1 flex-col bg-surface">
      <header className={cn("web-bar flex shrink-0 items-center gap-1", onBack ? "px-1.5" : "px-5")}>
        {onBack ? (
          <button type="button" aria-label="Back to threads" onClick={onBack} className="web-icon-button">
            <ChevronLeftIcon className="size-6" strokeWidth={2} />
          </button>
        ) : null}
        <h1 className="flex-1 text-ui font-semibold">Inbox</h1>
        {count ? <span data-inbox-summary className="pr-3 text-label text-attention">{count} {count === 1 ? "needs" : "need"} you</span> : null}
      </header>
      {/* The desk's Inbox keeps to a centred column; so does a tablet's, the phone's width being narrower than it. */}
      <div className="web-scroll min-h-0 flex-1 overflow-y-auto pb-[calc(env(safe-area-inset-bottom)+24px)]">
        <div className="mx-auto w-full max-w-content">
        {empty ? (
          <div className="web-enter mx-auto flex max-w-[300px] flex-col items-center px-6 pt-28 text-center">
            <MakoMark className="size-8 opacity-35" />
            <p data-inbox-empty className="mt-5 text-ui text-muted-foreground">Nothing needs you. Asks from every Thread and Fin land here.</p>
          </div>
        ) : null}
        {fins.length ? (
          <section aria-label="Needs you" data-inbox-section="needs" className="web-section flex flex-col gap-2.5 px-2">
            <h2 className="web-section-label -mx-2 text-attention">Needs you</h2>
            {fins.map((fin) => (
              <div key={fin.key} data-inbox-item={fin.key}>
                <FinAskCard apex={fin.apex.conversation} ask={fin.ask} more={0} answerTyped={noTyped} from={fin.apex.title} onOpen={openApex(fin.apex.thread)} />
              </div>
            ))}
          </section>
        ) : null}
        {planAsks.length ? (
          <section aria-label="Your Apexes wait on you" data-inbox-section="apexes" className="web-section flex flex-col gap-2.5 px-2">
            <h2 className="web-section-label -mx-2 text-attention">Your Apexes wait on you</h2>
            {planAsks.map((ask) => (
              <div key={`${ask.apex.thread}:${ask.section}:${ask.index}`} data-inbox-plan={ask.apex.name} className="flex flex-col gap-2.5 bg-raised px-4 py-3.5">
                <span className="flex min-w-0 items-center gap-1.5 text-label text-faint">
                  <ApexMark className="size-3 shrink-0" />
                  <span className="truncate font-medium text-foreground/90">{ask.apex.name}</span>
                </span>
                {planQuestion(ask.text) ? (
                  <div className="-mx-4">
                    <QuestionLine item={{ key: ask.text, line: planQuestion(ask.text)!.question, kind: "question", options: planQuestion(ask.text)!.options }} onAnswer={(answer) => checkWebAnswer(client, ask.apex.deviceId, ask.apex.thread, ask.section, ask.index, answer)} />
                  </div>
                ) : <span className="text-ui text-foreground"><span className="mr-1.5 text-label text-attention">Your to-do</span>{ask.text}</span>}
                <span className="flex items-center gap-2">
                  {planQuestion(ask.text) ? null : (
                    <button type="button" data-inbox-plan-done onClick={() => void checkWebPlan(client, ask.apex.deviceId, ask.apex.thread, ask.section, ask.index)} className="pressable flex h-10 items-center gap-1.5 bg-foreground px-3.5 text-label text-background">
                      <CheckIcon className="size-3.5" />Mark done
                    </button>
                  )}
                  {openApex(ask.apex.thread) ? (
                    <button type="button" onClick={openApex(ask.apex.thread)} className="pressable flex h-10 items-center px-3.5 text-label text-foreground">Open {ask.apex.name}</button>
                  ) : null}
                </span>
              </div>
            ))}
          </section>
        ) : null}
        {waiting.length ? (
          <section aria-label={fins.length ? "Waiting in their Threads" : "Needs you"} data-inbox-section="waiting" className="web-section">
            <h2 className={cn("web-section-label", !fins.length && "text-attention")}>{fins.length ? "Waiting in their Threads" : "Needs you"}</h2>
            <ul role="list" className="web-rows">
              {waiting.map((thread) => (
                <li key={thread.id} data-inbox-item={`thread:${thread.id}`}>
                  {row(thread)}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {toRead.length ? (
          <section aria-label="To read" data-inbox-section="read" className="web-section">
            <h2 className="web-section-label">To read</h2>
            <ul role="list" className="web-rows">
              {toRead.map((thread) => (
                <li key={thread.id} data-inbox-item={`read:${thread.id}`}>
                  {row(thread)}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        </div>
      </div>
    </div>
  )
}
