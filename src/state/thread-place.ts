import { toast } from "sonner"
import type { LiveSnapshot } from "../../electron/contracts/live-conversations.ts"
import type { MessageAnchor } from "@/lib/types"
import { getMako, hasBridge } from "@/lib/bridge"
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

async function forkIntoWorktree(source: Source): Promise<{ fork: LiveSnapshot; leaving: ThreadTarget }> {
  const id = crypto.randomUUID()
  if (source.kind === "live") {
    const { live } = source
    const last = live.requests?.findLast((request) => request.status === "completed")
    if (!last || live.session.status === "running") throw new Error("Wait for the answer to finish, then move the thread.")
    const fork = await getMako().liveFork(live.key, { id, provider: live.harness, point: { kind: "run", requestId: last.id }, thread: "parent", worktree: true, move: true })
    return { fork, leaving: { kind: "live", id: live.key } }
  }
  const { ref } = source.viewing
  const anchor = lastAnswer(source.viewing)
  if (!anchor) throw new Error("Move the thread after its first answer.")
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
 * Moves the Thread on screen into its worktree, making one when it has none.
 * The Session on screen goes on there, in the same Thread, from its last
 * answer, and the one it leaves is archived, so the Thread moves rather than
 * splits. A new worktree takes the project folder's uncommitted changes
 * along; joining the Thread's worktree moves nothing.
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
    await threadLifecycle.archive([leaving], true, false).catch(() => false)
    const worktree = worktreeAt(worktreesStore.get().worktrees, fork.session.cwd)?.worktree
    const joining = Boolean(worktree && before.has(worktree.path))
    toast(worktree ? `Moved to a worktree on ${worktree.branch}` : "Moved to a worktree", {
      description: joining
        ? "It joined the worktree this thread already had."
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
