import { toast } from "sonner"
import type { WorkspaceMoveAnswer, WorkspaceMoveRequest, WorkspaceMoves } from "../../electron/contracts/workspace-moves.ts"
import { getMako, hasBridge } from "@/lib/bridge"
import { harnessLabel } from "@/lib/harness-label"
import { acpStore } from "@/state/acp-state"
import { applyLiveSnapshot } from "@/state/live-recovery"
import { createHook, createStore } from "@/state/store"
import { acknowledgeThread } from "@/state/thread-lifecycle"
import { refreshWorktrees } from "@/state/worktrees"

/**
 * Agents' requests to go on on their Thread's own branch, which the user
 * answers above the composer, and the projects that let agents move without
 * asking.
 */
export const workspaceMovesStore = createStore<WorkspaceMoves>({ requests: [], alwaysAllowed: [] })
export const useWorkspaceMoves = createHook(workspaceMovesStore)

export function workspaceMoveFor(moves: WorkspaceMoves, conversationId: string | null): WorkspaceMoveRequest | undefined {
  return conversationId ? moves.requests.find((request) => request.conversationId === conversationId) : undefined
}

export function projectName(project: string): string {
  return project.split("/").filter(Boolean).at(-1) ?? project
}

async function show(conversationId: string): Promise<void> {
  const { acp } = await import("@/state/acp")
  acp.activate(conversationId)
}

export function applyWorkspaceMoves(moves: WorkspaceMoves): void {
  const known = new Set(workspaceMovesStore.get().requests.map((request) => request.id))
  workspaceMovesStore.set(moves)
  for (const request of moves.requests) {
    if (known.has(request.id) || request.state !== "asking" || acpStore.get().activeKey === request.conversationId) continue
    toast(`${harnessLabel(request.harness)} wants to work on its own branch`, {
      description: request.title ?? projectName(request.project),
      action: { label: "Show", onClick: () => void show(request.conversationId) },
    })
  }
}

export async function loadWorkspaceMoves(): Promise<void> {
  if (!hasBridge()) return
  applyWorkspaceMoves(await getMako().workspaceMoves())
}

export const workspaceMoves = {
  async answer(id: string, answer: WorkspaceMoveAnswer): Promise<void> {
    try {
      await getMako().answerWorkspaceMove(id, answer)
    } catch (error) {
      toast.error("Mako couldn't record that answer", { description: error instanceof Error ? error.message : String(error) })
    }
  },
  async forget(project: string): Promise<void> {
    try {
      await getMako().forgetWorkspaceMoves(project)
    } catch (error) {
      toast.error(`Agents in ${projectName(project)} still move without asking`, { description: error instanceof Error ? error.message : String(error) })
    }
  },
}

/**
 * An agent's allowed move happened on the host. The Session it left is
 * archived there; a window showing it follows it onto the branch.
 */
export async function workspaceMoved(event: { from: string; to: string; branch?: string; changed: number }): Promise<void> {
  acknowledgeThread({ kind: "live", id: event.from })
  await refreshWorktrees().catch(() => {})
  if (acpStore.get().activeKey !== event.from) return
  const fork = await getMako().liveSnapshot(event.to).catch(() => null)
  if (!fork) return
  applyLiveSnapshot(fork)
  await show(event.to)
  toast(event.branch ? `Now on its own branch, ${event.branch}` : "Now on its own branch", {
    description: event.changed
      ? `${event.changed} changed ${event.changed === 1 ? "file" : "files"} came along; the project folder is clean again. The agent carries on there.`
      : "The agent carries on there.",
  })
}
