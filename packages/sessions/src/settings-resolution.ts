import {
  modelByIdentity,
  optionAccepts,
  optionDefault,
  settingsWithVariant,
  type ModelOption,
  type ModelIssue,
  type ResolvedSessionSettings,
  type ResolvedSetting,
  type SessionModel,
  type SessionSettings,
  type SettingSource,
  type SettingValue,
  type SettingsPreference,
} from "./settings.js"

export interface ResolveSessionSettingsInput {
  models: readonly SessionModel[]
  context: "new" | "existing"
  phase?: "launch" | "turn"
  overrides?: SessionSettings
  session?: SessionSettings
  preference?: SettingsPreference
  defaults?: SessionSettings
}

interface Layer {
  source: SettingSource
  settings: SessionSettings
}

/** One precedence rule for rendering and dispatch. Existing sessions never inherit another draft's preferences. */
export function resolveSessionSettings(
  input: ResolveSessionSettingsInput
): ResolvedSessionSettings {
  const layers: Layer[] = []
  if (input.overrides)
    layers.push({ source: "override", settings: input.overrides })
  if (input.context === "existing") {
    if (input.session)
      layers.push({ source: "session", settings: input.session })
    // A store that never records a model (Cursor's) continues with the
    // provider's own default, so that is the honest reading until the
    // session reports; a recorded model keeps its own options unfilled.
    if (!input.session?.model && input.defaults)
      layers.push({ source: "provider", settings: input.defaults })
  } else {
    if (input.preference) layers.push(input.preference)
    if (input.defaults)
      layers.push({ source: "provider", settings: input.defaults })
  }
  const expanded = layers.map((layer) => ({
    ...layer,
    settings: settingsWithVariant(input.models, layer.settings),
  }))
  const modelLayer = expanded.find((layer) => layer.settings.model)
  const identity = modelLayer?.settings.model
  const model = modelByIdentity(input.models, identity)
  const modelState: ResolvedSetting<string> =
    identity && modelLayer
      ? { kind: "known", value: identity, source: modelLayer.source }
      : { kind: "unknown" }
  const result: ResolvedSessionSettings = {
    model: modelState,
    options: {},
    settings: identity ? { model: identity } : {},
    issues: [],
  }
  const refusal = modelLayer && identity ? modelRefusal(input.models, modelLayer.source, identity) : undefined
  if (refusal && modelLayer && identity) {
    const instead = expanded
      .slice(expanded.indexOf(modelLayer) + 1)
      .map((layer) => modelByIdentity(input.models, layer.settings.model))
      .find((candidate) => candidate && !candidate.unavailable)
    const issue: ModelIssue = {
      kind: "model",
      model: identity,
      source: modelLayer.source === "saved" ? "saved" : "override",
      message: refusal,
    }
    if (instead) issue.instead = instead.id
    result.issues.push(issue)
  }
  // Options from a different model must never bleed across a model change.
  const applicable = expanded.filter(
    (layer) =>
      !layer.settings.model ||
      layer.settings.model === identity ||
      (model &&
        modelByIdentity(input.models, layer.settings.model)?.id === model.id)
  )
  const ids = new Set([
    ...(model?.options.map((option) => option.id) ?? []),
    ...applicable.flatMap((layer) => Object.keys(layer.settings.options ?? {})),
  ])
  // A new conversation on the provider's default model starts on that
  // model's reported defaults; an existing one may have been changed
  // outside Mako, so there the provider's model says nothing about options.
  const selectionChanged =
    modelState.kind === "known" &&
    modelState.source !== "session" &&
    (modelState.source !== "provider" || input.context === "new")
  for (const id of ids) {
    const option = model?.options.find((entry) => entry.id === id)
    // A remembered choice the model can't take was made for another catalog
    // (the provider's default moved, or the option went away); it yields to
    // the model's own default instead of leaving a new draft unable to send.
    const selected = applicable.find((layer) => {
      const value = layer.settings.options?.[id]
      if (value === undefined) return false
      if (!model || layer.source !== "saved") return true
      return option !== undefined && !option.disabledReason && optionAccepts(option, value)
    })
    const explicit = selected?.settings.options?.[id]
    // Speed is a choice about the account's throughput, not about one
    // model, so it survives a model switch whenever the new model offers
    // the same tier. Effort does not carry: each model has its own ladder.
    const carried =
      explicit === undefined && option?.role === "speed" && !option.disabledReason
        ? carriedSpeed(option, id, expanded, applicable)
        : undefined
    const fallback =
      option &&
      selectionChanged &&
      !(input.phase === "turn" && option.change === "launch")
        ? optionDefault(option)
        : undefined
    const value = explicit ?? carried?.value ?? fallback
    if (value === undefined) {
      result.options[id] = { kind: "unknown" }
      continue
    }
    const source = selected?.source ?? carried?.source ?? "model-default"
    if (model && !option && source !== "session" && source !== "provider") {
      result.issues.push({
        kind: "option",
        option: id,
        message: `${id} is not supported by ${model.label}.`,
      })
    }
    if (option && !optionAccepts(option, value)) {
      result.issues.push({
        kind: "option",
        option: id,
        message: `${option.label} ${String(value)} is not supported by ${model?.label}.`,
      })
    }
    if (
      option?.disabledReason &&
      source !== "session" &&
      source !== "provider" &&
      source !== "model-default"
    ) {
      result.issues.push({ kind: "option", option: id, message: option.disabledReason })
    }
    if (
      input.phase === "turn" &&
      option?.change === "launch" &&
      source === "override"
    ) {
      result.issues.push({
        kind: "option",
        option: id,
        message: `${option.label} can only be set when this provider starts a session.`,
      })
    }
    result.options[id] = { kind: "known", value, source }
    result.settings.options ??= {}
    result.settings.options[id] = value
  }
  return result
}

/**
 * Why a model chosen here or in Settings can't start. A session's own model
 * and the harness's default are what the harness reported, so they stand;
 * an empty catalog hasn't been read yet, so it says nothing.
 */
function modelRefusal(models: readonly SessionModel[], source: SettingSource, identity: string): string | undefined {
  if (source !== "override" && source !== "saved") return undefined
  if (!models.length) return undefined
  const model = modelByIdentity(models, identity)
  if (!model) return `${identity} isn't offered anymore. Choose another model.`
  return model.unavailable ? `${model.label} can't start. ${model.unavailable}` : undefined
}

function carriedSpeed(
  option: ModelOption,
  id: string,
  layers: readonly Layer[],
  applicable: readonly Layer[]
): { value: SettingValue; source: SettingSource } | undefined {
  for (const layer of layers) {
    if (applicable.includes(layer)) continue
    const value = layer.settings.options?.[id]
    if (value !== undefined && optionAccepts(option, value))
      return { value, source: layer.source }
  }
  return undefined
}

/** Resolve encoded model variants without silently substituting another choice. */
export function resolveModelLaunch(
  models: readonly SessionModel[],
  settings: SessionSettings
): SessionSettings {
  const model = modelByIdentity(models, settings.model)
  if (!model) return settings
  const selected = settingsWithVariant(models, settings)
  for (const option of model.options) {
    const value = selected.options?.[option.id]
    if (value !== undefined && !optionAccepts(option, value)) {
      throw new Error(
        `${option.label} ${String(value)} is not supported by ${model.label}.`
      )
    }
  }
  if (!model.variants?.length)
    return {
      ...selected,
      model:
        settings.model && model.aliases?.includes(settings.model)
          ? settings.model
          : (model.launchId ?? model.id),
    }
  const values = { ...selected.options }
  for (const option of model.options) {
    const value = optionDefault(option)
    if (values[option.id] === undefined && value !== undefined)
      values[option.id] = value
  }
  // Variants encode model parameters, while options can also carry session
  // controls (Cursor's plan mode). Those controls survive beside the model
  // id; they cannot constrain which model variant is selected.
  const encodedIds = new Set(
    model.variants.flatMap((candidate) => Object.keys(candidate.values))
  )
  const variant = model.variants.find((candidate) =>
    [...encodedIds].every(
      (id) => values[id] === undefined || candidate.values[id] === values[id]
    )
  )
  if (!variant)
    throw new Error(
      `The selected options are not available together for ${model.label}.`
    )
  // The variant id already says everything it carries. Sending those values
  // again as options asks a transport for a control it does not expose:
  // Devin's ACP session has no effort option, only model ids like
  // `swe-1-7-medium`, and re-applying `effort` there killed the session.
  const remaining: SessionSettings["options"] = {}
  for (const [id, value] of Object.entries(values)) {
    if (value !== undefined && !(id in variant.values)) remaining[id] = value
  }
  return Object.keys(remaining).length
    ? { model: variant.id, options: remaining }
    : { model: variant.id }
}
