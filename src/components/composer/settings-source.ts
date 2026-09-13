import type {
  ModelOption,
  ResolvedSetting,
  SettingSource,
  SettingValue,
} from "@mako/sessions/settings"

const labels = {
  override: "Selected for the next turn",
  saved: "Your saved choice for new threads",
  legacy:
    "Previously saved in Mako. Use provider defaults to follow your current configuration.",
  session: "Reported by this session",
  provider: "From this provider's workspace configuration",
  "model-default": "Default for the selected model",
} satisfies Record<SettingSource, string>

export function settingValueLabel(
  option: ModelOption,
  value: SettingValue
): string {
  if (option.role === "speed") {
    if (option.kind === "boolean") return value === true ? "Fast" : "Standard"
    if (option.booleanValues?.on === value) return "Fast"
    if (option.booleanValues?.off === value) return "Standard"
  }
  if (option.kind === "boolean") return value === true ? "On" : "Off"
  return (
    option.values.find((entry) => entry.value === value)?.label ?? String(value)
  )
}

/** The value's own words already say "reasoning" for Grok ("High Effort"). */
const REASONING_WORDS = /\b(reasoning|effort|thinking)\b/i

/** The composer's one-line reading of an option: its value with its noun. */
export function optionLabel(
  option: ModelOption,
  current: ResolvedSetting
): string {
  // Unknown means the provider has not said, not that the control is gone:
  // the picker still offers every value.
  if (current.kind === "unknown")
    return `${option.role === "speed" ? "Speed" : option.label} not reported`
  const value = settingValueLabel(option, current.value)
  return option.role === "reasoning" && !REASONING_WORDS.test(value)
    ? `${value} reasoning`
    : value
}

export function settingSourceLabel(setting: ResolvedSetting): string {
  return setting.kind === "known"
    ? labels[setting.source]
    : "The provider has not reported this value"
}
