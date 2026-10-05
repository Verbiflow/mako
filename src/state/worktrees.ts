import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"
import type { CheckoutHead, CheckoutHeads, LinkedCheckout } from "../../electron/contracts/checkout-heads.ts"
import type { GitDiff } from "../../electron/contracts/git-workspace-search.ts"
import type { GitStatus, ThreadRef } from "@/lib/types"
import type { ThreadWorktree, WorktreeBranch, WorktreeDetail, WorktreeInventory, WorktreePull, WorktreeRemoval, WorktreeReview, WorktreeStart, WorktreeStartPoint, WorktreeSummary, WorktreeUpdate } from "../../electron/contracts/thread-worktrees.ts"
import { getMako, hasBridge } from "@/lib/bridge"
import { ACTION_TOAST_MS } from "@/lib/toast-duration"
import { landedFor, removedNote } from "@/lib/worktree-removal"
import { mapWorktreeFolders, type FolderMap } from "@/lib/thread-folders"
import { pathInside, plainPath, projectFolder, worktreeAt } from "@/lib/worktree-paths"
import { chatFoldersStore, chatGroupOf } from "@/state/chat-folders"
import { checkoutHeadsStore } from "@/state/checkout-heads"
import { confirmAction } from "@/state/confirm"
import { prefsStore } from "@/state/prefs"
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
  for (const ref of refs) for (const linked of ref.worktrees ?? []) if (!linked.mirrors) add(linked, heads[linked.path])
  return [...found.values()]
}

function stateOf(worktrees: readonly ThreadWorktree[]): WorktreesState {
  const chats = chatFoldersStore.get()
  const outside = outsideOf(checkoutHeadsStore.get().heads, threadsStore.get().threads, worktrees)
  return {
    worktrees,
    outside,
    folderMap: (path) => {
      const found = worktreeAt(outside, path)
      return projectFolder(worktrees, path) ?? (found ? `${found.worktree.repoRoot}${found.inside}` : chatGroupOf(path, chats))
    },
  }
}

function outsideKey(outside: readonly OutsideWorktree[]): string {
  return outside.map((worktree) => `${worktree.path}\n${worktree.branch ?? ""}`).join("\n")
}

export const worktreesStore = createStore<WorktreesState>(stateOf([]))
export const useWorktrees = createHook(worktreesStore)

/** The worktree this device made at `thread`'s start, when `cwd` is in it. */
export function useStartedWorktree(thread: string | undefined, cwd: string | undefined): ThreadWorktree | undefined {
  return useWorktrees((state) => {
    const found = worktreeAt(state.worktrees, cwd)?.worktree
    return found?.start && thread !== undefined && found.thread === thread ? found : undefined
  })
}

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

const SUMMARIES_EVERY_MS = 30_000

/** How each of Mako's worktrees' branches stands, by path, for the rail's marks. */
export const worktreeSummariesStore = createStore<{ byPath: Readonly<Record<string, WorktreeSummary>> }>({ byPath: {} })
export const useWorktreeSummaries = createHook(worktreeSummariesStore)

let summaryReads = 0

export async function refreshWorktreeSummaries(): Promise<void> {
  if (!hasBridge()) return
  const mine = ++summaryReads
  const summaries = await getMako().worktreeSummaries()
  if (mine === summaryReads) worktreeSummariesStore.set({ byPath: Object.fromEntries(summaries.map((summary) => [summary.path, summary])) })
}

/**
 * Keeps the summaries current while the rail shows: when the window comes
 * back, when the worktrees change, and every half minute while it's
 * visible. The host asks GitHub at most once a minute.
 */
export function useKeepWorktreeSummaries(): void {
  useEffect(() => {
    const refresh = () => void refreshWorktreeSummaries().catch(() => {})
    const tick = () => {
      if (document.visibilityState === "visible") refresh()
    }
    refresh()
    let listed = worktreesStore.get().worktrees
    const unsubscribe = worktreesStore.subscribe(() => {
      const { worktrees } = worktreesStore.get()
      if (worktrees === listed) return
      listed = worktrees
      refresh()
    })
    const timer = window.setInterval(tick, SUMMARIES_EVERY_MS)
    window.addEventListener("focus", refresh)
    document.addEventListener("visibilitychange", tick)
    return () => {
      unsubscribe()
      window.clearInterval(timer)
      window.removeEventListener("focus", refresh)
      document.removeEventListener("visibilitychange", tick)
    }
  }, [])
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

const reviewStore = createStore<{ byPath: Readonly<Record<string, WorktreeReview>> }>({ byPath: {} })
const useReviewStore = createHook(reviewStore)
/** The status each worktree's last read was asked for, so every panel watching it shares one read. */
const reviewReads = new Map<string, { status: GitStatus | null | undefined; timer: ReturnType<typeof setTimeout> }>()

function readReviewFor(path: string, status: GitStatus | null | undefined, again: boolean): void {
  const last = reviewReads.get(path)
  if (last && last.status === status && !again) return
  if (last) clearTimeout(last.timer)
  const timer = setTimeout(() => {
    void getMako().worktreeReview(path).then(
      (next) => reviewStore.set((current) => ({ byPath: { ...current.byPath, [path]: next } })),
      () => {}
    )
  }, reviewStore.get().byPath[path] ? REVIEW_SETTLE_MS : 0)
  reviewReads.set(path, { status, timer })
}

/**
 * The worktree at `path`'s work since it branched, read again once `status`
 * (the Git status the Changes watcher already keeps) settles, or on `reread`.
 * Panels that show it share one read and one copy.
 */
export function useWorktreeReview(path: string | undefined, status: GitStatus | null | undefined) {
  const review = useReviewStore((state) => (path ? state.byPath[path] : undefined))
  useEffect(() => {
    if (path && hasBridge()) readReviewFor(path, status, false)
  }, [path, status])
  const reread = useCallback(() => {
    if (path && hasBridge()) readReviewFor(path, status, true)
  }, [path, status])
  return { review, reread } satisfies { review: WorktreeReview | undefined; reread: () => void }
}

export function readWorktreeReview(path: string): Promise<WorktreeReview> {
  return getMako().worktreeReview(path)
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

/** Merge what new Threads start from into the worktree's branch; a conflict is left for the Changes panel. Undefined when it failed. */
export async function updateFromMain(worktree: ThreadWorktree): Promise<WorktreeUpdate | undefined> {
  try {
    const update = await getMako().worktreeUpdate(worktree.path)
    if (update.kind === "updated")
      toast(`Updated from ${update.from}`, { description: `${update.commits === 1 ? "Its 1 commit is" : `Its ${update.commits} commits are`} on ${worktree.branch} now.`, duration: ACTION_TOAST_MS })
    if (update.kind === "current") toast(`${worktree.branch} already has everything in ${update.from}`)
    void refreshWorktreeSummaries().catch(() => {})
    return update
  } catch (error) {
    toast.error(`${worktree.branch} wasn't updated`, { description: error instanceof Error ? error.message : String(error) })
    return undefined
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

/** What the person chose for the next Thread's worktree in a project folder, until that Thread starts. */
export interface WorktreeStartChoice {
  start: WorktreeStart
  /** The branch, or `#812` and its title, as the composer names it. */
  label: string
  title?: string
}

export const worktreeStartChoices = createStore<{ byFolder: Readonly<Record<string, WorktreeStartChoice>> }>({ byFolder: {} })
export const useWorktreeStartChoices = createHook(worktreeStartChoices)

export function chooseWorktreeStart(cwd: string, choice: WorktreeStartChoice | null): void {
  const rest = Object.fromEntries(Object.entries(worktreeStartChoices.get().byFolder).filter(([folder]) => folder !== cwd))
  worktreeStartChoices.set({ byFolder: choice ? { ...rest, [cwd]: choice } : rest })
}

export function readWorktreeBranches(cwd: string): Promise<WorktreeBranch[]> {
  return hasBridge() ? getMako().worktreeBranches(cwd) : Promise.resolve([])
}

export function readWorktreePulls(cwd: string): Promise<WorktreePull[] | null> {
  return hasBridge() ? getMako().worktreePulls(cwd) : Promise.resolve(null)
}

type RemovableWorktree = Pick<ThreadWorktree, "path" | "branch">

/** Worktrees whose removal waits out its toast's Undo: gone from view, still on disk. */
export const leavingWorktrees = createStore<{ byPath: Readonly<Record<string, true>> }>({ byPath: {} })
export const useLeavingWorktrees = createHook(leavingWorktrees)

function setLeaving(paths: readonly string[], leaving: boolean): void {
  const rest = Object.fromEntries(Object.entries(leavingWorktrees.get().byPath).filter(([path]) => !paths.includes(path)))
  leavingWorktrees.set({ byPath: leaving ? { ...rest, ...Object.fromEntries(paths.map((path) => [path, true as const])) } : rest })
}

/**
 * Take the worktrees out of view now and remove them once the toast's Undo
 * has passed. Nothing is removed before then, so Undo puts them back exactly
 * and quitting first keeps them. `undo` also runs on Undo.
 */
function removeAfterUndo(going: readonly RemovableWorktree[], title: string, description: string, undo?: () => void): void {
  const paths = going.map((worktree) => worktree.path)
  setLeaving(paths, true)
  const timer = window.setTimeout(() => void removeNow(), ACTION_TOAST_MS)
  toast(title, {
    description,
    duration: ACTION_TOAST_MS,
    action: {
      label: "Undo",
      onClick: () => {
        window.clearTimeout(timer)
        setLeaving(paths, false)
        undo?.()
      },
    },
  })
  async function removeNow() {
    const failed: string[] = []
    for (const worktree of going) {
      try {
        const { worktrees } = await getMako().removeWorktree(worktree.path)
        reads += 1
        worktreesStore.set(stateOf(worktrees))
      } catch (error) {
        failed.push(going.length === 1 ? error instanceof Error ? error.message : String(error) : `${worktree.branch}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    setLeaving(paths, false)
    void refreshWorktreeSummaries().catch(() => {})
    if (failed.length) toast.error(failed.length === 1 ? "A worktree wasn't removed after all" : `${failed.length} worktrees weren't removed after all`, { description: failed.join("\n") })
  }
}

/** Remove a worktree, with Undo instead of a question; one that would lose work stays and says why. Its branch keeps whatever was committed there. */
export async function removeWorktree(worktree: RemovableWorktree): Promise<void> {
  if (leavingWorktrees.get().byPath[worktree.path]) return
  let removal: WorktreeRemoval
  try {
    removal = await getMako().worktreeRemoval(worktree.path)
  } catch (error) {
    toast.error("The worktree wasn't removed", { description: error instanceof Error ? error.message : String(error) })
    return
  }
  if (removal.held) {
    toast("The worktree stays", { description: removal.held })
    return
  }
  removeAfterUndo([worktree], "Worktree removed", removedNote(worktree.branch, removal.landing, worktreeSummariesStore.get().byPath[worktree.path]))
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

/** Remove every worktree whose work landed or never started, as one toast with one Undo; their branches stay. */
export function removeLandedWorktrees(worktrees: readonly WorktreeDetail[]): void {
  const going = worktrees.filter((worktree) => removable(worktree) && !leavingWorktrees.get().byPath[worktree.path])
  const [only] = going
  if (!only) return
  if (going.length === 1) removeAfterUndo(going, "Worktree removed", removedNote(only.branch, only.landing, worktreeSummariesStore.get().byPath[only.path]))
  else removeAfterUndo(going, `${going.length} worktrees removed`, "Their branches are kept, with every commit made there")
}

/**
 * A Thread was put away with nothing running in it. With the tidy-up on and
 * its work landed and committed, its worktree goes too, under the archive
 * toast's Undo, which brings back both; otherwise the toast offers the removal.
 */
export async function archivedWithWorktree(worktree: ThreadWorktree, restore: () => void): Promise<void> {
  const offer = () => toast("Thread archived", {
    description: `Its worktree on ${worktree.branch} is still on disk. Removing it keeps the branch.`,
    duration: ACTION_TOAST_MS,
    action: { label: "Remove worktree", onClick: () => void removeWorktree(worktree) },
  })
  if (!prefsStore.get().removeLandedOnArchive || !hasBridge()) return void offer()
  const removal = await getMako().worktreeRemoval(worktree.path).catch(() => null)
  const summary = worktreeSummariesStore.get().byPath[worktree.path]
  if (!removal || removal.held || !landedFor(removal.landing, summary)) return void offer()
  removeAfterUndo([worktree], "Thread archived", `Its worktree goes too. ${removedNote(worktree.branch, removal.landing, summary)}`, restore)
}
