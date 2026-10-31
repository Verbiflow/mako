import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react"
import { CloudIcon, LaptopIcon, LinkIcon, MoonIcon, PanelRightIcon, PlusIcon, SearchIcon, SquareIcon, XIcon, ArchiveIcon } from "lucide-react"
import { toast } from "sonner"
import { CommandPalette } from "@/components/palette/command-palette"
import { AgentThreads } from "@/components/rail/agent-threads"
import { Divider } from "@/components/shell/divider"
import { RailToggle, TitleStrip } from "@/components/shell/title-bar"
import { SessionTabList } from "@/components/stage/session-tabs"
import { Welcome } from "@/components/transcript/transcript"
import { OceanScene } from "@/components/ui/ocean-scene"
import { WorkbenchStrip } from "@/components/stage/stage-strip"
import { Avatar } from "@/components/ui/avatar"
import { IconAction, Keys } from "@/components/ui/kit"
import { MakoMark } from "@/components/ui/mako-mark"
import { MenuItem } from "@/components/ui/menu"
import { ConfirmHost } from "@/components/ui/confirm-host"
import { TooltipProvider } from "@/components/ui/tooltip"
import { commands, formatChord, keysFor, matchesChord, registerCommands } from "@/extend/commands"
import { cn } from "@/lib/utils"
import { acp, acpStore, activeLiveAcp, useAcp } from "@/state/acp"
import { prefsStore, setPref, togglePref, usePrefs } from "@/state/prefs"
import { store } from "@/state/session"
import { useThreadTabs } from "@/state/thread-sessions"
import { routeWindow } from "@/state/window-routes"
import { useAccountList } from "./account-list"
import { useWebClient } from "./client"
import { followListing } from "./desk-listing"
import { webHarnessLabel } from "./labels"
import { StartForm, StartSheet, type AddingTo, type StartIn } from "./new-thread"
import { CLOUD_PLACE } from "./places"
import type { ScreenRoute, WebRoute } from "./route"
import { routeHref } from "./route"
import type { Started } from "./start"
import { startingWhere } from "./started"
import { archiveWithUndo } from "./archive-thread"
import { ThreadActions, ThreadBody, TranscriptLoading } from "./thread"
import { CLOUD_WHERE, foldThreads, openingSession, ownerOf, subtitle, waitingRank, type WebThread } from "./threads"
import { useThread } from "./use-thread"
import { ConnectMac } from "./connect-mac"
import { macConnection } from "./mac-connection"
import { macPlace, useReach } from "./reach"
import { ReviewLayer } from "./review-layer"
import { closeReview, deskReviewCode, openReview, reviewOpenStore, useReviewOpen } from "./review-open"

const Settings = lazy(() => import("./settings").then((module) => ({ default: module.Settings })))

/** The rail's narrowest and widest, as the desktop's. */
const RAIL_MIN = 200
const RAIL_MAX = 420
/**
 * New thread's chord in a browser. The desk's ⌘N and ⌘T belong to the browser itself (a window, a tab) and never reach a
 * page, so the web takes the chord web apps share for a new conversation; the palette offers it too.
 */
const NEW_THREAD_KEYS = "mod+shift+o"

/**
 * Mako in a laptop's browser: the desktop app, drawn by the desktop's own pieces. Its title strip (the rail's header on
 * the left, without a window's traffic lights), its rail (`AgentThreads`: every Thread on the account by project, its
 * Sessions folded into one row, Projects, Recent and Status, search and the filter), the open Thread's Sessions as the
 * desktop's tabs over its own transcript and composer, its command palette, and its keys: ⌘K for everything, ⌘B for
 * the rail, arrows through the rail, ⌥↑/⌥↓ between Threads, ⌘L to the composer, ⌘⎋ to stop.
 *
 * The rail reads the account's list as a Mac's window reads another device's Sessions (`desk-listing.ts`), and what it
 * opens comes here (`routeWindow`): a Session is an address, its Thread's page opens it through the gateway.
 */
export default function Desk({ route, navigate, back, onStarted }: { route: WebRoute; navigate: (route: WebRoute, how?: { replace?: boolean }) => void; back: () => void; onStarted: (started: Started, where: string) => void }) {
  const list = useAccountList((state) => state)
  const { threads } = useMemo(() => foldThreads(list), [list])
  const starting = route.kind === "new"
  const under: ScreenRoute = route.kind === "new" ? (route.over ?? { kind: "list" }) : route
  const selected = !starting && under.kind === "thread" ? under.thread : undefined
  const railOpen = usePrefs((prefs) => prefs.railOpen)
  const rail = useRef<HTMLDivElement>(null)
  // One step of the app at a time: opening another Thread replaces the one open, as the desk's rail does.
  const open = (next: ScreenRoute) => navigate(next, { replace: route.kind !== "list" })
  const [startIn, setStartIn] = useState<StartIn | undefined>(undefined)
  const newThread = (into?: StartIn) => {
    setStartIn(into)
    navigate({ kind: "new", over: under }, { replace: route.kind === "new" })
  }
  // The Thread on screen's `+`, which its pane answers with its own Add a Session.
  const addSession = useRef<(() => boolean) | null>(null)
  useEffect(() => followListing(), [])
  // A browser has no file manager to show a path in and no folder chooser: the desk's pieces don't offer either.
  useEffect(() => store.set({ machine: { fileManager: null, chooseFolder: false } }), [])
  const latest = useRef({ open, newThread, list })
  useEffect(() => {
    latest.current = { open, newThread, list }
  })
  useEffect(
    () =>
      routeWindow({
        open: (presence) => {
          if (presence.threadId) latest.current.open({ kind: "thread", thread: presence.threadId, ...(presence.sessionId && { session: presence.sessionId }) })
        },
        newSession: () => addSession.current?.() ?? false,
        newThreadIn: (cwd) => {
          // Where the folder's Sessions run: its Mac, or the cloud.
          const row = latest.current.list.rows.find((each) => each.folder === cwd)
          latest.current.newThread(row ? { place: row.runsOn.kind === "cloud" ? CLOUD_PLACE : row.runsOn.deviceId, project: cwd } : undefined)
        },
        threadMenu: (thread) => <DeskThreadMenu thread={thread} />,
      }),
    []
  )
  useDeskKeys({ threads, selected, open, newThread: () => newThread(), settings: () => open({ kind: "settings" }) })

  return (
    <TooltipProvider delayDuration={350}>
    <div className="web-desk flex min-h-0 min-w-0 flex-1 flex-col bg-shell">
      <DeskTitleBar starting={starting} onNew={() => newThread()} />
      <div className="relative flex min-h-0 min-w-0 flex-1">
        {railOpen ? (
          <>
            <nav ref={rail} aria-label="Threads" style={{ width: prefsStore.get().railWidth }} className="flex min-h-0 shrink-0 flex-col overflow-hidden">
              <AgentThreads />
              <DeskIdentity settings={!starting && under.kind === "settings"} onSettings={() => open({ kind: "settings" })} />
            </nav>
            <Divider
              side="left"
              size={prefsStore.get().railWidth}
              min={RAIL_MIN}
              max={RAIL_MAX}
              onResize={(next) => {
                if (rail.current) rail.current.style.width = `${next}px`
              }}
              onCommit={(next) => setPref("railWidth", next)}
            />
          </>
        ) : null}
        <main className="flex min-w-0 flex-1 flex-col bg-surface">
          {starting ? (
            <DeskStart key="new" startIn={startIn} onDismiss={back} onStarted={onStarted} />
          ) : under.kind === "thread" ? (
            <DeskThread key={under.thread} threadId={under.thread} sessionId={under.session} addSessionRef={addSession} onArchived={back} onSession={(session) => navigate({ kind: "thread", thread: under.thread, session }, { replace: true })} />
          ) : under.kind === "settings" ? (
            <Suspense fallback={null}>
              <Settings onBack={undefined} />
            </Suspense>
          ) : (
            <DeskEmpty onNew={() => newThread()} />
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
 * The desktop's title strip in a browser. The left segment heads the rail, with the rail's toggle and New; the right
 * holds what the desktop's does: Stop while a turn runs, search, and the right sidebar, which here is the Session's
 * Changes. The browser's own bar is above it, so there's no window to drag and no traffic lights to make room for.
 */
function DeskTitleBar({ starting, onNew }: { starting: boolean; onNew: () => void }) {
  const running = useAcp((state) => activeLiveAcp(state)?.session.status === "running")
  const live = useAcp((state) => activeLiveAcp(state)?.key)
  const changes = useReviewOpen((state) => state.open !== null)
  return (
    <TitleStrip
      leading={
        <>
          <RailToggle />
          <IconAction label="New thread" keys={formatChord(NEW_THREAD_KEYS)} data-on={starting || undefined} onClick={onNew}>
            <PlusIcon />
          </IconAction>
        </>
      }
      trailing={
        <>
          {running ? (
            <IconAction label="Stop" keys={formatChord("mod+escape")} tone="danger" onClick={() => void acp.cancel()}>
              <SquareIcon />
            </IconAction>
          ) : null}
          <IconAction label="Search threads and commands" keys={formatChord("mod+k")} onClick={() => window.dispatchEvent(new CustomEvent("mako:palette"))}>
            <SearchIcon />
          </IconAction>
          <IconAction label={changes ? "Hide changed files" : "Show changed files"} data-on={changes} disabled={!changes && !live} onClick={toggleChanges}>
            <PanelRightIcon />
          </IconAction>
        </>
      }
    />
  )
}

/** Changes beside the transcript, for the Session on screen, or away again: the desktop's right sidebar, here. */
function toggleChanges(): void {
  if (reviewOpenStore.get().open) return closeReview()
  const live = activeLiveAcp(acpStore.get())
  if (!live) return
  void deskReviewCode.read()
  openReview({ conversation: live.key, scope: { kind: "thread" } })
}

/**
 * The desk's commands, in its own registry, so its palette lists them with their keys and the keyboard layer runs them:
 * the palette, New, Settings, the rail, the composer, Stop, the next Thread that needs you, the next and previous
 * Thread, and every Thread by its title.
 */
function useDeskKeys({ threads, selected, open, newThread, settings }: { threads: WebThread[]; selected: string | undefined; open: (route: ScreenRoute) => void; newThread: () => void; settings: () => void }) {
  const latest = useRef({ threads, selected, open, newThread, settings })
  useEffect(() => {
    latest.current = { threads, selected, open, newThread, settings }
  })
  useEffect(() => {
    // ⌥↑ and ⌥↓ walk the rail's rows as it draws them, top to bottom, from the one lit.
    const step = (by: number) => () => {
      const rows = [...document.querySelectorAll<HTMLElement>("[data-thread-row]")].filter((row) => row.offsetParent !== null)
      if (!rows.length) return
      const at = rows.findIndex((row) => row.dataset.active !== undefined)
      const next = rows[at < 0 ? (by > 0 ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, at + by))]
      next?.click()
    }
    // In the desktop palette's order: what to look at, then what to do in a Session.
    return registerCommands([
      {
        id: "attention.next",
        title: "Open the next thread that needs you",
        section: "View",
        keys: "mod+shift+u",
        hint: "Approvals first, then questions, then anything else waiting on you",
        run: () => {
          const waiting = latest.current.threads.filter((thread) => thread.standing === "waiting" && thread.id !== latest.current.selected).sort((left, right) => waitingRank(left) - waitingRank(right))
          const next = waiting[0] ?? latest.current.threads.find((thread) => thread.standing === "failed" && thread.id !== latest.current.selected)
          if (next) latest.current.open({ kind: "thread", thread: next.id })
          else toast("Nothing is waiting for you")
        },
      },
      { id: "view.command-palette", title: "Open command palette", section: "View", keys: "mod+k", run: () => void window.dispatchEvent(new CustomEvent("mako:palette")) },
      { id: "view.toggle-rail", title: "Toggle the session list", section: "View", keys: "mod+b", run: () => togglePref("railOpen") },
      {
        id: "view.search-sessions",
        title: "Search sessions…",
        section: "View",
        keys: "mod+shift+l",
        run: () => {
          setPref("railOpen", true)
          requestAnimationFrame(() => window.dispatchEvent(new CustomEvent("mako:search-threads")))
        },
      },
      // The desk's own command for Changes: the open Session's turns, beside its transcript, and away again.
      { id: "view.changes", title: "Show changed files", section: "View", keywords: "review diff turn right sidebar", when: () => Boolean(reviewOpenStore.get().open ?? activeLiveAcp(acpStore.get())), run: toggleChanges },
      { id: "view.settings", title: "Settings", section: "View", keys: "mod+,", keywords: "preferences notifications theme sign out", run: () => latest.current.settings() },
      { id: "session.new", title: "New thread", section: "Session", keys: NEW_THREAD_KEYS, keywords: "start create", run: () => latest.current.newThread() },
      { id: "session.focus-composer", title: "Focus the composer", section: "Session", keys: "mod+l", run: () => document.querySelector<HTMLTextAreaElement>("main textarea:not([readonly]):not([disabled])")?.focus() },
      { id: "session.stop", title: "Stop the current turn", section: "Session", keys: "mod+escape", when: () => activeLiveAcp(acpStore.get())?.session.status === "running", run: () => void acp.cancel() },
      { id: "thread.next", title: "Next thread", section: "Session", keys: "alt+arrowdown", run: step(1) },
      { id: "thread.previous", title: "Previous thread", section: "Session", keys: "alt+arrowup", run: step(-1) },
    ])
  }, [])
  // Each Thread by its title: the palette's way to any of them from the keyboard.
  useEffect(
    () =>
      registerCommands(
        threads.map((thread) => ({
          id: `thread.open:${thread.id}`,
          title: thread.title,
          section: "Session" as const,
          hint: [thread.project, thread.where === CLOUD_WHERE ? "Cloud" : thread.where].filter(Boolean).join(" · "),
          keywords: [...new Set(thread.sessions.map((session) => webHarnessLabel(session.row.harness)))].join(" "),
          run: () => latest.current.open({ kind: "thread", thread: thread.id }),
        }))
      ),
    [threads]
  )
  // The keyboard layer, as the desk's: a chord runs its command; an unmodified key stays with what's being typed into.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return
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

/**
 * The rail's foot, where the desktop's says whose desk it is: the account, and Settings, which the browser keeps in the
 * pane rather than a menu of the desktop's own accounts (GitHub, harness sign-ins) that live on a Mac.
 */
function DeskIdentity({ settings, onSettings }: { settings: boolean; onSettings: () => void }) {
  const client = useWebClient()
  return (
    <div className="shrink-0 px-2 pt-1 pb-2">
      <button
        type="button"
        aria-label="Settings"
        aria-current={settings ? "page" : undefined}
        onClick={onSettings}
        className={cn("pressable flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1.5 text-left transition-colors duration-100 hover:bg-fill-hover", settings && "bg-fill-selected")}
      >
        <Avatar name={client.account.name} src={client.account.image ?? undefined} size={5} className="rounded-full" />
        <span className="min-w-0 flex-1 truncate text-ui text-foreground/85">{client.account.name || client.account.email}</span>
      </button>
    </div>
  )
}

/**
 * A Thread's menu in the rail, from its `…` or a right-click: what the browser can do with it, in the desktop's menu
 * rows. Its link, and archiving it as the list does: gone from the rail at once with Undo, then asked of the computer it
 * runs on (or its cloud machine ended).
 */
function DeskThreadMenu({ thread: id }: { thread: string | undefined }) {
  const client = useWebClient()
  const thread = useAccountList((state) => (id ? foldThreads(state).threads.find((each) => each.id === id) : undefined))
  if (!thread) return null
  const reachable = !thread.quietSince && !thread.archived
  const copyLink = async () => {
    const link = new URL(routeHref({ kind: "thread", thread: thread.id }, client.options.base), location.origin).href
    try {
      await navigator.clipboard.writeText(link)
      toast.success("Link copied", { description: thread.title })
    } catch {
      toast.error("The link wasn't copied", { description: link })
    }
  }
  return (
    <>
      <MenuItem onSelect={() => void copyLink()}>
        <LinkIcon className="size-3.5" />Copy link
      </MenuItem>
      {reachable ? (
        <MenuItem data-thread-action="archive" onSelect={() => archiveWithUndo(client, thread)}>
          <ArchiveIcon className="size-3.5" />Archive thread
        </MenuItem>
      ) : null}
    </>
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

/**
 * The open Thread: the desktop's strip (its Session tabs, the desktop's own, then where it runs and its menu), then
 * the Session's transcript and composer.
 */
function DeskThread({ threadId, sessionId, addSessionRef, onArchived, onSession }: { threadId: string; sessionId?: string; addSessionRef: React.RefObject<(() => boolean) | null>; onArchived: () => void; onSession: (session: string) => void }) {
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
  const session = thread ? (thread.sessions.find((each) => each.row.session === (sessionId ?? openedOn)) ?? openingSession(thread)) : undefined
  if (thread && session && sessionId === undefined && openedOn !== session.row.session && !thread.sessions.some((each) => each.row.session === openedOn)) setOpenedOn(session.row.session)
  const addingTo: AddingTo | undefined = thread && session?.row.folder && !thread.archived && !session.quietSince ? { thread: thread.id, folder: session.row.folder, owner: ownerOf(session), where: session.where === CLOUD_WHERE ? "Cloud" : session.where } : undefined
  const canAdd = addingTo !== undefined
  useEffect(() => {
    addSessionRef.current = canAdd
      ? () => {
          setAdding(true)
          return true
        }
      : null
    return () => {
      addSessionRef.current = null
    }
  }, [addSessionRef, canAdd])
  const tabs = useThreadTabs(useMemo(() => ({ thread: threadId, session: session?.row.session }), [threadId, session?.row.session]))
  if (!thread || !session) {
    const starting = startingWhere(threadId)
    return (
      <>
        <WorkbenchStrip>
          <span className="flex h-7 items-center gap-1.5 px-1.5 text-ui font-medium text-faint">
            <MakoMark className="size-4" />
            {starting ? `Starting on ${starting}…` : phase === "live" ? "Not in your list" : "Opening…"}
          </span>
        </WorkbenchStrip>
        {starting || phase !== "live" ? <TranscriptLoading /> : <p className="mx-auto max-w-[360px] px-6 pt-24 text-center text-ui text-muted-foreground">This Thread isn't in your list any more. It may have been archived or closed on another device.</p>}
      </>
    )
  }
  const Place = session.row.runsOn.kind === "cloud" ? CloudIcon : session.quietSince ? MoonIcon : LaptopIcon
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-thread-screen={thread.id}>
      <WorkbenchStrip
        end={
          <>
            <span className="flex min-w-0 shrink items-center gap-1.5 px-2 text-label text-faint">
              <Place aria-hidden className="size-3 shrink-0" />
              <span className="truncate">{subtitle(thread, session)}</span>
            </span>
            {thread.archived ? null : <ThreadActions desk thread={thread} session={session} onArchived={onArchived} onAdd={undefined} />}
          </>
        }
      >
        {tabs.length ? <SessionTabList tabs={tabs} here={{ thread: thread.id, session: session.row.session }} paneId="main" agentActive /> : null}
      </WorkbenchStrip>
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

/** New, as the desk's new thread: a tab of its own, the opening screen, and the composer tiled across the foot of the pane. */
function DeskStart({ startIn, onDismiss, onStarted }: { startIn: StartIn | undefined; onDismiss: () => void; onStarted: (started: Started, where: string) => void }) {
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
      <WorkbenchStrip
        end={
          <IconAction label="Close" keys={["Esc"]} size="xs" className="mr-1" onClick={onDismiss}>
            <XIcon />
          </IconAction>
        }
      >
        <div role="tab" aria-selected data-active className="relative flex h-7 w-56 min-w-16 max-w-56 shrink items-center gap-1.5 overflow-hidden rounded-md bg-raised px-1.5 text-ui font-medium text-foreground">
          <MakoMark className="size-4" />
          <span className="truncate">New thread</span>
        </div>
      </WorkbenchStrip>
      {/* The desktop's opening screen, its pane's own: the engraving under the headline and the composer, whose chips
          say where it runs and in what. */}
      <div className="agent-surface relative isolate flex min-h-0 flex-1 flex-col overflow-hidden">
        <OceanScene />
        <div className="min-h-0 flex-1 overflow-y-auto">
          <Welcome />
        </div>
        <StartForm desk startIn={startIn} onStarted={onStarted} />
      </div>
    </section>
  )
}
