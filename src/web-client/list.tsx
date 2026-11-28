import { ExitScene } from "@/components/ui/exit"
import { useExit } from "@/components/ui/exit-motion"
import { observeVisibleAnimation } from "@/lib/visible-animation"
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react"
import { ArchiveIcon, ArrowDownIcon, ArrowUpIcon, ChevronRightIcon, CloudIcon, InboxIcon, MessagesSquareIcon, MoonIcon, SearchIcon, ServerIcon, SquarePenIcon } from "lucide-react"
import { loadWebSettings, paletteThreads, useThreadOpener } from "./palette-threads"
import type { PaletteItem } from "@/components/palette/palette-search"
import { askWords, childLine, childStateOf, childWord, finsAsChildren, rollup, rollupLabel } from "@mako/host/contracts/children"
import type { NativeAgent } from "@mako/host/contracts/native-agents"
import { WORK_STATUS_WORDS } from "@mako/host/contracts/thread-marks"
import { RailRow } from "@/components/rail/rail-row"
import { WorkGlyph } from "@/components/rail/work-status"
import { finMarkState, motionOf } from "@/lib/live-mark-state"
import { avatarHue, monogram } from "@/lib/rail-marks"
import { threadChildren, useAcp } from "@/state/acp-state"
import { personAsks } from "@/state/fin-asks"
import { createHook, createStore, shallowEqual } from "@/state/store"
import { Avatar } from "@/components/ui/avatar"
import { useRowFlip } from "@/components/rail/use-row-flip"
import { LiveMark } from "@/components/ui/live-mark"
import type { LiveMarkState } from "@/lib/live-mark-state"
import { Spinner } from "@/components/ui/spinner"
import { WebHarnessIcon } from "./harness-icon"
import { MakoMark } from "@/components/ui/mako-mark"
import { copyAge, formatRelative } from "@/lib/format"
import { cn } from "@/lib/utils"
import { useAccountList, type AccountListState } from "./account-list"
import { useWebClient } from "./client"
import { useWebApexesOf } from "./apexes"
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
import { foldThreads, type ThreadStanding, type WebThread } from "./threads"
import { webHarnessLabel } from "./labels"
import { computerCount } from "./places"
import { followedWays, listedMove, useMoves } from "./moves"
import type { MoveWay } from "./move-progress"
import { ConnectMac } from "./connect-mac"
import { macConnection } from "./mac-connection"
import { macPlace, useReach } from "./reach"
import { DiagnosisCard } from "./trouble"
import { placedWaiting, useWebFinAsks, webInboxCount } from "./inbox"
import { checkList, useListDiagnosis, useTryAgain } from "./trouble-state"
import { CHATS_KEY, railGroups, type RailGroup } from "./rail-groups"
import { SetupCard } from "./setup-card"
import { settleAskedMarks, shownMarks, useAskedMarks, type ShownMarks } from "./thread-marks"

/**
 * What the person folded and unfolded in the list this visit: a project's rows put away, an Apex's Fins all shown, a
 * project's Done Threads shown. Not kept past the visit: the list opens as the desk's rail does by default.
 */
interface ListFolds {
  closedProjects: ReadonlySet<string>
  openApexes: ReadonlySet<string>
  shownDone: ReadonlySet<string>
}
const foldsStore = createStore<ListFolds>({ closedProjects: new Set(), openApexes: new Set(), shownDone: new Set() })
const useFolds = createHook(foldsStore)

function toggleFold(which: keyof ListFolds, key: string): void {
  const next = new Set(foldsStore.get()[which])
  if (!next.delete(key)) next.add(key)
  foldsStore.set({ ...foldsStore.get(), [which]: next })
}

/**
 * The account's Threads under a finger, in the desk's rail's anatomy: grouped by project under each project's tile, an
 * Apex's Fins hung under it on a 1 px line, where its work stands and when beside each title. On a phone, the first
 * screen: its bar says where you are and holds your account, Finish setting up heads the rows while there's something
 * to do, and New floats at the bottom right in thumb's reach, a square that steps aside while the list is scrolled
 * down and comes back on the way up. On a tablet, the rail beside what's open, the one open lit, the desk's New thread
 * and Inbox rows at its head and your account at its foot. A row swipes left to Archive and offers its menu when held.
 */
export function ThreadList({ selected, onOpen, onNew, onSettings, onInbox, wide, starting = false, settings = false, inbox = false }: { selected?: string; onOpen: (thread: WebThread) => void; onNew: () => void; onSettings: () => void; onInbox?: () => void; wide: boolean; starting?: boolean; settings?: boolean; inbox?: boolean }) {
  const client = useWebClient()
  const list = useAccountList((state) => state)
  const folded = useMemo(() => foldThreads(list), [list])
  // A Thread swiped away leaves the list at once; it's back only if the archive is taken back or refused.
  const hidden = useArchiving((state) => state.hidden)
  const threads = useMemo(() => (hidden.size ? folded.threads.filter((thread) => !hidden.has(thread.id)) : folded.threads), [folded, hidden])
  const { archived, placed } = folded
  const fins = useWebFinAsks()
  const byId = useMemo(() => new Map(threads.map((thread) => [thread.id, thread])), [threads])
  // A Fin placed on another device hangs under its Apex's row; one whose Apex isn't listed stands in its project.
  const { placedByApex, unplaced } = useMemo(() => {
    const under = new Map<string, WebThread[]>()
    const alone: WebThread[] = []
    for (const thread of placed) {
      const apex = thread.apex?.thread
      if (apex && byId.has(apex)) under.set(apex, [...(under.get(apex) ?? []), thread])
      else alone.push(thread)
    }
    return { placedByApex: under, unplaced: alone }
  }, [placed, byId])
  // Search: the desk's palette over every Thread listed here, Fins and archived ones too; its rows open as a row does.
  useThreadOpener(onOpen)
  // The palette's code loads the first time Search is pressed: a phone's list opens without it.
  const [searchAsked, setSearchAsked] = useState(0)
  const searchRows = useMemo(() => (searchAsked ? paletteThreads([...threads, ...placed, ...archived]) : []), [searchAsked, threads, placed, archived])
  const read = useReadState((state) => state)
  const asked = useAskedMarks((state) => state)
  // Threads listed here for the first time read as seen: only what happens from now on is news.
  useEffect(() => {
    if (list.phase === "live") noteListed(folded.threads)
  }, [list.phase, folded])
  // Each Mac's Apexes, read now, so an Apex's digest opens with its conversation.
  useWebApexesOf(client, folded.threads)
  // What this browser asked an owner to mark, once its rows say it, is theirs to say again.
  useEffect(() => settleAskedMarks([...folded.threads, ...folded.placed, ...folded.archived]), [folded])
  const now = useTick(threads.some((thread) => thread.standing === "working"))
  const groups = useMemo(() => railGroups([...threads, ...unplaced], (thread) => shownMarks(thread, asked), now), [threads, unplaced, asked, now])
  // The held row's menu; `serial` starts each one afresh, a rename half-typed in the last one left behind.
  const [menu, setMenu] = useState<{ thread: WebThread; anchor: HTMLElement | null; open: boolean; serial: number } | undefined>(undefined)
  // Which way each followed move goes, and only that: a step's bytes re-render no row.
  const ways = useMoves((state) => followedWays(state.moves), shallowEqual)
  const named = computerCount(list) > 1
  const rowProps = (thread: WebThread) => {
    const context = rowContext(thread, read, now, ways[thread.id])
    const marks = shownMarks(thread, asked)
    return {
      thread,
      selected: thread.id === selected,
      named,
      context,
      marks,
      // News: a run that finished since it was last opened here, or a Mark as unread, here or on any device.
      unread: Boolean(read.unread[thread.id]) || context.done === true || marks.markedUnread,
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
  // Any draw of this list may have moved a row, so each one is a new order to read.
  useRowFlip(scroller, showArchived ? "archived" : "threads", {})
  return (
    <div data-list={wide ? "rail" : "screen"} className={cn("web-list relative flex min-h-0 flex-1 flex-col", wide ? "bg-shell" : "bg-surface")}>
      {/* A phone's screen says where you are and holds your account; an iPad's rail, as the desk's, has no title of its
          own: only the notch's room, and where the list stands while it isn't simply live. */}
      {wide ? (
        <header data-rail-head className="flex min-h-[calc(env(safe-area-inset-top)+12px)] shrink-0 items-end justify-end px-4 pt-[env(safe-area-inset-top)]">
          <ListPhase list={list} />
        </header>
      ) : (
        <header className="web-bar flex shrink-0 items-center gap-0.5 pr-1.5 pl-4">
          <h1 className="min-w-0 flex-1 truncate text-title font-semibold">Threads</h1>
          <ListPhase list={list} />
          <button type="button" aria-label="Settings" onClick={onSettings} className="web-icon-button">
            <Avatar name={client.account.name} src={client.account.image ?? undefined} size={6} />
          </button>
        </header>
      )}
      <div ref={scroller} className="web-scroll relative min-h-0 flex-1 overflow-y-auto">
        <PullIndicator pulled={pull.pulled} refreshing={pull.refreshing} />
        <div ref={content} className="pb-[calc(var(--dock,0px)+24px)]">
          <ListTrouble />
          {wide || list.phase === "starting" ? null : <SetupCard onNew={onNew} onSettings={onSettings} />}
          <ListTop wide={wide} starting={starting} onNew={onNew} onSearch={threads.length > 0 || archived.length > 0 ? () => setSearchAsked((asked) => asked + 1) : undefined} inbox={onInbox && (threads.length > 0 || archived.length > 0) ? { count: webInboxCount(threads, fins, placed), open: inbox, onOpen: onInbox } : undefined} />
          {threads.length === 0 && archived.length === 0 ? (
            <EmptyList answered={list.phase === "live" || list.asOf !== undefined} onNew={onNew} />
          ) : groups.length ? (
            <>
              <h2 data-list-heading className="web-section-label pt-4">
                Projects
              </h2>
              {groups.map((group) => (
                <ProjectGroup key={group.key} group={group} rowProps={rowProps} placedByApex={placedByApex} onOpen={onOpen} />
              ))}
            </>
          ) : null}
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
        unread={menu ? isUnread(read, menu.thread) || shownMarks(menu.thread, asked).markedUnread : false}
        onDismiss={() => setMenu((shown) => (shown ? { ...shown, open: false } : shown))}
        onArchive={(thread) => archiveWithUndo(client, thread)}
      />
      {/* Finish setting up, at the rail's foot on an iPad as on the desk; at the head of a phone's list. */}
      {wide && list.phase !== "starting" ? <SetupCard onNew={onNew} onSettings={onSettings} /> : null}
      {wide ? (
        <footer className="shrink-0 p-2">
          <button type="button" aria-label="Settings" aria-current={settings ? "page" : undefined} onClick={onSettings} className="web-account">
            <Avatar name={client.account.name} src={client.account.image ?? undefined} size={6} />
            <span className="min-w-0 flex-1 truncate text-left">{client.account.name || client.account.email}</span>
          </button>
        </footer>
      ) : null}
      {searchAsked ? (
        <Suspense fallback={null}>
          <TouchSearch rows={searchRows} asked={searchAsked} />
        </Suspense>
      ) : null}
    </div>
  )
}

type RowProps = Parameters<typeof ThreadRow>[0]

/**
 * One project: its row (the project's tile and name, a tap folding its Threads away, a dot while folded if one needs
 * the person), its Threads with each Apex's Fins under it, and its Done Threads past three days as one "N done" line.
 */
function ProjectGroup({ group, rowProps, placedByApex, onOpen }: { group: RailGroup; rowProps: (thread: WebThread) => RowProps; placedByApex: ReadonlyMap<string, readonly WebThread[]>; onOpen: (thread: WebThread) => void }) {
  const closed = useFolds((state) => state.closedProjects.has(group.key))
  const doneShown = useFolds((state) => state.shownDone.has(group.key))
  const needs = group.threads.some((thread) => thread.standing === "waiting" && !thread.quietSince)
  const rows = (threads: readonly WebThread[]) =>
    threads.map((thread) => (
      <li key={thread.id} data-flip-key={thread.id}>
        <ListedThread {...rowProps(thread)} placed={placedByApex.get(thread.id)} onOpenThread={onOpen} />
      </li>
    ))
  return (
    <section data-project-group={group.key || "chats"} aria-label={group.name} className="web-project">
      <button type="button" data-project-row aria-expanded={!closed} onClick={() => toggleFold("closedProjects", group.key)} className="web-project-row">
        {group.key === CHATS_KEY ? (
          <span aria-hidden className="flex size-5 shrink-0 items-center justify-center text-faint">
            <MessagesSquareIcon className="size-4" strokeWidth={1.75} />
          </span>
        ) : (
          <ProjectTile name={group.name} folder={group.key} />
        )}
        <span data-project-name className="min-w-0 flex-1 truncate text-ui font-medium text-foreground/80">{group.name}</span>
        {closed && needs ? <span data-folder-needs aria-label="Something here needs you" className="rail-attention-dot" /> : null}
      </button>
      {closed ? null : (
        <>
          <ul role="list" className="web-rows web-nest">
            {rows(group.threads)}
          </ul>
          {group.done.length ? (
            <>
              <button type="button" data-done-fold={group.done.length} aria-expanded={doneShown} onClick={() => toggleFold("shownDone", group.key)} className="web-done-line">
                <WorkGlyph status="done" className="size-3.5" />
                {group.done.length} done
                <ChevronRightIcon aria-hidden className={cn("size-3.5 transition-transform duration-200 ease-[var(--ease-out)]", doneShown && "rotate-90")} />
              </button>
              {doneShown ? (
                <ul role="list" className="web-rows web-nest" data-done-rows>
                  {rows(group.done)}
                </ul>
              ) : null}
            </>
          ) : null}
        </>
      )}
    </section>
  )
}

/**
 * A project's tile, as the desk's rail draws it without a GitHub avatar (which the web has no host to fetch): its
 * monogram in one of eight hues hashed from its folder.
 */
function ProjectTile({ name, folder }: { name: string; folder: string }) {
  return (
    <span aria-hidden data-project-avatar="monogram" className={cn("rail-avatar web-tile flex shrink-0 items-center justify-center", `rail-hue-${avatarHue(folder)}`)}>
      {monogram(name)}
    </span>
  )
}

/** An Apex's Fins as this page knows them: the roster it holds once opened here, or else as its row lists them. */
function useApexRoster(thread: WebThread): readonly NativeAgent[] {
  const listed = thread.sessions.find((session) => session.summary.fins)?.summary.fins
  const held = useAcp((state) => threadChildren(state, thread.id))
  return held.length ? held : finsAsChildren(listed)
}

/** A Thread's row, and when it's an Apex, its Fins hung under it. */
function ListedThread({ placed = NO_THREADS, onOpenThread, ...row }: RowProps & { placed?: readonly WebThread[]; onOpenThread: (thread: WebThread) => void }) {
  const roster = useApexRoster(row.thread)
  const open = useFolds((state) => state.openApexes.has(row.thread.id))
  const hung = useMemo(() => hungFins(roster, placed, open), [roster, placed, open])
  if (!roster.length && !placed.length) return <ThreadRow {...row} />
  const counts = rollup(roster)
  const hangs = hung.placed.length + hung.fins.length + hung.finished > 0
  return (
    <>
      <ThreadRow {...row} apex={{ open, hangs, finsWorking: counts.working > 0, counts: rollupLabel(counts), onToggle: () => toggleFold("openApexes", row.thread.id) }} />
      {hangs ? <ApexFins apex={row.thread} hung={hung} open={open} onOpen={onOpenThread} /> : null}
    </>
  )
}

const NO_THREADS: readonly WebThread[] = []

/** What hangs under an Apex: its placed Fins and its own to show, what each asks the person, and how many finished. */
/** A Fin's ask of the person: the whole of it for a reader, and the question alone for the few words its row has room for. */
interface HungAsk {
  words: string
  question: string
}

interface HungFins {
  placed: readonly WebThread[]
  fins: ReadonlyArray<{ agent: NativeAgent; ask: HungAsk | undefined }>
  finished: number
}

/**
 * Folded, the Fins that wait on the person; open, every Fin still in play, those that need the person first, then the
 * finished counted. A Fin placed on another device is its own Thread's row, which says it rather than the roster.
 */
function hungFins(roster: readonly NativeAgent[], placed: readonly WebThread[], open: boolean): HungFins {
  const asks = new Map(personAsks(roster).map((ask) => [ask.fin, ask]))
  const own = new Set(placed.map((thread) => thread.id))
  const fins = roster.filter((agent) => !own.has(agent.child?.thread ?? ""))
  const asked = (agent: NativeAgent) => asks.has(agent.child?.thread ?? "")
  const waiting = new Set(placedWaiting(placed).map((thread) => thread.id))
  const asking = fins.filter(asked)
  const live = open ? fins.filter((agent) => !asked(agent) && childStateOf(agent).kind !== "ended") : []
  return {
    placed: [...placed.filter((thread) => waiting.has(thread.id)), ...(open ? placed.filter((thread) => !waiting.has(thread.id)) : [])],
    fins: [...asking, ...live].map((agent) => {
      const ask = asks.get(agent.child?.thread ?? "")
      return { agent, ask: ask ? { words: askWords(ask), question: ask.question } : undefined }
    }),
    finished: open ? fins.filter((agent) => !asked(agent) && childStateOf(agent).kind === "ended").length : 0,
  }
}

/**
 * An Apex's Fins under its row, as the desk's rail hangs them: a 1 px line from the Apex's fin and a square elbow into
 * each, the finished as one line at the end. A Fin opens its Apex, where its card answers it; one placed on another
 * device opens its own Thread, where that device answers.
 */
function ApexFins({ apex, hung, open, onOpen }: { apex: WebThread; hung: HungFins; open: boolean; onOpen: (thread: WebThread) => void }) {
  const count = hung.placed.length + hung.fins.length
  const last = (index: number) => index === count - 1 && !hung.finished
  // A Fin that finishes or is answered leaves its place and those under it come up (`exit.tsx`); folding or opening
  // the Apex is another view of it, which its rows don't leave for.
  const exit = useExit<HTMLDivElement>(`hung-fins:${apex.id}`)
  return (
    <div ref={exit} data-hung-fins={apex.id} data-hung-fins-open={open || undefined}>
      <ExitScene scene={open ? "open" : "folded"}>
      {hung.placed.map((thread, index) => (
        <PlacedFinRow key={thread.id} thread={thread} last={last(index)} onOpen={() => onOpen(thread)} />
      ))}
      {hung.fins.map(({ agent, ask }, index) => (
        <FinRow key={agent.nativeId} agent={agent} ask={ask} last={last(hung.placed.length + index)} onOpen={() => onOpen(apex)} />
      ))}
      </ExitScene>
      {hung.finished ? (
        <div data-fins-finished={hung.finished} className="web-fins-finished">
          <span aria-hidden className="rail-branch" data-last />
          {hung.finished} finished
        </div>
      ) : null}
    </div>
  )
}

/** One Fin of an Apex: its mark, its title, and what it asks the person beside it. */
function FinRow({ agent, ask, last, onOpen }: { agent: NativeAgent; ask: HungAsk | undefined; last: boolean; onOpen: () => void }) {
  const state = childStateOf(agent)
  const line = ask?.words ?? childLine(state)
  const exit = useExit<HTMLButtonElement>(`fin-row:${agent.nativeId}`, { motion: "shrink" })
  return (
    <button
      ref={exit}
      type="button"
      onClick={onOpen}
      data-fin-row={agent.child?.thread}
      data-asking-fin={ask ? agent.child?.thread : undefined}
      aria-label={[agent.title, ask ? "needs you" : childWord(state), line].filter(Boolean).join(", ")}
      className="web-fin-row"
    >
      <span aria-hidden className="rail-branch" data-last={last || undefined} />
      <span className="web-row-mark">
        <LiveMark kind="fin" state={finMarkState(state)} motion={motionOf(childLine(state))} label={childWord(state)}>
          <WebHarnessIcon harness={agent.provider} />
        </LiveMark>
      </span>
      <span data-asking-title className={cn("min-w-0 flex-1 truncate text-ui", ask ? "text-foreground" : "text-foreground/65")}>{agent.title}</span>
      {ask ? (
        <span data-asking-line className="max-w-[48%] shrink truncate text-label text-faint">
          {ask.question}
        </span>
      ) : null}
    </button>
  )
}

/** A Fin placed on another device, under its Apex: its own Thread, opened where that device answers it. */
function PlacedFinRow({ thread, last, onOpen }: { thread: WebThread; last: boolean; onOpen: () => void }) {
  const detail = rowDetail(thread, true)
  const asks = thread.standing === "waiting"
  const exit = useExit<HTMLButtonElement>(`placed-fin-row:${thread.id}`, { motion: "shrink" })
  return (
    <button ref={exit} type="button" onClick={onOpen} data-thread={thread.id} data-under={thread.apex?.thread} data-standing={thread.standing} aria-label={`${shownTitle(thread)}. ${detail.where ? `On ${detail.where}. ` : ""}${detail.text}.`} className={cn("web-fin-row", thread.quietSince && "opacity-60")}>
      <span aria-hidden className="rail-branch" data-last={last || undefined} />
      <span className="web-row-mark">
        <LiveMark kind="fin" state={STANDING_MARK[thread.standing]}>
          <WebHarnessIcon harness={thread.sessions[0]?.row.harness ?? "claude"} />
        </LiveMark>
      </span>
      <span className={cn("min-w-0 flex-1 truncate text-ui", asks ? "text-foreground" : "text-foreground/65")}>{shownTitle(thread)}</span>
      {asks ? (
        <span data-asking-line className="max-w-[48%] shrink truncate text-label text-faint">
          {detail.where ? <span data-row-where>{detail.where} · </span> : null}
          {detail.text}
        </span>
      ) : null}
    </button>
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

/**
 * The list can't be followed: why (this phone offline, or Mako Cloud not answering), with Try again, said once it has
 * lasted a moment so a reconnect that's over at once never shows. The rows stay as last heard beneath it.
 */
function ListTrouble() {
  const client = useWebClient()
  const diagnosis = useListDiagnosis()
  const { checking, tryAgain } = useTryAgain(() => checkList(client))
  const shown = useDelayedStatus(diagnosis ? diagnosis.headline : null)
  if (!diagnosis || !shown) return null
  return <DiagnosisCard diagnosis={diagnosis} checking={checking} onTryAgain={tryAgain} compact className="web-trouble-list" />
}

/**
 * No Threads to list: said only once the account has answered so. Until then (or while it can't), the rows' shapes.
 * An account with no Mac heard from yet gets the checklist that connects one, following along on its own.
 */
function EmptyList({ answered, onNew }: { answered: boolean; onNew: () => void }) {
  const list = useAccountList((state) => state)
  const places = useReach((state) => state.places)
  const needsMac = useMemo(() => !macConnection(list, new Set([...list.devices.keys()].filter((id) => places.get(macPlace(id))?.ok))).heard && !list.rows.some((row) => row.runsOn.kind === "device"), [list, places])
  // Kept up while it says it's done, a beat, then it gives way.
  const [connecting, setConnecting] = useState(false)
  if (answered && needsMac && !connecting) setConnecting(true)
  if (answered && connecting)
    return (
      <div className="web-enter mx-auto flex max-w-[380px] flex-col px-5 pt-10">
        <ConnectMac onDone={() => setConnecting(false)} />
      </div>
    )
  if (!answered)
    return (
      <div className="skeleton-rows flex flex-col gap-1 px-4 pt-5" aria-hidden>
        {[0.62, 0.48, 0.7, 0.4].map((width) => (
          <div key={width} className="flex items-center gap-3 py-2.5">
            <span className="skeleton size-[18px]" />
            <span className="flex flex-1 flex-col gap-1.5">
              <span className="skeleton h-3.5" style={{ width: `${width * 100}%` }} />
              <span className="skeleton h-3 w-1/3" />
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

const STANDING_MARK = { waiting: "needs", failed: "failed", working: "working", moving: "starting", idle: "idle" } satisfies Record<ThreadStanding, LiveMarkState>

/**
 * A Thread's live mark, as the desk's rail draws it (`LiveMark`): the agent of the Session that speaks for it, and its
 * standing round it; a run that finished unread wears the dot. Its size and the colour its dot is cut from come from
 * the list it's in (`.web-row-mark`).
 */
export function WebThreadMark({ thread, unread }: { thread: WebThread; unread: boolean }) {
  const speaking = thread.sessions.find((session) => session.row.state === thread.standing) ?? thread.sessions.at(-1)
  const state = thread.standing === "idle" && unread ? "unread" : STANDING_MARK[thread.standing]
  return (
    <LiveMark state={state} fresh={state === "unread"}>
      <WebHarnessIcon harness={speaking?.row.harness ?? "claude"} />
    </LiveMark>
  )
}

function threadLabel(thread: WebThread, detail: string, unread: boolean): string {
  const harnesses = [...new Set(thread.sessions.map((session) => webHarnessLabel(session.row.harness)))].join(", ")
  return `${shownTitle(thread)}. ${unread ? "Unread. " : ""}${detail}. ${harnesses}.${thread.quietSince ? ` ${thread.where} is asleep or offline, seen ${copyAge(Date.parse(thread.quietSince))}.` : ""}`
}

/** When this browser first saw each Thread at work, for one whose owner doesn't say when its run started. */
const seenWorking = new Map<string, number>()

/** What a row reads besides its Thread: the clock, when its run started, whether it finished unread, a move under way. */
function rowContext(thread: WebThread, read: ReadState, now: number, followed: MoveWay | undefined): RowContext {
  const way = followed ?? listedMove(thread)?.way
  if (way) return { move: way }
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

/** An Apex's row's fold: whether its Fins are all shown, whether any is at work, their counts, and the tap that folds. */
export interface ApexFold {
  open: boolean
  /** Fins hang under it: its fin's line runs down to them. */
  hangs: boolean
  finsWorking: boolean
  counts: string
  onToggle: () => void
}

/**
 * A title's tone, as the desk's rail sets it (`titleTone`): the open one full and medium, one that needs the person or
 * holds news full, a Done one faded, the rest quieter.
 */
function titleTone(selected: boolean, thread: WebThread, unread: boolean, marks: ShownMarks): string {
  if (selected) return "font-medium text-foreground"
  if (unread || thread.standing === "waiting") return "text-foreground"
  if (marks.workStatus === "done") return "text-foreground/45"
  return "text-foreground/72"
}

/**
 * One Thread in the list, in the desk's rail's anatomy at touch size: its live mark (an Apex's fin, which folds and
 * unfolds its Fins), its title, what it waits on the person for beside it, then at its end its Fins at work, where it
 * runs when that's not a Mac, its Status and its time. Under a finger it opens as the finger lifts, offers its menu
 * when held, and swipes left to Archive (`row-gestures.ts`). News (a run that finished since it was last opened here, a
 * Mark as unread from any device) wears the unread sphere and a full-tone title; a Done one fades.
 */
export function ThreadRow({ thread, selected, named, onOpen, context = {}, marks, unread = false, swipe = false, onHold, onArchive, apex }: { thread: WebThread; selected: boolean; named: boolean; onOpen: () => void; context?: RowContext; marks?: ShownMarks; unread?: boolean; swipe?: boolean; onHold?: (anchor: HTMLElement | null) => void; onArchive?: () => void; apex?: ApexFold }) {
  const detail = rowDetail(thread, named, context)
  const shown = marks ?? { markedUnread: thread.markedUnread === true, ...(thread.workStatus && { workStatus: thread.workStatus }) }
  const box = useRef<HTMLDivElement>(null)
  const front = useRef<HTMLDivElement>(null)
  useRowGestures(box, front, swipe, { onTap: onOpen, onHold: () => onHold?.(box.current), onArchive: () => onArchive?.() })
  // A Mac that's off says so on its own rows, dimmed with a moon; the cloud and a machine of the person's own are marked,
  // as the places apart from their Macs; a move under way wears its blinking arrow.
  const Place = detail.move ? (detail.move === "cloud" ? ArrowUpIcon : ArrowDownIcon) : thread.quietSince ? MoonIcon : detail.place === "cloud" ? CloudIcon : detail.place === "machine" ? ServerIcon : undefined
  const spoken = detail.elapsed ? `${detail.text} for ${detail.elapsed}` : detail.lead ? `${detail.lead}, ${detail.text}` : detail.text
  const status = shown.workStatus ? WORK_STATUS_WORDS[shown.workStatus] : undefined
  const keyed = (event: KeyboardEvent) => {
    if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return
    event.preventDefault()
    onOpen()
  }
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
      <div
        ref={front}
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={keyed}
        aria-current={selected ? "page" : undefined}
        aria-label={threadLabel(thread, [spoken, status, apex?.counts].filter(Boolean).join(". "), unread)}
        data-thread={thread.id}
        data-under={thread.apex?.thread}
        data-standing={thread.standing}
        data-moving={detail.move}
        data-unread={unread || undefined}
        data-work-status={shown.workStatus}
        data-marked-unread={shown.markedUnread || undefined}
        data-apex-row={apex ? thread.id : undefined}
        data-apex-open={apex ? apex.open : undefined}
        data-fin-counts={apex?.counts}
        className={cn("web-row group relative flex w-full items-center text-left", thread.quietSince && "opacity-60")}
      >
        {apex ? (
          <>
            {apex.hangs ? <span aria-hidden className="web-apex-stem" /> : null}
            <button
              type="button"
              data-row-fold
              data-apex-mark
              aria-label={apex.open ? "Fold its Fins" : "Show all its Fins"}
              aria-expanded={apex.open}
              onClick={(event) => {
                event.stopPropagation()
                apex.onToggle()
              }}
              className="web-row-mark web-apex-fold"
            >
              <WebThreadMark thread={thread} unread={unread} />
            </button>
          </>
        ) : (
          <span className="web-row-mark">
            <WebThreadMark thread={thread} unread={unread} />
          </span>
        )}
        <span data-row-title className={cn("min-w-0 flex-1 truncate text-ui", titleTone(selected, thread, unread, shown))}>
          {shownTitle(thread)}
          {thread.apex ? <span data-row-apex={thread.apex.thread} className="text-label text-faint"> · {thread.apex.title}</span> : null}
        </span>
        {detail.tone === "attention" ? (
          <span data-row-ask className="max-w-[45%] shrink truncate text-label text-faint">
            {detail.where ? <span data-row-where>{detail.where} · </span> : null}
            {detail.text}
          </span>
        ) : null}
        <span data-row-end className="flex shrink-0 items-center gap-1.5">
          {apex ? (
            <button
              type="button"
              data-row-fold
              tabIndex={-1}
              aria-hidden
              onClick={(event) => {
                event.stopPropagation()
                apex.onToggle()
              }}
              className="web-fold-chevron"
            >
              <ChevronRightIcon className={cn("size-3.5 transition-transform duration-200 ease-[var(--ease-out)]", apex.open && "rotate-90")} />
            </button>
          ) : null}
          {apex?.finsWorking ? <span ref={observeVisibleAnimation} data-fins-working className="rail-spin spinner" aria-hidden /> : null}
          {Place ? <Place aria-hidden data-move-mark={detail.move} data-place={detail.move ? undefined : thread.quietSince ? "quiet" : detail.place} className={cn("size-3.5 shrink-0", detail.move ? "web-move-blink text-foreground" : "text-faint")} /> : null}
          {shown.workStatus ? <WorkGlyph status={shown.workStatus} className="size-3.5" /> : null}
          {thread.standing === "failed" ? (
            <span data-status-end="failed" className="text-label text-negative">
              Failed
            </span>
          ) : (
            <span className="tabular text-label text-faint">{formatRelative(thread.activityAt)}</span>
          )}
        </span>
      </div>
    </div>
  )
}

/**
 * The rail's fixed top, the desk's own rows (`RailRow`, as `rail-top.tsx` draws them) at a finger's height: on a
 * tablet New thread and the Inbox, on a phone the Inbox alone, since New floats at the foot in thumb's reach. The
 * Inbox's count is the desk's, a number in the attention hue. Search opens the desk's palette on its Threads, as the
 * laptop's Search row does, over every Thread the account lists. Pull requests and Automations need a Mac's checkouts
 * and schedules, which this browser doesn't reach, so they have no row here.
 */
function ListTop({ wide, starting, onNew, inbox, onSearch }: { wide: boolean; starting: boolean; onNew: () => void; inbox: { count: number; open: boolean; onOpen: () => void } | undefined; onSearch: (() => void) | undefined }) {
  if (!wide && !inbox && !onSearch) return null
  // A finger's 44 px, its icon in the column the projects' tiles stand in: inset on the tablet's rail as on the desk's.
  const row = cn("h-11 gap-3", wide ? "px-2" : "px-4")
  return (
    <nav aria-label="Go to" data-rail-top className={cn("flex shrink-0 flex-col gap-px pt-2", wide && "px-2")}>
      {wide ? <RailRow data-rail-top-row="session.new" icon={<SquarePenIcon />} label="New thread" open={starting} onClick={onNew} className={row} /> : null}
      {onSearch ? <RailRow data-rail-top-row="view.command-palette" icon={<SearchIcon />} label="Search" onClick={onSearch} className={row} /> : null}
      {inbox ? (
        <RailRow
          data-rail-top-row="inbox"
          icon={<InboxIcon />}
          label="Inbox"
          spoken={inbox.count ? `Inbox, ${inbox.count} ${inbox.count === 1 ? "needs" : "need"} you` : "Inbox"}
          open={inbox.open}
          onClick={inbox.onOpen}
          className={row}
          end={inbox.count ? (
            <span data-inbox-count={inbox.count} className="tabular shrink-0 pr-1 text-label font-medium text-attention">
              {inbox.count}
            </span>
          ) : null}
        />
      ) : null}
    </nav>
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

const CommandPalette = lazy(() => import("@/components/palette/command-palette").then((module) => ({ default: module.CommandPalette })))

/** The palette over the list's Threads, opened on its Threads tab each time Search is pressed. */
function TouchSearch({ rows, asked }: { rows: readonly PaletteItem[]; asked: number }) {
  useEffect(() => {
    // After the palette's own listener is in: a child's effects run before its parent's.
    window.dispatchEvent(new CustomEvent("mako:palette", { detail: { category: "threads" } }))
  }, [asked])
  return <CommandPalette threads={rows} settings={loadWebSettings} />
}
