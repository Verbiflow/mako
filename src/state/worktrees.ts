import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import type { CheckoutHead, CheckoutHeads, LinkedCheckout } from "../../electron/contracts/checkout-heads.ts"
import type { GitDiff } from "../../electron/contracts/git-workspace-search.ts"
import type { GitStatus, ThreadRef } from "@/lib/types"
import type { ThreadWorktree, WorktreeDetail, WorktreeInventory, WorktreeReview, WorktreeStartPoint } from "../../electron/contracts/thread-worktrees.ts"
import { getMako, hasBridge } from "@/lib/bridge"
import { ACTION_TOAST_MS } from "@/lib/toast-duration"
import { mapWorktreeFolders, type FolderMap } from "@/lib/thread-folders"
import { pathInside, plainPath, worktreeAt } from "@/lib/worktree-paths"
import { chatFoldersStore, chatGroupOf } from "@/state/chat-folders"
import { checkoutHeadsStore } from "@/state/checkout-heads"
import { confirmAction } from "@/state/confirm"
import { createHook, createStore } from "@/state/store"
import { threadsStore } from "@/state/thread-store"

/**
 * This device's Thread worktrees. A folder inside one stands for the same
 * folder of the project it was made from, so a Thread started in a worktree
 * files under its project in the rail, beside the Threads that didn't. A
 * chat's folder stands for the Chats folder the same way, until it's a
 * repository.
 */
interface WorktreesState {
  worktrees: readonly ThreadWorktree[]
  /**
   * Worktrees made outside Mako: an agent's own `git worktree add`, a
   * harness's worktree mode, the user's. The host names the ones every
   * listed session's folders are in; the checkout heads add any other folder
   * on screen, and the branch. Neither runs Git.
   */
  outside: readonly OutsideWorktree[]
  /** New with every list and every change to the chats, so what groups by folder regroups. */
  folderMap: FolderMap
}

export interface OutsideWorktree extends LinkedCheckout {
  /** Undefined while detached, or until its head has been read. */
  branch: string | undefined
}

export { worktreeAt }

export type WorktreePlaces = Pick<WorktreesState, "worktrees" | "outside">

function checkoutAt(state: WorktreePlaces, path: string | undefined): Pick<ThreadWorktree, "path" | "repoRoot"> | undefined {
  return (worktreeAt(state.worktrees, path) ?? worktreeAt(state.outside, path))?.worktree
}

/**
 * Where a Session works now. A harness that moves a session between
 * checkouts of its repository records the new folder as `currentCwd`:
 * Claude's EnterWorktree and ExitWorktree, a Codex turn started in another
 * checkout. Its shell changing into a subfolder, around its own checkout or
 * into another repository records one too, and that doesn't move the
 * Session.
 */
export function workingFolder(state: WorktreePlaces, ref: { cwd?: string; currentCwd?: string }): string | undefined {
  const { cwd, currentCwd: moved } = ref
  if (!cwd || !moved) return cwd
  const from = checkoutAt(state, cwd)
  const to = checkoutAt(state, moved)
  if (to === from) return cwd
  if (to) return (from ? from.repoRoot === to.repoRoot : pathInside(to.repoRoot, cwd)) ? moved : cwd
  // Out of the worktree it started in, back into that project's own checkout.
  return from && pathInside(from.repoRoot, moved) ? moved : cwd
}

function outsideOf(heads: CheckoutHeads, refs: readonly ThreadRef[], worktrees: readonly ThreadWorktree[]): OutsideWorktree[] {
  const found = new Map<string, OutsideWorktree>()
  const add = (linked: LinkedCheckout, head: CheckoutHead | null | undefined) => {
    const key = plainPath(linked.path)
    if (found.has(key) || worktrees.some((worktree) => plainPath(worktree.path) === key)) return
    found.set(key, { path: linked.path, repoRoot: linked.repoRoot, branch: head && head.kind !== "detached" ? head.name : undefined })
  }
  for (const head of Object.values(heads)) if (head?.linked) add(head.linked, head)
  for (const ref of refs) for (const linked of ref.worktrees ?? []) add(linked, heads[linked.path])
  return [...found.values()]
}

function stateOf(worktrees: readonly ThreadWorktree[]): WorktreesState {
  const chats = chatFoldersStore.get()
  const outside = outsideOf(checkoutHeadsStore.get().heads, threadsStore.get().threads, worktrees)
  return {
    worktrees,
    outside,
    folderMap: (path) => {
      const found = worktreeAt(worktrees, path) ?? worktreeAt(outside, path)
      return found ? `${found.worktree.repoRoot}${found.inside}` : chatGroupOf(path, chats)
    },
  }
}

function outsideKey(outside: readonly OutsideWorktree[]): string {
  return outside.map((worktree) => `${worktree.path}\n${worktree.branch ?? ""}`).join("\n")
}

export const worktreesStore = createStore<WorktreesState>(stateOf([]))
export const useWorktrees = createHook(worktreesStore)

mapWorktreeFolders((path) => worktreesStore.get().folderMap(path))
chatFoldersStore.subscribe(() => worktreesStore.set(stateOf(worktreesStore.get().worktrees)))
function refreshOutside(): void {
  const current = worktreesStore.get()
  const next = stateOf(current.worktrees)
  if (outsideKey(next.outside) !== outsideKey(current.outside)) worktreesStore.set(next)
}
checkoutHeadsStore.subscribe(refreshOutside)
let listed = threadsStore.get().threads
threadsStore.subscribe(() => {
  const { threads } = threadsStore.get()
  if (threads === listed) return
  listed = threads
  refreshOutside()
})

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

/** After a status change, the branch review waits this long before reading again: an agent's edits come in bursts. */
const REVIEW_SETTLE_MS = 400

/**
 * The worktree at `path`'s work since it branched, read again once `status`
 * (the Git status the Changes watcher already keeps) settles, or on `reread`.
 */
export function useWorktreeReview(path: string | undefined, status: GitStatus | null | undefined) {
  const [review, setReview] = useState<WorktreeReview>()
  const [asked, setAsked] = useState(0)
  const shownFor = useRef<string>(undefined)
  useEffect(() => {
    if (!path || !hasBridge()) return
    let current = true
    const timer = setTimeout(() => {
      void getMako().worktreeReview(path).then(
        (next) => {
          if (!current) return
          shownFor.current = path
          setReview(next)
        },
        () => {}
      )
    }, shownFor.current === path ? REVIEW_SETTLE_MS : 0)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [path, status, asked])
  const reread = useCallback(() => setAsked((count) => count + 1), [])
  return { review: review?.path === path ? review : undefined, reread } satisfies { review: WorktreeReview | undefined; reread: () => void }
}

export function readWorktreeReviewDiffs(path: string): Promise<{ diffs: GitDiff[]; truncated: number }> {
  return getMako().worktreeReviewDiffs(path)
}

/** Merge the worktree's branch into the main checkout's branch, once asked; once it's in, removing the worktree is one click. */
export async function mergeWorktree(worktree: ThreadWorktree, review: Pick<WorktreeReview, "commits" | "into">, onConfirmed?: () => void): Promise<boolean> {
  const into = review.into ?? "the project's branch"
  const confirmed = await confirmAction({
    title: `Merge into ${into}?`,
    body: `${review.commits === 1 ? "Its commit goes" : `Its ${review.commits} commits go`} into ${into} in the main checkout now.`,
    confirm: `Merge into ${into}`,
    icon: "merge",
    subjects: [
      { kind: "branch", name: worktree.branch, detail: review.commits === 1 ? "1 commit" : `${review.commits} commits` },
      ...(review.into ? [{ kind: "branch" as const, name: review.into, detail: "Receives them" }] : []),
    ],
  })
  if (!confirmed) return false
  onConfirmed?.()
  try {
    const { branch, into } = await getMako().mergeWorktree(worktree.path)
    toast(`Merged into ${into}`, {
      description: `${branch} is in the main checkout now, so its worktree can go.`,
      duration: ACTION_TOAST_MS,
      action: { label: "Remove worktree", onClick: () => void removeWorktree(worktree) },
    })
    return true
  } catch (error) {
    toast.error("The branch wasn't merged", { description: error instanceof Error ? error.message : String(error) })
    return false
  }
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

/** A project asks the host to fetch its upstream at most this often; the host holds a fetch for as long. */
const START_FETCH_EVERY_MS = 60_000
const startFetched = new Map<string, number>()

/**
 * Where the next Thread's branch in `cwd`'s project starts, read while
 * `active` and again whenever `asked` changes. The refs as they are come
 * back first; the answer after the upstream's fetch follows, at most once a
 * minute, so the send finds them current without waiting on the network.
 */
export function useWorktreeStart(cwd: string, active: boolean, asked: string): WorktreeStartPoint | null | undefined {
  const [shown, setShown] = useState<{ cwd: string; point: WorktreeStartPoint | null }>()
  useEffect(() => {
    if (!active || !cwd || !hasBridge()) return
    let current = true
    let fetched = false
    const mako = getMako()
    void mako.worktreeStartPoint(cwd, false).then((point) => {
      if (current && !fetched) setShown({ cwd, point })
    }, () => {})
    const now = Date.now()
    if (now - (startFetched.get(cwd) ?? 0) >= START_FETCH_EVERY_MS) {
      startFetched.set(cwd, now)
      void mako.worktreeStartPoint(cwd, true).then((point) => {
        fetched = true
        if (current) setShown({ cwd, point })
      }, () => startFetched.delete(cwd))
    }
    return () => {
      current = false
    }
  }, [cwd, active, asked])
  return shown?.cwd === cwd ? shown.point : undefined
}

type RemovableWorktree = Pick<ThreadWorktree, "path" | "branch">
/** A batch removal names this many worktrees and counts the rest. */
const LISTED = 5
const folderOf = (path: string) => path.split("/").filter(Boolean).at(-1) ?? path

/** Remove a worktree once asked; its branch keeps whatever was committed there. */
export async function removeWorktree(worktree: RemovableWorktree): Promise<void> {
  const confirmed = await confirmAction({
    title: "Remove this worktree?",
    body: "Its folder is deleted from disk. The branch stays, with every commit made there.",
    confirm: "Remove worktree",
    tone: "negative",
    icon: "remove",
    subjects: [
      { kind: "folder", name: folderOf(worktree.path), detail: "Deleted", lost: true },
      { kind: "branch", name: worktree.branch, detail: "Kept" },
    ],
    note: "Files Git ignores go with the folder, such as .env copies and installed packages.",
  })
  if (!confirmed) return
  try {
    const { worktrees } = await getMako().removeWorktree(worktree.path)
    reads += 1
    worktreesStore.set(stateOf(worktrees))
    toast("Worktree removed", { description: `The branch ${worktree.branch} keeps its commits.` })
  } catch (error) {
    toast.error("The worktree wasn't removed", { description: error instanceof Error ? error.message : String(error) })
  }
}

/** Every worktree with what decides whether it can go, and the spares kept for new Threads. */
export async function readWorktreeInventory(): Promise<WorktreeInventory> {
  if (!hasBridge()) return { worktrees: [], spares: { count: 0, bytes: null } }
  return getMako().worktreeInventory()
}

/** Nothing would be lost and nothing stopped: its work is on the main checkout's branch, or it never had any. */
export function removable(worktree: WorktreeDetail): boolean {
  return !worktree.held && worktree.users.length === 0 && (worktree.landing.kind === "merged" || worktree.landing.kind === "empty")
}

/** Remove every worktree whose work landed or never started, once asked; their branches stay. */
export async function removeLandedWorktrees(worktrees: readonly WorktreeDetail[]): Promise<void> {
  const going = worktrees.filter(removable)
  if (!going.length) return
  const one = going.length === 1
  const confirmed = await confirmAction({
    title: one ? "Remove this worktree?" : `Remove ${going.length} worktrees?`,
    body: one
      ? "Its work is on the project's branch, or it never made a commit. The folder is deleted; the branch stays."
      : "Their work is on the project's branch, or they never made a commit. The folders are deleted; the branches stay.",
    confirm: one ? "Remove worktree" : `Remove ${going.length} worktrees`,
    tone: "negative",
    icon: "remove",
    subjects: going.slice(0, LISTED).map((worktree) => ({ kind: "folder" as const, name: folderOf(worktree.path), detail: worktree.branch })),
    more: Math.max(0, going.length - LISTED),
    note: "Files Git ignores go with each folder, such as .env copies and installed packages.",
  })
  if (!confirmed) return
  const failed: string[] = []
  let removed = 0
  for (const worktree of going) {
    try {
      const { worktrees: left } = await getMako().removeWorktree(worktree.path)
      reads += 1
      worktreesStore.set(stateOf(left))
      removed += 1
    } catch (error) {
      failed.push(`${worktree.branch}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (removed) toast(removed === 1 ? "1 worktree removed" : `${removed} worktrees removed`, { description: "Their branches keep their commits." })
  if (failed.length) toast.error(failed.length === 1 ? "A worktree wasn't removed" : `${failed.length} worktrees weren't removed`, { description: failed.join("\n") })
}

/** A Thread was put away with its worktree still on disk: say so, with the removal one click away. */
export function offerWorktreeRemoval(worktree: ThreadWorktree): void {
  toast("Thread archived", {
    description: `Its worktree on ${worktree.branch} is still on disk. Removing it keeps the branch.`,
    duration: ACTION_TOAST_MS,
    action: { label: "Remove worktree", onClick: () => void removeWorktree(worktree) },
  })
}
