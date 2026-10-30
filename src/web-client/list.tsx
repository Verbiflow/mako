import { useEffect, useMemo, useRef, useState } from "react"
import { ArchiveIcon, ChevronRightIcon, CloudIcon, LaptopIcon, MoonIcon, SquarePenIcon } from "lucide-react"
import { Avatar } from "@/components/ui/avatar"
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
import { useDelayedStatus } from "./delayed-status"
import { InstallCard } from "./install-card"
import { usePullToRefresh } from "./pull"
import { PullIndicator } from "./pull-indicator"
import { archiveWithUndo, useArchiving } from "./archive-thread"
import { isUnread, noteListed, useReadState, type ReadState } from "./read-state"
import { useRowGestures } from "./row-gestures"
import { RowMenu } from "./row-menu"
import { shownTitle } from "./renames"
import { rowDetail, type RowContext } from "./rows"
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

/**
 * The account's Threads under a finger. On a phone, the first screen: its bar says where you are and holds your
 * account, rows run edge to edge, parted by hairlines, and New floats at the bottom right in thumb's reach, a small
 * round button that steps aside while the list is scrolled down and comes back on the way up. On a tablet, the rail
 * beside what's open: rows inset and rounded, the one open lit, New at its head and your account at its foot.
 */
export function ThreadList({ selected, onOpen, onNew, onSettings, wide, starting = false, settings = false }: { selected?: string; onOpen: (thread: WebThread) => void; onNew: () => void; onSettings: () => void; wide: boolean; starting?: boolean; settings?: boolean }) {
  const client = useWebClient()
  const list = useAccountList((state) => state)
  const folded = useMemo(() => foldThreads(list), [list])
  // A Thread swiped away leaves the list at once; it's back only if the archive is taken back or refused.
  const hidden = useArchiving((state) => state.hidden)
  const threads = useMemo(() => (hidden.size ? folded.threads.filter((thread) => !hidden.has(thread.id)) : folded.threads), [folded, hidden])
  const { archived } = folded
  const read = useReadState((state) => state)
  // Threads listed here for the first time read as seen: only what happens from now on is news.
  useEffect(() => {
    if (list.phase === "live") noteListed(folded.threads)
  }, [list.phase, folded])
  const now = useTick(threads.some((thread) => thread.standing === "working"))
  // The held row's menu; `serial` starts each one afresh, a rename half-typed in the last one left behind.
  const [menu, setMenu] = useState<{ thread: WebThread; anchor: HTMLElement | null; open: boolean; serial: number } | undefined>(undefined)
  const rowProps = (thread: WebThread) => {
    const context = rowContext(thread, read, now)
    return {
      thread,
      selected: thread.id === selected,
      named,
      context,
      // A dot for news: a run that finished since it was last opened here, or the person's own mark.
      unread: Boolean(read.unread[thread.id]) || context.done === true,
      swipe: !thread.archived && !thread.quietSince,
      onOpen: () => onOpen(thread),
      onHold: (anchor: HTMLElement | null) => setMenu((last) => ({ thread, anchor, open: true, serial: (last?.serial ?? 0) + 1 })),
      onArchive: () => archiveWithUndo(client, thread),
    }
  }
  const [showArchived, setShowArchived] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const dock = useRef<HTMLDivElement>(null)
  // The list scrolls clear of what floats at its foot: its last row ends above the install offer, however tall.
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
  const away = useAwayWhileScrolling(scroller, !wide)
  useRowFlip(scroller, showArchived ? "archived" : "threads")
  const named = macCount(list) > 1
  return (
    <div data-list={wide ? "rail" : "screen"} className={cn("web-list relative flex min-h-0 flex-1 flex-col", wide ? "bg-shell" : "bg-surface")}>
      <header className="web-bar flex shrink-0 items-center gap-0.5 pr-1.5 pl-4">
        <h1 className="min-w-0 flex-1 truncate text-title font-semibold">Threads</h1>
        {wide ? (
          <>
            <ListPhase list={list} />
            <button type="button" aria-label="New thread" aria-pressed={starting} onClick={onNew} className={cn("web-icon-button", starting && "bg-fill-selected text-foreground")}>
              <SquarePenIcon className="size-[19px]" />
            </button>
          </>
        ) : (
          <>
            <ListPhase list={list} />
            <button type="button" aria-label="Settings" onClick={onSettings} className="web-icon-button">
              <Avatar name={client.account.name} src={client.account.image ?? undefined} size={6} className="rounded-full" />
            </button>
          </>
        )}
      </header>
      <div ref={scroller} className="web-scroll relative min-h-0 flex-1 overflow-y-auto">
        <PullIndicator pulled={pull.pulled} refreshing={pull.refreshing} />
        <div ref={content} className="pb-[calc(var(--dock,0px)+24px)]">
          {threads.length === 0 && archived.length === 0 ? (
            <EmptyList answered={list.phase === "live" || list.asOf !== undefined} onNew={onNew} />
          ) : (
            <>
              {sections(threads).map((section) => (
                <section key={section.id} aria-labelledby={`section-${section.id}`} className="web-section">
                  <h2 id={`section-${section.id}`} className="web-section-label">
                    {section.label}
                  </h2>
                  <ul role="list" className="web-rows">
                    {section.threads.map((thread) => (
                      <li key={thread.id} data-flip-key={thread.id}>
                        <ThreadRow {...rowProps(thread)} />
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </>
          )}
          {archived.length ? (
            <section className="pt-5">
              <button type="button" onClick={() => setShowArchived((shown) => !shown)} aria-expanded={showArchived} className="web-section-label pressable flex min-h-11 w-full items-center gap-1.5">
                <ArchiveIcon className="size-3.5" />
                {archived.length === 1 ? "1 archived" : `${archived.length} archived`}
                <ChevronRightIcon className={cn("size-3.5 transition-transform duration-200 ease-[var(--ease-out)]", showArchived && "rotate-90")} />
              </button>
              {showArchived ? (
                <ul role="list" className="web-rows">
                  {archived.map((thread) => (
                    <li key={thread.id} data-flip-key={`archived:${thread.id}`}>
                      <ThreadRow {...rowProps(thread)} />
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          ) : null}
        </div>
      </div>
      {/* What floats at the foot of the list, stacked so nothing covers anything: on a phone New, and under it the
          install offer while it shows, above the Home indicator. */}
      <div ref={dock} className="web-list-foot">
        {wide ? null : (
          <button type="button" aria-label="New thread" onClick={onNew} data-away={away || undefined} className="web-fab">
            <SquarePenIcon aria-hidden className="size-[21px]" strokeWidth={1.9} />
          </button>
        )}
        <InstallCard />
      </div>
      <RowMenu
        key={menu?.serial}
        thread={menu?.thread}
        open={menu?.open ?? false}
        anchor={menu?.anchor ?? null}
        unread={menu ? isUnread(read, menu.thread) : false}
        onDismiss={() => setMenu((shown) => (shown ? { ...shown, open: false } : shown))}
        onArchive={(thread) => archiveWithUndo(client, thread)}
      />
      {wide ? (
        <footer className="shrink-0 border-t border-hairline p-2">
          <button type="button" aria-label="Settings" aria-current={settings ? "page" : undefined} onClick={onSettings} className="web-account">
            <Avatar name={client.account.name} src={client.account.image ?? undefined} size={6} className="rounded-full" />
            <span className="min-w-0 flex-1 truncate text-left">{client.account.name || client.account.email}</span>
          </button>
        </footer>
      ) : null}
    </div>
  )
}

/**
 * Where the list stands, when it isn't simply live: painted from this browser's last visit, or following again. Said
 * only once it has lasted 400 ms, and then for 400 ms at least, so a reconnect that's over in a moment never flickers.
 */
function ListPhase({ list }: { list: AccountListState }) {
  const label = useDelayedStatus(
    list.phase === "live" || list.phase === "signed-out" ? null : list.phase === "starting" ? "Connecting…" : list.phase === "cached" && list.asOf ? `As of ${copyAge(list.asOf)}` : "Reconnecting…"
  )
  if (!label) return null
  return (
    <span role="status" className="flex items-center gap-1.5 text-label text-faint">
      <Spinner aria-hidden className="size-3" />
      {label}
    </span>
  )
}

/** No Threads to list: said only once the account has answered so. Until then (or while it can't), the rows' shapes. */
function EmptyList({ answered, onNew }: { answered: boolean; onNew: () => void }) {
  if (!answered)
    return (
      <div className="skeleton-rows flex flex-col gap-1 px-4 pt-5" aria-hidden>
        {[0.62, 0.48, 0.7, 0.4].map((width) => (
          <div key={width} className="flex items-center gap-3 py-2.5">
            <span className="skeleton size-[18px] rounded-md" />
            <span className="flex flex-1 flex-col gap-1.5">
              <span className="skeleton h-3.5 rounded" style={{ width: `${width * 100}%` }} />
              <span className="skeleton h-3 w-1/3 rounded" />
            </span>
          </div>
        ))}
      </div>
    )
  return (
    <div className="web-enter mx-auto flex max-w-[300px] flex-col items-center px-6 pt-28 text-center">
      <MakoMark className="size-8 opacity-35" />
      <p className="mt-5 text-title font-medium">No threads yet</p>
      <p className="mt-1.5 text-ui text-muted-foreground">Start one here or on a Mac; it shows up here as it runs.</p>
      <button type="button" onClick={onNew} className="web-button mt-6">
        <SquarePenIcon className="size-4" />
        New thread
      </button>
    </div>
  )
}

/** Marks a stack draws in a row's mark column: one is read at a glance, three still fit side by side. */
const STACK_SIZES = [18, 15, 11] as const

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

function threadLabel(thread: WebThread, detail: string, unread: boolean): string {
  const harnesses = [...new Set(thread.sessions.map((session) => webHarnessLabel(session.row.harness)))].join(", ")
  return `${shownTitle(thread)}. ${unread ? "Unread. " : ""}${detail}. ${harnesses}.${thread.quietSince ? ` ${thread.where} is off, seen ${copyAge(Date.parse(thread.quietSince))}.` : ""}`
}

/** When this browser first saw each Thread at work, for one whose owner doesn't say when its run started. */
const seenWorking = new Map<string, number>()

/** What a row reads besides its Thread: the clock, when its run started, and whether it finished unread. */
function rowContext(thread: WebThread, read: ReadState, now: number): RowContext {
  if (thread.standing !== "working") {
    seenWorking.delete(thread.id)
    const seen = read.seen[thread.id]
    return { done: thread.standing === "idle" && !thread.archived && seen !== undefined && thread.activityAt > seen }
  }
  let since = thread.workingSince
  if (since === undefined) {
    since = seenWorking.get(thread.id) ?? now
    seenWorking.set(thread.id, since)
  }
  return { now, workingSince: since }
}

/** The clock, ticking each second while `on` (a row counts its run), else still. */
function useTick(on: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!on) return
    const tick = () => setNow(Date.now())
    const first = setTimeout(tick, 0)
    const timer = setInterval(tick, 1000)
    return () => {
      clearTimeout(first)
      clearInterval(timer)
    }
  }, [on])
  return now
}

/**
 * One Thread in the list. Under a finger it opens as the finger lifts, offers its menu when held, and swipes left to
 * Archive (`row-gestures.ts`). Its title is set in medium, except while it's at work: that doesn't need the person yet.
 * A run that finished since it was last opened here leads its line with "Done" and marks it unread.
 */
export function ThreadRow({ thread, selected, named, onOpen, context = {}, unread = false, swipe = false, onHold, onArchive }: { thread: WebThread; selected: boolean; named: boolean; onOpen: () => void; context?: RowContext; unread?: boolean; swipe?: boolean; onHold?: (anchor: HTMLElement | null) => void; onArchive?: () => void }) {
  const detail = rowDetail(thread, named, context)
  const box = useRef<HTMLDivElement>(null)
  const front = useRef<HTMLButtonElement>(null)
  useRowGestures(box, front, swipe, { onTap: onOpen, onHold: () => onHold?.(box.current), onArchive: () => onArchive?.() })
  // A Mac that's off says so on its own rows, dimmed with a moon where its laptop stood, rather than in a line of its own.
  const Place = detail.place === "cloud" ? CloudIcon : thread.quietSince ? MoonIcon : LaptopIcon
  const receding = thread.standing === "working" || thread.standing === "moving"
  const spoken = detail.elapsed ? `${detail.text} for ${detail.elapsed}` : detail.lead ? `${detail.lead}, ${detail.text}` : detail.text
  return (
    <div ref={box} className="web-swipe">
      {swipe ? (
        <div className="web-swipe-actions" aria-hidden>
          <button type="button" tabIndex={-1} data-swipe-action className="web-swipe-archive">
            <ArchiveIcon className="size-5" />
            <span>Archive</span>
          </button>
        </div>
      ) : null}
      <button
        ref={front}
        type="button"
        onClick={onOpen}
        aria-current={selected ? "page" : undefined}
        aria-label={threadLabel(thread, spoken, unread)}
        data-thread={thread.id}
        data-standing={thread.standing}
        data-unread={unread || undefined}
        className={cn("web-row group relative flex w-full items-center text-left", thread.quietSince && "opacity-60")}
      >
        <span className="web-row-mark">
          <HarnessMarks thread={thread} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className={cn("min-w-0 flex-1 truncate text-ui text-foreground", receding ? "font-normal" : "font-medium")}>{shownTitle(thread)}</span>
            <span className="flex shrink-0 items-center gap-1.5 self-center">
              {unread ? <span aria-hidden data-unread-mark className="size-2 rounded-full bg-foreground" /> : null}
              <span className="tabular text-label text-faint">{formatRelative(thread.activityAt)}</span>
            </span>
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-label">
            {detail.place ? <Place aria-hidden className="size-3 shrink-0 text-faint" /> : null}
            {detail.tone === "working" ? (
              <Shimmer className="min-w-0 truncate">
                {detail.text}
                {detail.elapsed ? <span className="tabular"> {detail.elapsed}</span> : null}
              </Shimmer>
            ) : (
              <span className={cn("min-w-0 flex-1 truncate", detail.tone === "caution" ? "text-caution" : detail.tone === "negative" ? "text-negative" : "text-faint")}>
                {detail.lead ? (
                  <>
                    <span data-done className="font-medium text-foreground">
                      {detail.lead}
                    </span>
                    {" · "}
                  </>
                ) : null}
                {detail.text}
              </span>
            )}
          </span>
        </span>
      </button>
    </div>
  )
}

/** How far the list must travel one way before New steps aside or comes back: a nudge doesn't move it. */
const AWAY_AFTER_PX = 24

/**
 * Whether New steps aside: scrolled down past a short run it leaves, scrolled back up it returns, and at the top or
 * the bottom of the list it's always there. Read per frame from the scroll, so a reversal mid-way brings it straight back.
 */
function useAwayWhileScrolling(scroller: React.RefObject<HTMLDivElement | null>, on: boolean): boolean {
  const [away, setAway] = useState(false)
  useEffect(() => {
    const node = scroller.current
    if (!node || !on) return
    let turnedAt = node.scrollTop
    let last = node.scrollTop
    let down = false
    const scrolled = () => {
      const top = node.scrollTop
      const going = top > last
      if (going !== down) {
        down = going
        turnedAt = last
      }
      last = top
      const atEnd = top <= 0 || top + node.clientHeight >= node.scrollHeight - 2
      if (atEnd) setAway(false)
      else if (Math.abs(top - turnedAt) > AWAY_AFTER_PX) setAway(down)
    }
    node.addEventListener("scroll", scrolled, { passive: true })
    return () => node.removeEventListener("scroll", scrolled)
  }, [scroller, on])
  return away
}
