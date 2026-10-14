import { toast } from "sonner"
import type { HostEvent } from "@mako/host/contracts/host-events-boot"
import type { MoveOutcome, MoveShares, WorkspaceMoveAnswer, WorkspaceMoveRequest, WorkspaceMoves } from "@mako/host/contracts/workspace-moves"
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
  /** Whether what might be the Thread's, and what nobody can be named for, comes along too. */
  async bring(id: string, bring: boolean): Promise<void> {
    try {
      await getMako().bringWithWorkspaceMove(id, bring)
    } catch (error) {
      toast.error("Mako couldn't record that choice", { description: error instanceof Error ? error.message : String(error) })
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

const files = (count: number) => `${count} ${count === 1 ? "file" : "files"}`

/** Files whose changes stay unless brought: they might be the Thread's, or nobody can be named for them. */
export function unsure(shares: Pick<MoveShares, "uncertain" | "unattributed">): number {
  return shares.uncertain.files + shares.unattributed.files
}

/** Files with other threads' or the person's changes, each counted once. */
function kept(shares: Omit<MoveShares, "thread" | "split">): number {
  return shares.kept ?? Math.max(shares.others.files, shares.person.files)
}

/**
 * What stays in the project folder, in one quiet line: others' changes,
 * and those that come only if brought, each with its noun. `bring` says
 * they were chosen to come.
 */
export function stayingLine(shares: Omit<MoveShares, "thread" | "split">, bring = false): string {
  const others = kept(shares)
  const maybe = shares.uncertain.files
  const nobody = shares.unattributed.files
  const unsureParts = [maybe ? `${files(maybe)} that might be its` : "", nobody ? `${files(nobody)} not attributed` : ""].filter(Boolean).join(" and ")
  const staying = [others ? `yours and other threads' changes in ${files(others)}` : "", bring ? "" : unsureParts].filter(Boolean).join("; ")
  return [staying ? `Staying: ${staying}` : "", bring && unsureParts ? `Coming too: ${unsureParts}` : ""].filter(Boolean).join(". ")
}

/** The hunks a move couldn't split by line, named. */
export function splitLine(split: MoveShares["split"]): string | undefined {
  const [first] = split
  if (!first) return undefined
  const more = split.length > 1 ? ` (and ${split.length - 1} more)` : ""
  return `A hunk in ${first.path} mixes writers, so it ${first.to === "thread" ? "goes whole with the thread, which wrote most of it" : "stays whole, since others wrote most of it"}${more}`
}

/** What a finished move did, for its toast: what came, and what stayed. */
export function movedDescription(outcome: MoveOutcome): string {
  const came = outcome.came.files ? `Its changes in ${files(outcome.came.files)} came along.` : "None of the project folder's changes were its own, so none came."
  const stayed = stayingLine(outcome.stayed)
  return stayed ? `${came} ${stayed.replace("Staying:", "Stayed in the project folder:")}.` : came
}

/** "Bring these" after a move: what stayed because Mako couldn't put it on the Thread follows it. */
export async function bringStayed(conversationId: string): Promise<void> {
  try {
    const { outcome, left } = await getMako().bringStayedChanges(conversationId)
    toast(outcome.brought ? "They're in the worktree now" : "Nothing more came", {
      description: left.length ? `${left.join(", ")} changed since the move, so ${left.length === 1 ? "it" : "they"} stayed as ${left.length === 1 ? "it is" : "they are"}.` : undefined,
    })
  } catch (error) {
    toast.error("Mako couldn't bring them", { description: error instanceof Error ? error.message : String(error) })
  }
}

/** The toast after a move: its branch, what came and stayed, and "Bring these" when something could still follow. */
export function movedToast(conversationId: string, branch: string | undefined, outcome: MoveOutcome, told?: boolean): void {
  const description = [movedDescription(outcome), told === false ? undefined : "The agent carries on there."].filter(Boolean).join(" ")
  const title = branch ? `Now on its own branch, ${branch}` : "Now on its own branch"
  if (!unsure(outcome.stayed)) {
    toast(title, { description })
    return
  }
  toast(title, {
    description,
    duration: ACTION_TOAST_MS,
    action: { label: "Bring these", onClick: () => void bringStayed(conversationId) },
  })
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
  if (event.outcome && !event.lead) {
    movedToast(event.to, event.branch, event.outcome, event.told)
    return
  }
  const description = [
    event.lead ? "It moved with the rest of its Thread."
      : event.changed ? `${event.changed} changed ${event.changed === 1 ? "file" : "files"} came along; the project folder is clean again.` : undefined,
    event.told === false ? undefined : "The agent carries on there.",
  ].filter(Boolean).join(" ")
  toast(event.branch ? `Now on its own branch, ${event.branch}` : "Now on its own branch", description ? { description } : undefined)
}
