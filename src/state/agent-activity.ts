import type { Entry } from "@mako/sessions/entries"
import { entryToolIdentity } from "@/lib/tools"
import { toolKindActivity } from "@mako/sessions/tool-identity"
import type { NativeActivity } from "@/lib/types"
import type { WorktreeStep } from "@mako/host/contracts/thread-worktrees"
import type { CloudStartStep } from "@mako/host/contracts/cloud-threads"

export type AgentActivityKind = "working" | "connecting" | "reasoning" | "searching" | "executing" | "editing" | "responding" | "waiting" | "failed" | "complete" | "idle"

export interface AgentActivity {
  kind: AgentActivityKind
  label: string
  /** Quieter words after the label. */
  detail?: string
  /**
   * Set when the provider itself reported what the turn is doing, rather
   * than Mako reading it from output: host epoch ms it began, and the row
   * counts up from it. Primitive fields keep the activity `shallowEqual`.
   */
  since?: number
  /** Host epoch ms of the provider's next attempt; the row counts down to it. */
  retryAt?: number
}

/**
 * How long a running turn goes without output before it reads as quiet.
 * Models reason silently and tools run long, so a quiet turn is reported,
 * never ended or sent again.
 */
export const QUIET_AFTER_MS = 60_000

const WORKTREE_STEPS = {
  checkout: "Checking out files",
  carry: "Copying files from your folder",
} satisfies Record<WorktreeStep, string>

/**
 * What a starting conversation's row says, in words about the person's project and harness: a cloud Thread's
 * project coming up (its machine and its copy of the repository), then the harness starting, as a local one's does.
 */
export function startLabel(harnessName: string | undefined, cloudStep?: { step: CloudStartStep; project: string }): string {
  if (cloudStep?.step === "preparing") return `Getting ${cloudStep.project} ready`
  return harnessName ? `Starting ${harnessName}` : "Starting"
}

export function agentActivity({ blocks, waiting, connecting, starting, makingWorktree = false, worktreeStep, preparing, switchingAccount = false, quietForMs = 0, native, harness }: { blocks: readonly Entry[]; waiting: boolean; connecting: boolean; /** What a start says while `connecting`. */ starting?: string; makingWorktree?: boolean; worktreeStep?: WorktreeStep; preparing: boolean; switchingAccount?: boolean; quietForMs?: number; native?: NativeActivity; harness?: string }): AgentActivity {
  if (waiting) return { kind: "waiting", label: "Waiting for your approval" }
  if (connecting) return { kind: "connecting", label: makingWorktree ? WORKTREE_STEPS[worktreeStep ?? "checkout"] : (starting ?? "Starting") }
  if (switchingAccount) return { kind: "waiting", label: "Waiting to switch account" }
  if (preparing) return { kind: "connecting", label: "Sending" }
  if (native) return nativeAgentActivity(native)
  const quiet = quietForMs >= QUIET_AFTER_MS ? `No output for ${quietDuration(quietForMs)}` : undefined
  const tool = blocks.findLast((block) => block.type === "tool" && block.status === "pending")
  if (tool?.type === "tool") {
    const identity = entryToolIdentity(tool, harness)
    const label = !identity.target ? identity.label : identity.kind === "shell" ? identity.target : `${identity.label} · ${identity.target}`
    return { kind: toolKindActivity(identity.kind), label: quiet ? `${quiet} · ${label}` : label }
  }
  const last = blocks.at(-1)
  if (last?.type === "thinking" && last.text.length > 0) return { kind: "reasoning", label: quiet ?? "Reasoning" }
  if (last?.type === "text" && last.text.length > 0) return quiet ? { kind: "working", label: quiet } : { kind: "responding", label: "Responding" }
  return { kind: "working", label: quiet ?? "Working" }
}

function nativeAgentActivity(activity: NativeActivity): AgentActivity {
  switch (activity.kind) {
    case "compacting":
      return { kind: "working", label: "Compacting context", detail: "Making room to continue", since: activity.since }
    case "retrying": {
      const attempt = activity.attempt
        ? activity.maxAttempts ? `attempt ${activity.attempt} of ${activity.maxAttempts}` : `attempt ${activity.attempt}`
        : undefined
      const detail = [attempt, activity.reason].filter(Boolean).join(" · ") || undefined
      return { kind: "working", label: "Retrying", detail, since: activity.since, retryAt: activity.retryAt }
    }
    case "waiting":
      return { kind: "working", label: activity.label, since: activity.since }
  }
}

function quietDuration(milliseconds: number): string {
  const minutes = Math.floor(milliseconds / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`
}
