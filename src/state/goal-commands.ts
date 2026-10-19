import { toast } from "sonner"
import { GOAL_OBJECTIVE_LIMIT, type ConversationGoal, type StartGoal } from "@mako/host/contracts/live-goals"
import { acp, acpStore, activeAcp, activeLiveAcp } from "@/state/acp"
import { confirmAction } from "@/state/confirm"
import { descriptorFor } from "@/state/descriptors"
import type { GoalLine } from "@/state/goals"
import { startInThread } from "@/state/thread-sessions"
import { openSessionDraft, threadGroupsStore, type SessionDraft } from "@/state/thread-groups"
import { threadsStore } from "@/state/thread-store"
import { harnessLabel } from "@/lib/harness-label"
import type { ThreadRef } from "@/lib/types"
import type { HarnessFeatureKey } from "@mako/host/contracts/harness-features"
import { HARNESS_FEATURES } from "@mako/host/contracts/harness-features"
import { featureFloor, featureFloorText } from "@/lib/runtime-versions"
import { ACTION_TOAST_MS } from "@/lib/toast-duration"
import { providers, providerStore } from "@/state/providers"

/** Where the composer would send a message, which is where its `/goal` and `/review` go. */
export type CommandRoute =
  | { kind: "conversation"; key: string }
  | { kind: "thread"; ref: ThreadRef }
  | { kind: "tab"; draft: SessionDraft; harness: string }
  | { kind: "new"; harness: string; cwd: string }
  | { kind: "elsewhere"; reason: string; update?: string }

/** How a refusal names the command: what it does to a conversation, what it starts one with, and what picking another agent is for. */
export interface CommandWords {
  act: string
  start: string
  pick: string
  /** The shared feature the command drives, which an older CLI may lack. */
  feature?: HarnessFeatureKey
}

const GOAL_WORDS: CommandWords = { act: "set its goal", start: "a goal", pick: "set one", feature: "goals" }

/** The composer's routing for a message, read for one of Mako's commands: the conversation it continues, or the one it starts. */
export function commandRoute(cwd: string | undefined, words: CommandWords): CommandRoute {
  const conversation = activeAcp(acpStore.get())
  const live = activeLiveAcp(acpStore.get())
  const viewing = threadsStore.get().viewing?.ref
  const harness = threadsStore.get().composerHarness
  // The harness's own form of the feature arrived in a later release than
  // the one installed: say which, with the update, rather than let it fail.
  const floor = words.feature && featureFloor(providerStore.get().runtimeUpdates, harness, words.feature)
  if (words.feature && floor) {
    const reason = featureFloorText(harnessLabel(harness), HARNESS_FEATURES[words.feature].name, floor)
    return floor.update ? { kind: "elsewhere", reason, update: floor.id } : { kind: "elsewhere", reason: `${reason} ${floor.owner}` }
  }
  if (viewing && (!live || viewing.path !== conversation?.threadPath)) {
    if (harness !== viewing.harness)
      return { kind: "elsewhere", reason: `Send a message to move this conversation to ${harnessLabel(harness)} first, then ${words.act}.` }
    return viewing.copyOnly || viewing.resumeUnavailable
      ? { kind: "elsewhere", reason: `Send a message to reopen this conversation first, then ${words.act}.` }
      : { kind: "thread", ref: viewing }
  }
  if (conversation) {
    return harness === conversation.harness
      ? { kind: "conversation", key: conversation.key }
      : { kind: "elsewhere", reason: `This conversation runs in ${harnessLabel(conversation.harness)}. Pick ${harnessLabel(conversation.harness)} again to ${words.act}, or send a message to move it to ${harnessLabel(harness)} first.` }
  }
  const draft = openSessionDraft(threadGroupsStore.get())
  if (draft) return { kind: "tab", draft, harness }
  return descriptorFor(threadsStore.get(), harness)?.live
    ? { kind: "new", harness, cwd: cwd ?? "" }
    : { kind: "elsewhere", reason: `${harnessLabel(harness)} can't start a conversation with ${words.start}. Pick another agent to ${words.pick}.` }
}

/** Says why a command can't go where the composer would send it, with the update that fixes an older CLI. */
export function refuseCommand(route: Extract<CommandRoute, { kind: "elsewhere" }>): void {
  const update = route.update
  toast.error(route.reason, update
    ? { duration: ACTION_TOAST_MS, action: { label: "Update", onClick: () => void providers.runRuntimeUpdate(update) } }
    : undefined)
}

export function goalRoute(cwd: string | undefined): CommandRoute {
  return commandRoute(cwd, GOAL_WORDS)
}

/** Sends what a `/goal` draft asks where the composer is pointed; false keeps the draft. */
export async function sendGoalLine(line: GoalLine, route: CommandRoute): Promise<boolean> {
  if (line.kind === "empty") {
    toast.info("Write the goal after /goal, such as “/goal the parser tests pass”. Add --budget 200k to cap the tokens it spends.")
    return false
  }
  if (line.kind === "bad-budget") {
    toast.error(line.written
      ? `“${line.written}” isn't a token count. Write the budget as a number, such as --budget 200k or --budget 1.5m.`
      : "Write the budget after --budget, such as --budget 200k.")
    return false
  }
  if (line.kind === "too-long") {
    toast.error(`A goal can be up to ${GOAL_OBJECTIVE_LIMIT.toLocaleString()} characters. This one is ${line.length.toLocaleString()}; shorten it and try again.`)
    return false
  }
  if (route.kind === "elsewhere") {
    refuseCommand(route)
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
  const goal: StartGoal = { objective: line.objective, tokenBudget: line.tokenBudget }
  switch (route.kind) {
    case "thread":
      return acp.resumeWith(route.ref, { goal })
    case "tab":
      return startInThread(route.draft, route.harness, { goal })
    case "new":
      return acp.startWith(route.harness, route.cwd, { goal })
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
