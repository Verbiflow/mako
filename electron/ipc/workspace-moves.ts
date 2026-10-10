import type { MethodTable } from "../host-methods.js"
import type { WorkspaceMoves } from "../workspace-moves.js"
import type { WorkspaceMoveAnswer, WorkspaceMoveHold, WorkspaceMoveTarget, WorkspaceMoves as WorkspaceMovesState } from "@mako/host/contracts/workspace-moves"

export function installWorkspaceMovesIpc(methods: MethodTable, moves: WorkspaceMoves, hold: (target: WorkspaceMoveTarget) => WorkspaceMoveHold) {
  methods.handle("mako:workspace-moves", (): WorkspaceMovesState => moves.state())
  methods.handle("mako:workspace-move-hold", (target: WorkspaceMoveTarget): WorkspaceMoveHold => hold(target))
  methods.handle("mako:workspace-move-answer", (id: string, answer: WorkspaceMoveAnswer) => moves.answer(id, answer))
  methods.handle("mako:workspace-move-forget", (project: string) => moves.forget(project))
}
