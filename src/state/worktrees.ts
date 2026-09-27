import { useEffect, useState } from "react"
import { toast } from "sonner"
import type { ThreadWorktree } from "../../electron/contracts/thread-worktrees.ts"
import { getMako, hasBridge } from "@/lib/bridge"
import { mapWorktreeFolders, type FolderMap } from "@/lib/thread-folders"
import { createHook, createStore } from "@/state/store"

/**
 * This device's Thread worktrees. A folder inside one stands for the same
 * folder of the project it was made from, so a Thread started in a worktree
 * files under its project in the rail, beside the Threads that didn't.
 */
interface WorktreesState {
  worktrees: readonly ThreadWorktree[]
  /** New with every list, so what groups by folder regroups. */
  folderMap: FolderMap
}

/** The worktree holding `path`, and the rest of the path inside it ("" or "/web"). */
export function worktreeAt(
  worktrees: readonly ThreadWorktree[],
  path: string | undefined
): { worktree: ThreadWorktree; inside: string } | undefined {
  if (!path) return undefined
  for (const worktree of worktrees)
    if (path === worktree.path || path.startsWith(`${worktree.path}/`)) return { worktree, inside: path.slice(worktree.path.length) }
  return undefined
}

function stateOf(worktrees: readonly ThreadWorktree[]): WorktreesState {
  return {
    worktrees,
    folderMap: (path) => {
      const found = worktreeAt(worktrees, path)
      return found && `${found.worktree.repoRoot}${found.inside}`
    },
  }
}

export const worktreesStore = createStore<WorktreesState>(stateOf([]))
export const useWorktrees = createHook(worktreesStore)

mapWorktreeFolders((path) => worktreesStore.get().folderMap(path))

let reads = 0

export async function refreshWorktrees(): Promise<void> {
  if (!hasBridge()) return
  const mine = ++reads
  const { worktrees } = await getMako().worktrees()
  if (mine === reads) worktreesStore.set(stateOf(worktrees))
}

/**
 * Commits on the worktree at `path` since its Thread started, read again
 * whenever `head` moves; `head` comes from the Git status the Changes
 * watcher already keeps, so this adds no watcher of its own.
 */
export function useWorktreeAhead(path: string | undefined, head: string | undefined): number | undefined {
  const [ahead, setAhead] = useState<{ path: string; count: number }>()
  useEffect(() => {
    if (!path || !head || !hasBridge()) return
    let current = true
    void getMako().worktreeAhead(path).then(
      (count) => {
        if (current && count !== null) setAhead({ path, count })
      },
      () => {}
    )
    return () => {
      current = false
    }
  }, [path, head])
  // The previous count stands while a new HEAD is read, so the chip doesn't blink on a commit.
  return ahead && ahead.path === path ? ahead.count : undefined
}

/** A project asks for spares at most this often; the host keeps them for a day after. */
const WANT_EVERY_MS = 10 * 60_000
const wanted = new Map<string, number>()

/** The project in `cwd` is about to start a Thread in a worktree: have the host keep checkouts of it ready. */
export function wantSpareWorktrees(cwd: string): void {
  const now = Date.now()
  if (!hasBridge() || now - (wanted.get(cwd) ?? 0) < WANT_EVERY_MS) return
  wanted.set(cwd, now)
  void getMako().wantWorktree(cwd).catch(() => wanted.delete(cwd))
}

/** Remove a worktree; its branch keeps whatever was committed there. */
export async function removeWorktree(worktree: ThreadWorktree): Promise<void> {
  try {
    const { worktrees } = await getMako().removeWorktree(worktree.path)
    reads += 1
    worktreesStore.set(stateOf(worktrees))
    toast("Worktree removed", { description: `The branch ${worktree.branch} keeps its commits.` })
  } catch (error) {
    toast.error("The worktree wasn't removed", { description: error instanceof Error ? error.message : String(error) })
  }
}
