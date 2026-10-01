import type { ProposedPlan } from "@mako/sessions/content"
import type { ModelOption, SessionSettings } from "@mako/sessions/settings"
import type { ComposerSettingsView } from "@/components/composer/use-composer-settings"
import { getMako, hasBridge } from "@/lib/bridge"
import { harnessLabel } from "@/lib/harness-label"
import { appendPlanContext, proposedPlanReply } from "@/lib/proposed-plan"
import type { AcpBlock } from "@/lib/acp-blocks"
import type { LivePermissionRequest, LiveSessionMode, ThreadRef } from "@/lib/types"
import { acp, useAcp } from "@/state/acp"
import { acpForThread, acpStore, type AcpConversation, type AcpState } from "@/state/acp-state"
import {
  chooseComposerOption,
  composerSettingsInput,
  currentSettingsTarget,
  liveSettingsTarget,
  settingsConversation,
  settingsTargetKey,
  threadSettingsTarget,
  type ComposerTarget,
} from "@/state/composer-settings"
import { draftText, rememberDraft, rememberDraftPlan } from "@/state/drafts"
import { answerLiveApproval } from "@/state/live-approvals"
import {
  planChoiceStore,
  rememberReturnMode,
  returnMode,
  setPendingPlan,
  usePlanChoice,
  type NativePlan,
} from "@/state/plan-choice"
import { recordPlanBuild, type PlanBuildTarget } from "@/state/plan-builds"
import { prefsStore, usePrefs } from "@/state/prefs"
import {
  chooseThreadMode,
  providerAccessModes,
  providerDefaultMode,
  savedProviderMode,
  threadAccessMode,
} from "@/state/provider-access"
import { openSessionDraft, sessionDraftKey, threadGroupsStore } from "@/state/thread-groups"
import { newSessionInThread } from "@/state/thread-sessions"
import type { ThreadsState, ViewedThreadEntry } from "@/state/thread-state"
import { threadsStore, useThreads } from "@/state/thread-store"
import { threads } from "@/state/threads"

/**
 * Plan mode: the agent investigates and writes a plan before it changes
 * anything, and the plan arrives as a Markdown document to build from. Mako
 * shows one control over two native shapes:
 *
 * - `setting`: the harness plans independently of access (Codex's
 *   collaboration mode), a per-session setting sent with each turn. Planning
 *   with full access stays full access.
 * - `mode`: planning is one of the harness's access modes (Claude's `plan`
 *   permission mode, OpenCode's plan agent, Devin's and Grok's plan modes).
 *   Entering it replaces the access level; leaving returns to the level the
 *   session had.
 *
 * A harness with neither has no plan mode in Mako; Cursor runs as Agent and
 * still proposes plans with its own plan tool.
 */
export type PlanControl =
  | { kind: "none" }
  | { kind: "setting"; option: string; active: boolean; locked?: string }
  | { kind: "mode"; mode: LiveSessionMode; active: boolean; locked?: string }

/** Where the session the composer answers is: running, starting, resumed from a thread, or not started. */
export type PlanPhase = "live" | "starting" | "thread" | "new"

export interface PlanInputs {
  phase: PlanPhase
  options: readonly ModelOption[]
  settings: SessionSettings
  modes: readonly LiveSessionMode[]
  currentMode: string | null
  /** For a session not started, the plan chosen for it; for a starting one, the plan it launched with. */
  chosen?: NativePlan
}

export function planControl(input: PlanInputs): PlanControl {
  const option = input.options.find((entry) => entry.role === "plan" && entry.kind === "boolean")
  const notStarted = input.phase === "new" || input.phase === "starting"
  const starting = input.phase === "starting" ? "Plan mode can change once the session has started." : undefined
  if (option)
    return {
      kind: "setting",
      option: option.id,
      active: notStarted ? input.chosen !== undefined : input.settings.options?.[option.id] === true,
      locked: starting ?? option.disabledReason,
    }
  const mode = input.modes.find((entry) => entry.access === "plan")
  if (!mode) return { kind: "none" }
  return {
    kind: "mode",
    mode,
    active: notStarted ? input.chosen !== undefined : input.currentMode === mode.id,
    locked:
      starting ??
      (input.phase === "live" && mode.enforcement === "launch" ? "Plan mode is set when a session starts." : undefined),
  }
}

export function nativePlan(control: Exclude<PlanControl, { kind: "none" }>): NativePlan {
  return control.kind === "setting" ? { kind: "setting", option: control.option } : { kind: "mode", mode: control.mode.id }
}

/**
 * The access mode a mode-backed plan returns to: the one the session left,
 * else the harness's saved or default level, else its first level that is
 * not planning.
 */
export function leavePlanMode(input: {
  modes: readonly LiveSessionMode[]
  plan: string
  remembered?: string
  saved: string | null
  defaulted: string | null
}): string | undefined {
  const usable = (id: string | null | undefined) =>
    id && id !== input.plan && input.modes.some((mode) => mode.id === id) ? id : undefined
  return (
    usable(input.remembered) ??
    usable(input.saved) ??
    usable(input.defaulted) ??
    input.modes.find((mode) => mode.access !== "plan")?.id
  )
}

/** Everything a plan toggle needs about one composer target. */
export interface PlanContext extends PlanInputs {
  target: ComposerTarget
  /** The live or starting conversation answering the target. */
  conversation?: string
  saved: string | null
  defaulted: string | null
  control: PlanControl
}

interface PlanSources {
  target: ComposerTarget
  options: readonly ModelOption[]
  settings: SessionSettings
  conversation?: { key: string; starting: boolean; modes?: readonly LiveSessionMode[]; currentMode?: string | null }
  providerModes: readonly LiveSessionMode[]
  threadMode: string | null
  saved: string | null
  defaulted: string | null
  pending?: NativePlan
  launched?: NativePlan
}

function planContext(sources: PlanSources): PlanContext {
  const { target, conversation } = sources
  const phase: PlanPhase = conversation
    ? conversation.starting ? "starting" : "live"
    : target.kind === "thread" ? "thread" : "new"
  const live = phase === "live"
  const inputs: PlanInputs = {
    phase,
    options: sources.options,
    settings: sources.settings,
    modes: live ? (conversation?.modes ?? []) : sources.providerModes,
    currentMode: live
      ? (conversation?.currentMode ?? null)
      : phase === "thread" ? (sources.threadMode ?? sources.saved ?? sources.defaulted) : (sources.saved ?? sources.defaulted),
    chosen: phase === "new" ? sources.pending : phase === "starting" ? sources.launched : undefined,
  }
  return { ...inputs, target, conversation: conversation?.key, saved: sources.saved, defaulted: sources.defaulted, control: planControl(inputs) }
}

function conversationSource(conversation: AcpConversation | null | undefined, harness: string): PlanSources["conversation"] {
  if (!conversation || liveSettingsTarget(conversation).harness !== harness) return undefined
  return conversation.kind === "live"
    ? { key: conversation.key, starting: false, modes: conversation.session.modes, currentMode: conversation.session.currentMode }
    : { key: conversation.key, starting: true }
}

function threadRef(state: ThreadsState, path: string): ThreadRef | undefined {
  return [state.opening?.ref, state.viewing?.ref].find((ref) => ref?.path === path) ??
    state.threads.find((ref) => ref.path === path)
}

/** The plan context of `target` now, outside React. */
export function planContextFor(target: ComposerTarget, conversation = settingsConversation(target)): PlanContext {
  const state = threadsStore.get()
  const { options, resolved } = composerSettingsInput(target)
  const providerModes = providerAccessModes(state, target.harness)
  const choices = planChoiceStore.get()
  const live = conversationSource(conversation, target.harness)
  return planContext({
    target,
    options,
    settings: resolved.settings,
    conversation: live,
    providerModes,
    threadMode: target.kind === "thread" ? threadAccessMode(threadRef(state, target.path), providerModes, target.harness) : null,
    saved: savedProviderMode(prefsStore.get().providerModes, providerModes, target.harness),
    defaulted: providerDefaultMode(state, providerModes, target.harness),
    pending: choices.pending[settingsTargetKey(target)],
    launched: live ? choices.launched[live.key] : undefined,
  })
}

/** The composer's plan context, subscribed to the facts it reads and nothing streaming. */
export function usePlanContext(view: ComposerSettingsView): PlanContext {
  const { target } = view
  const harness = target.harness
  const key = view.conversation
  const kind = useAcp((state) => (key ? state.conversations[key]?.kind : undefined))
  const modes = useAcp((state) => {
    const conversation = key ? state.conversations[key] : undefined
    return conversation?.kind === "live" ? conversation.session.modes : undefined
  })
  const currentMode = useAcp((state) => {
    const conversation = key ? state.conversations[key] : undefined
    return conversation?.kind === "live" ? conversation.session.currentMode : undefined
  })
  const providerModes = useThreads((state) => providerAccessModes(state, harness))
  const threadMode = useThreads((state) =>
    target.kind === "thread" ? threadAccessMode(threadRef(state, target.path), providerModes, harness) : null
  )
  const defaulted = useThreads((state) => providerDefaultMode(state, providerModes, harness))
  const saved = usePrefs((prefs) => savedProviderMode(prefs.providerModes, providerModes, harness))
  const pending = usePlanChoice((state) => state.pending[settingsTargetKey(target)])
  const launched = usePlanChoice((state) => (key ? state.launched[key] : undefined))
  return planContext({
    target,
    options: view.options,
    settings: view.resolved.settings,
    conversation: key && kind ? { key, starting: kind === "starting", modes, currentMode } : undefined,
    providerModes,
    threadMode,
    saved,
    defaulted,
    pending,
    launched,
  })
}

/** Put the session `context` describes into plan mode or take it out. */
export async function setPlanMode(context: PlanContext, on: boolean): Promise<void> {
  const { control, target } = context
  if (control.kind === "none") throw new Error(`${harnessLabel(target.harness)} has no plan mode in Mako.`)
  if (control.active === on) return
  if (control.locked) throw new Error(control.locked)
  if (context.phase === "new") {
    setPendingPlan(target, on ? nativePlan(control) : null)
    return
  }
  if (control.kind === "setting") {
    chooseComposerOption(target, control.option, on)
    return
  }
  const next = on
    ? control.mode.id
    : leavePlanMode({ modes: context.modes, plan: control.mode.id, remembered: returnMode(target), saved: context.saved, defaulted: context.defaulted })
  if (!next) throw new Error(`${harnessLabel(target.harness)} offers no other mode to leave plan mode for.`)
  if (on && context.currentMode && context.currentMode !== control.mode.id) rememberReturnMode(target, context.currentMode)
  if (context.phase === "live" && context.conversation) {
    if (!hasBridge()) return
    await getMako().liveSetMode(context.conversation, next)
    return
  }
  if (target.kind === "thread") chooseThreadMode({ path: target.path, harness: target.harness }, next, false)
}

/** The palette: flip plan mode for the composer's session. Null when its harness has none. */
export async function togglePlanMode(context = planContextFor(currentSettingsTarget())): Promise<boolean | null> {
  if (context.control.kind === "none") return null
  const on = !context.control.active
  await setPlanMode(context, on)
  return on
}

/* ------------------------------------------------------------------ */
/* Building a plan                                                     */
/* ------------------------------------------------------------------ */

/** Where a plan card was rendered: a live conversation or a catalogued thread. */
export interface PlanSource {
  liveId?: string
  threadPath?: string
}

function sourceConversation(state: AcpState, source: PlanSource): AcpConversation | undefined {
  return (source.liveId ? state.conversations[source.liveId] : undefined) ??
    (source.threadPath ? (acpForThread(state, { path: source.threadPath }) ?? undefined) : undefined)
}

function latestInBlocks(blocks: readonly AcpBlock[]): string | undefined {
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index]
    if (block?.type === "proposed-plan") return block.id
  }
  return undefined
}

function latestInEntries(entries: readonly ViewedThreadEntry[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]
    if (entry?.kind !== "assistant") continue
    for (let at = entry.blocks.length - 1; at >= 0; at--) {
      const block = entry.blocks[at]
      if (block?.type === "proposed-plan") return block.id
    }
  }
  return undefined
}

/** The newest plan of the conversation a card belongs to; only it gets the build actions. */
export function useLatestPlan(source: PlanSource): string | undefined {
  const live = useAcp((state) => {
    const conversation = sourceConversation(state, source)
    return conversation ? latestInBlocks(conversation.blocks) : undefined
  })
  const viewed = useThreads((state) =>
    source.threadPath && state.viewing?.ref.path === source.threadPath ? latestInEntries(state.viewing.entries) : undefined
  )
  return live ?? viewed
}

function planApproval(conversation: AcpConversation | undefined, plan: ProposedPlan): LivePermissionRequest | undefined {
  const permission = conversation?.kind === "live" ? conversation.permission : null
  return permission?.implementsPlan?.plan === plan.id &&
    permission.options.some((option) => option.optionId === permission.implementsPlan?.approve)
    ? permission
    : undefined
}

/** The source's pending native approval implements this plan; Build answers it. */
export function usePlanAwaitingApproval(source: PlanSource, plan: ProposedPlan): boolean {
  return useAcp((state) => planApproval(sourceConversation(state, source), plan) !== undefined)
}

function assertBuildable(plan: ProposedPlan): void {
  if (plan.status !== "proposed" || plan.truncated) throw new Error("Wait for the complete plan before building it.")
}

/**
 * Build the plan in the session that wrote it: answer its native plan
 * approval when it is waiting on one, else leave plan mode and send the
 * implementation request with the whole plan attached. The composer's draft
 * is untouched.
 */
export async function buildPlan(source: PlanSource, plan: ProposedPlan): Promise<void> {
  assertBuildable(plan)
  const conversation = sourceConversation(acpStore.get(), source)
  const approval = planApproval(conversation, plan)
  if (conversation && approval?.implementsPlan) {
    await answerLiveApproval(conversation.key, approval.id, { kind: "choice", optionId: approval.implementsPlan.approve })
    return
  }
  if (conversation?.kind === "live" && conversation.permission?.implementsPlan)
    throw new Error("The agent is waiting on its newest plan. Build or answer that one first.")
  const ref = source.threadPath ? threadRef(threadsStore.get(), source.threadPath) : undefined
  const target = conversation ? liveSettingsTarget(conversation) : ref ? threadSettingsTarget(ref) : undefined
  if (!target) throw new Error("Open the plan's conversation before building it.")
  const context = planContextFor(target, conversation)
  if (context.control.kind !== "none") await setPlanMode(context, false)
  const request = appendPlanContext(proposedPlanReply(plan, "implement"), [plan])
  if (conversation) {
    if (acpStore.get().activeKey !== conversation.key) acp.activate(conversation.key, false)
    if (!(await acp.send(request))) throw new Error("The implementation request was not sent.")
    recordPlanBuild(plan, { conversation: conversation.key })
    return
  }
  if (!ref || !(await threads.reply(ref, request, []))) throw new Error("The implementation request was not sent.")
  recordPlanBuild(plan, { thread: ref.path })
}

/**
 * Record the plans a sent message builds: those attached to it whose
 * implementation request the message still carries. A revision request
 * attaches the plan too, and builds nothing.
 */
export function recordSentPlanBuilds(text: string, plans: readonly ProposedPlan[] | undefined, target: PlanBuildTarget): void {
  for (const plan of plans ?? [])
    if (text.includes(proposedPlanReply(plan, "implement"))) recordPlanBuild(plan, target)
}

/**
 * Build the plan in a new session of the same Thread. The planning session
 * is settled first — a turn still running or waiting on its plan approval is
 * stopped — so it cannot carry on beside the build. The new tab opens with
 * the implementation request and the plan attached, not in plan mode, on the
 * same agent; pick another before sending if you like.
 */
export async function buildPlanInNewSession(source: PlanSource, plan: ProposedPlan): Promise<void> {
  assertBuildable(plan)
  const conversation = sourceConversation(acpStore.get(), source)
  if (conversation?.kind === "live" && (conversation.session.status === "running" || conversation.permission)) {
    if (acpStore.get().activeKey !== conversation.key) acp.activate(conversation.key, false)
    await acp.cancel()
  }
  if (!newSessionInThread())
    throw new Error("This conversation isn't in a Thread, so there's no Thread to add a session to.")
  const draft = openSessionDraft(threadGroupsStore.get())
  const key = sessionDraftKey(draft)
  if (!key) throw new Error("The new session's tab did not open.")
  setPendingPlan(currentSettingsTarget(), null)
  rememberDraftPlan(key, plan)
  const request = proposedPlanReply(plan, "implement")
  const current = draftText(key)
  if (!current.includes(request)) rememberDraft(key, current.trim() ? `${current}\n\n${request}` : request)
  window.dispatchEvent(new CustomEvent("mako:focus-composer"))
}
