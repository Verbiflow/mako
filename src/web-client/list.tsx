import { useMemo, useState } from "react"
import { ArchiveIcon, ChevronRightIcon, CloudIcon, LaptopIcon, MessageSquareTextIcon, PlusIcon, Settings2Icon } from "lucide-react"
import { Shimmer } from "@/components/ui/shimmer"
import { Spinner } from "@/components/ui/spinner"
import { WebHarnessIcon } from "./harness-icon"
import { MakoMark } from "@/components/ui/mako-mark"
import { copyAge, formatRelative } from "@/lib/format"
import { cn } from "@/lib/utils"
import { useAccountList, type AccountListState } from "./account-list"
import { CLOUD_WHERE, foldThreads, type WebThread } from "./threads"
import { webHarnessLabel } from "./labels"

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
  const list = useAccountList((state) => state)
  const { threads, archived } = useMemo(() => foldThreads(list), [list])
  const [showArchived, setShowArchived] = useState(false)
  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", wide ? "bg-shell" : "bg-surface")}>
      <header className="web-bar flex shrink-0 items-center gap-1 pr-2 pl-5">
        <h1 className="flex flex-1 items-center gap-2 text-title font-semibold">
          <MakoMark className="size-[18px] opacity-90" />
          Threads
        </h1>
        <ListPhase list={list} />
        <button type="button" aria-label="Settings" onClick={onSettings} className="web-icon-button">
          <Settings2Icon className="size-[18px]" />
        </button>
        <button type="button" aria-label="New thread in the cloud" onClick={onNew} className="web-icon-button text-foreground">
          <PlusIcon className="size-5" />
        </button>
      </header>
      <div className="web-scroll min-h-0 flex-1 overflow-y-auto pb-[calc(env(safe-area-inset-bottom)+24px)]">
        {threads.length === 0 && archived.length === 0 ? (
          <EmptyList phase={list.phase} onNew={onNew} />
        ) : (
          sections(threads).map((section) => (
            <section key={section.id} aria-labelledby={`section-${section.id}`} className="pt-4">
              <h2 id={`section-${section.id}`} className="flex items-center gap-2 px-5 pb-1.5 text-label font-medium text-faint">
                {section.label}
                {section.id === "needs" ? <span className="tabular rounded-full bg-caution/15 px-1.5 text-caution">{section.threads.length}</span> : null}
              </h2>
              <ul role="list" className={cn("flex flex-col", section.id === "needs" && "web-needs mx-3 overflow-hidden rounded-2xl")}>
                {section.threads.map((thread) => (
                  <li key={thread.id}>
                    <ThreadRow thread={thread} selected={thread.id === selected} onOpen={() => onOpen(thread)} />
                  </li>
                ))}
              </ul>
            </section>
          ))
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
                  <li key={thread.id}>
                    <ThreadRow thread={thread} selected={thread.id === selected} onOpen={() => onOpen(thread)} />
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        ) : null}
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
      <div className="flex flex-col gap-2 px-4 pt-5" aria-hidden>
        {[0, 1, 2, 3].map((row) => (
          <div key={row} className="flex items-center gap-3 py-2">
            <span className="skeleton size-8 rounded-lg" />
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
      <p className="mt-1.5 text-ui text-muted-foreground">Threads from your Macs and the cloud show up here as they run.</p>
      <button type="button" onClick={onNew} className="web-button mt-6">
        <PlusIcon className="size-4" />
        Start one in the cloud
      </button>
    </div>
  )
}

/** The harnesses of a Thread's Sessions, one mark each, overlapping as the rail draws them. */
export function HarnessMarks({ thread, size = "size-4" }: { thread: WebThread; size?: string }) {
  const harnesses = [...new Set(thread.sessions.map((session) => session.row.harness))].slice(0, 3)
  return (
    <span className="flex shrink-0 items-center -space-x-1.5" aria-hidden>
      {harnesses.map((harness) => (
        <span key={harness} className="web-mark flex items-center justify-center rounded-full p-[3px]">
          <WebHarnessIcon harness={harness} className={size} />
        </span>
      ))}
    </span>
  )
}

/** Where a Thread runs, in a word or a name: "Cloud", or its computer's own name. */
function placeOf(thread: WebThread): string {
  return thread.where === CLOUD_WHERE ? "Cloud" : thread.where
}

/** What a row says under its title, and in which tone. */
interface RowDetail {
  text: string
  tone: "caution" | "negative" | "working" | "faint"
}

/** What a row says under its title: what it waits on, that it failed, that it works, or where and when. */
function rowDetail(thread: WebThread): RowDetail {
  if (thread.archived) return { text: `Archived ${copyAge(Date.parse(thread.archived.archivedAt))}`, tone: "faint" }
  if (thread.standing === "waiting") return { text: thread.waitingOn ?? "Waiting for you", tone: "caution" }
  if (thread.standing === "failed") return { text: "Its last turn failed", tone: "negative" }
  if (thread.quietSince) return { text: `${thread.where} is off · seen ${copyAge(Date.parse(thread.quietSince))}`, tone: "faint" }
  if (thread.standing === "working") return { text: "Working", tone: "working" }
  if (thread.standing === "moving") return { text: "Moving", tone: "working" }
  if (thread.waitingMessages) return { text: thread.waitingMessages === 1 ? "A message waits for it" : `${thread.waitingMessages} messages wait for it`, tone: "faint" }
  return { text: [thread.project, placeOf(thread)].filter(Boolean).join(" · "), tone: "faint" }
}

function threadLabel(thread: WebThread, detail: string): string {
  const harnesses = [...new Set(thread.sessions.map((session) => webHarnessLabel(session.row.harness)))].join(", ")
  return `${thread.title}. ${detail}. ${harnesses}.`
}

export function ThreadRow({ thread, selected, onOpen }: { thread: WebThread; selected: boolean; onOpen: () => void }) {
  const detail = rowDetail(thread)
  const cloud = thread.sessions.every((session) => session.row.runsOn.kind === "cloud")
  const PlaceIcon = cloud ? CloudIcon : LaptopIcon
  const live = !thread.quietSince && !thread.archived
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={selected ? "page" : undefined}
      aria-label={threadLabel(thread, detail.text)}
      data-thread={thread.id}
      data-standing={thread.standing}
      className={cn("web-row group relative flex w-full items-center gap-3.5 py-3 pr-4 pl-5 text-left", selected && "bg-fill-selected", thread.quietSince && "opacity-60")}
    >
      <span className="relative flex size-10 shrink-0 items-center justify-center rounded-full bg-raised">
        <HarnessMarks thread={thread} size="size-[18px]" />
        {live && (thread.standing === "waiting" || thread.standing === "failed") ? (
          <span aria-hidden className={cn("web-badge absolute -top-0.5 -right-0.5 size-3 rounded-full", thread.standing === "waiting" ? "bg-caution" : "bg-negative")} />
        ) : null}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-ui font-medium text-foreground">{thread.title}</span>
          <span className="tabular shrink-0 text-label text-faint">{formatRelative(thread.activityAt)}</span>
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-label">
          {detail.tone === "faint" && !thread.archived && !thread.quietSince && !thread.waitingMessages ? <PlaceIcon aria-hidden className="size-3 shrink-0 text-faint" /> : null}
          {detail.tone === "working" && live ? (
            <Shimmer text={detail.text} className="min-w-0 truncate" />
          ) : (
            <span className={cn("min-w-0 flex-1 truncate", detail.tone === "caution" ? "text-caution" : detail.tone === "negative" ? "text-negative" : "text-faint")}>{detail.text}</span>
          )}
        </span>
      </span>
    </button>
  )
}
