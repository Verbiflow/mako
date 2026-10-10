import { registerIpc } from "./register.js"
import type { WorkspaceMoves } from "../workspace-moves.js"
import type { WorkspaceMoveAnswer, WorkspaceMoveHold, WorkspaceMoveTarget, WorkspaceMoves as WorkspaceMovesState } from "../contracts/workspace-moves.js"

export function installWorkspaceMovesIpc(moves: WorkspaceMoves, hold: (target: WorkspaceMoveTarget) => WorkspaceMoveHold) {
  registerIpc("mako:workspace-moves", (): WorkspaceMovesState => moves.state())
  registerIpc("mako:workspace-move-hold", (_event, target: WorkspaceMoveTarget): WorkspaceMoveHold => hold(target))
  registerIpc("mako:workspace-move-answer", (_event, id: string, answer: WorkspaceMoveAnswer) => moves.answer(id, answer))
  registerIpc("mako:workspace-move-forget", (_event, project: string) => moves.forget(project))
}
