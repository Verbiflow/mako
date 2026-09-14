import type { HarnessModelCatalog } from "../model-catalog.js"
import {
  modelByIdentity,
  type ModelChoice,
  type ModelOption,
  type ModelVariant,
  type SessionModel,
  type SessionSettings,
  type SettingValue,
} from "../settings.js"

/**
 * Cursor's SDK lists a model as a flat id plus parameter definitions
 * (`reasoning`, `fast`, `context`, …) and a model's variants as parameter
 * sets. This is the SDK's `ModelListItem` reduced to the fields Mako reads;
 * it is declared here so the pure catalog never imports the SDK.
 */
export interface CursorSdkModelParameter {
  id: string
  displayName?: string
  values: readonly { value: string; displayName?: string }[]
}

export interface CursorSdkModelVariant {
  params: readonly { id: string; value: string }[]
  displayName: string
  description?: string
  isDefault?: boolean
}

export interface CursorSdkModelListItem {
  id: string
  displayName: string
  description?: string
  aliases?: readonly string[]
  parameters?: readonly CursorSdkModelParameter[]
  variants?: readonly CursorSdkModelVariant[]
}

export interface CursorSdkModelSelection {
  id: string
  params?: { id: string; value: string }[]
}

/**
 * The SDK's parameter ids and Mako's option ids differ for the two roles the
 * composer treats specially. Cursor's ACP transport already normalizes its
 * `reasoning` option to `effort` and its boolean `fast` option to `fast`;
 * the SDK keeps the same wire ids, so a thread that saved `effort: high`
 * under ACP resolves to the same choice when it continues through the SDK.
 */
const OPTION_IDS = new Map<string, { id: string; role?: "reasoning" | "speed" }>([
  ["reasoning", { id: "effort", role: "reasoning" }],
  ["fast", { id: "fast", role: "speed" }],
])

function optionFor(parameter: CursorSdkModelParameter): ModelOption | undefined {
  const mapped = OPTION_IDS.get(parameter.id) ?? { id: parameter.id }
  const values: ModelChoice[] = []
  for (const entry of parameter.values) {
    if (!entry.value) continue
    values.push({ value: entry.value, label: entry.displayName ?? entry.value })
  }
  if (values.length === 0) return undefined
  const label = parameter.displayName ?? labelFor(parameter.id)
  const wireValues = new Set(values.map((value) => value.value))
  if (wireValues.size === 2 && wireValues.has("true") && wireValues.has("false")) {
    return {
      kind: "select",
      id: mapped.id,
      wireId: parameter.id,
      label,
      role: mapped.role,
      values,
      presentation: "toggle",
      booleanValues: { on: "true", off: "false" },
    }
  }
  return {
    kind: "select",
    id: mapped.id,
    wireId: parameter.id,
    label,
    role: mapped.role,
    values,
  }
}

function labelFor(parameterId: string): string {
  switch (parameterId) {
    case "reasoning":
      return "Reasoning"
    case "fast":
      return "Fast"
    case "context":
      return "Context"
    default:
      return parameterId.charAt(0).toUpperCase() + parameterId.slice(1)
  }
}

function variantFor(
  item: CursorSdkModelListItem,
  variant: CursorSdkModelVariant,
  options: readonly ModelOption[]
): ModelVariant | undefined {
  const entries: [string, SettingValue][] = []
  for (const param of variant.params) {
    const option = options.find((candidate) => candidate.wireId === param.id)
    if (!option) continue
    entries.push([option.id, param.value])
  }
  if (entries.length === 0) return undefined
  const values = Object.fromEntries(entries)
  const suffix = variant.params.map((param) => `${param.id}=${param.value}`).join(",")
  const result: ModelVariant = {
    id: `${item.id}[${suffix}]`,
    label: variant.displayName,
    values,
  }
  if (variant.description) result.description = variant.description
  return result
}

/** Cursor's SDK model list as Mako's catalog, defaults applied from the variants. */
export function normalizeCursorSdkModels(
  list: readonly CursorSdkModelListItem[],
  configuredModel?: string
): HarnessModelCatalog {
  const byId = new Map<string, SessionModel>()
  let defaultModel: string | undefined
  for (const item of list) {
    if (!item.id || byId.has(item.id)) continue
    const options: ModelOption[] = []
    for (const parameter of item.parameters ?? []) {
      const option = optionFor(parameter)
      if (option) options.push(option)
    }
    const variants: ModelVariant[] = []
    for (const variant of item.variants ?? []) {
      const mapped = variantFor(item, variant, options)
      if (!mapped) continue
      variants.push(mapped)
      if (variant.isDefault) {
        for (const option of options) {
          const value = mapped.values[option.id]
          if (option.kind === "select" && value !== undefined && value !== true && value !== false)
            option.current = value
        }
        defaultModel ??= item.id
      }
    }
    const model: SessionModel = {
      id: item.id,
      label: item.displayName || item.id,
      options,
    }
    if (item.description) model.description = item.description
    if (item.aliases?.length) model.aliases = [...item.aliases]
    if (variants.length > 0) model.variants = variants
    byId.set(item.id, model)
  }
  const models = [...byId.values()]
  const catalog: HarnessModelCatalog = { models }
  if (defaultModel) catalog.defaultModel = defaultModel
  const configured = modelByIdentity(models, configuredModel)?.id
  if (configured) catalog.configuredModel = configured
  // A new thread has no session to read a model from, so the catalog's own
  // settings are what the composer shows and sends: the configured model when
  // one is known, otherwise the list's first model with a default variant
  // (Cursor's Auto), with that variant's option values.
  const chosen = configured ?? defaultModel
  if (chosen) {
    catalog.settings = {
      model: chosen,
      options: Object.fromEntries(
        (byId.get(chosen)?.options ?? []).flatMap((option) =>
          option.current === undefined ? [] : [[option.id, option.current]]
        )
      ),
    }
  }
  return catalog
}

export interface CursorSdkSelectionResult {
  selection: CursorSdkModelSelection
  /** Option ids the settings named that this model does not offer. */
  dropped: string[]
}

/**
 * Turns Mako's settings into the SDK's `ModelSelection`. A variant id
 * (`model[reasoning=high]`) expands to its parameter set; option values are
 * translated back to the SDK's wire ids; a boolean answers a toggle with the
 * string the SDK lists. Options the model does not define are reported so
 * the caller can tell the user what a continuation left behind.
 */
export function cursorSdkSelection(
  settings: SessionSettings,
  models: readonly SessionModel[]
): CursorSdkSelectionResult | undefined {
  const model = modelByIdentity(models, settings.model)
  if (!model) return undefined
  const params = new Map<string, string>()
  const variant = model.variants?.find((candidate) => candidate.id === settings.model)
  const values = { ...variant?.values, ...settings.options }
  const dropped: string[] = []
  for (const [id, value] of Object.entries(values)) {
    const option = model.options.find((candidate) => candidate.id === id)
    if (!option) {
      dropped.push(id)
      continue
    }
    const wire = option.wireId ?? option.id
    if (value === true || value === false) {
      const on = option.kind === "select" ? option.booleanValues?.on ?? "true" : "true"
      const off = option.kind === "select" ? option.booleanValues?.off ?? "false" : "false"
      params.set(wire, value ? on : off)
      continue
    }
    if (option.kind === "select" && !option.values.some((choice) => choice.value === value)) {
      dropped.push(id)
      continue
    }
    params.set(wire, value)
  }
  const selection: CursorSdkModelSelection = { id: model.id }
  if (params.size > 0)
    selection.params = [...params].map(([id, value]) => ({ id, value }))
  return { selection, dropped }
}

/** The settings a run reported, expressed in Mako's option ids. */
export function cursorSdkReportedSettings(
  selection: CursorSdkModelSelection,
  models: readonly SessionModel[]
): SessionSettings {
  const model = modelByIdentity(models, selection.id)
  const options: Record<string, SettingValue> = {}
  for (const param of selection.params ?? []) {
    const option = model?.options.find((candidate) => (candidate.wireId ?? candidate.id) === param.id)
    const mapped = OPTION_IDS.get(param.id)
    const id = option?.id ?? mapped?.id ?? param.id
    options[id] = param.value
  }
  const settings: SessionSettings = { model: model?.id ?? selection.id }
  if (Object.keys(options).length > 0) settings.options = options
  return settings
}
