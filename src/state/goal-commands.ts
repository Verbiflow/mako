import { toast } from "sonner"
import { GOAL_OBJECTIVE_LIMIT, type ConversationGoal } from "@mako/host/contracts/live-goals"
import { acp, acpStore, activeAcp, activeLiveAcp } from "@/state/acp"
import { confirmAction } from "@/state/confirm"
import { descriptorFor } from "@/state/descriptors"
import type { GoalLine } from "@/state/goals"
import { startInThread } from "@/state/thread-sessions"
import { openSessionDraft, threadGroupsStore, type SessionDraft } from "@/state/thread-groups"
import { threadsStore } from "@/state/thread-store"
import { harnessLabel } from "@/lib/harness-label"
import type { ThreadRef } from "@/lib/types"

/** Where the composer would send a message, which is where its `/goal` goes. */
export type GoalRoute =
  | { kind: "conversation"; key: string }
  | { kind: "thread"; ref: ThreadRef }
  | { kind: "tab"; draft: SessionDraft; harness: string }
  | { kind: "new"; harness: string; cwd: string }
  | { kind: "elsewhere"; reason: string }

/** The composer's routing for a message, read for a goal: the conversation it continues, or the one it starts. */
export function goalRoute(cwd: string | undefined): GoalRoute {
  const conversation = activeAcp(acpStore.get())
  const live = activeLiveAcp(acpStore.get())
  const viewing = threadsStore.get().viewing?.ref
  const harness = threadsStore.get().composerHarness
  if (viewing && (!live || viewing.path !== conversation?.threadPath)) {
    if (harness !== viewing.harness)
      return { kind: "elsewhere", reason: `Send a message to move this conversation to ${harnessLabel(harness)} first, then set its goal.` }
    return viewing.archived || viewing.resumeUnavailable
      ? { kind: "elsewhere", reason: "Send a message to reopen this conversation first, then set its goal." }
      : { kind: "thread", ref: viewing }
  }
  if (conversation) {
    return harness === conversation.harness
      ? { kind: "conversation", key: conversation.key }
      : { kind: "elsewhere", reason: `This conversation runs in ${harnessLabel(conversation.harness)}. Pick ${harnessLabel(conversation.harness)} again to set its goal, or send a message to move it to ${harnessLabel(harness)} first.` }
  }
  const draft = openSessionDraft(threadGroupsStore.get())
  if (draft) return { kind: "tab", draft, harness }
  return descriptorFor(threadsStore.get(), harness)?.live
    ? { kind: "new", harness, cwd: cwd ?? "" }
    : { kind: "elsewhere", reason: `${harnessLabel(harness)} can't start a conversation with a goal. Pick another agent to set one.` }
}

/** Sends what a `/goal` draft asks where the composer is pointed; false keeps the draft. */
export async function sendGoalLine(line: GoalLine, route: GoalRoute): Promise<boolean> {
  if (line.kind === "empty") {
    toast.info("Write the goal after /goal, such as “/goal the parser tests pass”.")
    return false
  }
  if (line.kind === "too-long") {
    toast.error(`A goal can be up to ${GOAL_OBJECTIVE_LIMIT.toLocaleString()} characters. This one is ${line.length.toLocaleString()}; shorten it and try again.`)
    return false
  }
  if (route.kind === "elsewhere") {
    toast.error(route.reason)
    return false
  }
  if (route.kind === "conversation") {
    const goal = acpStore.get().conversations[route.key]?.goal
    if (line.kind !== "set" && !goal) {
      toast.error(`This conversation has no goal to ${line.kind}.`)
      return false
    }
    if (line.kind === "set" && goal && goal.status !== "complete" && !(await replaces(goal))) return false
    return acp.goal(line, route.key)
  }
  if (line.kind !== "set") {
    toast.error(`This conversation has no goal to ${line.kind}.`)
    return false
  }
  switch (route.kind) {
    case "thread":
      return acp.resumeWithGoal(route.ref, line.objective)
    case "tab":
      return startInThread(route.draft, route.harness, { goal: line.objective })
    case "new":
      return acp.startGoal(route.harness, route.cwd, line.objective)
  }
}

async function replaces(goal: ConversationGoal): Promise<boolean> {
  const objective = goal.objective.length > 120 ? `${goal.objective.slice(0, 119)}…` : goal.objective
  const replacing = await confirmAction({
    title: "Replace the goal?",
    body: `This conversation is still working toward “${objective}”. The new goal takes its place, and the agent stops working toward this one.`,
    confirm: "Replace goal",
  })
  requestAnimationFrame(() => window.dispatchEvent(new CustomEvent("mako:focus-composer")))
  return replacing
}
