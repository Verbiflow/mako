import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { AskRow, AutomationFailRow, PlanRow, ReadRow } from "@/components/inbox/inbox-rows"
import { ListPage, ListSection } from "@/components/ui/list"
import { useListKeys, walkedRows } from "@/components/ui/use-list-keys"
import { workspaceName } from "@/lib/format"
import { useHarnessIdentity } from "@/lib/harness-label"
import type { ThreadRef } from "@/lib/types"
import { everyWhileShown } from "@/lib/window-shown"
import { acp } from "@/state/acp"
import { planKey, useApexPlanAsks, type PlanAsk } from "@/state/apexes"
import { useAutomations } from "@/state/automations"
import { showAutomation } from "@/state/automations-view"
import { forgetRead, readToday, useInboxRead, type ReadEntry } from "@/state/inbox-read"
import { inboxListStore, useInboxList } from "@/state/inbox-view"
import { usePrefs } from "@/state/prefs"
import { markThreadReviewed, setThreadAttention } from "@/state/threads"
import { useThreads } from "@/state/thread-store"
import { threadTitle } from "@/state/thread-titles"
import {
  inboxView,
  openInboxItem,
  sameItems,
  useInbox,
  useInboxView,
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
  useEffect(() => everyWhileShown(60_000, () => setNow(Date.now())), [])
  return now
}

/** An automation whose newest run failed since Automations was last opened, as a line to read. */
interface FailedAutomation {
  key: string
  project: string
  id: string
  name: string
  why?: string
  at: number
}

function useFailedAutomations(): FailedAutomation[] {
  const seenAt = usePrefs((prefs) => prefs.automationsSeenAt)
  const projects = useAutomations((state) => state.projects)
  return useMemo(
    () =>
      projects.flatMap((reading) =>
        reading.automations.flatMap((view) => {
          const run = view.lastRun
          if (!run || (run.status !== "failed" && run.status !== "failed-to-start")) return []
          const at = run.endedAt ?? run.at
          if (at <= seenAt) return []
          return [{ key: `automation:${view.project}#${view.definition.id}`, project: view.project, id: view.definition.id, name: view.definition.name, ...(run.why && { why: run.why }), at }]
        })
      ),
    [projects, seenAt]
  )
}

type TodayItem = ReadInboxItem & { path: string; entry: ReadEntry }

/** Today's reads as rows, each its Thread as the catalog has it, past what's still to read. */
function useReadToday(toRead: readonly ReadInboxItem[], now: number): TodayItem[] {
  const entries = useInboxRead((state) => state.entries)
  const refs = useThreads((state) => state.threads)
  return useMemo(() => {
    const pending = new Set(toRead.map((item) => item.key))
    const byPath = new Map<string, ThreadRef>(refs.map((ref) => [ref.path, ref]))
    return readToday(entries, now).flatMap((entry): TodayItem[] => {
      const ref = byPath.get(entry.path)
      if (!ref || pending.has(`read:${entry.path}`)) return []
      return [{ kind: entry.kind, key: `today:${entry.path}`, path: entry.path, entry, title: threadTitle(ref.threadId) ?? ref.title ?? workspaceName(ref.cwd), harness: ref.harness, at: entry.readAt, ...(entry.detail && { detail: entry.detail }), open: { kind: "ref", ref } }]
    })
  }, [entries, refs, toRead, now])
}

function summary(asks: number, toRead: number): string {
  const parts = [asks ? `${asks} need${asks === 1 ? "s" : ""} you` : undefined, toRead ? `${toRead} to read` : undefined].filter(Boolean)
  return parts.length ? parts.join(" · ") : "Nothing waits on you"
}

/**
 * Everything waiting on the person, from every Thread and Fin, answerable where it stands; then what's to read; then
 * what was read today, folded. The keyboard walks it: j/k, 1–9 answer the selected ask, Enter opens, e settles a line
 * to read and u puts back one read today. Escape goes back to the conversation.
 */
export function InboxView() {
  const open = useInboxView((state) => state.open)
  if (!open) return null
  return <InboxPane />
}

function InboxPane() {
  useHarnessIdentity()
  const model = useInbox((next) => next, sameModel)
  const now = useMinute()
  const planAsks = useApexPlanAsks()
  const failedAutomations = useFailedAutomations()
  const today = useReadToday(model.toRead, now)
  const selected = useInboxList((state) => state.selected)
  const readFolded = useInboxList((state) => state.readFolded)
  const root = useRef<HTMLDivElement>(null)
  const select = useCallback((key: string | undefined) => inboxListStore.set({ selected: key }), [])

  const asks = useMemo(() => new Map<string, InboxAsk>(model.asks.map((item) => [item.key, item])), [model.asks])
  const plans = useMemo(() => new Map<string, PlanAsk>(planAsks.map((ask) => [planKey(ask), ask])), [planAsks])
  const reads = useMemo(() => new Map<string, ReadInboxItem>([...model.toRead, ...today].map((item) => [item.key, item])), [model.toRead, today])
  const failures = useMemo(() => new Map(failedAutomations.map((each) => [each.key, each])), [failedAutomations])

  const openPlan = (ask: PlanAsk) => {
    if (!ask.apex.conversation) return
    inboxView.close()
    acp.open(ask.apex.conversation)
  }
  const openAutomation = (each: FailedAutomation) => {
    inboxView.close()
    showAutomation(each.project, each.id)
  }
  const settle = (key: string) => {
    if (key.startsWith("read:")) markThreadReviewed(key.slice("read:".length))
  }
  const unsettle = (key: string) => {
    const item = today.find((each) => each.key === key)
    if (!item) return
    setThreadAttention(item.path, item.kind === "failed" ? { kind: "failed", at: item.entry.at, ...(item.detail && { detail: item.detail }) } : { kind: "review", at: item.entry.at, unread: true })
    forgetRead(item.path)
  }

  useListKeys({
    root,
    enabled: true,
    selected,
    onSelect: select,
    onBack: () => inboxView.close(),
    onOpen: (key) => {
      const item = asks.get(key) ?? reads.get(key)
      if (item) return openInboxItem(item)
      const plan = plans.get(key)
      if (plan) return openPlan(plan)
      const failure = failures.get(key)
      if (failure) openAutomation(failure)
    },
    onKey: (event, key, typing) => {
      if (typing || event.metaKey || event.ctrlKey || event.altKey || key === undefined) return false
      const row = walkedRows(root.current).find((each) => each.dataset.listRow === key)
      const press = (selector: string) => {
        const button = row?.querySelector<HTMLButtonElement>(selector)
        if (!button || button.disabled) return false
        button.click()
        return true
      }
      if (/^[1-9]$/.test(event.key)) return press(`[data-inbox-choice="${event.key}"]`)
      if (event.key === "a") return press('[data-inbox-answer="allow"], [data-inbox-answer="allow_once"]')
      if (event.key === "d") return press('[data-inbox-answer="refuse"], [data-inbox-answer="reject_once"]')
      if (event.key === "r" || (event.key === "Tab" && !event.shiftKey)) {
        const field = row?.querySelector<HTMLInputElement>("[data-fin-typed] input")
        if (!field) return false
        field.focus()
        return true
      }
      if (event.key === "e" && key.startsWith("read:")) {
        settle(key)
        return true
      }
      if (event.key === "u" && key.startsWith("today:")) {
        unsettle(key)
        return true
      }
      return false
    },
  })

  const needs = model.asks.length + planAsks.length
  const toRead = model.toRead.length + failedAutomations.length
  const empty = !needs && !toRead && !today.length
  return (
    <section data-inbox aria-label="Inbox" className="absolute inset-0 z-30 flex min-h-0 flex-col bg-surface">
      <ListPage scrollRef={root} title="Inbox" summary={<span data-inbox-summary>{summary(needs, toRead)}</span>} summaryTone={needs ? "attention" : "faint"}>
        {empty ? (
          <p data-inbox-empty className="pt-24 text-center text-ui text-faint">
            Nothing needs you
          </p>
        ) : null}
        {needs ? (
          <ListSection label="Needs you" count={needs} attention data-inbox-section="needs">
            {model.asks.map((item) => (
              <AskRow key={item.key} item={item} selected={selected === item.key} onSelect={select} />
            ))}
            {planAsks.map((ask) => (
              <PlanRow key={planKey(ask)} ask={ask} selected={selected === planKey(ask)} onSelect={select} onOpen={() => openPlan(ask)} />
            ))}
          </ListSection>
        ) : null}
        {toRead ? (
          <ListSection label="To read" count={toRead} data-inbox-section="read">
            {failedAutomations.map((each) => (
              <AutomationFailRow key={each.key} rowKey={each.key} name={each.name} why={each.why} at={each.at} selected={selected === each.key} onSelect={select} onOpen={() => openAutomation(each)} />
            ))}
            {model.toRead.map((item) => (
              <ReadRow key={item.key} item={item} selected={selected === item.key} onSelect={select} onSettle={() => settle(item.key)} />
            ))}
          </ListSection>
        ) : null}
        {today.length ? (
          <ListSection label="Read today" count={today.length} folded={readFolded} onFold={() => inboxListStore.set({ readFolded: !readFolded })} data-inbox-section="today">
            {today.map((item) => (
              <ReadRow key={item.key} item={item} read selected={selected === item.key} onSelect={select} onSettle={() => unsettle(item.key)} />
            ))}
          </ListSection>
        ) : null}
      </ListPage>
    </section>
  )
}
