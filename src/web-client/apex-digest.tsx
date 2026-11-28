import { useCallback, useState } from "react"
import { CheckIcon, ChevronRightIcon } from "lucide-react"
import { DIGEST_HEADINGS, parsePlan, type DigestItem } from "@mako/host/contracts/apexes"
import type { NativeAgent } from "@mako/host/contracts/native-agents"
import { ApexMark } from "@/components/ui/apex-mark"
import { cn } from "@/lib/utils"
import { useThreadChildren } from "@/state/apex-fins"
import { useSeenSince } from "@/state/apexes"
import { useWebClient } from "./client"
import { FinTypedAnswer } from "@/components/composer/fin-typed-answer"
import { FinAnswerButtons } from "@/components/viewer/fin-answer-buttons"
import { useFinAnswer } from "@/components/viewer/use-fin-answer"
import { childStateOf, openAsk } from "@mako/host/contracts/children"
import { LastKnownLine } from "@/components/apexes/last-known"
import { checkWebAnswer, checkWebPlan, markWebSeen, useWebApex, useWebDigest, useWebLastKnown, useWebPlan } from "./apexes"
import { useAccountList } from "./account-list"
import type { WebSession, WebThread } from "./threads"
import { ownerOf } from "./threads"

const SHOWN = 3

/**
 * A deliberate Apex's digest under its bar on the phone and the iPad, and on a laptop's while its Mac is off: what needs the person, what's new since they last
 * read it, what's in progress, built from the same roster and plan its Mac's note reads, so it can't say otherwise.
 * Folded to one line when nothing needs them; a Fin's row opens it, a plan line checks off where it stands. Read from
 * the account's list, so it stands while its Mac is off, marked as the last it said, nothing in it to act on until it's
 * back.
 */
export function PhoneApexDigest({ thread, session, onOpenFin }: { thread: WebThread; session: WebSession; onOpenFin: (agent: NativeAgent) => void }) {
  const client = useWebClient()
  const owner = ownerOf(session)
  const deviceId = owner.kind === "mac" ? owner.deviceId : undefined
  const apex = useWebApex(client, deviceId, thread.id)
  const fins = useThreadChildren(apex ? thread.id : undefined)
  const lastKnown = useWebLastKnown(apex?.thread)
  const device = useAccountList((state) => (deviceId ? state.devices.get(deviceId)?.name : undefined)) ?? "Its Mac"
  const seen = useCallback((thread: string) => {
    if (deviceId) markWebSeen(client, deviceId, thread)
  }, [client, deviceId])
  // Its Mac off, reading it here tells it nothing: what's new stays new for when it's back.
  const since = useSeenSince(lastKnown ? undefined : apex?.thread, apex?.seenAt, seen)
  const digest = useWebDigest(client, deviceId, apex, fins, lastKnown ? apex?.seenAt : since)
  const plan = useWebPlan(apex?.thread)
  // Folded to its line ("4 need you · 2 new · 7 in progress") until tapped: open, it took two thirds of a phone's
  // screen above the conversation. What needs the person is also in the Inbox.
  const [shown, setOpen] = useState(false)
  if (!apex) return null
  const rest = [digest.new.length ? `${digest.new.length} new` : undefined, digest.progress.length ? `${digest.progress.length} in progress` : undefined].filter(Boolean).join(" · ")
  const check = (item: DigestItem) => {
    if (!deviceId || !plan) return
    const found = locate(plan, item.line)
    if (found) void checkWebPlan(client, deviceId, apex.thread, found.section, found.index)
  }
  const fin = (item: DigestItem) => fins.find((agent) => agent.child?.thread === item.fin?.thread)
  return (
    <section data-phone-digest={apex.name} data-last-known={lastKnown} aria-label={`${apex.name}'s digest`} className="shrink-0 bg-raised/60">
      <button type="button" aria-expanded={shown} onClick={() => setOpen(!shown)} className="pressable flex min-h-11 w-full items-center gap-2 px-4 text-left">
        <ApexMark className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-label">
          {apex.purpose ? <span className="text-muted-foreground">{apex.purpose}</span> : <span className="text-muted-foreground">{apex.name}</span>}
        </span>
        <span className="shrink-0 text-label tabular">
          {digest.needs.length ? <span className="font-medium text-attention">{digest.needs.length} need{digest.needs.length === 1 ? "s" : ""} you</span> : null}
          {digest.needs.length && rest ? <span className="text-faint"> · </span> : null}
          {rest ? <span className="text-faint">{rest}</span> : digest.needs.length ? null : <span className="text-faint">Nothing needs you</span>}
        </span>
        <ChevronRightIcon className={cn("size-3.5 shrink-0 text-faint transition-transform duration-150", shown && "rotate-90")} />
      </button>
      {lastKnown ? <LastKnownLine device={device} since={lastKnown} className="block px-4 pt-0 pb-2" /> : null}
      {shown ? (
        <div className="flex max-h-[45dvh] flex-col overflow-y-auto overscroll-contain pb-2">
          <Part heading={DIGEST_HEADINGS.needs} items={digest.needs} shown={5} attention render={(item) => {
            if (item.kind === "plan") return <PlanLine key={item.key} item={item} {...(!lastKnown && { onDone: () => check(item) })} />
            if (item.kind === "question" && item.planAt && deviceId)
              return <QuestionLine key={item.key} item={item} {...(!lastKnown && { onAnswer: (answer: string) => checkWebAnswer(client, deviceId, apex.thread, item.planAt!.section, item.planAt!.index, answer) })} />
            const agent = fin(item)
            if (agent && lastKnown) return <FinLine key={item.key} item={item} onOpen={() => onOpenFin(agent)} needs />
            return agent ? <FinAskLine key={item.key} item={item} agent={agent} apex={session.row.conversation} apexTitle={apex.name} onOpen={() => onOpenFin(agent)} /> : null
          }} />
          <Part heading={DIGEST_HEADINGS.new} items={digest.new} folds render={(item) => <FinLine key={item.key} item={item} onOpen={() => { const agent = fin(item); if (agent) onOpenFin(agent) }} />} />
          <Part heading={DIGEST_HEADINGS.progress} items={digest.progress} folds render={(item) => <FinLine key={item.key} item={item} onOpen={() => { const agent = fin(item); if (agent) onOpenFin(agent) }} />} />
        </div>
      ) : null}
    </section>
  )
}

/** A plan line's section and place, by its words: the digest names it by them. */
function locate(plan: string, text: string): { section: string; index: number } | undefined {
  for (const section of parsePlan(plan).sections) {
    const index = section.items.findIndex((item) => !item.done && item.text === text)
    if (index >= 0 && /^waiting on\b/i.test(section.name)) return { section: section.name, index }
  }
  return undefined
}

/** One part of the digest: Needs you open, New and In progress a heading to open, each its first rows then the rest. */
function Part({ heading, items, render, attention = false, folds = false, shown: first = SHOWN }: { heading: string; items: DigestItem[]; render: (item: DigestItem) => React.ReactNode; attention?: boolean; folds?: boolean; shown?: number }) {
  const [all, setAll] = useState(false)
  const [open, setOpen] = useState(!folds)
  if (!items.length) return null
  const shown = all ? items : items.slice(0, first)
  return (
    <div data-phone-digest-part={heading}>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className={cn("pressable flex h-9 w-full items-center px-4 text-left text-label font-medium", attention ? "text-attention" : "text-muted-foreground")}>
        {heading} <span className="ml-1.5 font-normal tabular text-faint">{items.length}</span>
        <ChevronRightIcon className={cn("ml-auto size-3.5 text-faint transition-transform duration-150", open && "rotate-90")} />
      </button>
      {open ? shown.map(render) : null}
      {open && items.length > first && !all ? (
        <button type="button" onClick={() => setAll(true)} className="pressable flex h-9 w-full items-center px-4 text-label text-faint">
          Show {items.length - first} more
        </button>
      ) : null}
    </div>
  )
}

function FinLine({ item, onOpen, needs = false }: { item: DigestItem; onOpen: () => void; needs?: boolean }) {
  return (
    <button type="button" data-phone-digest-item={item.kind} onClick={onOpen} className="pressable flex min-h-11 w-full flex-col justify-center px-4 py-1.5 text-left">
      <span className={cn("truncate text-ui", needs ? "font-medium text-foreground" : "text-foreground/90")}>{item.fin?.title}</span>
      <span className="line-clamp-2 text-label text-muted-foreground">{item.kind === "failed" ? `Failed: ${item.line}` : item.line}</span>
    </button>
  )
}

/** A to-do of the person's the plan lists: ticked once done. */
function PlanLine({ item, onDone }: { item: DigestItem; onDone?: () => void }) {
  return (
    <div data-phone-digest-item="plan" className="flex min-h-11 items-center gap-3 px-4 py-1.5">
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-label text-attention">Your to-do</span>
        <span className="text-ui font-medium text-foreground">{item.line}</span>
      </span>
      {onDone ? (
        <button type="button" data-phone-plan-done onClick={onDone} className="pressable flex h-9 shrink-0 items-center gap-1.5 bg-raised px-3 text-label text-foreground">
          <CheckIcon className="size-3.5" />Mark done
        </button>
      ) : null}
    </div>
  )
}

/** A question the plan asks the person, answered where it stands: its answers a tap each, their own words beside. */
export function QuestionLine({ item, onAnswer }: { item: DigestItem; onAnswer?: (answer: string) => Promise<boolean> }) {
  const [sent, setSent] = useState<string | null>(null)
  const send = async (answer: string) => {
    if (!onAnswer) return
    setSent(answer)
    if (!(await onAnswer(answer))) setSent(null)
  }
  if (!onAnswer)
    return (
      <div data-phone-digest-item="question" className="flex flex-col gap-1 px-4 py-2">
        <span className="text-ui font-medium text-foreground">{item.line}</span>
        {item.options?.length ? <span className="text-label text-muted-foreground">{item.options.join(" · ")}</span> : null}
      </div>
    )
  return (
    <div data-phone-digest-item="question" className="flex flex-col gap-2 px-4 py-2">
      <span className="text-ui font-medium text-foreground">{item.line}</span>
      <div className="flex flex-wrap items-center gap-1.5">
        {(item.options ?? []).map((option, at) => (
          <button key={option} type="button" data-phone-answer={option} disabled={sent !== null} onClick={() => void send(option)} className={cn("pressable flex h-9 items-center px-3 text-label font-medium disabled:opacity-50", at === 0 ? "bg-foreground text-background" : "bg-raised text-foreground/85")}>
            {option}
          </button>
        ))}
        <FinTypedAnswer title={item.line} options={item.options?.length ?? 0} disabled={sent !== null} onAnswer={(words) => void send(words)} />
      </div>
    </div>
  )
}

/** A Fin's ask of the person, answered in the row as its card answers it: its options, or the person's own words. */
function FinAskLine({ item, agent, apex, apexTitle, onOpen }: { item: DigestItem; agent: NativeAgent; apex: string; apexTitle: string; onOpen: () => void }) {
  const { sent, send } = useFinAnswer(agent, apex)
  const ask = openAsk(childStateOf(agent))?.ask
  return (
    <div data-phone-digest-item={item.kind} className="flex flex-col gap-2 px-4 py-2">
      <button type="button" onClick={onOpen} className="pressable flex flex-col text-left">
        <span className="truncate text-ui font-medium text-foreground">{item.fin?.title}</span>
        <span className="line-clamp-2 text-label text-muted-foreground">{item.line}</span>
      </button>
      {ask ? <FinAnswerButtons agent={agent} ask={ask} apexTitle={apexTitle} sent={sent} send={send} compact typed /> : null}
    </div>
  )
}
