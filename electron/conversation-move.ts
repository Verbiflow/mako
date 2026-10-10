import { existsSync, realpathSync } from "node:fs"
import { isAbsolute, join, relative } from "node:path"
import type { ForkInput } from "./contracts/conversation-control.js"
import type { LiveSnapshot } from "./contracts/live-conversations.js"
import type { LiveConversations } from "./live-conversations.js"
import type { ThreadWorktreeService } from "./thread-worktrees.js"

export interface ConversationMoveDeps {
  conversations: Pick<LiveConversations, "snapshot" | "relocatable" | "relocate" | "resumeMoved" | "fork">
  worktrees: Pick<ThreadWorktreeService, "joinFolder" | "prepareFork" | "moveChanges" | "attach" | "abandon">
  warn(message: string, facts: Record<string, string>): void
}

/** A conversation brought into its Thread's worktree. */
export interface MovedConversation {
  /** The conversation that goes on there: the same one when `relocated`, else its fork. */
  conversation: LiveSnapshot
  /** Uncommitted files of the main checkout that came along. */
  moved: number
  relocated: boolean
  /** Why the harness didn't resume the same session there, when it was tried and the move forked instead. */
  refused?: string
}

/**
 * Bring a conversation into its Thread's worktree, making one (and moving
 * the checkout's changes) when it has none; `project`, a folder around the
 * conversation's, is what the worktree is made of. `enter` puts the
 * conversation, under `owner`'s id, in the folder it gets; when it gives
 * nothing back, a worktree made for it is taken back and nothing moves.
 */
async function intoWorktree<T>(deps: ConversationMoveDeps, id: string, owner: string, project: string | undefined, enter: (cwd: string) => T | undefined | Promise<T | undefined>): Promise<{ entered: T; moved: number } | undefined> {
  const source = deps.conversations.snapshot(id)
  if (!source) throw new Error("Open the conversation before moving it into a worktree.")
  // A Thread has one worktree: a Session moving in once it exists joins it, and nothing moves with it.
  const joined = await deps.worktrees.joinFolder(id, owner, source.session.cwd)
  if (joined) {
    const entered = await enter(joined)
    return entered === undefined ? undefined : { entered, moved: 0 }
  }
  const from = project ?? source.session.cwd
  const worktree = await deps.worktrees.prepareFork(id, owner, from, source.session.title)
  const inside = relative(realpathSync(from), realpathSync(source.session.cwd))
  const nested = inside && !inside.startsWith("..") && !isAbsolute(inside) ? join(worktree.cwd, inside) : worktree.cwd
  let entered: T | undefined
  try {
    entered = await enter(existsSync(nested) ? nested : worktree.cwd)
  } catch (error) {
    await deps.worktrees.abandon(owner).catch(() => undefined)
    throw error
  }
  if (entered === undefined) {
    await deps.worktrees.abandon(owner).catch(() => undefined)
    return undefined
  }
  // The conversation is there before anything moves, so a refused one leaves the checkout untouched.
  const moved = await deps.worktrees.moveChanges(owner)
  await deps.worktrees.attach(owner)
  return { entered, moved }
}

/**
 * Move a conversation into its Thread's worktree. As it is, when its harness
 * goes on in another folder (`resume.elsewhere`) and the move goes on from
 * its last answer: the session resumes there before this returns, once the
 * worktree is the Thread's, so it starts with the worktree's environment.
 * Otherwise, or when that resume fails, as a fork from `input`'s point with
 * its transcript, the conversation left as it was in its own folder.
 */
export async function moveIntoWorktree(deps: ConversationMoveDeps, id: string, input: ForkInput, project?: string): Promise<MovedConversation> {
  const fork = async (project?: string) => {
    const forked = await intoWorktree(deps, id, input.id, project, (cwd) => deps.conversations.fork(id, input, cwd))
    if (!forked) throw new Error("The conversation couldn't be forked into the worktree.")
    return forked
  }
  const last = deps.conversations.snapshot(id)?.requests.filter((request) => request.status === "completed").at(-1)
  if (!input.move || input.point.kind !== "run" || input.point.requestId !== last?.id || !deps.conversations.relocatable(id)) {
    const forked = await fork(project)
    return { conversation: forked.entered, moved: forked.moved, relocated: false }
  }
  const placed = await intoWorktree(deps, id, id, project, async (cwd) => {
    const from = await deps.conversations.relocate(id, cwd)
    return from === undefined ? undefined : { from }
  })
  if (!placed) {
    const forked = await fork(project)
    return { conversation: forked.entered, moved: forked.moved, relocated: false }
  }
  const refused = await deps.conversations.resumeMoved(id, placed.entered.from)
  const conversation = deps.conversations.snapshot(id)
  if (!refused && conversation) return { conversation, moved: placed.moved, relocated: true }
  const reason = refused ?? "The conversation closed during the move."
  deps.warn("the moved conversation didn't resume in the worktree, so it was forked there", { conversation: id, reason })
  // The worktree is the Thread's now, so the fork joins it; the changes came along already.
  const forked = await fork()
  return { conversation: forked.entered, moved: placed.moved, relocated: false, refused: reason }
}
