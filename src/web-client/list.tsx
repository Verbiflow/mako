import { useEffect, useMemo, useRef, useState } from "react"
import { ArchiveIcon, ChevronRightIcon, CloudIcon, LaptopIcon, MessageSquareTextIcon, MoonIcon, PlusIcon, Settings2Icon } from "lucide-react"
import { useRowFlip } from "@/components/rail/use-row-flip"
import { MarkStack, StackedMark } from "@/components/ui/mark-stack"
import { Shimmer } from "@/components/ui/shimmer"
import { Spinner } from "@/components/ui/spinner"
import { WebHarnessIcon } from "./harness-icon"
import { MakoMark } from "@/components/ui/mako-mark"
import { copyAge, formatRelative } from "@/lib/format"
import { cn } from "@/lib/utils"
import { useAccountList, type AccountListState } from "./account-list"
import { useWebClient } from "./client"
import { InstallCard } from "./install-card"
import { usePullToRefresh } from "./pull"
import { PullIndicator } from "./pull-indicator"
import { rowDetail } from "./rows"
import { foldThreads, type WebThread } from "./threads"
import { webHarnessLabel } from "./labels"
import { macCount } from "./places"

/** The list's sections: what needs the person, what's at work, and the rest. */
function sections(threads: readonly WebThread[]) {
  const needs = threads.filter((thread) => thread.standing === "waiting" || thread.standing === "failed")
  const working = threads.filter((thread) => thread.standing === "working" || thread.standing === "moving")
  const rest = threads.filter((thread) => thread.standing === "idle")
  return [
    { id: "needs", label: "Needs you", threads: needs },
    { id: "working", label: "Working", threads: working },
    { id: "recent", label: "Recent", threads: rest },
  ].filter((section) => section.threads.length > 0)
}

export function ThreadList({ selected, onOpen, onNew, onSettings, wide }: { selected?: string; onOpen: (thread: WebThread) => void; onNew: () => void; onSettings: () => void; wide: boolean }) {
  const client = useWebClient()
  const list = useAccountList((state) => state)
  const { threads, archived } = useMemo(() => foldThreads(list), [list])
  const [showArchived, setShowArchived] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const dock = useRef<HTMLDivElement>(null)
  // The list scrolls clear of what floats at its foot: its last row ends above New and the install offer, however tall.
  useEffect(() => {
    const floating = dock.current
    const rows = content.current
    if (!floating || !rows) return
    const fit = () => rows.style.setProperty("--dock", `${floating.getBoundingClientRect().height}px`)
    const observer = new ResizeObserver(fit)
    observer.observe(floating)
    fit()
    return () => observer.disconnect()
  }, [])
  const pull = usePullToRefresh(scroller, content, () => client.list.refresh())
  useRowFlip(scroller, showArchived ? "archived" : "threads")
  const named = macCount(list) > 1
  const quietMacs = [...list.quiet].map(([deviceId, since]) => ({ name: list.devices.get(deviceId)?.name ?? "A Mac", since }))
  return (
    <div className={cn("relative flex min-h-0 flex-1 flex-col", wide ? "bg-shell" : "bg-surface")}>
      <header className="web-bar flex shrink-0 items-center gap-1 pr-2 pl-5">
        <h1 className="flex flex-1 items-center gap-2 text-title font-semibold">
          <MakoMark className="size-[18px] opacity-90" />
          Threads
        </h1>
        <ListPhase list={list} />
        <button type="button" aria-label="Settings" onClick={onSettings} className="web-icon-button">
          <Settings2Icon className="size-[18px]" />
        </button>
      </header>
      <div ref={scroller} className="web-scroll relative min-h-0 flex-1 overflow-y-auto">
        <PullIndicator pulled={pull.pulled} refreshing={pull.refreshing} />
        <div ref={content} className="pb-[calc(var(--dock,96px)+16px)]">
          {threads.length === 0 && archived.length === 0 ? (
            <EmptyList phase={list.phase} onNew={onNew} />
          ) : (
            <>
              {quietMacs.length ? (
                <p className="flex flex-col gap-0.5 px-5 pt-2 text-label text-faint">
                  {quietMacs.map((mac) => (
                    <span key={mac.name} className="flex items-center gap-1.5">
                      <MoonIcon aria-hidden className="size-3" />
                      {mac.name} is off · seen {copyAge(Date.parse(mac.since))}
                    </span>
                  ))}
                </p>
              ) : null}
              {sections(threads).map((section) => (
                <section key={section.id} aria-labelledby={`section-${section.id}`} className="pt-4">
                  <h2 id={`section-${section.id}`} className="flex items-center gap-2 px-5 pb-1.5 text-label font-medium text-faint">
                    {section.label}
                    {section.id === "needs" ? <span className="tabular rounded-full bg-caution/15 px-1.5 text-caution">{section.threads.length}</span> : null}
                  </h2>
                  <ul role="list" className={cn("flex flex-col", section.id === "needs" && "web-needs mx-3 overflow-hidden rounded-2xl")}>
                    {section.threads.map((thread) => (
                      <li key={thread.id} data-flip-key={thread.id}>
                        <ThreadRow thread={thread} selected={thread.id === selected} named={named} onOpen={() => onOpen(thread)} />
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </>
          )}
          {archived.length ? (
            <section className="pt-5">
              <button type="button" onClick={() => setShowArchived((shown) => !shown)} aria-expanded={showArchived} className="pressable flex min-h-11 w-full items-center gap-1.5 px-5 text-label font-medium text-faint">
                <ArchiveIcon className="size-3.5" />
                Archived
                <span className="tabular">{archived.length}</span>
                <ChevronRightIcon className={cn("size-3.5 transition-transform duration-200 ease-[var(--ease-out)]", showArchived && "rotate-90")} />
              </button>
              {showArchived ? (
                <ul role="list" className="flex flex-col">
                  {archived.map((thread) => (
                    <li key={thread.id} data-flip-key={`archived:${thread.id}`}>
                      <ThreadRow thread={thread} selected={thread.id === selected} named={named} onOpen={() => onOpen(thread)} />
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          ) : null}
        </div>
      </div>
      {/* What floats at the foot of the list, stacked so nothing covers anything: New, and under it the install offer
          while it shows, each above the Home indicator. */}
      <div ref={dock} className="web-list-foot">
        <button type="button" aria-label="New thread" onClick={onNew} className="web-fab">
          <PlusIcon className="size-6" strokeWidth={2.2} />
        </button>
        <InstallCard />
      </div>
    </div>
  )
}

/** Where the list stands, when it isn't simply live: painted from this browser's last visit, or following again. */
function ListPhase({ list }: { list: AccountListState }) {
  if (list.phase === "live" || list.phase === "signed-out") return null
  const label =
    list.phase === "starting" ? "Connecting…" : list.phase === "cached" && list.asOf ? `As of ${copyAge(list.asOf)}` : "Reconnecting…"
  return (
    <span role="status" className="flex items-center gap-1.5 text-label text-faint">
      <Spinner aria-hidden className="size-3" />
      {label}
    </span>
  )
}

function EmptyList({ phase, onNew }: { phase: AccountListState["phase"]; onNew: () => void }) {
  if (phase === "starting")
    return (
      <div className="flex flex-col gap-2 px-5 pt-5" aria-hidden>
        {[0, 1, 2, 3].map((row) => (
          <div key={row} className="flex items-center gap-3.5 py-2.5">
            <span className="skeleton size-5 rounded-md" />
            <span className="flex flex-1 flex-col gap-1.5">
              <span className="skeleton h-3.5 w-3/5 rounded" />
              <span className="skeleton h-3 w-2/5 rounded" />
            </span>
          </div>
        ))}
      </div>
    )
  return (
    <div className="mx-auto flex max-w-[320px] flex-col items-center px-6 pt-24 text-center">
      <MessageSquareTextIcon className="size-7 text-faint" />
      <p className="mt-4 text-title font-medium">No threads yet</p>
      <p className="mt-1.5 text-ui text-muted-foreground">Start one here, or on a Mac. Every Thread shows up here as it runs.</p>
      <button type="button" onClick={onNew} className="web-button mt-6">
        <PlusIcon className="size-4" />
        New thread
      </button>
    </div>
  )
}

/** Marks a stack draws at a phone's size: one is read at a glance, three still fit side by side in the row's mark column. */
const STACK_SIZES = [20, 18, 12] as const

/** The harnesses of a Thread's Sessions, one mark each, as the rail stacks them. */
export function HarnessMarks({ thread, size }: { thread: WebThread; size?: number }) {
  const harnesses = [...new Set(thread.sessions.map((session) => session.row.harness))].slice(0, STACK_SIZES.length)
  return (
    <MarkStack size={size ?? STACK_SIZES[harnesses.length - 1]}>
      {harnesses.map((harness) => (
        <StackedMark key={harness}>
          <WebHarnessIcon harness={harness} />
        </StackedMark>
      ))}
    </MarkStack>
  )
}

function threadLabel(thread: WebThread, detail: string): string {
  const harnesses = [...new Set(thread.sessions.map((session) => webHarnessLabel(session.row.harness)))].join(", ")
  return `${thread.title}. ${detail}. ${harnesses}.`
}

export function ThreadRow({ thread, selected, named, onOpen }: { thread: WebThread; selected: boolean; named: boolean; onOpen: () => void }) {
  const detail = rowDetail(thread, named)
  const Place = detail.place === "cloud" ? CloudIcon : LaptopIcon
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={selected ? "page" : undefined}
      aria-label={threadLabel(thread, detail.text)}
      data-thread={thread.id}
      data-standing={thread.standing}
      className={cn("web-row group relative flex w-full items-center gap-3 py-3 pr-4 pl-5 text-left", selected && "bg-fill-selected", thread.quietSince && "opacity-60")}
    >
      <span className="flex w-10 shrink-0 items-center justify-center">
        <HarnessMarks thread={thread} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-ui font-medium text-foreground">{thread.title}</span>
          <span className="tabular shrink-0 text-label text-faint">{formatRelative(thread.activityAt)}</span>
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-label">
          {detail.place ? <Place aria-hidden className="size-3 shrink-0 text-faint" /> : null}
          {detail.tone === "working" ? (
            <Shimmer text={detail.text} className="min-w-0 truncate" />
          ) : (
            <span className={cn("min-w-0 flex-1 truncate", detail.tone === "caution" ? "text-caution" : detail.tone === "negative" ? "text-negative" : "text-faint")}>{detail.text}</span>
          )}
        </span>
      </span>
    </button>
  )
}
