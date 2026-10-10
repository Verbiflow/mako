import { randomUUID } from "node:crypto"
import type { SessionSettings } from "@mako/sessions/settings"
import type { ForkInput } from "./contracts/conversation-control.js"
import type { HostEvent } from "./contracts/host-events-boot.js"
import type { LiveSnapshot } from "./contracts/live-conversations.js"
import { moveIntoWorktree, type ConversationMoveDeps, type MovedConversation } from "./conversation-move.js"
import type { LiveConversations } from "./live-conversations.js"
import type { MoveSource } from "./workspace-moves.js"

type WorkspaceMoved = Extract<HostEvent, { type: "workspace-moved" }>

export interface ThreadWorktreeMoveDeps {
  conversations: ConversationMoveDeps["conversations"] & Pick<LiveConversations, "session" | "summaries" | "submit">
  worktrees: ConversationMoveDeps["worktrees"] & {
    /** The Thread's checkout, once its worktree is made (`ThreadWorktreeService`). */
    threadCheckout(conversationId: string): { path: string } | undefined
    ofConversation(conversationId: string): { branch: string } | undefined
  }
  /** The Thread a conversation's journal is placed in. */
  threadOf(conversationId: string): string | undefined
  archived(conversationId: string): boolean
  /** Archive a conversation a move forked from. */
  archive(conversationId: string): void
  moved(event: WorkspaceMoved): void
  /** The tuning a carry-on turn starts with, resolved as a launch would. */
  launch(harness: string, cwd: string, tuning: SessionSettings | undefined): Promise<SessionSettings | undefined>
  warn(message: string, facts: Record<string, string>): void
}

/** A conversation as `WorkspaceMoves` weighs it: busy with a turn, or waiting on what else holds its move. */
export function moveSource(conversations: Pick<LiveConversations, "snapshot" | "relocation">, id: string): MoveSource | undefined {
  const snapshot = conversations.snapshot(id)
  if (!snapshot || snapshot.session.status === "closed") return undefined
  const { session } = snapshot
  const source: MoveSource = {
    cwd: session.cwd,
    harness: session.harness,
    busy: session.status === "starting" || session.status === "running" ||
      snapshot.requests.some((request) => request.status === "queued" || request.status === "dispatching"),
  }
  const relocation = conversations.relocation(id)
  if (relocation.kind === "wait") source.waiting = relocation.reason
  if (session.title) source.title = session.title
  return source
}

const holds = (folder: string, path: string) => path === folder || path.startsWith(`${folder}/`)

/**
 * Moving a Thread's Sessions into its worktree, one at a time; when each
 * goes is `WorkspaceMoves`'s to decide.
 */
export class ThreadWorktreeMoves {
  private readonly deps: ThreadWorktreeMoveDeps

  constructor(deps: ThreadWorktreeMoveDeps) {
    this.deps = deps
  }

  /**
   * The Thread's other open Sessions editing in the same checkout as this
   * one, in a folder around it or inside it. Archived ones, such as those a
   * move left behind, and those in the Thread's worktree already stay put.
   */
  companions(id: string): string[] {
    const thread = this.deps.threadOf(id)
    const cwd = this.deps.conversations.session(id)?.cwd
    if (!thread || !cwd) return []
    const worktree = this.deps.worktrees.threadCheckout(id)?.path
    return this.deps.conversations.summaries()
      .filter(({ session }) => session.id !== id && session.status !== "closed" && this.deps.threadOf(session.id) === thread &&
        (holds(cwd, session.cwd) || holds(session.cwd, cwd)) && !(worktree && holds(worktree, session.cwd)) &&
        !this.deps.archived(session.id))
      .map(({ session }) => session.id)
  }

  /** Where a Thread's move starts from: the outermost folder among this Session's and its companions', so the worktree is the whole project's. */
  project(id: string): string | undefined {
    const cwd = this.deps.conversations.session(id)?.cwd
    if (!cwd) return undefined
    return this.companions(id)
      .map((other) => this.deps.conversations.session(other)?.cwd ?? cwd)
      .reduce((outer, folder) => holds(folder, outer) ? folder : outer, cwd)
  }

  /** Move one conversation into its Thread's worktree (`conversation-move.ts`). */
  move(id: string, input: ForkInput, project?: string): Promise<MovedConversation> {
    return moveIntoWorktree(this.deps, id, input, project)
  }

  /**
   * Carry one of a Thread's Sessions into its worktree, once its turn and its
   * companions' ended. The `lead` is the Session the move began with: the
   * worktree is made around its folder and its companions', and the others
   * join it, following `after`, where the lead goes on. A fork leaves the
   * Session it came from archived. `tell` sends its agent, which had asked
   * to move, a message to carry on there; the rest start no turn. The
   * person's own move (`input`) is announced by the window that made it,
   * which also archives what it leaves.
   */
  async carry(id: string, how: { lead: boolean; tell: boolean; after?: string; input?: ForkInput }): Promise<LiveSnapshot> {
    const source = this.deps.conversations.snapshot(id)
    if (!source) throw new Error("The conversation closed before it could move onto its own branch.")
    const title = source.session.title || "Untitled conversation"
    const last = source.requests.filter((request) => request.status === "completed").at(-1)
    const input = how.input ?? (last && {
      id: randomUUID(),
      provider: source.session.harness,
      point: { kind: "run", requestId: last.id },
      thread: "parent",
      worktree: true,
      move: true,
    } satisfies ForkInput)
    if (!input) throw new Error(how.lead
      ? "The agent's turn didn't finish, so it didn't move onto its own branch. Move it from the composer once it has an answer."
      : `“${title}” stayed in the main checkout: it has no answer yet to go on from in the worktree.`)
    const { conversation, moved, relocated } = await this.move(id, input, how.lead ? this.project(id) : undefined)
    const branch = this.deps.worktrees.ofConversation(conversation.session.id)?.branch
    if (!how.input) {
      if (!relocated) this.deps.archive(id)
      const event: WorkspaceMoved = { type: "workspace-moved", from: id, to: conversation.session.id, changed: moved, told: how.tell }
      if (branch) event.branch = branch
      if (how.after) Object.assign(event, { lead: how.after, title })
      this.deps.moved(event)
    }
    if (!how.tell) return conversation
    const came = moved ? ` The ${moved === 1 ? "uncommitted file" : `${moved} uncommitted files`} from the project folder came with you.` : ""
    const tuning = await this.deps.launch(conversation.session.harness, conversation.session.cwd, last?.tuning)
    this.deps.conversations.submit(
      conversation.session.id,
      randomUUID(),
      `You're on this Thread's own branch now${branch ? `, ${branch}` : ""}, in ${conversation.session.cwd}.${came} Work there from now on, and carry on where you left off.`,
      [],
      tuning,
      undefined,
      undefined,
      { kind: "service", name: "workspace" }
    )
    return conversation
  }
}
