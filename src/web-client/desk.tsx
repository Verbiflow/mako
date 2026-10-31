import { lazy, Suspense, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react"
import { ArchiveIcon, ArrowDownIcon, ArrowUpIcon, ChevronRightIcon, CloudIcon, FolderIcon, LaptopIcon, MoonIcon, PlusIcon, SearchIcon, XIcon } from "lucide-react"
import { CommandPalette } from "@/components/palette/command-palette"
import { ROW_SURFACE } from "@/components/rail/thread-row"
import { ThreadStatusMark } from "@/components/rail/thread-status"
import { Avatar } from "@/components/ui/avatar"
import { IconAction, Keys } from "@/components/ui/kit"
import { MakoMark } from "@/components/ui/mako-mark"
import { ConfirmHost } from "@/components/ui/confirm-host"
import { TooltipProvider } from "@/components/ui/tooltip"
import { commands, formatChord, keysFor, matchesChord, registerCommands } from "@/extend/commands"
import { copyAge } from "@/lib/format"
import { cn } from "@/lib/utils"
import { acp, acpStore, activeLiveAcp } from "@/state/acp"
import { prefsStore } from "@/state/prefs"
import type { ThreadStatus } from "@/state/thread-status"
import { useAccountList } from "./account-list"
import { useWebClient } from "./client"
import { webHarnessLabel } from "./labels"
import { HarnessMarks } from "./list"
import { StartForm, StartSheet, type AddingTo } from "./new-thread"
import type { ScreenRoute, WebRoute } from "./route"
import type { Started } from "./start"
import { startingWhere } from "./started"
import { ThreadActions, ThreadBody, TranscriptLoading } from "./thread"
import { CLOUD_WHERE, foldThreads, openingSession, ownerOf, subtitle, type WebSession, type WebThread } from "./threads"
import { useThread } from "./use-thread"
import { followedWay, listedMove, useMoves } from "./moves"
import { ConnectMac } from "./connect-mac"
import { macConnection } from "./mac-connection"
import { macPlace, useReach } from "./reach"
import { ReviewLayer } from "./review-layer"
import { closeReview, deskReviewCode, openReview, reviewOpenStore } from "./review-open"
import { WebHarnessIcon } from "./harness-icon"

const Settings = lazy(() => import("./settings").then((module) => ({ default: module.Settings })))

/** The rail's width: the desk's own, as its title strip's left segment is. */
const RAIL_PX = 264
/**
 * New thread's chord in a browser. The desk's ⌘N and ⌘T belong to the browser itself (a window, a tab) and never reach a
 * page, so the web takes the chord web apps share for a new conversation; the palette offers it too.
 */
const NEW_THREAD_KEYS = "mod+shift+o"

/**
 * Mako in a laptop's browser: the desktop app. The title strip whose left segment heads the rail, the rail of every
 * Thread on the account (each Mac's and the cloud's, by project), the open Thread's Sessions as tabs over the
 * desktop's own transcript and composer, the desktop's command palette, and its keys: ⌘K for everything, arrows
 * through the rail, ⌥↑/⌥↓ between Threads, ⌘L to the composer, ⌘⎋ to stop.
 */
export default function Desk({ route, navigate, back, onStarted }: { route: WebRoute; navigate: (route: WebRoute, how?: { replace?: boolean }) => void; back: () => void; onStarted: (started: Started, where: string) => void }) {
  const list = useAccountList((state) => state)
  const { threads, archived } = useMemo(() => foldThreads(list), [list])
  const ordered = useMemo(() => railGroups(threads).flatMap((group) => group.threads), [threads])
  const starting = route.kind === "new"
  const under: ScreenRoute = route.kind === "new" ? (route.over ?? { kind: "list" }) : route
  const selected = !starting && under.kind === "thread" ? under.thread : undefined
  // One step of the app at a time: opening another Thread replaces the one open, as the desk's rail does.
  const open = (next: ScreenRoute) => navigate(next, { replace: route.kind !== "list" })
  const newThread = () => navigate({ kind: "new", over: under }, { replace: route.kind === "new" })
  useDeskKeys({ ordered, selected, open, newThread, settings: () => open({ kind: "settings" }) })

  return (
    <TooltipProvider delayDuration={350}>
    <div className="web-desk flex min-h-0 min-w-0 flex-1 flex-col bg-shell">
      <header className="flex h-[38px] shrink-0 items-center border-b border-hairline bg-shell pr-2">
        <div style={{ width: RAIL_PX }} className="flex h-full shrink-0 items-center gap-1 border-r border-hairline px-2">
          <span className="flex min-w-0 flex-1 items-center gap-2 pl-1 text-ui font-medium text-foreground">
            <MakoMark className="size-3.5 opacity-80" />
            Mako
          </span>
          <IconAction label="New thread" keys={formatChord(NEW_THREAD_KEYS)} data-on={starting || undefined} onClick={newThread}>
            <PlusIcon />
          </IconAction>
        </div>
        <span className="flex-1" />
        <IconAction label="Search threads and commands" keys={formatChord("mod+k")} onClick={() => window.dispatchEvent(new CustomEvent("mako:palette"))}>
          <SearchIcon />
        </IconAction>
      </header>
      <div className="flex min-h-0 flex-1">
        <DeskRail threads={threads} archived={archived} selected={selected} settings={!starting && under.kind === "settings"} onOpen={(thread) => open({ kind: "thread", thread: thread.id })} onSettings={() => open({ kind: "settings" })} />
        <main className="flex min-w-0 flex-1 flex-col bg-surface">
          {starting ? (
            <DeskStart key="new" onDismiss={back} onStarted={onStarted} />
          ) : under.kind === "thread" ? (
            <DeskThread key={under.thread} threadId={under.thread} sessionId={under.session} onArchived={back} onSession={(session) => navigate({ kind: "thread", thread: under.thread, session }, { replace: true })} />
          ) : under.kind === "settings" ? (
            <Suspense fallback={null}>
              <Settings onBack={undefined} />
            </Suspense>
          ) : (
            <DeskEmpty onNew={newThread} />
          )}
        </main>
        <ReviewLayer form="desk" place={under.kind === "thread" && !starting ? `thread:${under.thread}` : starting ? "new" : under.kind} />
      </div>
      <CommandPalette />
      <ConfirmHost />
    </div>
    </TooltipProvider>
  )
}

/**
 * The desk's commands, in its own registry, so its palette lists them with their keys and the keyboard layer runs them:
 * the palette, New, Settings, the composer, Stop, the next and previous Thread, and every Thread by its title.
 */
function useDeskKeys({ ordered, selected, open, newThread, settings }: { ordered: WebThread[]; selected: string | undefined; open: (route: ScreenRoute) => void; newThread: () => void; settings: () => void }) {
  const latest = useRef({ ordered, selected, open, newThread, settings })
  useEffect(() => {
    latest.current = { ordered, selected, open, newThread, settings }
  })
  useEffect(() => {
    const step = (by: number) => () => {
      const { ordered: rows, selected: at, open: go } = latest.current
      if (!rows.length) return
      const index = rows.findIndex((thread) => thread.id === at)
      const next = rows[index < 0 ? (by > 0 ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, index + by))]
      if (next) go({ kind: "thread", thread: next.id })
    }
    return registerCommands([
      { id: "view.command-palette", title: "Open command palette", section: "View", keys: "mod+k", run: () => void window.dispatchEvent(new CustomEvent("mako:palette")) },
      { id: "session.new", title: "New thread", section: "Session", keys: NEW_THREAD_KEYS, keywords: "start create", run: () => latest.current.newThread() },
      { id: "view.settings", title: "Settings", section: "View", keys: "mod+,", keywords: "preferences notifications theme sign out", run: () => latest.current.settings() },
      { id: "session.focus-composer", title: "Focus the composer", section: "Session", keys: "mod+l", run: () => document.querySelector<HTMLTextAreaElement>("main textarea:not([readonly]):not([disabled])")?.focus() },
      { id: "session.stop", title: "Stop the current turn", section: "Session", keys: "mod+escape", when: () => activeLiveAcp(acpStore.get())?.session.status === "running", run: () => void acp.cancel() },
      { id: "thread.next", title: "Next thread", section: "Session", keys: "alt+arrowdown", run: step(1) },
      { id: "thread.previous", title: "Previous thread", section: "Session", keys: "alt+arrowup", run: step(-1) },
      // The desk's own command for Changes: the open Session's turns, beside its transcript, and away again.
      {
        id: "view.changes",
        title: "Show changed files",
        section: "View",
        keywords: "review diff turn",
        when: () => Boolean(reviewOpenStore.get().open ?? activeLiveAcp(acpStore.get())),
        run: () => {
          if (reviewOpenStore.get().open) return closeReview()
          const live = activeLiveAcp(acpStore.get())
          if (!live) return
          void deskReviewCode.read()
          openReview({ conversation: live.key, scope: { kind: "thread" } })
        },
      },
    ])
  }, [])
  // Each Thread by its title: the palette's way to any of them from the keyboard.
  useEffect(
    () =>
      registerCommands(
        ordered.map((thread) => ({
          id: `thread.open:${thread.id}`,
          title: thread.title,
          section: "Session" as const,
          hint: [thread.project, thread.where === CLOUD_WHERE ? "Cloud" : thread.where].filter(Boolean).join(" · "),
          keywords: [...new Set(thread.sessions.map((session) => webHarnessLabel(session.row.harness)))].join(" "),
          run: () => latest.current.open({ kind: "thread", thread: thread.id }),
        }))
      ),
    [ordered]
  )
  // The keyboard layer, as the desk's: a chord runs its command; an unmodified key stays with what's being typed into.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      const mod = event.metaKey || event.ctrlKey
      if (!mod && !event.altKey && typingInto(event.target)) return
      const overrides = prefsStore.get().keybindings
      for (const command of commands.list()) {
        const keys = keysFor(command, overrides)
        if (!keys || !matchesChord(event, keys) || command.when?.() === false) continue
        event.preventDefault()
        void command.run()
        return
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])
}

function typingInto(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || target.matches("input, textarea, select"))
}

/** The rail's groups, as the desk's Projects view draws them: a project on its Mac (or the cloud), newest first. */
function railGroups(threads: readonly WebThread[]) {
  const groups = new Map<string, { key: string; project: string; place: string; cloud: boolean; latest: number; threads: WebThread[] }>()
  for (const thread of threads) {
    const cloud = thread.where === CLOUD_WHERE
    const place = cloud ? "Cloud" : thread.where
    const project = thread.project ?? place
    const key = `${place}\u0000${project}`
    const group = groups.get(key) ?? { key, project, place, cloud, latest: 0, threads: [] }
    group.threads.push(thread)
    group.latest = Math.max(group.latest, thread.activityAt)
    groups.set(key, group)
  }
  for (const group of groups.values()) group.threads.sort((left, right) => right.activityAt - left.activityAt)
  return [...groups.values()].sort((left, right) => right.latest - left.latest)
}

/** What a row's trailing mark says, in the desk rail's own vocabulary (`ThreadStatusMark`). */
function statusOf(thread: WebThread): ThreadStatus {
  if (thread.standing === "waiting") {
    const waiting: ThreadStatus = { kind: "needs-permission", since: thread.activityAt }
    if (thread.waitingOn) waiting.detail = thread.waitingOn
    return waiting
  }
  if (thread.standing === "failed") return { kind: "failed", at: thread.activityAt }
  if (thread.standing === "working" || thread.standing === "moving") return { kind: "working", since: thread.activityAt, detail: thread.standing === "moving" ? "Moving" : "Working" }
  return { kind: "idle" }
}

function DeskRail({ threads, archived, selected, settings, onOpen, onSettings }: { threads: WebThread[]; archived: WebThread[]; selected: string | undefined; settings: boolean; onOpen: (thread: WebThread) => void; onSettings: () => void }) {
  const client = useWebClient()
  const phase = useAccountList((state) => state.phase)
  const groups = useMemo(() => railGroups(threads), [threads])
  const [showArchived, setShowArchived] = useState(false)
  // Arrows walk the rail's rows, Home and End go to its ends; Enter or Space opens the one focused.
  const walk = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) || event.altKey || event.metaKey || event.ctrlKey) return
    const rows = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-desk-row]")]
    if (!rows.length) return
    event.preventDefault()
    const at = rows.findIndex((row) => row === document.activeElement)
    const next = event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1 : Math.min(rows.length - 1, Math.max(0, at + (event.key === "ArrowDown" ? 1 : -1)))
    rows[next]?.focus()
  }
  return (
    <nav aria-label="Threads" style={{ width: RAIL_PX }} className="flex min-h-0 shrink-0 flex-col border-r border-hairline bg-shell">
      <div onKeyDown={walk} className="min-h-0 flex-1 overflow-y-auto px-2 pt-2 pb-4 [scrollbar-width:thin]">
        {groups.length === 0 ? (
          phase === "starting" ? (
            <div className="skeleton-rows flex flex-col gap-2 px-1.5 pt-2" aria-hidden>
              {[0.7, 0.5, 0.62, 0.44].map((width) => (
                <span key={width} className="skeleton h-3.5 rounded" style={{ width: `${width * 100}%` }} />
              ))}
            </div>
          ) : (
            <p className="px-1.5 pt-2 text-ui text-faint">No threads yet.</p>
          )
        ) : null}
        {groups.map((group) => (
          <section key={group.key} aria-label={`${group.project} on ${group.place}`} className="pb-2">
            <h2 className="flex h-7 items-center gap-2 px-1.5 text-ui text-muted-foreground">
              {group.cloud ? <CloudIcon aria-hidden className="size-3.5 shrink-0" /> : <FolderIcon aria-hidden className="size-3.5 shrink-0" />}
              <span className="min-w-0 shrink-0 truncate font-medium text-foreground/90">{group.project}</span>
              {group.project !== group.place ? <span className="min-w-0 truncate text-label text-faint">{group.place}</span> : null}
            </h2>
            <ul role="list" className="flex flex-col">
              {group.threads.map((thread) => (
                <li key={thread.id}>
                  <DeskRow thread={thread} lit={thread.id === selected} onOpen={() => onOpen(thread)} />
                </li>
              ))}
            </ul>
          </section>
        ))}
        {archived.length ? (
          <section className="pt-1">
            <button type="button" aria-expanded={showArchived} onClick={() => setShowArchived((shown) => !shown)} className={cn(ROW_SURFACE, "px-1.5 text-ui text-faint")}>
              <ArchiveIcon aria-hidden className="size-3.5" />
              {archived.length === 1 ? "1 archived" : `${archived.length} archived`}
              <ChevronRightIcon aria-hidden className={cn("size-3.5 transition-transform duration-150 ease-[var(--ease-out)]", showArchived && "rotate-90")} />
            </button>
            {showArchived ? (
              <ul role="list" className="flex flex-col">
                {archived.map((thread) => (
                  <li key={thread.id}>
                    <DeskRow thread={thread} lit={thread.id === selected} onOpen={() => onOpen(thread)} />
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        ) : null}
      </div>
      <footer className="shrink-0 px-2 pb-2">
        <button type="button" aria-label="Settings" aria-current={settings ? "page" : undefined} data-active={settings || undefined} onClick={onSettings} className={cn(ROW_SURFACE, "h-9 gap-2.5 px-1.5")}>
          <Avatar name={client.account.name} src={client.account.image ?? undefined} size={5} className="rounded-full" />
          <span className="min-w-0 flex-1 truncate text-ui text-foreground/85">{client.account.name || client.account.email}</span>
        </button>
      </footer>
    </nav>
  )
}

/** A rail row as the desk draws one: its agents' marks, its title, and its state or its age at the trailing edge. */
function DeskRow({ thread, lit, onOpen }: { thread: WebThread; lit: boolean; onOpen: () => void }) {
  const quiet = thread.quietSince ? `${thread.where} is asleep or offline, seen ${copyAge(Date.parse(thread.quietSince))}` : undefined
  // On its way between a Mac and the cloud: a blinking arrow, up or down, as the phone's row wears.
  const way = useMoves((state) => followedWay(state.moves.get(thread.id))) ?? listedMove(thread)?.way
  const Arrow = way === "device" ? ArrowDownIcon : ArrowUpIcon
  const harnesses = [...new Set(thread.sessions.map((session) => webHarnessLabel(session.row.harness)))].join(", ")
  return (
    <button
      type="button"
      data-desk-row
      data-thread={thread.id}
      data-standing={thread.standing}
      data-moving={way}
      data-active={lit || undefined}
      aria-current={lit ? "page" : undefined}
      aria-label={`${thread.title}. ${thread.waitingOn ?? (thread.standing === "idle" ? "" : thread.standing)}${harnesses ? ` ${harnesses}.` : ""}${quiet ? ` ${quiet}.` : ""}`.replace(/\.\s+\./g, ".")}
      title={[thread.title, thread.waitingOn, quiet].filter(Boolean).join("\n")}
      onClick={onOpen}
      className={cn(ROW_SURFACE, "pl-1.5", quiet && "opacity-60")}
    >
      <HarnessMarks thread={thread} size={14} />
      <span className={cn("min-w-0 flex-[1_1_60%] truncate text-ui", lit ? "font-medium text-foreground" : "text-foreground/85")}>{thread.title}</span>
      {quiet ? <MoonIcon aria-hidden className="size-3 shrink-0 text-faint" /> : null}
      {way ? <Arrow aria-label={way === "cloud" ? "Moving to the cloud" : "Coming back from the cloud"} data-move-mark={way} className="web-move-blink size-3 shrink-0 text-foreground" /> : null}
      <span className="flex shrink-0 items-center pr-1">
        <ThreadStatusMark status={statusOf(thread)} updatedAt={new Date(thread.activityAt).toISOString()} />
      </span>
    </button>
  )
}

/** Nothing open: the fin, and the two keys that start everything. */
function DeskEmpty({ onNew }: { onNew: () => void }) {
  // An account with no Mac heard from yet: the checklist that connects one, in the pane, following along on its own.
  const list = useAccountList((state) => state)
  const places = useReach((state) => state.places)
  const needsMac = useMemo(() => list.phase === "live" && list.rows.length === 0 && !macConnection(list, new Set([...list.devices.keys()].filter((id) => places.get(macPlace(id))?.ok))).heard, [list, places])
  const [connecting, setConnecting] = useState(false)
  if (needsMac && !connecting) setConnecting(true)
  if (connecting)
    return (
      <div className="web-enter flex min-h-0 flex-1 flex-col items-center justify-center px-6">
        <div className="w-full max-w-[420px]">
          <ConnectMac onDone={() => setConnecting(false)} />
        </div>
      </div>
    )
  return (
    <div className="web-enter flex min-h-0 flex-1 flex-col items-center justify-center gap-6 text-center">
      <MakoMark className="size-9 opacity-25" />
      <div className="flex flex-col gap-1.5 text-ui text-muted-foreground">
        <button type="button" onClick={onNew} className="pressable flex h-8 items-center justify-between gap-8 rounded-md px-2.5 hover:bg-fill-hover hover:text-foreground">
          New thread <Keys keys={formatChord(NEW_THREAD_KEYS)} />
        </button>
        <button type="button" onClick={() => window.dispatchEvent(new CustomEvent("mako:palette"))} className="pressable flex h-8 items-center justify-between gap-8 rounded-md px-2.5 hover:bg-fill-hover hover:text-foreground">
          Search threads and commands <Keys keys={formatChord("mod+k")} />
        </button>
      </div>
    </div>
  )
}

/** The pane's strip, as the desk's: the open Thread's Sessions as tabs, where it runs, and its menu. */
function DeskStrip({ children, end }: { children: React.ReactNode; end?: React.ReactNode }) {
  return (
    <div className="flex h-11 shrink-0 items-center gap-1 border-b border-hairline bg-surface px-2">
      <div role="tablist" aria-label="Sessions in this Thread" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none]">
        {children}
      </div>
      {end}
    </div>
  )
}

function DeskTab({ selected, onClick, icon, label, waiting }: { selected: boolean; onClick?: () => void; icon: React.ReactNode; label: string; waiting?: boolean }) {
  return (
    <button type="button" role="tab" aria-selected={selected} onClick={onClick} className={cn("pressable flex h-8 max-w-[280px] shrink-0 items-center gap-1.5 rounded-md px-2 text-ui font-medium", selected ? "bg-raised text-foreground" : "text-muted-foreground hover:bg-fill-hover hover:text-foreground")}>
      {icon}
      <span className="truncate">{label}</span>
      {waiting ? <span aria-label="waiting for you" className="size-1.5 shrink-0 rounded-full bg-caution" /> : null}
    </button>
  )
}

function DeskThread({ threadId, sessionId, onArchived, onSession }: { threadId: string; sessionId?: string; onArchived: () => void; onSession: (session: string) => void }) {
  const thread = useThread(threadId)
  const phase = useAccountList((state) => state.phase)
  const client = useWebClient()
  const [adding, setAdding] = useState(false)
  const [openedOn, setOpenedOn] = useState<string | undefined>(undefined)
  const seenThread = thread?.id
  useEffect(() => {
    if (!seenThread) return
    const seen = () => {
      if (document.visibilityState === "visible") void client.push.seen(seenThread).catch(() => undefined)
    }
    seen()
    document.addEventListener("visibilitychange", seen)
    return () => document.removeEventListener("visibilitychange", seen)
  }, [client, seenThread])
  if (!thread) {
    const starting = startingWhere(threadId)
    return (
      <>
        <DeskStrip>
          <DeskTab selected icon={<MakoMark className="size-3.5 opacity-70" />} label={starting ? `Starting on ${starting}…` : phase === "live" ? "Not in your list" : "Opening…"} />
        </DeskStrip>
        {starting || phase !== "live" ? <TranscriptLoading /> : <p className="mx-auto max-w-[360px] px-6 pt-24 text-center text-ui text-muted-foreground">This Thread isn't in your list any more. It may have been archived or closed on another device.</p>}
      </>
    )
  }
  const session = thread.sessions.find((each) => each.row.session === (sessionId ?? openedOn)) ?? openingSession(thread)
  if (sessionId === undefined && openedOn !== session.row.session && !thread.sessions.some((each) => each.row.session === openedOn)) setOpenedOn(session.row.session)
  const owner = ownerOf(session)
  const addingTo: AddingTo | undefined = session.row.folder && !thread.archived && !session.quietSince ? { thread: thread.id, folder: session.row.folder, owner, where: session.where === CLOUD_WHERE ? "Cloud" : session.where } : undefined
  const Place = session.row.runsOn.kind === "cloud" ? CloudIcon : session.quietSince ? MoonIcon : LaptopIcon
  const tabLabel = (each: WebSession) => (thread.sessions.length === 1 ? thread.title : (each.row.title ?? webHarnessLabel(each.row.harness)))
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-thread-screen={thread.id}>
      <DeskStrip
        end={
          <>
            <span className="flex min-w-0 shrink items-center gap-1.5 px-2 text-label text-faint">
              <Place aria-hidden className="size-3 shrink-0" />
              <span className="truncate">{subtitle(thread, session)}</span>
            </span>
            {thread.archived ? null : <ThreadActions thread={thread} session={session} onArchived={onArchived} onAdd={undefined} />}
          </>
        }
      >
        {thread.sessions.map((each) => (
          <DeskTab key={each.row.session} selected={each.row.session === session.row.session} onClick={() => onSession(each.row.session)} icon={<WebHarnessIcon harness={each.row.harness} className="size-3.5 shrink-0" />} label={tabLabel(each)} waiting={each.row.state === "waiting" && !each.quietSince && each.row.session !== session.row.session} />
        ))}
        {addingTo ? (
          <IconAction label="New session" size="xs" className="shrink-0" onClick={() => setAdding(true)}>
            <PlusIcon />
          </IconAction>
        ) : null}
      </DeskStrip>
      <ThreadBody thread={thread} session={session} desk />
      {addingTo ? (
        <StartSheet
          open={adding}
          adding={addingTo}
          onDismiss={() => setAdding(false)}
          onStarted={(started) => {
            setAdding(false)
            const listed = thread.sessions.find((each) => each.row.conversation === started.conversationId)
            if (listed) onSession(listed.row.session)
          }}
        />
      ) : null}
    </div>
  )
}

/** New, as the desk's new tab: a tab of its own, an empty page, and the composer tiled across the foot of the pane. */
function DeskStart({ onDismiss, onStarted }: { onDismiss: () => void; onStarted: (started: Started, where: string) => void }) {
  // Escape leaves, unless a choice of the start's is open over it: that one closes first.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || document.querySelector(".web-sheet-layer[data-open]")) return
      onDismiss()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onDismiss])
  return (
    <section aria-label="New thread" className="web-start-pane flex min-h-0 flex-1 flex-col">
      <DeskStrip
        end={
          <IconAction label="Close" keys={["Esc"]} onClick={onDismiss}>
            <XIcon />
          </IconAction>
        }
      >
        <DeskTab selected icon={<PlusIcon className="size-3.5 shrink-0" />} label="New thread" />
      </DeskStrip>
      <div className="web-enter flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <MakoMark className="size-8 opacity-25" />
      </div>
      <StartForm desk onStarted={onStarted} />
    </section>
  )
}
