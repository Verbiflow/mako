import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react"
import { RailAnnouncer } from "@/components/rail/thread-status"
import type { RailAsk } from "@/lib/rail-announcement"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { LiveAgentRow } from "@/components/rail/active-threads"
import { AppMarkIcon } from "@/components/rail/app-mark"
import { threadAppDriver } from "@/state/thread-app"
import type { AcpPresence } from "@/state/acp-presence"
import { ThreadRow } from "@/components/rail/thread-row"
import { HARNESS_LABEL, harnessLabel } from "@/components/rail/harness-meta"
import { formatRelative } from "@/lib/format"
import {
  groupThreadFolders,
  orderThreadFolders,
  showsInRecent,
  stableFolderRanks,
  stableThreadRanks,
  threadBelongsToWorkspace,
  threadFolderKey,
  visibleThreadFolders,
  type FolderRanks,
  type RailRanks,
  type ThreadFolder,
  type ThreadFolderActivity,
} from "@/lib/thread-folders"
import {
  boardBucketOf,
  groupThreadBoard,
  liveBoardBucket,
  type BoardBucket,
  type BoardItem,
  type BoardSection as BoardSectionData,
} from "@/lib/thread-board"
import { useRowFlip } from "@/components/rail/use-row-flip"
import { EMPTY_FOLD, foldThreads, foldedThreadStatus, type FoldRow, type ThreadFold } from "@/lib/thread-fold"
import { useThreadGroups } from "@/state/thread-groups"
import { RailTip } from "@/components/rail/rail-tip"
import { railRanksStore } from "@/state/rail-ranks"
import {
  threadStatus,
  threadStatusPriority,
  threadsStore,
  useThreads,
  type ThreadStatus,
} from "@/state/threads"
import type { ThreadRef } from "@/lib/types"
import { ActivityMark, type ActivityState } from "@/components/ui/activity-mark"
import { actions } from "@/state/session"
import { checkoutSentence, followCheckouts, useCheckoutHead } from "@/state/checkout-heads"
import { CheckoutLabel } from "@/components/rail/checkout-label"
import { useAcp } from "@/state/acp"
import {
  canonicalThreadRefs,
  sameAcpPresence,
  sameSessionOwners,
  selectAcpPresence,
  selectSessionOwners,
} from "@/state/acp-presence"
import { useWorkspaceFocus } from "@/components/stage/workspace-focus-context"
import { prefsStore, setPref, setProjectHidden, togglePinnedProject, usePrefs } from "@/state/prefs"
import { openAppSetup } from "@/state/app-setup"
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
import { useWorktrees } from "@/state/worktrees"
import { cn } from "@/lib/utils"
import { Blank } from "@/components/ui/kit"
import { formatChord } from "@/extend/commands"
import { DraftThreads } from "@/components/rail/draft-threads"
import { archivedLive, archivedThread, useThreadArchives } from "@/state/thread-lifecycle"
import { FolderActivity, RailSkeleton } from "@/components/rail/rail-activity"
import { HarnessIcon } from "@/components/ui/provider-icon"
import {
  AppWindowIcon,
  CheckIcon,
  ChevronRightIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  CodeIcon,
  CopyIcon,
  EyeIcon,
  EyeOffIcon,
  FolderIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  ListFilterIcon,
  MessagesSquareIcon,
  MoreHorizontalIcon,
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
 * Position never carries status. A folder takes its place when first seen
 * and moves only when you work there — a prompt sent, a thread started —
 * never when an agent answers; a busy thread keeps its rank until it
 * finishes; while the pointer is inside the rail nothing changes place at
 * all. What a thread needs from you is its mark and its folder's chip, and
 * the Status view is the one place threads regroup by state, on purpose.
 * Rows that do move glide there. Each folder holds the same handful of rows
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
/** Rows the board's Done section shows before "More"; the sections above it show everything. */
const BOARD_LEAD_ROWS = 8
const FOLDER_ROWS = 6
/** Folders quiet longer than this start out collapsed. */
const COLD_MS = 7 * 24 * 3600_000
const LIVE_TIME_MS = 60_000
const INITIAL_TIME = Date.now()

function useLiveTime(): number {
  const [now, setNow] = useState(INITIAL_TIME)

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), LIVE_TIME_MS)
    return () => window.clearInterval(timer)
  }, [])

  return now
}

export function AgentThreads() {
  const rail = useRef<HTMLDivElement>(null)
  const topFade = useRef<HTMLSpanElement>(null)
  const [query, setQuery] = useState("")
  const [jumpHints, setJumpHints] = useState(false)
  const [searching, setSearching] = useState(false)
  const [showAllPinned, setShowAllPinned] = useState(false)
  const [showAllFolders, setShowAllFolders] = useState(false)
  // Extra pages unfolded per folder — More reveals a handful at a time,
  // not the whole archive in one avalanche.
  const [pages, setPages] = useState<Record<string, number>>({})
  useEffect(() => threadAppDriver()?.watchMarks?.(), [])
  const deferred = useDeferredValue(query)
  const nativeRefs = useThreads((state) => state.threads)
  const liveAgents = useAcp(selectAcpPresence, sameAcpPresence)
  const loaded = useThreads((state) => state.loaded)
  const working = useThreads((state) => state.working)
  const attention = useThreads((state) => state.attention)
  const observed = useThreads((state) => state.observed)
  const externalActivity = useThreads((state) => state.externalActivity)
  const filter = usePrefs((prefs) => prefs.agentHarnessFilter)
  const pinned = usePrefs((prefs) => prefs.pinnedThreads)
  const owners = useAcp(selectSessionOwners, sameSessionOwners)
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
  const folderUse = usePrefs((prefs) => prefs.folderUse)
  const scroller = useRef<HTMLDivElement>(null)
  // The order caught when the pointer entered the rail; held until it leaves,
  // so nothing can change place under a click.
  const [hold, setHold] = useState<{ ranks: RailRanks; folderRanks: FolderRanks } | null>(null)
  const { cwd } = useWorkspaceFocus()
  const now = useLiveTime()

  useEffect(() => {
    const search = () => setSearching(true)
    window.addEventListener("mako:search-threads", search)
    return () => window.removeEventListener("mako:search-threads", search)
  }, [])

  useEffect(() => {
    const rows = () =>
      [
        ...(rail.current?.querySelectorAll<HTMLElement>("[data-thread-row]") ??
          []),
      ].filter((row) => row.offsetParent !== null)
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return
      const mod = event.metaKey || event.ctrlKey
      setJumpHints(mod && event.shiftKey)
      if (!mod || !event.shiftKey || !event.code.startsWith("Digit")) return
      const index = Number(event.code.slice(5)) - 1
      const row = rows()[index]
      if (!row || index < 0 || index > 8) return
      event.preventDefault()
      row.click()
    }
    const onKeyUp = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey)
        setJumpHints(false)
    }
    const onBlur = () => setJumpHints(false)
    window.addEventListener("keydown", onKeyDown)
    window.addEventListener("keyup", onKeyUp)
    window.addEventListener("blur", onBlur)
    return () => {
      window.removeEventListener("keydown", onKeyDown)
      window.removeEventListener("keyup", onKeyUp)
      window.removeEventListener("blur", onBlur)
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
    const nativePaths = new Set(all.map((ref) => ref.path))
    const nativeIdentities = new Set(
      all.map((ref) => `${ref.harness}:${ref.identity ?? ref.nativeId}`)
    )
    return liveAgents.filter(
      (presence) =>
        (grouping === "archived" ? archivedLive(presence, archiveKeys) : !archivedLive(presence, archiveKeys) || presence.status === "running" || presence.status === "starting" || presence.status === "needs-permission") &&
        (!filter.length || filter.includes(presence.harness)) &&
        (scope !== "workspace" || threadBelongsToWorkspace(presence, cwd)) &&
        (!deferred.trim() || `${presence.title ?? ""} ${presence.cwd} ${presence.harness}`.toLowerCase().includes(deferred.trim().toLowerCase())) &&
        (!presence.threadPath || !nativePaths.has(presence.threadPath)) &&
        !presence.nativePaths?.some((path) => nativePaths.has(path)) &&
        (!presence.nativeId ||
          !nativeIdentities.has(`${presence.harness}:${presence.nativeId}`))
    )
  }, [all, liveAgents, filter, scope, cwd, deferred, archiveKeys, grouping])

  const matched = useMemo(() => {
    const needle = deferred.trim().toLowerCase()
    const active = filter.length > 0 ? new Set(filter) : null
    const statusState = { ...threadsStore.get(), attention, working, externalActivity }
    return all.filter(
      (ref) =>
        (grouping === "archived" ? archivedThread(ref, archiveKeys) : !archivedThread(ref, archiveKeys) || ["working", "external-active", "needs-permission"].includes(threadStatus(ref, statusState).kind)) &&
        (scope !== "workspace" || threadBelongsToWorkspace(ref, cwd)) &&
        (!active || active.has(ref.harness)) &&
        (!needle ||
          `${ref.title ?? ""} ${ref.cwd ?? ""} ${harnessLabel(ref.harness)} ${ref.model ?? ""}`
            .toLowerCase()
            .includes(needle))
    )
  }, [all, cwd, deferred, filter, scope, archiveKeys, grouping, attention, working, externalActivity])

  // A Thread with several Sessions is one row: its first Session's row
  // stands for the rest, which leave the list before anything counts or
  // ranks them.
  const groups = useThreadGroups((state) => state.groups)
  const threadOf = useThreadGroups((state) => state.threadOf)
  const fold = useMemo((): ThreadFold => {
    const grouped = (session?: string) => session !== undefined && threadOf[session] !== undefined
    const rows: FoldRow[] = [
      ...matched.flatMap((ref): FoldRow[] => (grouped(ref.sessionId) ? [{ kind: "native", key: ref.path, ref }] : [])),
      ...unboundLiveAgents.flatMap((presence): FoldRow[] => (grouped(presence.sessionId) ? [{ kind: "live", key: presence.key, presence }] : [])),
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

  const { priorities, threadActivity, statuses } = useMemo(() => {
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
      const status = folded
        ? foldedThreadStatus(folded.members, (member) => threadStatus(member, state))
        : threadStatus(ref, state)
      nextStatuses[ref.path] = status
      nextPriorities[ref.path] = threadStatusPriority(status)
      nextActivity[ref.path] = {
        running: status.kind === "working",
        needsInput: status.kind === "needs-permission",
        failed: status.kind === "failed",
        unread: status.kind === "review" && status.unread,
        active: status.kind === "external-active",
        observed: status.kind === "observed",
      }
    }
    return { priorities: nextPriorities, threadActivity: nextActivity, statuses: nextStatuses }
  }, [attention, externalActivity, fold, shownRefs, observed, working])

  const asks = useMemo((): RailAsk[] => [
    ...shownRefs.flatMap((ref): RailAsk[] => {
      const kind = statuses[ref.path]?.kind
      return kind === "needs-permission" || kind === "failed" ? [{ key: ref.path, title: ref.title ?? "A thread", kind }] : []
    }),
    ...shownLive.flatMap((presence): RailAsk[] =>
      presence.status === "needs-permission" || presence.status === "failed"
        ? [{ key: presence.key, title: presence.title ?? "A conversation", kind: presence.status }]
        : []),
  ], [shownRefs, shownLive, statuses])

  // Ranks from the last render decide this one, so a thread that is busy
  // keeps its place instead of climbing on every appended byte.
  const ranks = useMemo(
    () => stableThreadRanks(shownRefs, threadActivity, railRanksStore.get().ranks),
    [shownRefs, threadActivity]
  )
  const shownRanks = hold?.ranks ?? ranks

  const held = useMemo(() => {
    const set = new Set(pinned)
    const list = shownRefs.filter((ref) => set.has(ref.path))
    list.sort((a, b) => pinned.indexOf(a.path) - pinned.indexOf(b.path))
    return list
  }, [shownRefs, pinned])

  const folderMap = useWorktrees((state) => state.folderMap)
  const grouped = useMemo(
    () =>
      groupThreadFolders({
        refs: shownRefs,
        live: shownLive,
        currentCwd: cwd,
        pinnedThreads: pinned,
        pinnedFolders: pinnedProjects,
        priorities,
        activity: threadActivity,
        ranks: shownRanks,
        sortBy,
        folderMap,
      }),
    [cwd, shownRefs, shownLive, pinned, pinnedProjects, priorities, shownRanks, sortBy, threadActivity, folderMap]
  )
  // A folder takes its place when first seen and keeps it until you work
  // there. Agent output never moves one.
  const folderRanks = useMemo(
    () => stableFolderRanks(grouped, folderUse, railRanksStore.get().folderRanks),
    [grouped, folderUse]
  )
  useEffect(() => {
    railRanksStore.set({ ranks, folderRanks })
  }, [ranks, folderRanks])
  const folders = useMemo(
    () => orderThreadFolders(grouped, hold?.folderRanks ?? folderRanks, sortBy),
    [grouped, hold, folderRanks, sortBy]
  )
  const recent = useMemo(() => [
    ...shownRefs.filter((ref) => showsInRecent(ref, threadActivity[ref.path])).map((ref) => ({ kind: "native" as const, key: ref.path, at: shownRanks[ref.path]?.at ?? ref.updatedAt ?? "", ref })),
    ...shownLive.map((presence) => ({ kind: "live" as const, key: presence.key, at: new Date(presence.createdAt).toISOString(), presence })),
  ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 80), [shownRefs, shownRanks, threadActivity, shownLive])
  const board = useMemo((): BoardSectionData<BoardRow>[] => {
    if (grouping !== "status") return []
    const items: BoardItem<BoardRow>[] = [
      ...shownRefs.map((ref) => {
        const status = statuses[ref.path] ?? { kind: "idle" as const }
        const placed = boardBucketOf(status)
        return {
          key: ref.path,
          bucket: placed.bucket,
          at: placed.at ?? shownRanks[ref.path]?.at ?? ref.updatedAt ?? "",
          item: { kind: "native" as const, ref },
        }
      }),
      ...shownLive.map((presence) => ({
        key: presence.key,
        bucket: liveBoardBucket(presence.status),
        at: new Date(presence.createdAt).toISOString(),
        item: { kind: "live" as const, presence },
      })),
    ]
    return groupThreadBoard(items)
  }, [grouping, shownRefs, statuses, shownRanks, shownLive])

  const searchActive = Boolean(deferred.trim())
  useRowFlip(scroller, `${grouping}:${searchActive}`)
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
      liveAgents={shownLive.filter((presence) => (threadFolderKey(presence, folderMap) || "~") === folder.key)}
      collapsed={collapsed.includes(`ws:${folder.key}`)}
      hidden={hidden}
      onToggle={() => {
        const key = `ws:${folder.key}`
        setPref(
          "collapsedGroups",
          collapsed.includes(key)
            ? collapsed.filter((entry) => entry !== key)
            : [...collapsed, key]
        )
      }}
      onNew={() => {
        if (folder.cwd) void actions.newConversationIn(folder.cwd)
      }}
      onPin={() => {
        if (folder.cwd) togglePinnedProject(folder.cwd)
      }}
      pages={pages[folder.key] ?? 0}
      onPages={(next) =>
        setPages((prev) => ({ ...prev, [folder.key]: next }))
      }
    />
  )
  const shownCheckouts = shownFolders.flatMap((folder) => (folder.cwd ? [folder.cwd] : [])).join("\n")
  useEffect(() => {
    if (shownCheckouts) followCheckouts(shownCheckouts.split("\n"))
  }, [shownCheckouts])

  useEffect(() => {
    const rows =
      rail.current?.querySelectorAll<HTMLElement>("[data-thread-row]")
    rows?.forEach((row, index) => {
      if (index < 9) row.dataset.jumpIndex = String(index + 1)
      else delete row.dataset.jumpIndex
    })
  }, [folders, held, jumpHints, shownRefs, shownLive, pages, showAllPinned, showAllFolders])

  return (
    <div
      ref={rail}
      data-jump-hints={jumpHints || undefined}
      onKeyDown={(event) => {
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
      className="thread-jump-scope flex min-h-0 flex-1 flex-col"
    >
      <RailAnnouncer asks={asks} />
      <RailHeader
        searching={searching}
        query={query}
        onQuery={setQuery}
        onToggleSearch={(next) => {
          setSearching(next)
          if (!next) setQuery("")
        }}
        counts={counts}
        filter={filter}
      />
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
          onPointerEnter={() => setHold((current) => current ?? { ranks, folderRanks })}
          onPointerLeave={() => setHold(null)}
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
                  {
                    label: "Open a folder",
                    keys: formatChord("mod+o"),
                    onSelect: () => void actions.pickWorkspace(),
                  },
                ]}
              />
            )
          ) : grouping === "status" && !searchActive ? (
            <div className="pt-1">
              <DraftThreads />
              {board.every((section) => section.key === "working" || section.key === "done") ? (
                <p data-flip-key="board:calm" className="flex h-7 items-center px-1.5 text-label text-faint/70">
                  Nothing needs you right now
                </p>
              ) : null}
              {board.map((section) => (
                <BoardSection
                  key={section.key}
                  section={section}
                  fold={fold}
                  pages={pages[`board:${section.key}`] ?? 0}
                  onPages={(next) =>
                    setPages((prev) => ({ ...prev, [`board:${section.key}`]: next }))
                  }
                />
              ))}
            </div>
          ) : searchActive || grouping !== "project" ? (
            <div className="pt-1">
              {grouping !== "archived" ? <DraftThreads /> : null}
              {recent.map((row) => row.kind === "native"
                ? <ThreadRow key={row.key} threadRef={row.ref} folded={fold.byLead.get(row.key)} showFolder />
                : <LiveAgentRow key={row.key} presence={row.presence} folded={fold.byLead.get(row.key)} />)}
              {shownRefs.length + shownLive.length > recent.length ? (
                <button type="button" onClick={() => setSearching(true)} className="pressable h-7 w-full px-2 text-left text-label text-faint hover:text-foreground">Search older threads</button>
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
                      className="flex h-6 w-full items-center rounded-md pl-7 text-left text-label text-faint transition-colors duration-100 hover:bg-fill-hover hover:text-muted-foreground"
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
                  className="mb-1 flex h-7 w-full items-center rounded-md px-1.5 text-left text-label text-faint transition-colors duration-100 hover:bg-fill-hover hover:text-muted-foreground"
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
                    onClick={() => setShowHidden((current) => !current)}
                    className="group/hidden mb-1 flex h-7 w-full items-center gap-1.5 rounded-md px-1.5 text-left text-label text-faint transition-colors duration-100 hover:bg-fill-hover hover:text-muted-foreground"
                  >
                    <ChevronRightIcon className={cn("size-3.5 transition-transform duration-200 ease-out", showHidden && "rotate-90")} />
                    Hidden
                    <span className="tabular text-faint/60">{hiddenList.length}</span>
                  </button>
                  <div className={cn("grid transition-[grid-template-rows] duration-200 ease-out", showHidden ? "grid-rows-[1fr]" : "grid-rows-[0fr]")}>
                    <div className="min-h-0 overflow-hidden" inert={!showHidden}>
                      {hiddenList.map((folder) => folderSection(folder, true))}
                    </div>
                  </div>
                </>
              ) : null}
              {sessions ? (
                <FolderSection
                  folder={sessions}
                  now={now}
                  fold={fold}
                  liveAgents={shownLive.filter((presence) => !threadFolderKey(presence, folderMap))}
                  collapsed={collapsed.includes(`ws:${sessions.key}`)}
                  onToggle={() => {
                    const key = `ws:${sessions.key}`
                    setPref(
                      "collapsedGroups",
                      collapsed.includes(key)
                        ? collapsed.filter((entry) => entry !== key)
                        : [...collapsed, key]
                    )
                  }}
                  pages={pages[sessions.key] ?? 0}
                  onPages={(next) =>
                    setPages((prev) => ({ ...prev, [sessions.key]: next }))
                  }
                />
              ) : null}
            </>
          )}
        </div>
        <span
          aria-hidden
          className="scroll-fade-bottom [--fade-from:var(--shell)]"
        />
        <RailTip scroller={scroller} />
      </div>
    </div>
  )
}

/**
 * The rail's one header line: an eyebrow, and two glyphs that expand into
 * search and the provider filter only when wanted. While searching, the whole
 * line becomes the input — space is spent on what is being done.
 */
function RailHeader({
  searching,
  query,
  onQuery,
  onToggleSearch,
  counts,
  filter,
}: {
  searching: boolean
  query: string
  onQuery: (value: string) => void
  onToggleSearch: (next: boolean) => void
  counts: Map<string, number>
  filter: string[]
}) {
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
          onChange={(event) => onQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation()
              onToggleSearch(false)
            }
          }}
          placeholder="Search every thread"
          aria-label="Search every thread"
          className="h-7 min-w-0 flex-1 bg-transparent px-1.5 text-ui text-foreground placeholder:text-faint focus:outline-none"
        />
        <button
          type="button"
          aria-label="Close search"
          onClick={() => onToggleSearch(false)}
          className="pressable rounded p-1 text-faint hover:text-foreground"
        >
          <XIcon className="size-3" />
        </button>
      </div>
    )
  }

  return (
    <div className="flex h-9 shrink-0 items-center px-2 pt-1.5">
      <div className="flex items-center gap-0.5" role="group" aria-label="Thread view">
        {/* Archived is reached from the filter glyph; while it is showing, the
            one pressed pill names it and returns to Projects. */}
        {(grouping === "archived"
          ? ([["archived", "Archived"]] as const)
          : ([["project", "Projects"], ["recent", "Recent"], ["status", "Status"]] as const)
        ).map(([value, label]) => (
          <button key={value} type="button" aria-pressed={grouping === value} onClick={() => setPref("railGrouping", value === "archived" ? "project" : value)} className={cn("pressable h-6 rounded px-1.5 text-label transition-colors hover:bg-fill-hover", grouping === value ? "bg-fill-selected font-medium text-foreground" : "text-faint")}>{label}</button>
        ))}
      </div>
      <span className="flex-1" />
      <button
        type="button"
        aria-label="Search threads"
        onClick={() => onToggleSearch(true)}
        className="pressable rounded-md p-1.5 text-faint transition-colors duration-100 hover:bg-fill-hover hover:text-foreground"
      >
        <SearchIcon className="size-3.5" />
      </button>
      <HarnessFilter counts={counts} filter={filter} />
      <button
        type="button"
        aria-label="Open a folder"
        title="Open a folder"
        onClick={() => void actions.pickWorkspace()}
        className="pressable rounded-md p-1.5 text-faint transition-colors duration-100 hover:bg-fill-hover hover:text-foreground"
      >
        <FolderPlusIcon className="size-3.5" />
      </button>
    </div>
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
  const [open, setOpen] = useState(false)
  const sortBy = usePrefs((prefs) => prefs.railSortBy)
  const scope = usePrefs((prefs) => prefs.railScope)
  const grouping = usePrefs((prefs) => prefs.railGrouping)
  const archived = grouping === "archived"
  const on = filter.length > 0 || scope === "workspace" || sortBy !== "recent" || archived

  const section = "px-2 pt-2 pb-1 text-label font-medium text-faint/80"
  const row = (active: boolean) =>
    cn(
      "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-ui transition-colors duration-100",
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
          className={cn(
            "pressable relative rounded-md p-1.5 transition-colors duration-100 hover:bg-fill-hover",
            on ? "text-foreground" : "text-faint hover:text-foreground"
          )}
        >
          <ListFilterIcon className="size-3.5" />
          {on ? (
            <span className="absolute top-1 right-1 size-1.5 rounded-full bg-foreground" />
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={6} className="w-56 p-1">
        <p className={section}>Agents</p>
        {[...counts.entries()]
          .filter(([harness]) => harness in HARNESS_LABEL)
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
                  tinted={active}
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

        <p className={section}>Show</p>
        {(
          [
            [false, "Current threads"],
            [true, "Archived threads"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={label}
            type="button"
            onClick={() => {
              if (value !== archived) setPref("railGrouping", value ? "archived" : "project")
              if (value) setOpen(false)
            }}
            className={row(archived === value)}
          >
            <span className="flex-1">{label}</span>
            {archived === value ? (
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
              if (archived) setPref("railGrouping", "project")
              setOpen(false)
            }}
            className="mt-1 flex w-full items-center justify-center rounded-md border-t border-hairline px-2 py-1.5 text-label text-faint hover:text-foreground"
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
  "pointer-events-none absolute inset-y-0 right-0 flex items-center rounded-r-md pl-4 pr-0.5 opacity-0 transition-opacity duration-100 group-hover/folder:pointer-events-auto group-hover/folder:opacity-100 group-focus-within/folder:pointer-events-auto group-focus-within/folder:opacity-100 has-[[data-state=open]]:pointer-events-auto has-[[data-state=open]]:opacity-100"

/** A project's own actions, from right-click on its header or its `…`. */
function FolderMenuItems({ folder, closed, hidden, onToggle, onNew, onPin, onHide }: {
  folder: ThreadFolder & { cwd: string }
  closed: boolean
  hidden: boolean
  onToggle: () => void
  onNew?: () => void
  onPin?: () => void
  onHide: (hidden: boolean) => void
}) {
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
      <MenuSeparator />
      <MenuItem data-folder-action="app-setup" onSelect={() => openAppSetup(folder.cwd)}>
        <AppWindowIcon className="size-3.5" />App setup
      </MenuItem>
      <MenuItem onSelect={() => { void desktop.openInEditor(folder.cwd, prefsStore.get().externalEditor) }}>
        <CodeIcon className="size-3.5" />Open in editor
      </MenuItem>
      <MenuItem onSelect={() => { void desktop.revealPath(folder.cwd) }}>
        <FolderOpenIcon className="size-3.5" />Show the folder
      </MenuItem>
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

function FolderSection({
  folder,
  now,
  fold,
  liveAgents,
  collapsed,
  hidden = false,
  onToggle,
  onNew,
  onPin,
  pages,
  onPages,
}: {
  folder: ThreadFolder
  now: number
  fold: ThreadFold
  liveAgents: AcpPresence[]
  collapsed: boolean
  /** Shown from the Hidden row: dimmed, and its menu offers Show. */
  hidden?: boolean
  onToggle: () => void
  onNew?: () => void
  onPin?: () => void
  pages: number
  onPages: (next: number) => void
}) {
  // A cold folder starts closed, a warm one open; the stored flag means
  // "the user flipped this one from its default", so both kinds remember.
  const cold =
    !folder.current &&
    !folder.priority &&
    folder.latest !== "" &&
    now - Date.parse(folder.latest) > COLD_MS
  const closed = collapsed ? !cold : cold
  const head = useCheckoutHead(folder.cwd ?? undefined)
  const contentId = `folder-${folder.key.replace(/[^a-zA-Z0-9_-]/g, "-")}`

  const limit = FOLDER_LEAD_ROWS + pages * PAGE_ROWS
  const shownLive = liveAgents.slice(0, limit)
  const visible = folder.refs.slice(0, Math.max(0, limit - shownLive.length))
  const more = folder.refs.length + liveAgents.length - visible.length - shownLive.length
  const project = folder.cwd === null ? null : { ...folder, cwd: folder.cwd }
  const menuItems = project ? (
    <FolderMenuItems folder={project} closed={closed} hidden={hidden} onToggle={onToggle} onNew={onNew} onPin={onPin} onHide={(next) => hideProject(project, next)} />
  ) : null

  const header = (
    <div data-flip-key={`folder:${folder.key}`} data-folder-hidden={hidden || undefined} className="group/folder relative flex h-7 w-full items-center rounded-md transition-colors duration-100 hover:bg-fill-hover data-[state=open]:bg-fill-hover">
      <button
        type="button"
        title={[folder.cwd ?? folder.name, head ? `On ${checkoutSentence(head)}` : undefined].filter(Boolean).join("\n")}
        aria-expanded={!closed}
        aria-controls={contentId}
        onClick={onToggle}
        className={cn("flex min-w-0 flex-1 items-center gap-1.5 self-stretch px-1.5 text-left", hidden && "opacity-55")}
      >
        {/* The folder glyph turns into the disclosure chevron under the
            pointer, so the row carries one leading mark instead of two. */}
        <span className="relative flex size-3.5 shrink-0 items-center justify-center text-faint">
          {closed ? (
            <FolderIcon className="size-3.5 transition-opacity duration-100 group-hover/folder:opacity-0 group-focus-within/folder:opacity-0" />
          ) : (
            <FolderOpenIcon className="size-3.5 transition-opacity duration-100 group-hover/folder:opacity-0 group-focus-within/folder:opacity-0" />
          )}
          <ChevronRightIcon
            className={cn(
              "absolute size-3.5 opacity-0 transition-[opacity,transform] duration-200 ease-out group-hover/folder:opacity-100 group-focus-within/folder:opacity-100",
              !closed && "rotate-90"
            )}
          />
        </span>
        <span
          className={cn(
            "min-w-8 shrink truncate text-ui",
            folder.current
              ? "font-medium text-foreground"
              : "text-foreground/80"
          )}
        >
          {folder.name}
        </span>
        {/* The main checkout's own branch; it gives way before the name does. */}
        {head ? <CheckoutLabel head={head} className="min-w-8 shrink-[4] text-label text-faint/80" /> : null}
        <span className="flex-1" />
        {folder.cwd ? <AppMarkIcon checkout={folder.cwd} /> : null}
        <FolderActivity folder={folder} />
        {/* Open, the newest row already shows this time. */}
        {closed && !folder.priority && folder.latest ? (
          <span className="tabular shrink-0 pr-0.5 text-label text-faint/60">
            {formatRelative(folder.latest)}
          </span>
        ) : null}
        {folder.pinned ? (
          <PinIcon className="size-3 shrink-0 fill-current text-faint/70" />
        ) : null}
      </button>
      <span data-tip-quiet className={cn("rail-row-actions", FOLDER_ACTIONS)}>
        {onNew ? (
          <button
            type="button"
            aria-label={`New thread in ${folder.name}`}
            title={`New thread in ${folder.name}`}
            onClick={onNew}
            className="pressable flex size-6 shrink-0 items-center justify-center rounded text-faint transition-colors duration-100 hover:bg-fill-hover hover:text-foreground"
          >
            <PlusIcon className="size-3.5" />
          </button>
        ) : null}
        {hidden && project ? (
          <button
            type="button"
            aria-label={`Show ${folder.name}`}
            title="Show this project in the list again"
            onClick={() => hideProject(project, false)}
            className="pressable flex size-6 shrink-0 items-center justify-center rounded text-faint transition-colors duration-100 hover:bg-fill-hover hover:text-foreground"
          >
            <EyeIcon className="size-3.5" />
          </button>
        ) : onPin ? (
          <button
            type="button"
            aria-label={folder.pinned ? "Unpin folder" : "Pin folder"}
            title={folder.pinned ? "Unpin folder" : "Pin folder"}
            onClick={onPin}
            className={cn(
              "pressable flex size-6 shrink-0 items-center justify-center rounded transition-colors duration-100 hover:bg-fill-hover hover:text-foreground",
              folder.pinned ? "text-foreground/70" : "text-faint"
            )}
          >
            <PinIcon
              className={cn("size-3", folder.pinned && "fill-current")}
            />
          </button>
        ) : null}
        {menuItems ? (
          <Menu modal={false}>
            <MenuTrigger asChild>
              <button
                type="button"
                aria-label={`Actions for ${folder.name}`}
                className="pressable flex size-6 shrink-0 items-center justify-center rounded text-faint transition-colors duration-100 hover:bg-fill-hover hover:text-foreground data-[state=open]:bg-fill-hover data-[state=open]:text-foreground"
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
    <section className="pb-1">
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
        {/* The folder's rows hang from a hairline under its glyph; their
            fills start past it, so the line never breaks. */}
        <div className="ml-[13px] min-h-0 overflow-hidden border-l border-hairline pl-1">
          {shownLive.map((presence) => <LiveAgentRow key={presence.key} presence={presence} folded={fold.byLead.get(presence.key)} indent />)}
          {visible.map((ref) => (
            <ThreadRow key={ref.path} threadRef={ref} folded={fold.byLead.get(ref.path)} indent />
          ))}
          {more > 0 ? (
            <button
              type="button"
              onClick={() => onPages(pages + 1)}
              className="flex h-6 w-full items-center rounded-md pl-7 text-left text-label text-faint transition-colors duration-100 hover:bg-fill-hover hover:text-muted-foreground"
            >
              More
              <span className="tabular ml-1 text-label text-faint/60">
                {more}
              </span>
            </button>
          ) : pages > 0 ? (
            <button
              type="button"
              onClick={() => onPages(0)}
              className="flex h-6 w-full items-center rounded-md pl-7 text-left text-label text-faint transition-colors duration-100 hover:bg-fill-hover hover:text-muted-foreground"
            >
              Less
            </button>
          ) : null}
        </div>
      </div>
    </section>
  )
}

type BoardRow =
  | { kind: "native"; ref: ThreadRef }
  | { kind: "live"; presence: AcpPresence }

const BOARD_MARK = {
  "needs-input": "waiting",
  failed: "failed",
  review: "complete",
  working: "working",
  done: null,
} satisfies Record<BoardBucket, ActivityState | null>

/**
 * One section of the status board: a heading that wears the state's own
 * mark, then the rows in it, newest change first. Every section above Done
 * shows all of its rows — they are bounded by real activity — and Done pages
 * like a folder does.
 */
function BoardSection({
  section,
  fold,
  pages,
  onPages,
}: {
  section: BoardSectionData<BoardRow>
  fold: ThreadFold
  pages: number
  onPages: (next: number) => void
}) {
  const mark = BOARD_MARK[section.key]
  const limit = section.key === "done" ? BOARD_LEAD_ROWS + pages * PAGE_ROWS : Infinity
  const visible = section.rows.slice(0, limit)
  const hidden = section.rows.length - visible.length
  return (
    <section className="pb-2">
      <p
        data-flip-key={`section:${section.key}`}
        data-board-section={section.key}
        className="flex h-7 items-center gap-1.5 px-1.5 text-label font-medium text-faint"
      >
        {mark ? <ActivityMark state={mark} size={20} className="text-faint" /> : null}
        <span className="flex-1 truncate">{section.label}</span>
        <span className="tabular text-faint/60">{section.rows.length}</span>
      </p>
      {visible.map((row) =>
        row.item.kind === "native" ? (
          <ThreadRow key={row.key} threadRef={row.item.ref} folded={fold.byLead.get(row.key)} showFolder />
        ) : (
          <LiveAgentRow key={row.key} presence={row.item.presence} folded={fold.byLead.get(row.key)} />
        )
      )}
      {hidden > 0 ? (
        <button
          type="button"
          onClick={() => onPages(pages + 1)}
          className="flex h-6 w-full items-center rounded-md pl-7 text-left text-label text-faint transition-colors duration-100 hover:bg-fill-hover hover:text-muted-foreground"
        >
          More
          <span className="tabular ml-1 text-label text-faint/60">{hidden}</span>
        </button>
      ) : pages > 0 ? (
        <button
          type="button"
          onClick={() => onPages(0)}
          className="flex h-6 w-full items-center rounded-md pl-7 text-left text-label text-faint transition-colors duration-100 hover:bg-fill-hover hover:text-muted-foreground"
        >
          Less
        </button>
      ) : null}
    </section>
  )
}
