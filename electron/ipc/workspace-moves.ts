import { registerIpc } from "./register.js"
import type { WorkspaceMoves } from "../workspace-moves.js"
import type { WorkspaceMoveAnswer, WorkspaceMoves as WorkspaceMovesState } from "../contracts/workspace-moves.js"

export function installWorkspaceMovesIpc(moves: WorkspaceMoves) {
  registerIpc("mako:workspace-moves", (): WorkspaceMovesState => moves.state())
  registerIpc("mako:workspace-move-answer", (_event, id: string, answer: WorkspaceMoveAnswer) => moves.answer(id, answer))
  registerIpc("mako:workspace-move-forget", (_event, project: string) => moves.forget(project))
}
