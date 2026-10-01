import type { SessionSettings } from "@mako/sessions/settings"
import { settingsTargetKey, type ComposerTarget } from "@/state/composer-settings"
import { createHook, createStore } from "@/state/store"

/** How a harness carries plan mode natively; see `planControl`. */
export type NativePlan =
  | { kind: "setting"; option: string }
  | { kind: "mode"; mode: string }

interface PlanChoiceState {
  /** Plan chosen for a session not started yet, by settings target. */
  pending: Record<string, NativePlan>
  /** The plan a starting conversation was launched with, by conversation key. */
  launched: Record<string, NativePlan>
  /** The access mode to go back to when a mode-backed plan ends, by settings target. */
  returns: Record<string, string>
}

export const planChoiceStore = createStore<PlanChoiceState>({ pending: {}, launched: {}, returns: {} })
export const usePlanChoice = createHook(planChoiceStore)

function without<T>(record: Record<string, T>, key: string) {
  const next = { ...record }
  delete next[key]
  return next
}

/**
 * Plan for a new session is the next session's alone: it is consumed by the
 * first send and never becomes the harness's saved default.
 */
export function setPendingPlan(target: ComposerTarget, plan: NativePlan | null): void {
  const key = settingsTargetKey(target)
  planChoiceStore.set((state) => ({
    pending: plan ? { ...state.pending, [key]: plan } : without(state.pending, key),
  }))
}

export function pendingPlan(target: ComposerTarget): NativePlan | undefined {
  return planChoiceStore.get().pending[settingsTargetKey(target)]
}

/** Take the pending plan into the conversation starting with it. */
export function takePendingPlan(target: ComposerTarget, conversation: string): NativePlan | undefined {
  const key = settingsTargetKey(target)
  const plan = planChoiceStore.get().pending[key]
  if (!plan) return undefined
  planChoiceStore.set((state) => ({
    pending: without(state.pending, key),
    launched: { ...state.launched, [conversation]: plan },
  }))
  return plan
}

/** A start that failed gives its plan back to the draft it came from. */
export function restorePendingPlan(target: ComposerTarget, conversation: string): void {
  const plan = planChoiceStore.get().launched[conversation]
  if (!plan) return
  planChoiceStore.set((state) => ({
    pending: { ...state.pending, [settingsTargetKey(target)]: plan },
    launched: without(state.launched, conversation),
  }))
}

/** The part of a start that carries plan mode. */
export interface PlanStart {
  modeId?: string
  launchModeId?: string
  tuning: SessionSettings
}

/**
 * What a start sends for its plan choice: the setting rides the tuning, the
 * mode is the mode, and the level it replaces is the one a launch-only
 * harness starts at, to return to once the plan is approved.
 */
export function withNativePlan(plan: NativePlan | undefined, start: PlanStart): PlanStart {
  if (!plan) return start
  if (plan.kind === "mode") {
    const planned: PlanStart = { ...start, modeId: plan.mode }
    if (start.modeId && start.modeId !== plan.mode) planned.launchModeId = start.modeId
    return planned
  }
  return { ...start, tuning: { ...start.tuning, options: { ...start.tuning.options, [plan.option]: true } } }
}

export function rememberReturnMode(target: ComposerTarget, mode: string): void {
  const key = settingsTargetKey(target)
  planChoiceStore.set((state) => ({ returns: { ...state.returns, [key]: mode } }))
}

export function returnMode(target: ComposerTarget): string | undefined {
  return planChoiceStore.get().returns[settingsTargetKey(target)]
}
