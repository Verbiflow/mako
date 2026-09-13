import { workspaceName } from "@/lib/format"
import type { ThreadRef } from "@/lib/types"
import type { RailSortBy } from "@/state/prefs"
import type { AcpPresence } from "@/state/acp-presence"

export interface ThreadFolderActivity {
  running?: boolean
  needsInput?: boolean
  failed?: boolean
  unread?: boolean
  active?: boolean
  /** Its file changed within the last minute; the writer may be outside Mako. */
  observed?: boolean
}

export interface ThreadFolder {
  key: string
  name: string
  cwd: string | null
  refs: ThreadRef[]
  current: boolean
  pinned: boolean
  /** Position among pinned folders; -1 when not pinned. */
  pinRank: number
  latest: string
  order: string
  /** The most demanding status inside — for the folder's chip and warmth, never its place. */
  priority: number
  running: number
  needsInput: number
  failed: number
  unread: number
  active: number
}

/** Whether something in the folder is working, waiting on you, or unread. */
function folderIsBusy(folder: ThreadFolder): boolean {
  return (
    folder.running > 0 ||
    folder.needsInput > 0 ||
    folder.failed > 0 ||
    folder.unread > 0 ||
    folder.active > 0
  )
}

/**
 * Keep the normal project order stable while ensuring a project selected by
 * another surface is not hidden behind pagination. A project already in the
 * first page stays exactly where it was; an off-page current project is added
 * at its natural relative position. So is a folder with a thread that is
 * working, waiting on you, or finished unread: a run you started must not
 * scroll out of sight because the folder ranks low.
 */
export function visibleThreadFolders(
  folders: ThreadFolder[],
  limit: number
): ThreadFolder[] {
  const visible = new Set(folders.slice(0, limit).map((folder) => folder.key))
  for (const folder of folders)
    if (folder.current || folderIsBusy(folder)) visible.add(folder.key)
  return folders.filter((folder) => visible.has(folder.key))
}

function normalizedPath(path: string | undefined): string {
  const normalized = (path ?? "").replaceAll("\\", "/").replace(/\/+$/, "")
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized
}

function folderPath(path: string | undefined): string {
  const normalized = normalizedPath(path)
  if (!normalized) return ""
  if (/^\/(?:private\/)?tmp(?:\/|$)/.test(normalized)) return ""
  if (/^\/(?:private\/)?var\/folders(?:\/|$)/.test(normalized)) return ""
  if (/^[a-z]:\/users\/[^/]+\/appdata\/local\/temp(?:\/|$)/.test(normalized)) return ""
  return normalized
}

function isHomePath(path: string): boolean {
  return (
    /^\/(?:Users|home)\/[^/]+$/.test(path) ||
    /^[a-z]:\/users\/[^/]+$/.test(path)
  )
}

export function threadBelongsToWorkspace(
  ref: Pick<ThreadRef, "cwd" | "workspace">,
  workspace: string | undefined
): boolean {
  const root = normalizedPath(workspace)
  if (!root) return true
  return [ref.cwd, ref.workspace].some((candidate) => {
    const path = normalizedPath(candidate)
    return path === root || path.startsWith(`${root}/`)
  })
}

export function threadFolderKey(ref: Pick<ThreadRef, "cwd" | "workspace">): string {
  return folderPath(ref.workspace ?? ref.cwd)
}

/**
 * Whether a thread belongs in the Recent list. A session that ran in a
 * temporary directory which no longer exists (a test fixture, a scratch run)
 * is noise there unless it is still doing something; it stays reachable
 * under Projects and in search.
 */
export function showsInRecent(
  ref: Pick<ThreadRef, "workspaceMissing">,
  activity: ThreadFolderActivity | undefined
): boolean {
  if (!ref.workspaceMissing) return true
  return Boolean(activity?.running || activity?.needsInput || activity?.active)
}

/** Where a thread sits in "latest activity" order, and why it sits there. */
export interface RailRank {
  at: string
  active: boolean
}

/** Held ranks by thread path. */
export interface RailRanks {
  [path: string]: RailRank
}

/**
 * Recency that holds still while work happens.
 *
 * A working thread's file changes many times a second, and every change
 * moved its updatedAt and with it the row, the folder, and everything below.
 * Two agents in two projects swapped places on every token. So a thread
 * takes a rank when it is first seen, moves once when it becomes active,
 * keeps that rank for as long as it stays active, and settles once when it
 * finishes. An idle thread still follows its file: activity from outside
 * Mako is real news.
 */
export function stableThreadRanks(
  refs: readonly ThreadRef[],
  activity: Record<string, ThreadFolderActivity>,
  previous: RailRanks
): RailRanks {
  const next: RailRanks = {}
  for (const ref of refs) {
    const state = activity[ref.path]
    const active = Boolean(
      state?.running || state?.needsInput || state?.active || state?.observed
    )
    const held = previous[ref.path]
    const at = ref.updatedAt ?? ""
    if (held && active && held.active) next[ref.path] = held
    else if (held && active) next[ref.path] = { at: at > held.at ? at : held.at, active }
    else next[ref.path] = { at, active }
  }
  return next
}

/** Held folder ranks by folder key, from `stableFolderRanks`. */
export interface FolderRanks {
  [key: string]: string
}

/**
 * A folder's place in Projects, held between renders.
 *
 * A folder takes its rank the first time it is seen — its newest thread's
 * time — and keeps it. Only working there lifts it: `use` carries the moment
 * you last sent a prompt or started a thread in each folder, and a newer one
 * wins. Agent output, a turn finishing, a file another app is writing: none
 * of these move a folder, so the list you are looking at is the list you
 * looked at a minute ago. Status changes the folder's chip, not its place.
 */
export function stableFolderRanks(
  folders: readonly ThreadFolder[],
  use: Readonly<Record<string, string>>,
  previous: FolderRanks
): FolderRanks {
  const next: FolderRanks = {}
  for (const folder of folders) {
    const held = previous[folder.key] ?? folder.order
    const used = use[folder.key] ?? ""
    next[folder.key] = used > held ? used : held
  }
  return next
}

function compareFolders(a: ThreadFolder, b: ThreadFolder, sortBy: RailSortBy): number {
  if (a.cwd === null || b.cwd === null) return a.cwd === null ? 1 : -1
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
  if (a.pinned && b.pinned) return a.pinRank - b.pinRank
  if (sortBy === "name") return a.name.localeCompare(b.name)
  return b.order.localeCompare(a.order)
}

/** The folders in held order: each takes its rank from `ranks` where one is held. */
export function orderThreadFolders(
  folders: readonly ThreadFolder[],
  ranks: FolderRanks,
  sortBy: RailSortBy
): ThreadFolder[] {
  return folders
    .map((folder) => {
      const held = sortBy === "recent" ? ranks[folder.key] : undefined
      return held !== undefined && held !== folder.order
        ? { ...folder, order: held }
        : folder
    })
    .sort((a, b) => compareFolders(a, b, sortBy))
}

/**
 * Threads by folder, each folder's rows in order.
 *
 * Position never carries status. A row sits by its held recency, a folder by
 * its newest thread — `orderThreadFolders` then applies the held folder
 * ranks — and a thread that starts working, finishes, or fails changes its
 * mark and its folder's chip, nothing else. `priorities` feeds only the
 * folder's aggregate `priority` for that chip.
 */
export function groupThreadFolders({
  refs,
  live = [],
  currentCwd,
  pinnedThreads,
  pinnedFolders,
  priorities = {},
  activity = {},
  ranks = {},
  sortBy,
}: {
  refs: ThreadRef[]
  live?: AcpPresence[]
  currentCwd?: string
  pinnedThreads: string[]
  pinnedFolders: string[]
  priorities?: Record<string, number>
  activity?: Record<string, ThreadFolderActivity>
  /** Held recency from `stableThreadRanks`; a thread without one uses its updatedAt. */
  ranks?: RailRanks
  sortBy: RailSortBy
}): ThreadFolder[] {
  const recency = (ref: ThreadRef): string => ranks[ref.path]?.at ?? ref.updatedAt ?? ""
  const held = new Set(pinnedThreads)
  const byCwd = new Map<string, ThreadRef[]>()
  const allByCwd = new Map<string, ThreadRef[]>()
  for (const ref of refs) {
    const key = threadFolderKey(ref)
    const all = allByCwd.get(key)
    if (all) all.push(ref)
    else allByCwd.set(key, [ref])
    if (!byCwd.has(key)) byCwd.set(key, [])
    if (held.has(ref.path)) continue
    byCwd.get(key)?.push(ref)
  }
  for (const presence of live) {
    const key = threadFolderKey(presence)
    if (!byCwd.has(key)) byCwd.set(key, [])
  }
  const normalizedCurrent = folderPath(currentCwd)
  const currentKey =
    [...byCwd.keys()]
      .filter(
        (key) =>
          key &&
          (key === normalizedCurrent || normalizedCurrent.startsWith(`${key}/`))
      )
      .sort((left, right) => right.length - left.length)[0] ?? normalizedCurrent
  if (currentKey && !byCwd.has(currentKey)) byCwd.set(currentKey, [])
  const byOrder = (a: ThreadRef, b: ThreadRef): number => {
    if (sortBy === "name") return (a.title ?? "").localeCompare(b.title ?? "")
    if (sortBy === "created")
      return (b.startedAt ?? "").localeCompare(a.startedAt ?? "")
    return recency(b).localeCompare(recency(a))
  }
  const normalizedPinnedFolders = pinnedFolders.map(folderPath)
  const pinned = new Set(normalizedPinnedFolders)
  const result: ThreadFolder[] = [...byCwd.entries()].map(([key, entries]) => {
    entries.sort(byOrder)
    const allEntries = allByCwd.get(key) ?? entries
    const present = live.filter((presence) => threadFolderKey(presence) === key)
    const liveLatest = present.reduce((latest, presence) => Math.max(latest, presence.createdAt), 0)
    const latest = allEntries.reduce(
      (top, ref) => ((ref.updatedAt ?? "") > top ? ref.updatedAt! : top),
      liveLatest ? new Date(liveLatest).toISOString() : ""
    )
    const order =
      sortBy === "created"
        ? allEntries.reduce(
            (top, ref) =>
              (ref.startedAt ?? "") > top ? ref.startedAt! : top,
            ""
          )
        : allEntries.reduce(
            (top, ref) => (recency(ref) > top ? recency(ref) : top),
            liveLatest ? new Date(liveLatest).toISOString() : ""
          )
    let running = present.filter((presence) => presence.status === "running" || presence.status === "starting").length
    let needsInput = present.filter((presence) => presence.status === "needs-permission").length
    let failed = present.filter((presence) => presence.status === "failed").length
    let priority = needsInput ? 5 : failed ? 4 : running ? 2 : 0
    let unread = 0
    let active = 0
    for (const ref of allEntries) {
      priority = Math.max(priority, priorities[ref.path] ?? 0)
      const state = activity[ref.path]
      if (state?.running) running += 1
      if (state?.needsInput) needsInput += 1
      if (state?.failed) failed += 1
      if (state?.unread) unread += 1
      if (state?.active) active += 1
    }
    return {
      key: key || "~",
      name: key ? (isHomePath(key) ? "Home" : workspaceName(key)) : "Other sessions",
      cwd: key || null,
      refs: entries,
      current: Boolean(currentKey) && key === currentKey,
      pinned:
        Boolean(key) &&
        (pinned.has(key) ||
          allEntries.some((ref) =>
            [ref.cwd, ref.workspace].some(
              (path) => Boolean(path) && pinned.has(folderPath(path))
            )
          )),
      pinRank: -1,
      latest,
      order,
      priority,
      running,
      needsInput,
      failed,
      unread,
      active,
    }
  })
  const pinIndex = (folder: ThreadFolder) => {
    const direct = folder.cwd
      ? normalizedPinnedFolders.indexOf(folder.cwd)
      : -1
    if (direct >= 0) return direct
    const entries = allByCwd.get(folder.cwd ?? "") ?? folder.refs
    return normalizedPinnedFolders.findIndex((path) =>
      entries.some((ref) =>
        [ref.cwd, ref.workspace].some(
          (candidate) => folderPath(candidate) === path
        )
      )
    )
  }
  for (const folder of result) if (folder.pinned) folder.pinRank = pinIndex(folder)
  result.sort((a, b) => compareFolders(a, b, sortBy))
  return result
}
