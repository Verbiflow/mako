import { useEffect, useState } from "react"
import { toast } from "sonner"
import type { LiveSnapshot } from "@mako/host/contracts/live-conversations"
import type { WorkspaceMoveHold, WorkspaceMoveTarget } from "@mako/host/contracts/workspace-moves"
import type { MessageAnchor } from "@/lib/types"
import { getMako, hasBridge } from "@/lib/bridge"
import { sameAcpPresence, selectAcpPresence } from "@/state/acp-presence"
import { acpStore, activeLiveAcp, type AcpState } from "@/state/acp-state"
import { descriptorFor } from "@/state/descriptors"
import { applyLiveSnapshot } from "@/state/live-recovery"
import { nativeThreadTarget, threadLifecycle, type ThreadTarget } from "@/state/thread-lifecycle"
import type { ThreadsState } from "@/state/thread-state"
import { threadsStore } from "@/state/threads"
import { refreshWorktrees, worktreeAt, worktreesStore } from "@/state/worktrees"

/**
 * Whether the conversation on screen can move into a worktree now: it needs
 * an answer to go on from, and not one being written.
 */
export type MoveReadiness = "ready" | "running" | "unanswered" | "loading" | "unsupported"

type Source =
  | { kind: "live"; live: NonNullable<ReturnType<typeof activeLiveAcp>> }
  | { kind: "viewed"; viewing: NonNullable<ThreadsState["viewing"]> }

/** The same choice the conversation area makes between the viewer and a live panel. */
function sourceOnScreen(acp: AcpState, threads: ThreadsState): Source | undefined {
  const live = activeLiveAcp(acp)
  const viewing = threads.viewing
  if (viewing && (!live || viewing.ref.path !== live.threadPath)) return { kind: "viewed", viewing }
  return live ? { kind: "live", live } : undefined
}

function lastAnswer(viewing: NonNullable<ThreadsState["viewing"]>): MessageAnchor | undefined {
  const at = viewing.entries.findLastIndex((entry) => entry.kind === "assistant")
  if (at < 0) return undefined
  const entry = viewing.entries[at]!
  const anchor: MessageAnchor = { index: viewing.pageStart + at }
  if (entry.id) anchor.id = entry.id
  if (entry.at) anchor.at = entry.at
  return anchor
}

export function moveReadiness(acp: AcpState, threads: ThreadsState): MoveReadiness {
  const source = sourceOnScreen(acp, threads)
  if (!source) return "unanswered"
  if (source.kind === "live") {
    if (source.live.session.status === "running") return "running"
    return source.live.requests?.some((request) => request.status === "completed") ? "ready" : "unanswered"
  }
  if (descriptorFor(threads, source.viewing.ref.harness)?.live !== true) return "unsupported"
  if (threads.opening || source.viewing.preview) return "loading"
  return lastAnswer(source.viewing) ? "ready" : "unanswered"
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

/** The Sessions a move brings along, as the menu names them; `undefined` before the host has said which. */
function along(hold: WorkspaceMoveHold | undefined): { named: string; many: boolean } | undefined {
  const companions = hold?.companions
  if (!companions) return { named: "Its sessions here", many: true }
  if (!companions.length) return undefined
  const [only] = companions
  if (companions.length === 1 && only) return { named: only.title ? `“${only.title}”` : "Its other session here", many: false }
  return { named: `Its ${companions.length} other sessions here`, many: true }
}

/** The composer's offer to move the Thread on screen onto its own branch: what it says, and whether it can be chosen now. */
export interface MoveOffer {
  detail: string
  disabled: boolean
}

/** `MoveOffer` as things stand: something still running in the Thread's Sessions here holds it, named, until that's done. */
export function moveOffer(ready: MoveReadiness, hold: WorkspaceMoveHold | undefined, place: { threadBranch?: string; changed: number }): MoveOffer {
  if (ready === "running") return { detail: "After this answer finishes", disabled: true }
  if (ready === "unanswered") return { detail: "After its first answer", disabled: true }
  if (ready === "loading") return { detail: "Once the conversation has loaded", disabled: true }
  if (ready === "unsupported") return { detail: "This agent can't go on in another folder yet", disabled: true }
  if (hold?.moving) return { detail: "Mako is moving this thread onto its own branch now", disabled: true }
  if (hold?.held) {
    const done = hold.held.includes("; ") ? "they're" : "that's"
    return { detail: `${hold.held.charAt(0).toUpperCase()}${hold.held.slice(1)}. Move once ${done} done`, disabled: true }
  }
  const others = along(hold)
  if (place.threadBranch) {
    const joining = others ? `, with ${others.named.charAt(0).toLowerCase()}${others.named.slice(1)}` : ""
    return { detail: `Joins this thread's branch, ${place.threadBranch}${joining}. Nothing in the project folder moves`, disabled: false }
  }
  const files = place.changed ? `the ${count(place.changed, "changed file", "changed files")}` : ""
  const coming = others && files ? `${others.named} and ${files} come along` : others ? `${others.named} ${others.many ? "come" : "comes"} along` : files ? `${files.charAt(0).toUpperCase()}${files.slice(1)} come${place.changed === 1 ? "s" : ""} along` : ""
  return { detail: `Moves the thread to a worktree on a new branch${coming ? `. ${coming}` : ""}`, disabled: false }
}

/** How soon a change to a conversation is asked about, so a streaming turn asks once. */
const HOLD_SETTLE_MS = 250
/** How often a held move is asked about again: a checkpoint or background task ends on the host without this window hearing of it. */
const HOLD_POLL_MS = 1_000

/**
 * Asks what the person's move of the Thread on screen meets now: the
 * Sessions it brings along and what holds it (`WorkspaceMoves.hold`). It
 * asks at once, again when a conversation starts or ends a turn, and each
 * second while the move is held. `told` hears each answer, or `undefined`
 * when the host can't say; a move chosen then still waits briefly and
 * refuses on its own. Returns the stop.
 */
export function watchMoveHold(place: { thread: string; cwd: string }, told: (hold: WorkspaceMoveHold | undefined) => void): () => void {
  let stopped = false
  let asked = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let due = Infinity
  const schedule = (ms: number) => {
    if (Date.now() + ms >= due) return
    clearTimeout(timer)
    due = Date.now() + ms
    timer = setTimeout(ask, ms)
  }
  function ask() {
    timer = undefined
    due = Infinity
    const turn = ++asked
    const source = sourceOnScreen(acpStore.get(), threadsStore.get())
    const target: WorkspaceMoveTarget = { ...place }
    if (source?.kind === "live") target.conversation = source.live.key
    getMako().workspaceMoveHold(target).then(
      (hold) => {
        if (stopped || turn !== asked) return
        told(hold)
        if (hold.held || hold.moving) schedule(HOLD_POLL_MS)
      },
      () => {
        if (!stopped && turn === asked) told(undefined)
      },
    )
  }
  ask()
  let presence = selectAcpPresence(acpStore.get())
  const unsubscribe = acpStore.subscribe(() => {
    const next = selectAcpPresence(acpStore.get())
    if (sameAcpPresence(presence, next)) return
    presence = next
    schedule(HOLD_SETTLE_MS)
  })
  return () => {
    stopped = true
    clearTimeout(timer)
    unsubscribe()
  }
}

/** `watchMoveHold` while `open`, the menu that offers the move, is; undefined until the host answers. */
export function useMoveHold(open: boolean, thread: string | undefined, cwd: string | undefined): WorkspaceMoveHold | undefined {
  const key = open && thread && cwd ? JSON.stringify([thread, cwd]) : undefined
  const [answer, setAnswer] = useState<{ key: string; hold: WorkspaceMoveHold | undefined }>()
  useEffect(() => {
    if (!key || !thread || !cwd || !hasBridge()) return
    return watchMoveHold({ thread, cwd }, (hold) => setAnswer({ key, hold }))
  }, [key, thread, cwd])
  return answer && answer.key === key ? answer.hold : undefined
}

async function forkIntoWorktree(source: Source): Promise<{ fork: LiveSnapshot; leaving: ThreadTarget }> {
  const id = crypto.randomUUID()
  if (source.kind === "live") {
    const { live } = source
    const last = live.requests?.findLast((request) => request.status === "completed")
    if (!last || live.session.status === "running") throw new Error("Wait for the answer to finish, then move it to its own branch.")
    const fork = await getMako().liveFork(live.key, { id, provider: live.harness, point: { kind: "run", requestId: last.id }, thread: "parent", worktree: true, move: true })
    return { fork, leaving: { kind: "live", id: live.key } }
  }
  const { ref } = source.viewing
  const anchor = lastAnswer(source.viewing)
  if (!anchor) throw new Error("Move it to its own branch after its first answer.")
  const captured = await getMako().liveCapture(crypto.randomUUID(), ref.path)
  const fork = await getMako().liveFork(captured.session.id, {
    id,
    provider: ref.harness,
    point: { kind: "native", index: anchor.index, revision: JSON.stringify([ref.revision, ref.bytes, ref.updatedAt]), anchor },
    thread: "parent",
    worktree: true,
    move: true,
  })
  return { fork, leaving: nativeThreadTarget(ref) }
}

/**
 * Moves the Thread on screen onto its own branch: into its worktree, making
 * one when it has none.
 * The Session on screen goes on there, in the same Thread: itself, when its
 * harness resumes the same session in another folder, or else a fork from
 * its last answer, and the one it leaves is archived, so the Thread moves
 * rather than splits. The host brings the Thread's other Sessions in the
 * same checkout along after it (`WorkspaceMoves.moveNow`), and refuses,
 * moving nothing, while one of them is still busy. A new worktree takes the
 * project folder's uncommitted changes along; joining the Thread's worktree
 * moves nothing.
 */
export async function moveToWorktree(changed: number): Promise<boolean> {
  if (!hasBridge()) return false
  const source = sourceOnScreen(acpStore.get(), threadsStore.get())
  if (!source) return false
  const before = new Set(worktreesStore.get().worktrees.map((worktree) => worktree.path))
  try {
    const { fork, leaving } = await forkIntoWorktree(source)
    const { acp } = await import("@/state/acp")
    applyLiveSnapshot(fork)
    acp.activate(fork.session.id)
    await refreshWorktrees()
    const relocated = leaving.kind === "live" && leaving.id === fork.session.id
    if (!relocated) await threadLifecycle.archive([leaving], true, false).catch(() => false)
    const worktree = worktreeAt(worktreesStore.get().worktrees, fork.session.cwd)?.worktree
    const joining = Boolean(worktree && before.has(worktree.path))
    toast(worktree ? `Now on its own branch, ${worktree.branch}` : "Now on its own branch", {
      description: joining
        ? "It joined the branch this thread already had."
        : changed
          ? `${changed} changed ${changed === 1 ? "file" : "files"} came along; the project folder is clean again.`
          : "The conversation came along; the project folder is untouched.",
    })
    return true
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error))
    return false
  }
}
