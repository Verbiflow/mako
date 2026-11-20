import { useHarnessIdentity } from "@/lib/harness-label"
import { nudgeProject, startProjectDrag, useProjectDrag } from "@/components/rail/project-drag"
import { ProjectDragLayer } from "@/components/rail/project-drag-layer"
import { orderByHand, useProjectOrder } from "@/state/project-order"
import { WorkGlyph } from "@/components/rail/work-status"
import { foldedAsDone, useThreadMarks } from "@/state/thread-marks"
import { rowThread } from "@/state/thread-groups"
import { railThreadRows } from "@/components/rail/rail-keys"
import { archivePicked, clearPicked, markPickedRead, pickableRows, railSelectionStore, togglePicked } from "@/state/rail-selection"
import { markThreads, markedUnread } from "@/state/thread-marks"
import { everyWhileShown } from "@/lib/window-shown"
import { memo, startTransition, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react"
import { RailAnnouncer } from "@/components/rail/thread-status"
import type { RailAsk } from "@/lib/rail-announcement"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { LiveAgentRow } from "@/components/rail/active-threads"
import { threadAppDriver } from "@/state/thread-app"
import type { AcpPresence } from "@/state/acp-presence"
import type { ThreadRef } from "@/lib/types"
import { ROW_SURFACE, ThreadRow } from "@/components/rail/thread-row"
import { harnessLabels, harnessLabel } from "@/components/rail/harness-meta"
import {
  groupThreadFolders,
  heldFolderRanks,
  orderThreadFolders,
  settledFolderRanks,
  showsInRecent,
  stableThreadRanks,
  threadBelongsToWorkspace,
  threadFolderKey,
  visibleThreadFolders,
  workedFolderRanks,
  type FolderRanks,
  type RailRanks,
  type ThreadFolder,
  type ThreadFolderActivity,
} from "@/lib/thread-folders"
import { useRowFlip } from "@/components/rail/use-row-flip"
import { EMPTY_FOLD, foldThreads, foldedThreadState, presenceStatusOf, unreadReview, type FoldRow, type ThreadFold } from "@/lib/thread-fold"
import { railSearchStore, setRailSearching, useRailSearch } from "@/state/rail-search"
import { useThreadGroups } from "@/state/thread-groups"
import { RailTip } from "@/components/rail/rail-tip"
import { keepFolderRanks, railRanksStore, releaseRevealedFolder, saveFolderRanks, useRailRanks } from "@/state/rail-ranks"
import {
  threadStatus,
  threadStatusPriority,
  threadsStore,
  useThreads,
  type ThreadStatus,
} from "@/state/threads"
import { actions, useCanChooseFolder, useSession } from "@/state/session"
import { useTabs } from "@/state/tabs"
import { IfCanChooseFolder, IfCanReveal } from "@/components/ui/machine-gate"
import { checkoutSentence, followCheckouts, useCheckoutHead } from "@/state/checkout-heads"
import { useRailAcp } from "@/state/acp-state"
import {
  canonicalThreadRefs,
  readsThreadRefs,
  sameAcpPresence,
  sameSessionOwners,
  selectAcpPresence,
  selectSessionOwners,
} from "@/state/acp-presence"
import { useWorkspaceFocus } from "@/components/stage/workspace-focus-context"
import { useWindowRoutes, windowRoutesStore } from "@/state/window-routes"
import { prefsStore, setPref, setProjectHidden, toggleApexOpen, toggleGroupCollapsed, togglePinnedProject, usePrefs } from "@/state/prefs"
import { openAppSetup } from "@/state/app-setup"
import { openProjectSettings } from "@/state/project-settings"
import { SlidersHorizontalIcon } from "lucide-react"
import { desktop } from "@/state/desktop"
import { ACTION_TOAST_MS } from "@/lib/toast-duration"
import { toast } from "sonner"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu"
import { useKeepWorktreeSummaries, useWorktrees } from "@/state/worktrees"
import { cn } from "@/lib/utils"
import { Blank } from "@/components/ui/kit"
import { formatChord } from "@/extend/commands"
import { DraftThreads } from "@/components/rail/draft-threads"
import { FirstProject } from "@/components/rail/first-project"
import { FolderDrop } from "@/components/shell/folder-drop"
import { openProjectPalette } from "@/state/open-project"
import { CustomizeItems, RailTop } from "@/components/rail/rail-top"
import { useInboxView } from "@/state/inbox"
import { archivedLive, archivedThread, useThreadArchives } from "@/state/thread-lifecycle"
import { RailSkeleton } from "@/components/rail/rail-activity"
import { ProjectAvatar } from "@/components/rail/rail-avatars"
import { HarnessIcon } from "@/components/ui/provider-icon"
import {
  AppWindowIcon,
  ArchiveIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  ClockIcon,
  ChevronRightIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  CodeIcon,
  CopyIcon,
  EyeIcon,
  EyeOffIcon,
  FolderOpenIcon,
  ListFilterIcon,
  MessagesSquareIcon,
  MoreHorizontalIcon,
  PencilLineIcon,
  PinIcon,
  PinOffIcon,
  PlusIcon,
  SearchIcon,
  XIcon,
} from "lucide-react"

/**
 * The threads rail: every agent's conversations, arranged the way work is —
 * by folder, the ones you work in first.
 *
 * Position never carries status. A folder sits by when you last worked
 * there, from any device — a prompt sent, a thread started — so it moves
 * only when you do, never when an agent answers, and every device lists the
 * folders in the same order; a busy thread keeps its rank until it
 * finishes; while the pointer is inside the rail nothing changes place at
 * all. What a thread needs from you is its mark and its folder's chip, and
 * the Inbox above the list is the one place that gathers it, across every
 * Thread and Fin. Rows that do move glide there. Each folder holds the same handful of rows
 * and a quiet "More" for the rest; folders gone cold collapse to a single
 * line. No chips, no toggles, no permanent search box — search and the
 * harness filter live behind two small glyphs in the header and take space
 * only while in use. A row is one line: the harness's mark, the title, and
 * how long ago.
 */

/**
 * Rows a folder shows before "More". The same count for every folder:
 * selecting a project must not grow it and shrink the one you came from.
 */
const FOLDER_LEAD_ROWS = 4
/** Each press of "More" reveals this many further rows. */
const PAGE_ROWS = 5
const PINNED_ROWS = 8
const FOLDER_ROWS = 6
/** Folders quiet longer than this start out collapsed. */
const COLD_MS = 7 * 24 * 3600_000
const LIVE_TIME_MS = 60_000
/** How long ⌘ is held alone before the rows show their keys: a ⌘K or ⌘N pressed at once shows none. */
const JUMP_HINT_MS = 200

/** Conversations in a folder, the one that moved last first: another device's by its listed time, this Mac's by its start. */
function byLatestMove(left: AcpPresence, right: AcpPresence): number {
  return (right.movedAt ?? right.createdAt) - (left.movedAt ?? left.createdAt)
}
const INITIAL_TIME = Date.now()
const NO_FOLDERS: ThreadFolder[] = []
const NO_REFS: ThreadRef[] = []
const NO_LIVE: AcpPresence[] = []
const NO_RANKS: FolderRanks = {}
/** How long what the rail ranks on stays still, once the catalog is ready, before it's saved for the next window. */
const SAVE_QUIET_MS = 2_000
/** How long a folder takes to fold away (`duration-200` on its rows' grid), and a little past it. */
const FOLD_MS = 250

/**
 * What's typed in the search box, as the list takes it: at a transition's priority, so a keystroke is drawn in the
 * box at once (`RailHeader` reads the store itself) and the list filters when the typing lets it.
 */
function useSought(): string {
  const [sought, setSought] = useState(() => railSearchStore.get().query)
  useEffect(() => railSearchStore.subscribe(() => {
    const { query } = railSearchStore.get()
    startTransition(() => setSought(query))
  }), [])
  return sought
}

/**
 * Whether what folds away under a header is drawn: while it's open, and for the length of its fold after it closes.
 * `fold` is called by whatever is about to open or close it. A closed folder's rows aren't in the page: with "More
 * folders" open they were several hundred rows, each with its subscriptions, drawn into no height.
 */
function useFoldAway(closed: boolean) {
  const [folding, setFolding] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const fold = useCallback(() => {
    window.clearTimeout(timer.current)
    setFolding(true)
    timer.current = window.setTimeout(() => setFolding(false), FOLD_MS)
  }, [])
  return { drawn: !closed || folding, folding, fold }
}

/**
 * ← folds and → opens what has focus: an Apex's Fins on its row, a project on its header. A project's row is its
 * header's button, which says whether it's open (`aria-expanded`), so it's toggled only when it isn't already so.
 */
function foldByKey(event: ReactKeyboardEvent<HTMLElement>): void {
  if (!(event.target instanceof HTMLElement) || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
  const open = event.key === "ArrowRight"
  const apex = event.target.closest<HTMLElement>("[data-thread-row][data-apex-row]")
  if (apex === event.target && apex.dataset.threadId) {
    event.preventDefault()
    toggleApexOpen(apex.dataset.threadId, open)
    return
  }
  const header = event.target.closest<HTMLElement>("[data-folder-toggle]")
  if (header === event.target) {
    event.preventDefault()
    if ((header.getAttribute("aria-expanded") === "true") !== open) header.click()
  }
}

function toggleFolder(folder: ThreadFolder): void {
  toggleGroupCollapsed(`ws:${folder.key}`)
}

function newThreadIn(cwd: string): void {
  const { routes } = windowRoutesStore.get()
  if (routes) routes.newThreadIn(cwd)
  else void actions.newConversationIn(cwd)
}

function useLiveTime(): number {
  const [now, setNow] = useState(INITIAL_TIME)

  useEffect(() => {
    return everyWhileShown(LIVE_TIME_MS, () => setNow(Date.now()))
  }, [])

  return now
}

export function AgentThreads() {
  useHarnessIdentity()
  const canChooseFolder = useCanChooseFolder()
  const rail = useRef<HTMLDivElement>(null)
  const topFade = useRef<HTMLSpanElement>(null)
  const [jumpHints, setJumpHints] = useState(false)
  const [showAllPinned, setShowAllPinned] = useState(false)
  const [showAllFolders, setShowAllFolders] = useState(false)
  // Extra pages unfolded per folder — More reveals a handful at a time,
  // not the whole archive in one avalanche.
  const [pages, setPages] = useState<Record<string, number>>({})
  useEffect(() => threadAppDriver()?.watchMarks?.(), [])
  const deferred = useSought()
  const searchActive = Boolean(deferred.trim())
  const nativeRefs = useThreads((state) => state.threads)
  const liveAgents = useRailAcp(selectAcpPresence, sameAcpPresence)
  const loaded = useThreads((state) => state.loaded)
  const working = useThreads((state) => state.working)
  const attention = useThreads((state) => state.attention)
  const observed = useThreads((state) => state.observed)
  const externalActivity = useThreads((state) => state.externalActivity)
  const filter = usePrefs((prefs) => prefs.agentHarnessFilter)
  const pinned = usePrefs((prefs) => prefs.pinnedThreads)
  const owners = useRailAcp(selectSessionOwners, sameSessionOwners)
  const all = useMemo(
    () => canonicalThreadRefs(nativeRefs, owners, pinned),
    [nativeRefs, owners, pinned]
  )
  const pinnedProjects = usePrefs((prefs) => prefs.pinnedProjects)
  const hiddenProjects = usePrefs((prefs) => prefs.hiddenProjects)
  const [showHidden, setShowHidden] = useState(false)
  const collapsed = usePrefs((prefs) => prefs.collapsedGroups)
  const scope = usePrefs((prefs) => prefs.railScope)
  const sortBy = usePrefs((prefs) => prefs.railSortBy)
  const grouping = usePrefs((prefs) => prefs.railGrouping)
  // Projects, each with its rows; a search, Recent and Archived are one list instead, and group nothing.
  const byProject = !searchActive && grouping === "project"
  const scroller = useRef<HTMLDivElement>(null)
  useKeepWorktreeSummaries()
  // The order caught when the pointer entered the rail; held until it leaves,
  // so nothing can change place under a click.
  // The folders' order is caught only where folders show: one caught under a search holds the rows alone.
  const [hold, setHold] = useState<{ ranks: RailRanks; folderRanks: FolderRanks | null } | null>(null)
  const { cwd } = useWorkspaceFocus()
  const now = useLiveTime()

  // ⌘ held alone for 200 ms shows the first nine rows' keys; ⌘1–9 opens that row at once, held or not. With rows
  // picked, U marks them read, E archives them and Escape lets go; with none, U and E act on the focused row.
  useEffect(() => {
    let held: ReturnType<typeof setTimeout> | undefined
    const hide = () => {
      clearTimeout(held)
      held = undefined
      setJumpHints(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return
      if ((event.key === "Meta" || event.key === "Control") && !event.shiftKey && !event.altKey) {
        clearTimeout(held)
        held = setTimeout(() => setJumpHints(true), JUMP_HINT_MS)
        return
      }
      const mod = event.metaKey || event.ctrlKey
      if (mod) {
        hide()
        // ⌘1–9 alone: ⌘⇧ digits are the strip's surfaces, ⌃⌘ digits the model loadout.
        if (event.shiftKey || event.altKey || (event.metaKey && event.ctrlKey) || !/^Digit[1-9]$/.test(event.code)) return
        const row = railThreadRows()[Number(event.code.slice(5)) - 1]
        if (!row) return
        event.preventDefault()
        row.click()
        return
      }
      if (event.altKey || event.defaultPrevented) return
      const typing = event.target instanceof HTMLElement && event.target.closest("input, textarea, select, [contenteditable]")
      if (typing) return
      const picked = railSelectionStore.get().picked
      if (event.key === "Escape" && picked.length) {
        event.preventDefault()
        clearPicked()
        return
      }
      const key = event.key.toLowerCase()
      if (key !== "u" && key !== "e") return
      if (picked.length) {
        event.preventDefault()
        void (key === "u" ? markPickedRead() : archivePicked())
        return
      }
      // No rows picked: the row with focus.
      const focused = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>(".thread-jump-scope [data-thread-row]") : null
      const row = focused?.dataset.flipKey ? pickableRows([focused.dataset.flipKey])[0] : undefined
      if (!row || focused !== event.target) return
      event.preventDefault()
      if (key === "e") {
        togglePicked(row)
        void archivePicked()
      } else if (row.thread) {
        void markThreads([row.thread], { unread: !markedUnread(row.thread) })
      }
    }
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Meta" || event.key === "Control" || !(event.metaKey || event.ctrlKey)) hide()
    }
    window.addEventListener("keydown", onKeyDown)
    window.addEventListener("keyup", onKeyUp)
    window.addEventListener("blur", hide)
    return () => {
      hide()
      window.removeEventListener("keydown", onKeyDown)
      window.removeEventListener("keyup", onKeyUp)
      window.removeEventListener("blur", hide)
    }
  }, [])

  const counts = useMemo(() => {
    const byHarness = new Map<string, number>()
    for (const ref of all) {
      byHarness.set(ref.harness, (byHarness.get(ref.harness) ?? 0) + 1)
    }
    return byHarness
  }, [all])

  const archiveKeys = useThreadArchives((state) => state.keys)
  const unboundLiveAgents = useMemo(() => {
    const bound = readsThreadRefs(all)
    return liveAgents.filter(
      (presence) =>
        // A Fin shows inside its Apex's Thread, as its catalog row does (`listedAsThread`).
        presence.apex === undefined &&
        (grouping === "archived" ? archivedLive(presence, archiveKeys) : !archivedLive(presence, archiveKeys) || presence.status === "running" || presence.status === "starting" || presence.status === "needs-permission") &&
        (!filter.length || filter.includes(presence.harness)) &&
        (scope !== "workspace" || threadBelongsToWorkspace(presence, cwd)) &&
        (!deferred.trim() || `${presence.title ?? ""} ${presence.cwd} ${presence.harness}`.toLowerCase().includes(deferred.trim().toLowerCase())) &&
        !bound(presence)
    )
  }, [all, liveAgents, filter, scope, cwd, deferred, archiveKeys, grouping])

  const matched = useMemo(() => {
    const needle = deferred.trim().toLowerCase()
    const active = filter.length > 0 ? new Set(filter) : null
    const statusState = { ...threadsStore.get(), attention, working, externalActivity }
    return all.filter(
      (ref) =>
        (grouping === "archived" ? archivedThread(ref, archiveKeys) : !archivedThread(ref, archiveKeys) || ["working", "background", "external-active", "needs-permission"].includes(threadStatus(ref, statusState).kind)) &&
        (scope !== "workspace" || threadBelongsToWorkspace(ref, cwd)) &&
        (!active || active.has(ref.harness)) &&
        (!needle ||
          `${ref.title ?? ""} ${ref.cwd ?? ""} ${harnessLabel(ref.harness)} ${ref.model ?? ""}`
            .toLowerCase()
            .includes(needle))
    )
  }, [all, cwd, deferred, filter, scope, archiveKeys, grouping, attention, working, externalActivity])

  // A Thread with several Sessions is one row, wherever they run: its first
  // Session's row stands for the rest, which leave the list before anything
  // counts or ranks them.
  const groups = useThreadGroups((state) => state.groups)
  const threadOf = useThreadGroups((state) => state.threadOf)
  const fold = useMemo((): ThreadFold => {
    const rows: FoldRow[] = [
      ...matched.map((ref): FoldRow => ({ kind: "native", key: ref.path, ref })),
      ...unboundLiveAgents.map((presence): FoldRow => ({ kind: "live", key: presence.key, presence })),
    ]
    return rows.length ? foldThreads(rows, groups, threadOf) : EMPTY_FOLD
  }, [matched, unboundLiveAgents, groups, threadOf])
  const shownRefs = useMemo(
    () => (fold.hidden.size ? matched.filter((ref) => !fold.hidden.has(ref.path)) : matched),
    [fold, matched]
  )
  const shownLive = useMemo(
    () => (fold.hidden.size ? unboundLiveAgents.filter((presence) => !fold.hidden.has(presence.key)) : unboundLiveAgents),
    [fold, unboundLiveAgents]
  )

  const { priorities, threadActivity, statuses, countedLive } = useMemo(() => {
    const state = {
      ...threadsStore.get(),
      attention,
      externalActivity,
      observed,
      working,
    }
    const nextPriorities: Record<string, number> = {}
    const nextActivity: Record<string, ThreadFolderActivity> = {}
    const nextStatuses: Record<string, ThreadStatus> = {}
    for (const ref of shownRefs) {
      const folded = fold.byLead.get(ref.path)
      // A folded Thread counts each fact any of its Sessions holds: one
      // running and one finished is a running Thread and one to review.
      const foldState = folded ? foldedThreadState(folded.members, (member) => threadStatus(member, state)) : undefined
      const status = foldState?.status ?? threadStatus(ref, state)
      const sessions = foldState?.sessions.map((session) => session.status) ?? [status]
      nextStatuses[ref.path] = status
      nextPriorities[ref.path] = foldState?.priority ?? threadStatusPriority(status)
      nextActivity[ref.path] = {
        running: sessions.some((session) => session.kind === "working"),
        needsInput: sessions.some((session) => session.kind === "needs-permission"),
        failed: sessions.some((session) => session.kind === "failed"),
        unread: sessions.some(unreadReview),
        active: sessions.some((session) => session.kind === "external-active"),
        observed: sessions.some((session) => session.kind === "observed"),
      }
    }
    // A folded Thread whose row is a conversation's counts as the Thread: one of its Sessions waiting on you is the
    // folder's to say, whichever Session leads it.
    const live = shownLive.map((presence) => {
      const folded = fold.byLead.get(presence.key)
      const standing = folded && presenceStatusOf(foldedThreadState(folded.members, (member) => threadStatus(member, state)).status)
      return standing && standing !== presence.status ? { ...presence, status: standing } : presence
    })
    return { priorities: nextPriorities, threadActivity: nextActivity, statuses: nextStatuses, countedLive: live }
  }, [attention, externalActivity, fold, shownRefs, shownLive, observed, working])

  const asks = useMemo((): RailAsk[] => [
    ...shownRefs.flatMap((ref): RailAsk[] => {
      const kind = statuses[ref.path]?.kind
      return kind === "needs-permission" || kind === "failed" ? [{ key: ref.path, title: ref.title ?? "A thread", kind }] : []
    }),
    ...countedLive.flatMap((presence): RailAsk[] =>
      presence.status === "needs-permission" || presence.status === "failed"
        ? [{ key: presence.key, title: presence.title ?? "A conversation", kind: presence.status }]
        : []),
  ], [shownRefs, countedLive, statuses])

  // Ranks from the last render decide this one, so a thread that is busy
  // keeps its place instead of climbing on every appended byte.
  const ranks = useMemo(
    () => stableThreadRanks(shownRefs, threadActivity, railRanksStore.get().ranks),
    [shownRefs, threadActivity]
  )
  const shownRanks = hold?.ranks ?? ranks

  // Everything from here to `recent` is for one of the two views, and is worked out only while that view shows.
  const held = useMemo(() => {
    if (!byProject) return NO_REFS
    const set = new Set(pinned)
    const list = shownRefs.filter((ref) => set.has(ref.path))
    list.sort((a, b) => pinned.indexOf(a.path) - pinned.indexOf(b.path))
    return list
  }, [byProject, shownRefs, pinned])

  const folderMap = useWorktrees((state) => state.folderMap)
  const grouped = useMemo(
    () =>
      byProject
        ? groupThreadFolders({
            refs: shownRefs,
            live: countedLive,
            currentCwd: cwd,
            pinnedThreads: pinned,
            pinnedFolders: pinnedProjects,
            priorities,
            activity: threadActivity,
            ranks: shownRanks,
            sortBy,
            folderMap,
          })
        : NO_FOLDERS,
    [byProject, cwd, shownRefs, countedLive, pinned, pinnedProjects, priorities, shownRanks, sortBy, threadActivity, folderMap]
  )
  // A folder sits by when you last worked there, on any device: every Session counts, a Thread's folded ones too, so
  // agent output never moves one and every device puts them in the same order.
  const workedRanks = useMemo(
    () => (byProject ? workedFolderRanks({ refs: matched, live: unboundLiveAgents, owners, folderMap }) : NO_RANKS),
    [byProject, matched, unboundLiveAgents, owners, folderMap]
  )
  // A Thread the person just started, or a folder they just added, lands where they're looking: its folder open,
  // scrolled into view, ranked as worked on now, and its unsent Thread drawn there, lit, until it's sent or they look
  // elsewhere. Only its first message moves the folder for good: a Thread never sent leaves the order as it was.
  const reveal = useRailRanks((state) => state.reveal)
  const activeTab = useTabs((state) => state.activeId)
  const viewingThread = useThreads((state) => Boolean(state.opening ?? state.viewing))
  const liveOpen = useRailAcp((state) => state.activeKey !== null)
  const unsent = useSession((state) => state.messages.length === 0)
  const unsentIn = reveal && reveal.tab === activeTab && !viewingThread && !liveOpen && unsent ? reveal.key : null
  const lift = unsentIn && reveal ? reveal.at : undefined
  // What has landed so far, never below where each folder stood earlier in this window or where the last one saved it:
  // the catalog's scan and another device's Sessions arrive after the first paint, and each used to reorder the whole
  // list (`railRanksStore`).
  const keptRanks = useRailRanks((state) => state.folders)
  const folderRanks = useMemo(() => {
    if (!byProject) return NO_RANKS
    const settled = settledFolderRanks(workedRanks, keptRanks)
    return unsentIn && lift !== undefined ? settledFolderRanks(settled, { [unsentIn]: new Date(lift).toISOString() }) : settled
  }, [byProject, workedRanks, keptRanks, unsentIn, lift])
  useEffect(() => {
    if (loaded) railRanksStore.set({ ranks })
  }, [loaded, ranks])
  // Only the unfiltered list says where a folder settled: a search or a harness filter ranks on part of it.
  const unfiltered = !deferred.trim() && filter.length === 0 && scope === "all" && grouping === "project"
  useEffect(() => {
    if (!loaded || !unfiltered) return
    keepFolderRanks(workedRanks)
    // Saved once what it ranks on has been still a moment past the catalog's ready: another device's Sessions come in
    // just after, and a save before them would start the next window lower than it ends.
    const save = setTimeout(() => saveFolderRanks(workedRanks), SAVE_QUIET_MS)
    return () => clearTimeout(save)
  }, [loaded, unfiltered, workedRanks])
  // The order the person dragged projects to comes first; the rest keep the order they were last worked in.
  const handOrder = useProjectOrder((state) => state.order)
  const folders = useMemo(
    () => orderByHand(orderThreadFolders(grouped, hold?.folderRanks ? heldFolderRanks(hold.folderRanks, folderRanks) : folderRanks, sortBy), sortBy === "recent" ? handOrder : []),
    [grouped, hold, folderRanks, sortBy, handOrder]
  )
  // Open for this reveal only (`reveal.open`); the person's stored choice for the folder is left as it was.
  const revealedOpen = reveal?.open ? reveal.key : null
  const revealedFolder = reveal ? folders.find((entry) => entry.key === reveal.key) : undefined
  // A folder just added has no row until its first Session's folder is known, so this waits for it to be drawn.
  const revealedShown = Boolean(revealedFolder)
  useEffect(() => {
    if (!reveal || !revealedShown) return
    const frame = requestAnimationFrame(() => {
      const head = rail.current?.querySelector(`[data-flip-key="folder:${CSS.escape(reveal.key)}"]`)
      ;(head?.closest("section") ?? head)?.scrollIntoView({ block: "nearest" })
    })
    return () => cancelAnimationFrame(frame)
  }, [reveal, revealedShown])
  // Each folder's conversations, the one that moved last first; the ones in no folder ("") as they're listed.
  const liveByFolder = useMemo(() => {
    const byFolder = new Map<string, AcpPresence[]>()
    if (!byProject) return byFolder
    for (const presence of shownLive) {
      const key = threadFolderKey(presence, folderMap)
      const present = byFolder.get(key)
      if (present) present.push(presence)
      else byFolder.set(key, [presence])
    }
    for (const [key, present] of byFolder) if (key) present.sort(byLatestMove)
    return byFolder
  }, [byProject, shownLive, folderMap])
  const recent = useMemo(() => byProject ? [] : [
    ...shownRefs.filter((ref) => showsInRecent(ref, threadActivity[ref.path])).map((ref) => ({ kind: "native" as const, key: ref.path, at: shownRanks[ref.path]?.at ?? ref.updatedAt ?? "", ref })),
    ...shownLive.map((presence) => ({ kind: "live" as const, key: presence.key, at: new Date(presence.movedAt ?? presence.createdAt).toISOString(), presence })),
  ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 80), [byProject, shownRefs, shownRanks, threadActivity, shownLive])
  const showPages = useCallback((key: string, next: number) => setPages((prev) => ({ ...prev, [key]: next })), [])
  const hiddenFold = useFoldAway(!showHidden)
  // The rows' order can change only when one of these does; the glide reads the page again then, and at no other draw.
  const rowOrder = useMemo(
    () => ({ folders, held, recent, liveByFolder, pages, collapsed, hiddenProjects, showAllPinned, showAllFolders, showHidden }),
    [folders, held, recent, liveByFolder, pages, collapsed, hiddenProjects, showAllPinned, showAllFolders, showHidden]
  )
  useRowFlip(scroller, `${grouping}:${searchActive}`, rowOrder)
  const inboxOpen = useInboxView((state) => state.open || state.automations)
  const quietPinned = held
  const shownPinned = showAllPinned
    ? quietPinned
    : quietPinned.slice(0, PINNED_ROWS)
  const hiddenPinned = quietPinned.length - shownPinned.length
  // A hidden project with a run going or waiting on you stays until that's done, so work never vanishes from view.
  const isHidden = (folder: ThreadFolder) => folder.cwd !== null && hiddenProjects.includes(folder.cwd) && !folder.running && !folder.needsInput
  const workspaceFolders = folders.filter((folder) => folder.cwd !== null && !isHidden(folder))
  const hiddenList = folders.filter(isHidden)
  const sessions = folders.find((folder) => folder.cwd === null)
  const priorityFolders = workspaceFolders.filter(
    (folder) => folder.current || folder.pinned
  ).length
  const shownFolders = showAllFolders
    ? workspaceFolders
    : visibleThreadFolders(
        workspaceFolders,
        Math.max(FOLDER_ROWS, priorityFolders)
      )
  const hiddenFolders = workspaceFolders.length - shownFolders.length
  const folderSection = (folder: ThreadFolder, hidden = false) => (
    <FolderSection
      key={folder.key}
      folder={folder}
      now={now}
      fold={fold}
      liveAgents={liveByFolder.get(folder.cwd === null ? "" : folder.key) ?? NO_LIVE}
      collapsed={collapsed.includes(`ws:${folder.key}`)}
      unsent={unsentIn === folder.key}
      revealed={revealedOpen === folder.key}
      hidden={hidden}
      pages={pages[folder.key] ?? 0}
      onPages={showPages}
    />
  )
  const shownCheckouts = shownFolders.flatMap((folder) => (folder.cwd ? [folder.cwd] : [])).join("\n")
  useEffect(() => {
    if (shownCheckouts) followCheckouts(shownCheckouts.split("\n"))
  }, [shownCheckouts])

  useEffect(() => {
    if (!jumpHints) return
    // The keys go on the rows as drawn now, the folded ones left out, as ⌘1–9 counts them.
    const shown = railThreadRows()
    for (const row of rail.current?.querySelectorAll<HTMLElement>("[data-thread-row]") ?? []) {
      const index = shown.indexOf(row)
      const cap = row.querySelector<HTMLElement>("[data-jump-cap]")
      if (index >= 0 && index < 9) {
        row.dataset.jumpIndex = String(index + 1)
        if (cap) cap.textContent = `⌘${index + 1}`
      } else delete row.dataset.jumpIndex
    }
  }, [folders, held, jumpHints, shownRefs, shownLive, pages, showAllPinned, showAllFolders, collapsed, showHidden])

  return (
    <FolderDrop className="flex min-h-0 flex-1 flex-col" data-rail-drop>
    <div
      ref={rail}
      data-jump-hints={jumpHints || undefined}
      data-inbox-open={inboxOpen || undefined}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          foldByKey(event)
          return
        }
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return
        const current =
          event.target instanceof HTMLElement
            ? event.target.closest<HTMLElement>("[data-thread-row]")
            : null
        if (!current) return
        const rows = [
          ...(rail.current?.querySelectorAll<HTMLElement>(
            "[data-thread-row]"
          ) ?? []),
        ].filter((row) => row.offsetParent !== null)
        const at = rows.indexOf(current)
        const next = rows[at + (event.key === "ArrowDown" ? 1 : -1)]
        if (!next) return
        event.preventDefault()
        next.focus()
      }}
      className="thread-jump-scope group/rail flex min-h-0 flex-1 flex-col"
    >
      <RailAnnouncer asks={asks} />
      <RailTop />
      <RailHeader counts={counts} filter={filter} />
      <div className="scroll-fade-scope flex min-h-0 flex-1 flex-col">
        <span
          ref={topFade}
          aria-hidden
          className="scroll-fade-top [--fade-from:var(--shell)]"
        />
        <div
          ref={scroller}
          onScroll={(event) =>
            topFade.current?.toggleAttribute(
              "data-scrolled",
              event.currentTarget.scrollTop > 0.5
            )
          }
          onPointerEnter={() => setHold((current) => current ?? { ranks, folderRanks: byProject ? folderRanks : null })}
          onPointerLeave={() => setHold(null)}
          data-rail-scroller
          className="scroll-fade-scroller min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-3"
        >
          {!loaded && matched.length === 0 && unboundLiveAgents.length === 0 ? (
            <RailSkeleton />
          ) : matched.length === 0 && unboundLiveAgents.length === 0 ? (
            searchActive || filter.length > 0 ? (
              <p className="px-3 pt-8 text-center text-ui leading-relaxed text-faint">
                Nothing matches.
              </p>
            ) : grouping === "archived" ? (
              <Blank icon={<MessagesSquareIcon />} title="No archived threads" body="Archived threads stay available here. Restore them whenever you need them." hints={[{ label: "Back to projects", onSelect: () => setPref("railGrouping", "project") }]} />
            ) : canChooseFolder ? (
              <FirstProject />
            ) : (
              <Blank
                icon={<MessagesSquareIcon />}
                title="No conversations yet"
                body="Threads from every agent land here."
                hints={[
                  {
                    label: "Ask for a change",
                    keys: formatChord("mod+l"),
                    onSelect: () =>
                      window.dispatchEvent(
                        new CustomEvent("mako:focus-composer")
                      ),
                  },
                ]}
              />
            )
          ) : !byProject ? (
            <div className="pt-1">
              {grouping !== "archived" ? <DraftThreads /> : null}
              {recent.map((row) => row.kind === "native"
                ? <ThreadRow key={row.key} threadRef={row.ref} folded={fold.byLead.get(row.key)} showFolder />
                : <LiveAgentRow key={row.key} presence={row.presence} folded={fold.byLead.get(row.key)} now={now} />)}
              {shownRefs.length + shownLive.length > recent.length ? (
                <button type="button" onClick={() => setRailSearching(true)} className="pressable h-7 w-full px-2 text-left text-label text-faint hover:text-foreground">Search older threads</button>
              ) : null}
            </div>
          ) : (
            <>
              <DraftThreads />
              {quietPinned.length > 0 ? (
                <section className="pt-1 pb-2">
                  <p className="flex h-7 items-center gap-1.5 px-1.5 text-label font-medium text-faint">
                    <PinIcon className="size-3 fill-current opacity-60" />
                    Pinned
                  </p>
                  {shownPinned.map((ref) => (
                    <ThreadRow key={ref.path} threadRef={ref} folded={fold.byLead.get(ref.path)} showFolder />
                  ))}
                  {hiddenPinned > 0 || showAllPinned ? (
                    <button
                      type="button"
                      onClick={() => setShowAllPinned((current) => !current)}
                      className="flex h-6 w-full items-center pl-7 text-left text-label text-faint transition-colors duration-100 hover:bg-fill-hover hover:text-muted-foreground"
                    >
                      {showAllPinned
                        ? "Fewer pinned"
                        : `${hiddenPinned} more pinned`}
                    </button>
                  ) : null}
                </section>
              ) : null}
              {shownFolders.map((folder) => folderSection(folder))}
              {hiddenFolders > 0 || showAllFolders ? (
                <button
                  type="button"
                  onClick={() => setShowAllFolders((current) => !current)}
                  className="mb-1 flex h-7 w-full items-center px-1.5 text-left text-label text-faint transition-colors duration-100 hover:bg-fill-hover hover:text-muted-foreground"
                >
                  {showAllFolders
                    ? "Fewer folders"
                    : `${hiddenFolders} more folders`}
                </button>
              ) : null}
              {hiddenList.length > 0 ? (
                <>
                  <button
                    type="button"
                    aria-expanded={showHidden}
                    data-rail-hidden-projects
                    onClick={() => {
                      hiddenFold.fold()
                      setShowHidden((current) => !current)
                    }}
                    className="group/hidden mb-1 flex h-7 w-full items-center gap-1.5 px-1.5 text-left text-label text-faint transition-colors duration-100 hover:bg-fill-hover hover:text-muted-foreground"
                  >
                    <ChevronRightIcon className={cn("size-3.5 transition-transform duration-200 ease-out", showHidden && "rotate-90")} />
                    Hidden
                    <span className="tabular text-faint/60">{hiddenList.length}</span>
                  </button>
                  <div className={cn("grid transition-[grid-template-rows] duration-200 ease-out", showHidden ? "grid-rows-[1fr]" : "grid-rows-[0fr]")}>
                    <div className="min-h-0 overflow-hidden" inert={!showHidden} data-folding={hiddenFold.folding || undefined}>
                      {hiddenFold.drawn ? hiddenList.map((folder) => folderSection(folder, true)) : null}
                    </div>
                  </div>
                </>
              ) : null}
              {sessions ? folderSection(sessions) : null}
            </>
          )}
        </div>
        <span
          aria-hidden
          className="scroll-fade-bottom [--fade-from:var(--shell)]"
        />
        <RailTip scroller={scroller} />
      </div>
      <ProjectDragLayer />
    </div>
    </FolderDrop>
  )
}

/**
 * The rail's one header line: an eyebrow, and two glyphs that expand into
 * search and the provider filter only when wanted. While searching, the whole
 * line becomes the input — space is spent on what is being done.
 */
function RailHeader({
  counts,
  filter,
}: {
  counts: Map<string, number>
  filter: string[]
}) {
  const searching = useRailSearch((state) => state.searching)
  const query = useRailSearch((state) => state.query)
  useEffect(() => {
    const search = () => setRailSearching(true)
    window.addEventListener("mako:search-threads", search)
    return () => {
      window.removeEventListener("mako:search-threads", search)
      // A search ends with the rail that showed it, as it did while the rail kept it itself.
      setRailSearching(false)
    }
  }, [])
  const input = useRef<HTMLInputElement | null>(null)
  const grouping = usePrefs((prefs) => prefs.railGrouping)

  if (searching) {
    return (
      <div className="flex h-9 shrink-0 items-center gap-1 px-2 pt-1.5">
        <SearchIcon className="ml-1.5 size-3.5 shrink-0 text-faint" />
        <input
          ref={input}
          autoFocus
          value={query}
          onChange={(event) => railSearchStore.set({ query: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation()
              setRailSearching(false)
            }
          }}
          placeholder="Search every thread"
          aria-label="Search every thread"
          className="h-7 min-w-0 flex-1 bg-transparent px-1.5 text-ui text-foreground placeholder:text-faint focus:outline-none"
        />
        <button
          type="button"
          aria-label="Close search"
          onClick={() => setRailSearching(false)}
          className="pressable p-1 text-faint hover:text-foreground"
        >
          <XIcon className="size-3" />
        </button>
      </div>
    )
  }

  return (
    <div className="mt-2 flex h-7 shrink-0 items-center pr-2 pl-4">
      {grouping === "project" ? (
        <h2 data-rail-threads-heading className="text-label font-medium text-faint">Projects</h2>
      ) : (
        // Recent and Archived are the filter menu's choices; the heading names the one showing and leads back.
        <button type="button" data-rail-threads-heading onClick={() => setPref("railGrouping", "project")} title="Back to projects" className="pressable -ml-1.5 flex h-6 items-center gap-1 px-1.5 text-label font-medium text-foreground transition-colors hover:bg-fill-hover">
          {grouping === "archived" ? "Archived" : "Recent"}
          <XIcon aria-hidden className="size-3 text-faint" />
        </button>
      )}
      <span className="flex-1" />
      {/* The header's controls show while the pointer is over the rail, or one of them has focus or its menu open. */}
      <span data-rail-header-actions className="flex items-center opacity-0 transition-opacity duration-150 group-hover/rail:opacity-100 focus-within:opacity-100 has-[[data-state=open]]:opacity-100 has-[[data-filter-on]]:opacity-100">
        <HarnessFilter counts={counts} filter={filter} />
        <IfCanChooseFolder>
          <button
            type="button"
            aria-label="Open project…"
            title={`Open project… ${formatChord("mod+o").join("")}`}
            data-rail-open-project
            onClick={() => openProjectPalette()}
            className="pressable p-1.5 text-faint transition-colors duration-100 hover:bg-fill-hover hover:text-foreground"
          >
            <PlusIcon className="size-3.5" />
          </button>
        </IfCanChooseFolder>
        <Menu modal={false}>
          <MenuTrigger asChild>
            <button type="button" aria-label="Sidebar options" data-rail-options className="pressable p-1.5 text-faint transition-colors duration-100 hover:bg-fill-hover hover:text-foreground data-[state=open]:bg-fill-hover data-[state=open]:text-foreground">
              <MoreHorizontalIcon className="size-3.5" />
            </button>
          </MenuTrigger>
          <MenuContent align="end" sideOffset={4} className="min-w-56">
            <CustomizeItems />
            <MenuSeparator />
            <RailOptionsItems />
          </MenuContent>
        </Menu>
      </span>
    </div>
  )
}

/** The Projects header's `⋯`: the other ways to list Threads. */
function RailOptionsItems() {
  const grouping = usePrefs((prefs) => prefs.railGrouping)
  return (
    <>
      <MenuItem data-rail-show="archived" onSelect={() => setPref("railGrouping", grouping === "archived" ? "project" : "archived")}>
        <ArchiveIcon className="size-3.5" />Archived threads
        {grouping === "archived" ? <CheckIcon className="ml-auto size-3.5" /> : null}
      </MenuItem>
      <MenuItem data-rail-show="recent" onSelect={() => setPref("railGrouping", grouping === "recent" ? "project" : "recent")}>
        <ClockIcon className="size-3.5" />Recent, all projects
        {grouping === "recent" ? <CheckIcon className="ml-auto size-3.5" /> : null}
      </MenuItem>
    </>
  )
}

/**
 * Filter and sort, one glyph. Three sections: which agents (multi-select
 * with counts), what order (activity, birth, name), and how far (every
 * folder, or only the one being worked). The glyph carries a dot while any
 * narrowing is on, so a filtered rail never reads as an empty machine.
 */
function HarnessFilter({
  counts,
  filter,
}: {
  counts: Map<string, number>
  filter: string[]
}) {
  useHarnessIdentity()
  const [open, setOpen] = useState(false)
  const sortBy = usePrefs((prefs) => prefs.railSortBy)
  const scope = usePrefs((prefs) => prefs.railScope)
  const grouping = usePrefs((prefs) => prefs.railGrouping)
  const on = filter.length > 0 || scope === "workspace" || sortBy !== "recent" || grouping !== "project"

  const section = "px-2 pt-2 pb-1 text-label font-medium text-faint/80"
  const row = (active: boolean) =>
    cn(
      "flex w-full items-center gap-2 px-2 py-1.5 text-left text-ui transition-colors duration-100",
      active
        ? "bg-fill-selected text-foreground"
        : "text-foreground/85 hover:bg-fill-hover"
    )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Filter and sort"
          data-filter-on={on || undefined}
          className={cn(
            "pressable relative p-1.5 transition-colors duration-100 hover:bg-fill-hover",
            on ? "text-foreground" : "text-faint hover:text-foreground"
          )}
        >
          <ListFilterIcon className="size-3.5" />
          {on ? (
            <span className="absolute top-1 right-1 size-1.5 rounded-full bg-foreground" />
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={6} collisionPadding={8} className="max-h-[var(--radix-popover-content-available-height)] w-56 overflow-y-auto overscroll-contain p-1">
        <p className={section}>Show</p>
        {(
          [
            ["project", "By project"],
            ["recent", "Recent, newest first"],
            ["archived", "Archived"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            data-rail-show={value}
            onClick={() => {
              setPref("railGrouping", value)
              if (value !== "project") setOpen(false)
            }}
            className={row(grouping === value)}
          >
            <span className="flex-1">{label}</span>
            {grouping === value ? (
              <CheckIcon className="size-3 text-foreground" />
            ) : null}
          </button>
        ))}

        <p className={section}>Agents</p>
        {[...counts.entries()]
          .filter(([harness]) => harness in harnessLabels())
          .sort((a, b) => b[1] - a[1])
          .map(([harness, count]) => {
            const active = filter.includes(harness)
            return (
              <button
                key={harness}
                type="button"
                onClick={() =>
                  setPref(
                    "agentHarnessFilter",
                    active
                      ? filter.filter((entry) => entry !== harness)
                      : [...filter, harness]
                  )
                }
                className={row(active)}
              >
                <HarnessIcon
                  harness={harness}
                  className="size-3.5"
                />
                <span className="flex-1">{harnessLabel(harness)}</span>
                {active ? (
                  <CheckIcon className="size-3 text-foreground" />
                ) : null}
                <span className="tabular text-label text-faint">{count}</span>
              </button>
            )
          })}

        <p className={section}>Order</p>
        {(
          [
            ["recent", "Latest activity"],
            ["created", "Newest first"],
            ["name", "By name"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setPref("railSortBy", value)}
            className={row(sortBy === value)}
          >
            <span className="flex-1">{label}</span>
            {sortBy === value ? (
              <CheckIcon className="size-3 text-foreground" />
            ) : null}
          </button>
        ))}

        <p className={section}>Folders</p>
        {(
          [
            ["all", "Every folder"],
            ["workspace", "This folder only"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setPref("railScope", value)}
            className={row(scope === value)}
          >
            <span className="flex-1">{label}</span>
            {scope === value ? (
              <CheckIcon className="size-3 text-foreground" />
            ) : null}
          </button>
        ))}

        {on ? (
          <button
            type="button"
            onClick={() => {
              setPref("agentHarnessFilter", [])
              setPref("railSortBy", "recent")
              setPref("railScope", "all")
              setPref("railGrouping", "project")
              setOpen(false)
            }}
            className="mt-1 flex w-full items-center justify-center px-2 py-1.5 text-label text-faint hover:bg-fill-hover hover:text-foreground"
          >
            Reset
          </button>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}

/**
 * One folder of conversations. Warm folders show a few rows; cold folders
 * rest as a single line. "More" unfolds
 * the tail in place — the grid-rows trick animates to unknown heights.
 */
/** `ROW_ACTIONS` for a folder header, whose group is `group/folder`. */
const FOLDER_ACTIONS =
  "pointer-events-none absolute inset-y-0 right-0 flex items-center pl-4 pr-0.5 opacity-0 transition-opacity duration-100 group-hover/folder:pointer-events-auto group-hover/folder:opacity-100 group-focus-visible/folder:pointer-events-auto group-focus-visible/folder:opacity-100 [.rail-folder:has(:focus-visible)_&]:pointer-events-auto [.rail-folder:has(:focus-visible)_&]:opacity-100 has-[[data-state=open]]:pointer-events-auto has-[[data-state=open]]:opacity-100"

/** The project's avatar (or the Chats glyph), which gives way to the chevron under the pointer or focus. */
const FOLDER_MARK_HIDES =
  "transition-opacity duration-100 group-hover/folder:opacity-0 group-focus-visible/folder:opacity-0 [.rail-folder:has(:focus-visible)_&]:opacity-0"

/** A project's own actions, from right-click on its header or its `…`. */
function FolderMenuItems({ folder, closed, hidden, movable, onToggle, onNew, onPin, onHide }: {
  folder: ThreadFolder & { cwd: string }
  closed: boolean
  hidden: boolean
  movable: boolean
  onToggle: () => void
  onNew?: () => void
  onPin?: () => void
  onHide: (hidden: boolean) => void
}) {
  // A window that routes reaches the folder's computer through its Sessions alone: no app setup, no editor of its own.
  const routed = useWindowRoutes((state) => state.routes !== null)
  return (
    <>
      {onNew ? (
        <MenuItem onSelect={onNew}>
          <PlusIcon className="size-3.5" />New thread in {folder.name}
        </MenuItem>
      ) : null}
      {onPin ? (
        <MenuItem onSelect={onPin}>
          {folder.pinned ? <PinOffIcon className="size-3.5" /> : <PinIcon className="size-3.5" />}{folder.pinned ? "Unpin project" : "Pin project"}
        </MenuItem>
      ) : null}
      <MenuItem onSelect={onToggle}>
        {closed ? <ChevronsUpDownIcon className="size-3.5" /> : <ChevronsDownUpIcon className="size-3.5" />}{closed ? "Expand" : "Collapse"}
      </MenuItem>
      {movable ? <>
        <MenuItem data-folder-action="move-up" onSelect={() => nudgeProject(folder.key, -1)}>
          <ArrowUpIcon className="size-3.5" />Move up
        </MenuItem>
        <MenuItem data-folder-action="move-down" onSelect={() => nudgeProject(folder.key, 1)}>
          <ArrowDownIcon className="size-3.5" />Move down
        </MenuItem>
      </> : null}
      <MenuSeparator />
      {routed ? null : <>
        <MenuItem data-folder-action="project-settings" onSelect={() => openProjectSettings(folder.cwd)}>
          <SlidersHorizontalIcon className="size-3.5" />Project settings
        </MenuItem>
        <MenuItem data-folder-action="app-setup" onSelect={() => openAppSetup(folder.cwd)}>
          <AppWindowIcon className="size-3.5" />App setup
        </MenuItem>
        <MenuItem onSelect={() => { void desktop.openInEditor(folder.cwd, prefsStore.get().externalEditor) }}>
          <CodeIcon className="size-3.5" />Open in editor
        </MenuItem>
      </>}
      <IfCanReveal>
        <MenuItem onSelect={() => { void desktop.revealPath(folder.cwd) }}>
          <FolderOpenIcon className="size-3.5" />Show the folder
        </MenuItem>
      </IfCanReveal>
      <MenuItem onSelect={() => { void navigator.clipboard.writeText(folder.cwd).then(() => toast("Path copied")) }}>
        <CopyIcon className="size-3.5" />Copy path
      </MenuItem>
      <MenuSeparator />
      <MenuItem data-folder-action={hidden ? "show" : "hide"} onSelect={() => onHide(!hidden)}>
        {hidden ? <EyeIcon className="size-3.5" /> : <EyeOffIcon className="size-3.5" />}{hidden ? "Show project" : "Hide project"}
      </MenuItem>
    </>
  )
}

/** Hide takes effect at once, with Undo; showing again is quiet. */
function hideProject(folder: ThreadFolder & { cwd: string }, hidden: boolean) {
  setProjectHidden(folder.cwd, hidden)
  if (!hidden) return
  toast(`Hid ${folder.name}`, {
    id: `hide-project:${folder.cwd}`,
    description: "It's under Hidden at the end of the list. Opening the folder brings it back.",
    duration: ACTION_TOAST_MS,
    action: { label: "Undo", onClick: () => setProjectHidden(folder.cwd, false) },
  })
}

/** A cold folder starts closed, a warm one open (`COLD_MS`). */
function folderStartsClosed(folder: ThreadFolder, now: number): boolean {
  return !folder.current && !folder.priority && folder.latest !== "" && now - Date.parse(folder.latest) > COLD_MS
}

interface FolderSectionProps {
  folder: ThreadFolder
  now: number
  fold: ThreadFold
  liveAgents: AcpPresence[]
  collapsed: boolean
  /** The Thread the person just started here and hasn't sent yet: drawn first, lit (`revealFolder`). */
  unsent?: boolean
  /** Open for the reveal of a Thread just started or a folder just added, whatever the stored choice, until folded. */
  revealed?: boolean
  /** Shown from the Hidden row: dimmed, and its menu offers Show. */
  hidden?: boolean
  pages: number
  /** Shows `next` pages of the folder with this key; the same function at every draw. */
  onPages: (key: string, next: number) => void
}

/**
 * Whether a folder would draw as it did. The list is grouped again on every change to any row, which makes each
 * folder a new object with new arrays; most of them hold the rows, the counts and the Sessions they held.
 */
function sameFolderSection(before: FolderSectionProps, after: FolderSectionProps): boolean {
  const was = before.folder
  const is = after.folder
  return (
    before.now === after.now &&
    before.collapsed === after.collapsed &&
    before.unsent === after.unsent &&
    before.revealed === after.revealed &&
    before.hidden === after.hidden &&
    before.pages === after.pages &&
    before.onPages === after.onPages &&
    was.key === is.key &&
    was.name === is.name &&
    was.cwd === is.cwd &&
    was.current === is.current &&
    was.pinned === is.pinned &&
    was.latest === is.latest &&
    was.priority === is.priority &&
    was.running === is.running &&
    was.needsInput === is.needsInput &&
    was.failed === is.failed &&
    was.unread === is.unread &&
    was.active === is.active &&
    was.refs.length === is.refs.length &&
    was.refs.every((ref, index) => ref === is.refs[index] && before.fold.byLead.get(ref.path) === after.fold.byLead.get(ref.path)) &&
    before.liveAgents.length === after.liveAgents.length &&
    before.liveAgents.every((presence, index) => presence === after.liveAgents[index] && before.fold.byLead.get(presence.key) === after.fold.byLead.get(presence.key))
  )
}

const FolderSection = memo(function FolderSection({
  folder,
  now,
  fold,
  liveAgents,
  collapsed,
  unsent = false,
  revealed = false,
  hidden = false,
  pages,
  onPages,
}: FolderSectionProps) {
  // A cold folder starts closed, a warm one open; the stored flag means
  // "the user flipped this one from its default", so both kinds remember.
  const cold = folderStartsClosed(folder, now)
  const chosenClosed = collapsed ? !cold : cold
  // A reveal opens it for this view alone; folding it hands it back to the stored choice, closed.
  const closed = revealed ? false : chosenClosed
  const rows = useFoldAway(closed)
  const onToggle = () => {
    rows.fold()
    if (revealed) releaseRevealedFolder(folder.key)
    if (!revealed || !chosenClosed) toggleFolder(folder)
  }
  const cwd = folder.cwd
  const onNew = cwd === null ? undefined : () => newThreadIn(cwd)
  const onPin = cwd === null ? undefined : () => togglePinnedProject(cwd)
  const head = useCheckoutHead(folder.cwd ?? undefined)
  const contentId = `folder-${folder.key.replace(/[^a-zA-Z0-9_-]/g, "-")}`

  // A Thread Done for three days leaves the rows for one "N done" line, which opens them in place.
  const threadOf = useThreadGroups((state) => state.threadOf)
  const doneKeys = useThreadMarks((state) => folder.refs.filter((ref) => foldedAsDone(state.byThread[rowThread(ref, threadOf) ?? ""], now)).map((ref) => ref.path).join("\n"))
  const [showDone, setShowDone] = useState(false)
  const folded = doneKeys ? new Set(doneKeys.split("\n")) : null
  const refs = folded ? folder.refs.filter((ref) => !folded.has(ref.path)) : folder.refs
  const doneRefs = folded && showDone ? folder.refs.filter((ref) => folded.has(ref.path)) : []
  const limit = FOLDER_LEAD_ROWS + pages * PAGE_ROWS
  const shownLive = liveAgents.slice(0, limit)
  const visible = refs.slice(0, Math.max(0, limit - shownLive.length))
  const more = refs.length + liveAgents.length - visible.length - shownLive.length
  const project = folder.cwd === null ? null : { ...folder, cwd: folder.cwd }
  // A project with a folder moves by hand, when the list is in the order worked in; a hidden one stays under Hidden.
  const sortBy = usePrefs((prefs) => prefs.railSortBy)
  const movable = project !== null && !hidden && sortBy === "recent"
  const dragging = useProjectDrag((state) => state.drag?.key === folder.key)
  const menuItems = project ? (
    <FolderMenuItems folder={project} closed={closed} hidden={hidden} movable={movable} onToggle={onToggle} onNew={onNew} onPin={onPin} onHide={(next) => hideProject(project, next)} />
  ) : null

  const header = (
    <div data-flip-key={`folder:${folder.key}`} data-folder-hidden={hidden || undefined} className="rail-folder rail-calm group/folder relative flex h-7 w-full items-center transition-colors duration-100 hover:bg-fill-hover data-[state=open]:bg-fill-hover">
      <button
        type="button"
        data-folder-toggle={folder.key}
        onPointerDown={movable && project ? (event) => startProjectDrag(event, { key: folder.key, name: folder.name, folder: project.cwd }) : undefined}
        data-tip={[folder.cwd ?? folder.name, head ? (head.kind === "branch" ? `On ${checkoutSentence(head)}` : checkoutSentence(head)) : undefined, folder.pinned ? "Pinned" : undefined].filter(Boolean).join("\n")}
        aria-expanded={!closed}
        aria-controls={contentId}
        onClick={onToggle}
        className={cn("flex min-w-0 flex-1 items-center gap-2 self-stretch px-2 text-left", hidden && "opacity-55")}
      >
        {/* The project's avatar turns into the disclosure chevron under the
            pointer, so the row carries one leading mark instead of two. */}
        <span className="relative flex size-[18px] shrink-0 items-center justify-center text-faint">
          {folder.cwd ? (
            <ProjectAvatar name={folder.name} folder={folder.cwd} className={FOLDER_MARK_HIDES} />
          ) : (
            <MessagesSquareIcon className={cn("size-[15px] stroke-[1.75]", FOLDER_MARK_HIDES)} />
          )}
          <ChevronRightIcon
            className={cn(
              "absolute size-3.5 opacity-0 transition-[opacity,transform] duration-200 ease-out group-hover/folder:opacity-100 group-focus-visible/folder:opacity-100 [.rail-folder:has(:focus-visible)_&]:opacity-100",
              !closed && "rotate-90"
            )}
          />
        </span>
        <span className={cn("rail-fade min-w-8 flex-1 text-ui font-medium", folder.current ? "text-foreground" : "text-foreground/80")}>
          {folder.name}
        </span>
        {/* Folded away, a project says only that something inside needs the person. */}
        <span data-row-end className="flex shrink-0 items-center pr-1.5">
          {closed && (folder.needsInput || folder.failed) ? <span data-folder-needs aria-label="Something here needs you" className="rail-attention-dot" /> : null}
        </span>
      </button>
      <span data-tip-quiet className={cn("rail-row-actions", FOLDER_ACTIONS)}>
        {onNew ? (
          <button
            type="button"
            aria-label={`New thread in ${folder.name}`}
            title={`New thread in ${folder.name}`}
            onClick={onNew}
            className="pressable flex size-6 shrink-0 items-center justify-center text-faint transition-colors duration-100 hover:bg-fill-hover hover:text-foreground"
          >
            <PlusIcon className="size-3.5" />
          </button>
        ) : null}
        {menuItems ? (
          <Menu modal={false}>
            <MenuTrigger asChild>
              <button
                type="button"
                aria-label={`Actions for ${folder.name}`}
                className="pressable flex size-6 shrink-0 items-center justify-center text-faint transition-colors duration-100 hover:bg-fill-hover hover:text-foreground data-[state=open]:bg-fill-hover data-[state=open]:text-foreground"
              >
                <MoreHorizontalIcon className="size-3.5" />
              </button>
            </MenuTrigger>
            <MenuContent align="end" sideOffset={4} className="min-w-52">{menuItems}</MenuContent>
          </Menu>
        ) : null}
      </span>
    </div>
  )

  return (
    <section data-project-section={folder.key} data-project-name={folder.name} data-project-movable={movable || undefined} data-dragging={dragging || undefined} className={cn("pb-2 transition-opacity duration-150", dragging && "opacity-35")}>
      {menuItems ? (
        <ContextMenu modal={false}>
          <ContextMenuTrigger asChild>{header}</ContextMenuTrigger>
          <ContextMenuContent className="min-w-52">{menuItems}</ContextMenuContent>
        </ContextMenu>
      ) : header}
      <div
        id={contentId}
        className={cn(
          "grid transition-[grid-template-rows] duration-200 ease-out",
          closed ? "grid-rows-[0fr]" : "grid-rows-[1fr]"
        )}
      >
        {/* `data-folding`: its rows are back with the fold, and come in with it, not each on its own (`useRowFlip`). */}
        <div className="min-h-0 overflow-hidden" data-folding={rows.folding || undefined}>
          {rows.drawn ? <>
          {unsent ? (
            <div data-active data-unsent-thread className={cn(ROW_SURFACE, "pl-2")} aria-current="page">
              <PencilLineIcon className="size-3 shrink-0 text-faint" />
              <span className="min-w-0 flex-1 truncate text-ui text-foreground/85">New thread</span>
            </div>
          ) : null}
          {shownLive.map((presence) => <LiveAgentRow key={presence.key} presence={presence} folded={fold.byLead.get(presence.key)} indent now={now} />)}
          {visible.map((ref) => (
            <ThreadRow key={ref.path} threadRef={ref} folded={fold.byLead.get(ref.path)} indent />
          ))}
          {more > 0 ? (
            <button
              type="button"
              onClick={() => onPages(folder.key, pages + 1)}
              data-folder-more={more}
              className="flex h-7 w-full items-center pl-9 text-left text-label text-faint transition-colors duration-100 hover:bg-fill-hover hover:text-muted-foreground"
            >
              Show {more} more
            </button>
          ) : pages > 0 ? (
            <button
              type="button"
              onClick={() => onPages(folder.key, 0)}
              data-folder-less
              className="flex h-7 w-full items-center pl-9 text-left text-label text-faint transition-colors duration-100 hover:bg-fill-hover hover:text-muted-foreground"
            >
              Show less
            </button>
          ) : null}
          {folded ? (
            <button
              type="button"
              aria-expanded={showDone}
              data-folder-done={folded.size}
              onClick={() => setShowDone((current) => !current)}
              className="flex h-7 w-full items-center gap-2 pl-[30px] text-left text-label text-faint transition-colors duration-100 hover:bg-fill-hover hover:text-muted-foreground"
            >
              <WorkGlyph status="done" className="text-faint" />
              {showDone ? "Fold the done" : `${folded.size} done`}
            </button>
          ) : null}
          {/* The Done Threads it holds, under it, all of them: they're out of the project's paging. */}
          {doneRefs.map((ref) => (
            <ThreadRow key={ref.path} threadRef={ref} folded={fold.byLead.get(ref.path)} indent />
          ))}
          </> : null}
        </div>
      </div>
    </section>
  )
}, sameFolderSection)
