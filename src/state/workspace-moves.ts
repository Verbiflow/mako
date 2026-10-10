import { toast } from "sonner"
import type { HostEvent } from "../../electron/contracts/host-events-boot.ts"
import type { WorkspaceMoveAnswer, WorkspaceMoveRequest, WorkspaceMoves } from "../../electron/contracts/workspace-moves.ts"
import { getMako, hasBridge } from "@/lib/bridge"
import { harnessLabel } from "@/lib/harness-label"
import { ACTION_TOAST_MS } from "@/lib/toast-duration"
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
      duration: ACTION_TOAST_MS,
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

/** The titles of the Sessions that followed each lead onto its branch, for the lead's window to name. */
const followed = new Map<string, string[]>()

/**
 * One of a Thread's Sessions moved onto its branch on the host: an agent's
 * allowed move, or a Session following another, the agent's or the
 * person's. A Session it left is archived there; a window showing it
 * follows it onto the branch, and the window showing the one it followed
 * says it came along.
 */
export async function workspaceMoved(event: Extract<HostEvent, { type: "workspace-moved" }>): Promise<void> {
  acknowledgeThread({ kind: "live", id: event.from })
  await refreshWorktrees().catch(() => {})
  const active = acpStore.get().activeKey
  if (event.lead && active === event.lead) {
    const titles = [...followed.get(event.lead) ?? [], event.title ?? "Untitled conversation"]
    followed.set(event.lead, titles)
    toast(titles.length === 1 ? `“${titles[0]}” came along too` : `${titles.length} more Sessions came along`, {
      id: `moved-with:${event.lead}`,
      description: titles.length === 1 ? `This Thread's other Session here is on ${event.branch ?? "the same branch"} as well.` : titles.map((title) => `“${title}”`).join(", "),
    })
    return
  }
  if (active !== event.from) return
  const fork = await getMako().liveSnapshot(event.to).catch(() => null)
  if (!fork) return
  applyLiveSnapshot(fork)
  await show(event.to)
  const description = [
    event.lead ? "It moved with the rest of its Thread."
      : event.changed ? `${event.changed} changed ${event.changed === 1 ? "file" : "files"} came along; the project folder is clean again.` : undefined,
    event.told === false ? undefined : "The agent carries on there.",
  ].filter(Boolean).join(" ")
  toast(event.branch ? `Now on its own branch, ${event.branch}` : "Now on its own branch", description ? { description } : undefined)
}
