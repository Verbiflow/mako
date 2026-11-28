import { useEffect, useMemo } from "react"
import { getMako, hasBridge } from "@/lib/bridge"
import { createHook, createStore } from "@/state/store"
import {
  repositoryKey,
  type Board,
  type BoardIssue,
  type BoardKind,
  type BoardProblem,
  type BoardPull,
  type BoardRepository,
} from "@mako/host/contracts/project-pulls"

/**
 * Projects' pull requests and issues, one cache for the right panel and the Pull requests page (`mako:project-board`).
 *
 * Rows are held by repository (`owner/name`), so the panel's project and the page's every project read the same
 * repositories once, and a repository two projects share is one. A view says what it shows with `useBoardWatch`:
 * - `shown` (the panel open, the page open): read now, then every two minutes while the window is in front;
 * - `glance` (the panel's tab reading): read once, and again when the window comes to the front after five minutes.
 * Nothing reads while no view watches. The host answers from its own minute-long readings and asks GitHub with
 * conditional requests, so two views asking at once cost one request per list.
 */

export const SHOWN_EVERY_MS = 2 * 60_000
export const GLANCE_EVERY_MS = 5 * 60_000

export interface BoardState {
  /** Each project folder's repositories, by key. */
  projects: Readonly<Record<string, readonly string[]>>
  repositories: Readonly<Record<string, BoardRepository>>
  pulls: Readonly<Record<string, readonly BoardPull[]>>
  issues: Readonly<Record<string, readonly BoardIssue[]>>
  viewer?: string
  problem?: BoardProblem
  /** When each kind was last read for each folder. */
  readAt: Readonly<Record<string, number>>
  /** Folders and kinds a read is out for (`folder\0kind`). */
  reading: Readonly<Record<string, true>>
}

export const boardStore = createStore<BoardState>({ projects: {}, repositories: {}, pulls: {}, issues: {}, readAt: {}, reading: {} })
export const useBoardStore = createHook(boardStore)

const slot = (folder: string, kind: BoardKind) => `${folder}\0${kind}`

/** Takes a reading in: its repositories' rows replace what was held of them, other repositories' stay. */
export function takeBoard(state: BoardState, board: Board, at: number): Partial<BoardState> {
  const projects = { ...state.projects }
  const readAt = { ...state.readAt }
  for (const project of board.projects) {
    projects[project.folder] = project.repositories
    readAt[slot(project.folder, board.kind)] = at
  }
  const repositories = { ...state.repositories, ...board.repositories }
  const taken: Partial<BoardState> = { projects, readAt, repositories, viewer: board.viewer, problem: board.problem }
  const keys = Object.keys(board.repositories)
  if (board.kind === "pulls") taken.pulls = byRepository(state.pulls, keys, board.pulls)
  else taken.issues = byRepository(state.issues, keys, board.issues)
  return taken
}

/** `held` with the rows of the repositories read (`keys`) replaced by `rows`. */
function byRepository<Row extends { repository: string }>(held: Readonly<Record<string, readonly Row[]>>, keys: readonly string[], rows: readonly Row[]): Record<string, Row[]> {
  const next: Record<string, Row[]> = Object.fromEntries(Object.entries(held).map(([key, kept]) => [key, [...kept]]))
  for (const key of keys) next[key] = []
  for (const row of rows) (next[repositoryKey(row.repository)] ??= []).push(row)
  return next
}

/** Reads the folders' boards of one kind, unless a read of them is out. */
export async function readBoard(folders: readonly string[], kind: BoardKind, why: "look" | "refresh" = "look"): Promise<void> {
  if (!hasBridge() || folders.length === 0) return
  const asking = folders.filter((folder) => why === "refresh" || !boardStore.get().reading[slot(folder, kind)])
  if (asking.length === 0) return
  boardStore.set((state) => ({ reading: { ...state.reading, ...Object.fromEntries(asking.map((folder) => [slot(folder, kind), true as const])) } }))
  try {
    const board = await getMako().projectBoard({ folders: [...asking], kind, why })
    boardStore.set((state) => takeBoard(state, board, Date.now()))
  } catch {
    // The host answers each repository's failure in the board; a refused call (an older host) leaves what's held.
  } finally {
    boardStore.set((state) => {
      const reading = { ...state.reading }
      for (const folder of asking) delete reading[slot(folder, kind)]
      return { reading }
    })
  }
}

/** When the folders were all last read for a kind: the oldest of them, 0 when one never was. */
export function boardAge(state: Pick<BoardState, "readAt">, folders: readonly string[], kind: BoardKind): number {
  return folders.reduce((oldest, folder) => Math.min(oldest, state.readAt[slot(folder, kind)] ?? 0), Infinity)
}

/**
 * Keeps the folders' board read while a view shows it (see the module's note). Folders are compared by value, so a
 * new array of the same folders doesn't read again.
 */
export function useBoardWatch(folders: readonly string[], kind: BoardKind, mode: "shown" | "glance" | "off"): void {
  const key = folders.join("\0")
  useEffect(() => {
    if (mode === "off" || !key) return
    const watched = key.split("\0")
    const every = mode === "shown" ? SHOWN_EVERY_MS : GLANCE_EVERY_MS
    const due = () => Date.now() - boardAge(boardStore.get(), watched, kind) >= every
    const front = () => document.visibilityState === "visible" && document.hasFocus()
    if (mode === "shown" || due()) void readBoard(watched, kind)
    const onFocus = () => { if (due()) void readBoard(watched, kind) }
    window.addEventListener("focus", onFocus)
    document.addEventListener("visibilitychange", onFocus)
    const timer = mode === "shown" ? window.setInterval(() => { if (front() && due()) void readBoard(watched, kind) }, 15_000) : undefined
    return () => {
      window.removeEventListener("focus", onFocus)
      document.removeEventListener("visibilitychange", onFocus)
      if (timer !== undefined) window.clearInterval(timer)
    }
  }, [key, kind, mode])
}

export interface BoardView<Row> {
  /** Each folder's repositories, by key; a folder not read yet is absent. */
  projects: { folder: string; repositories: string[] }[]
  repositories: BoardRepository[]
  rows: Row[]
  viewer?: string
  problem?: BoardProblem
  /** Nothing read yet for these folders. */
  loading: boolean
  readAt: number
}

/** What the folders' board holds of pull requests. */
export function usePullBoard(folders: readonly string[]): BoardView<BoardPull> {
  return useBoardOf(folders, "pulls", useBoardStore((state) => state.pulls))
}

/** What the folders' board holds of issues. */
export function useIssueBoard(folders: readonly string[]): BoardView<BoardIssue> {
  return useBoardOf(folders, "issues", useBoardStore((state) => state.issues))
}

/** The folders' board of one kind, its repositories each once. */
function useBoardOf<Row>(folders: readonly string[], kind: BoardKind, held: Readonly<Record<string, readonly Row[]>>): BoardView<Row> {
  const projects = useBoardStore((state) => state.projects)
  const repositories = useBoardStore((state) => state.repositories)
  const viewer = useBoardStore((state) => state.viewer)
  const problem = useBoardStore((state) => state.problem)
  const readAt = useBoardStore((state) => boardAge(state, folders, kind))
  const key = folders.join("\0")
  return useMemo(() => {
    const listed = key ? key.split("\0") : []
    const known = listed.filter((folder) => projects[folder] !== undefined).map((folder) => ({ folder, repositories: [...projects[folder]!] }))
    const keys = [...new Set(known.flatMap((project) => project.repositories))]
    return {
      projects: known,
      repositories: keys.flatMap((each) => repositories[each] ? [repositories[each]] : []),
      rows: keys.flatMap((each) => held[each] ?? []),
      viewer,
      problem,
      loading: known.length < listed.length,
      readAt: Number.isFinite(readAt) ? readAt : 0,
    }
  }, [key, projects, repositories, held, viewer, problem, readAt])
}
