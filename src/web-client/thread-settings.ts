import { accessTierInfo } from "@mako/host/contracts/access"
import type { LiveSessionMode } from "@mako/host/contracts/providers-acp"
import type { ModelOption, ResolvedSessionSettings, SessionModel, SettingValue } from "@mako/sessions/settings"
import { optionLabel, settingValueLabel } from "@/components/composer/settings-source"

/**
 * What a Thread's settings chip and sheet read, from the desk composer's own settings (`useComposerSettings`): the
 * harness's models, the one the next message runs on, its options and what each resolves to. Nothing here is the
 * phone's own; the chip and the sheet only say it.
 */
export interface SettingsReading {
  /** Every model the harness offers, to tell a model without effort from a harness without it. */
  models: readonly SessionModel[]
  model: SessionModel | undefined
  modelLabel: string
  options: readonly ModelOption[]
  resolved: ResolvedSessionSettings
}

/** A mode's word: its tier's, "Read-only" for plan, else the harness's own name for it. */
export function modeLabel(mode: LiveSessionMode): string {
  return mode.access ? (mode.access === "plan" ? "Read-only" : accessTierInfo(mode.access).label) : mode.name
}

/** What a mode lets the agent do, in a sentence: its tier's, else the harness's own description. */
export function modeSummary(mode: LiveSessionMode): string | undefined {
  return mode.access ? accessTierInfo(mode.access).summary : mode.description
}

/** Whether a mode lets the agent act with nothing waiting for the person: the one the chip warns about. */
export function riskyMode(mode: LiveSessionMode | undefined): boolean {
  return mode?.access === "full"
}

export interface EffortChoice {
  value: SettingValue
  label: string
}

/**
 * The sheet's effort control for the model the next message runs on, generically from the harness's catalog:
 * - `none`: no model of this harness has an effort setting, so nothing is drawn.
 * - `absent`: other models have one and this one doesn't; said in its place, so the sheet doesn't jump under a finger
 *   moving between models.
 * - `fixed`: this model has one that can't be chosen here (a running session that doesn't report it, or one level).
 * - `choose`: the levels this model offers, least to most, and the one in effect.
 */
export type EffortControl =
  | { kind: "none" }
  | { kind: "absent"; model: string }
  | { kind: "fixed"; label: string | undefined; reason: string | undefined }
  | { kind: "choose"; option: ModelOption; choices: readonly EffortChoice[]; current: SettingValue | undefined }

export function effortControl(reading: SettingsReading): EffortControl {
  const option = reading.options.find((each) => each.role === "reasoning")
  if (!option) {
    const offered = reading.models.some((model) => model.options.some((each) => each.role === "reasoning"))
    return offered && reading.model ? { kind: "absent", model: reading.model.label } : { kind: "none" }
  }
  const current = effortValue(reading, option)
  const choices: EffortChoice[] = option.kind === "boolean" ? [false, true].map((value) => ({ value, label: settingValueLabel(option, value) })) : option.values.map((each) => ({ value: each.value, label: each.label }))
  if (option.disabledReason || choices.length < 2) return { kind: "fixed", label: current === undefined ? undefined : settingValueLabel(option, current), reason: option.disabledReason }
  return { kind: "choose", option, choices, current }
}

function effortValue(reading: SettingsReading, option: ModelOption): SettingValue | undefined {
  const resolved = reading.resolved.options[option.id]
  return resolved?.kind === "known" ? resolved.value : undefined
}

/** The chip's reading: the model, its effort as a soft suffix, and whether the access is the risky one. */
export interface ChipReading {
  model: string
  effort: string | undefined
  risky: boolean
  /** All of it in words, for a screen reader. */
  spoken: string
}

export function chipReading(reading: SettingsReading, mode: LiveSessionMode | undefined): ChipReading {
  const option = reading.options.find((each) => each.role === "reasoning")
  const value = option ? effortValue(reading, option) : undefined
  const effort = option && value !== undefined ? settingValueLabel(option, value) : undefined
  const risky = riskyMode(mode)
  const spoken = [reading.modelLabel, option && value !== undefined && optionLabel(option, { kind: "known", value, source: "override" }), mode && modeLabel(mode)].filter(Boolean).join(", ")
  return { model: reading.modelLabel, effort, risky, spoken: `Model and access: ${spoken}` }
}
