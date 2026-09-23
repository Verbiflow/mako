import { z } from "zod"

export const SettingValueSchema = z.union([z.string(), z.boolean()])
export type SettingValue = z.infer<typeof SettingValueSchema>

/** Only requested/observed values. Absence means inherit, never false or medium. */
export const SessionSettingsSchema = z.object({
  model: z.string().min(1).optional(),
  options: z.record(z.string(), SettingValueSchema).optional(),
})
export type SessionSettings = z.infer<typeof SessionSettingsSchema>

export const ModelChoiceSchema = z.object({
  value: z.string(),
  label: z.string(),
  description: z.string().optional(),
  default: z.boolean().optional(),
  aliases: z.array(z.string()).optional(),
})
export type ModelChoice = z.infer<typeof ModelChoiceSchema>

const optionFields = {
  id: z.string(),
  wireId: z.string().optional(),
  label: z.string(),
  /** Provider-assigned semantics; consumers must not infer them from labels. */
  role: z.enum(["reasoning", "speed", "context"]).optional(),
  /** A provider may expose a setting that cannot be changed in this transport. */
  disabledReason: z.string().optional(),
  change: z.literal("launch").optional(),
}
export const ModelOptionSchema = z.discriminatedUnion("kind", [
  z.object({
    ...optionFields,
    kind: z.literal("select"),
    current: z.string().optional(),
    values: z.array(ModelChoiceSchema),
    presentation: z.enum(["select", "toggle"]).optional(),
    booleanValues: z.object({ on: z.string(), off: z.string() }).optional(),
  }),
  z.object({
    ...optionFields,
    kind: z.literal("boolean"),
    current: z.boolean().optional(),
  }),
])
export type ModelOption = z.infer<typeof ModelOptionSchema>

export const ModelVariantSchema = z.object({
  id: z.string(),
  label: z.string(),
  values: z.record(z.string(), SettingValueSchema),
  contextWindow: z.number().optional(),
  maxOutputTokens: z.number().optional(),
  description: z.string().optional(),
})
export type ModelVariant = z.infer<typeof ModelVariantSchema>

export const SessionModelSchema = z.object({
  id: z.string(),
  launchId: z.string().optional(),
  label: z.string(),
  description: z.string().optional(),
  aliases: z.array(z.string()).optional(),
  contextWindow: z.number().optional(),
  maxOutputTokens: z.number().optional(),
  options: z.array(ModelOptionSchema),
  variants: z.array(ModelVariantSchema).optional(),
})
export type SessionModel = z.infer<typeof SessionModelSchema>

export type SettingSource =
  "override" | "saved" | "legacy" | "session" | "provider" | "model-default"
export type ResolvedSetting<T extends SettingValue = SettingValue> =
  { kind: "known"; value: T; source: SettingSource } | { kind: "unknown" }

export const SettingsPreferenceSchema = z.object({
  source: z.enum(["saved", "legacy"]),
  settings: SessionSettingsSchema,
})
export type SettingsPreference = z.infer<typeof SettingsPreferenceSchema>

export interface SettingsIssue {
  option: string
  message: string
}

export interface ResolvedSessionSettings {
  model: ResolvedSetting<string>
  options: Record<string, ResolvedSetting>
  /** The exact known selection that the transport receives. */
  settings: SessionSettings
  issues: SettingsIssue[]
}

export function modelByIdentity(
  models: readonly SessionModel[],
  identity: string | undefined
): SessionModel | undefined {
  if (!identity) return undefined
  return models.find(
    (model) =>
      model.id === identity ||
      model.launchId === identity ||
      model.aliases?.includes(identity) ||
      model.variants?.some((variant) => variant.id === identity)
  )
}

export function optionDefault(option: ModelOption): SettingValue | undefined {
  return (
    option.current ??
    (option.kind === "select"
      ? option.values.find((value) => value.default)?.value
      : undefined)
  )
}

export function optionAccepts(
  option: ModelOption,
  value: SettingValue
): boolean {
  return option.kind === "boolean"
    ? value === true || value === false
    : option.values.some((choice) => choice.value === value)
}

/** Variant identity carries its option values even if the family is displayed. */
export function settingsWithVariant(
  models: readonly SessionModel[],
  settings: SessionSettings
): SessionSettings {
  const model = modelByIdentity(models, settings.model)
  const variant = model?.variants?.find((entry) => entry.id === settings.model)
  const options = { ...variant?.values, ...settings.options }
  for (const option of model?.options ?? []) {
    // A choice saved under the provider's own name for an option (Cursor's
    // `reasoning_effort`) is the same choice as Mako's id for it.
    if (option.wireId && option.wireId !== option.id && options[option.wireId] !== undefined) {
      options[option.id] ??= options[option.wireId]
      delete options[option.wireId]
    }
    const value = options[option.id]
    if (
      option.kind !== "select" ||
      value === undefined ||
      value === true ||
      value === false
    )
      continue
    const choice = option.values.find(
      (entry) => entry.value === value || entry.aliases?.includes(value)
    )
    if (choice) options[option.id] = choice.value
  }
  return Object.keys(options).length ? { ...settings, options } : settings
}

/** Old preferences had duplicated effort/fast fields. Only migration understands them. */
export function migrateSettingsPreference(
  preference: SettingsPreference | undefined,
  models: readonly SessionModel[]
): SettingsPreference | undefined {
  if (!preference || preference.source !== "legacy") return preference
  const model = modelByIdentity(models, preference.settings.model)
  if (!model) return preference
  const options = { ...preference.settings.options }
  for (const option of model.options) {
    if (
      option.role === "reasoning" &&
      option.id !== "effort" &&
      options.effort !== undefined
    ) {
      options[option.id] ??= options.effort
      delete options.effort
    }
    if (
      option.role === "speed" &&
      option.kind === "select" &&
      option.booleanValues
    ) {
      const fast = options.fast
      if (fast === true || fast === false) {
        options[option.id] ??= fast
          ? option.booleanValues.on
          : option.booleanValues.off
        delete options.fast
      }
    }
  }
  return { source: "legacy", settings: { ...preference.settings, options } }
}

export {
  resolveSessionSettings,
  resolveModelLaunch,
} from "./settings-resolution.js"
