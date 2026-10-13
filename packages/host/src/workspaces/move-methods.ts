import type { MethodTable } from "../base/methods.js"
import type { WorkspaceMoves } from "./moves.js"
import type { ThreadWorktreeService } from "./thread-worktrees.js"
import type { MoveOutcome, WorkspaceMoveAnswer, WorkspaceMoveHold, WorkspaceMoveTarget, WorkspaceMoves as WorkspaceMovesState } from "../contracts/workspace-moves.js"

export function declareMoveMethods(methods: MethodTable, moves: WorkspaceMoves, hold: (target: WorkspaceMoveTarget) => WorkspaceMoveHold, worktrees: Pick<ThreadWorktreeService, "bringStayed" | "moveOutcome" | "threadShares"> | null) {
  methods.handle("mako:workspace-moves", (): WorkspaceMovesState => moves.state())
  methods.handle("mako:workspace-move-hold", async (target: WorkspaceMoveTarget): Promise<WorkspaceMoveHold> => {
    const held = hold(target)
    const shares = await worktrees?.threadShares(target.thread, target.cwd).catch(() => undefined)
    return shares ? { ...held, shares } : held
  })
  methods.handle("mako:workspace-move-answer", (id: string, answer: WorkspaceMoveAnswer) => moves.answer(id, answer))
  methods.handle("mako:workspace-move-bring", (id: string, bring: boolean) => moves.bring(id, bring))
  methods.handle("mako:workspace-move-bring-stayed", (conversationId: string): Promise<{ outcome: MoveOutcome; left: string[] }> => {
    if (!worktrees) throw new Error("Worktrees need the Thread store, which didn't open.")
    return worktrees.bringStayed(conversationId)
  })
  methods.handle("mako:workspace-move-outcome", async (conversationId: string): Promise<MoveOutcome | null> => (await worktrees?.moveOutcome(conversationId)) ?? null)
  methods.handle("mako:workspace-move-forget", (project: string) => moves.forget(project))
}
