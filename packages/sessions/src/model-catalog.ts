export { cursorModelSettings } from "./providers/cursor-settings.js"
import {
  modelByIdentity,
  type SessionSettings,
  type SessionModel as HarnessModel,
  type ModelOption as HarnessModelOption,
  type ModelVariant as HarnessModelVariant,
  type ModelChoice as HarnessSelectValue,
} from "./settings.js"

const REASONING_ORDER = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]

export interface ClaudeModelRow {
  value?: string
  resolvedModel?: string
  displayName?: string
  description?: string
  supportsEffort?: boolean
  supportedEffortLevels?: string[]
  supportsFastMode?: boolean
}

export interface CodexReasoningEffort {
  reasoningEffort?: string
}

export interface CodexServiceTier {
  id?: string
  name?: string
  description?: string
}

export interface CodexModelRow {
  model?: string
  displayName?: string
  description?: string
  isDefault?: boolean
  defaultReasoningEffort?: string
  supportedReasoningEfforts?: CodexReasoningEffort[]
  defaultServiceTier?: string
  serviceTiers?: CodexServiceTier[]
  additionalSpeedTiers?: string[]
}

export interface CodexModelListResponse {
  data?: CodexModelRow[]
}

export interface AcpOptionValueInput {
  value?: string
  name?: string
  description?: string | null
}

export interface AcpOptionGroupInput {
  group?: string
  name?: string
  options: AcpOptionValueInput[]
}

export type AcpOptionEntryInput = AcpOptionValueInput | AcpOptionGroupInput

export interface AcpOptionGroups {
  [group: string]: AcpOptionEntryInput[]
}

export interface AcpConfigOptionInput {
  id?: string
  name?: string
  category?: string | null
  type?: string
  currentValue?: string | boolean
  options?: AcpOptionEntryInput[] | AcpOptionGroups
}

export interface CursorModelRow {
  value?: string
  name?: string
  configOptions?: AcpConfigOptionInput[]
}

export interface CursorModelListResponse {
  models?: CursorModelRow[]
}

export interface CursorConfig {
  model?: { modelId?: string }
}

export interface GrokReasoningEffort {
  value?: string
  label?: string
  description?: string
  default?: boolean
}

export interface GrokModelInfo {
  name?: string
  description?: string | null
  context_window?: number | null
  max_completion_tokens?: number | null
  reasoning_effort?: string
  reasoning_efforts?: GrokReasoningEffort[]
}

export interface GrokCachedModel {
  info?: GrokModelInfo
}

export interface GrokModelMap {
  [id: string]: GrokCachedModel
}

export interface GrokModelCache {
  models?: GrokModelMap
}

export interface OpenCodeModelRow {
  id?: string
  providerID?: string
  name?: string
  family?: string
  status?: string
  variants?: Record<string, { reasoningEffort?: string }>
  defaultVariant?: string
  limit?: {
    context?: number
    output?: number
  }
  capabilities?: {
    reasoning?: boolean
    input?: {
      text?: boolean
      image?: boolean
    }
  }
}

export interface DevinVariantRow {
  model_uid?: string
  label?: string
  description?: string | null
  max_context_tokens?: number
  max_output_tokens?: number
  is_default?: boolean
}

export interface DevinFamilyRow {
  family_label?: string
  slug?: string
  aliases?: string[]
  variants?: DevinVariantRow[]
  is_default?: boolean
}

export interface DevinModelListResponse {
  families?: DevinFamilyRow[]
  default_model?: string
  defaultModel?: string
}

export type HarnessTuning = SessionSettings

export interface HarnessModelCatalog {
  models: HarnessModel[]
  defaultModel?: string
  configuredModel?: string
  settings?: SessionSettings
  configurationError?: string
}

export function harnessModelByIdentity(
  models: HarnessModel[],
  identity: string | undefined
): HarnessModel | undefined {
  return modelByIdentity(models, identity)
}

/**
 * Claude Code's picker names some rows by family alone: "Fable" for
 * `claude-fable-5-1`, while Fable 5 is a different model with different
 * prices. Every other harness writes the version. The resolved id always
 * knows it, so the label says it: "Fable 5.1", "Opus 5 (1M context)".
 */
export function claudeVersionedLabel(
  id: string,
  displayName: string | undefined
): string {
  if (!displayName) return id
  const match = /^claude-([a-z]+)-(\d+)(?:[.-](\d{1,2}))?(?=$|\[|-20\d{6})/.exec(id)
  if (!match) return displayName
  const [, family, major, minor] = match
  const version = minor ? `${major}.${minor}` : major
  // The family word, unless a version already follows it ("Sonnet 4.6").
  const unversioned = new RegExp(`\\b${family}\\b(?!\\s*\\d)`, "i")
  return displayName.replace(unversioned, (name) => `${name} ${version}`)
}

export function normalizeClaudeModels(
  response: ClaudeModelRow[]
): HarnessModelCatalog {
  const defaultResolved = response.find(
    (row) => row.value === "default"
  )?.resolvedModel
  const byId = new Map<string, HarnessModel>()
  for (const row of response) {
    const launchId = presentString(row.value)
    if (!launchId || launchId === "default") continue
    const id = presentString(row.resolvedModel) ?? launchId
    if (byId.has(id)) continue
    const options: HarnessModelOption[] = []
    const efforts = row.supportedEffortLevels?.filter(Boolean) ?? []
    if (row.supportsEffort && efforts.length > 0) {
      options.push(selectOption("effort", "Reasoning", efforts))
    }
    const speed: HarnessModelOption = {
      kind: "boolean",
      id: "fast",
      label: "Fast mode",
      role: "speed",
    }
    if (!row.supportsFastMode) {
      speed.current = false
      speed.disabledReason = "Fast mode is not available for this model."
    }
    options.push(speed)
    options.push({
      kind: "boolean",
      id: "agentTeams",
      label: "Agent teams",
      change: "launch",
    })
    const model: HarnessModel = {
      id,
      launchId,
      label: claudeVersionedLabel(id, presentString(row.displayName)),
      options,
    }
    // Claude's API messages omit the CLI context selector. Match capabilities
    // across those identities while retaining an explicit selector at launch.
    const base = id.replace(/\[1m\]$/, "")
    model.aliases = id === base ? [`${base}[1m]`] : [base]
    if (row.description) model.description = row.description
    byId.set(id, model)
  }
  const catalog: HarnessModelCatalog = { models: [...byId.values()] }
  if (defaultResolved && byId.has(defaultResolved))
    catalog.defaultModel = defaultResolved
  return catalog
}

/** Codex's legacy speed name and canonical request tier describe the same choice. */
export function codexServiceTier(value: string): string {
  return value === "fast" ? "priority" : value
}

export function normalizeCodexModels(
  result: CodexModelListResponse
): HarnessModelCatalog {
  if (!Array.isArray(result.data))
    throw new Error("Codex did not return its model catalog")
  let defaultModel: string | undefined
  const byId = new Map<string, HarnessModel>()
  for (const row of result.data) {
    const id = presentString(row.model)
    if (!id || byId.has(id)) continue
    if (row.isDefault) defaultModel = id
    const options: HarnessModelOption[] = []
    const efforts: HarnessSelectValue[] = []
    for (const entry of row.supportedReasoningEfforts ?? []) {
      const value = presentString(entry.reasoningEffort)
      if (!value) continue
      efforts.push({
        value,
        label: effortLabel(value),
        default: value === row.defaultReasoningEffort,
      })
    }
    if (efforts.length > 0) {
      options.push({
        kind: "select",
        id: "effort",
        label: "Reasoning",
        role: "reasoning",
        current: presentString(row.defaultReasoningEffort),
        values: efforts,
      })
    }
    const tiers: HarnessSelectValue[] = []
    for (const entry of row.serviceTiers ?? []) {
      const raw = presentString(entry.id)
      if (!raw) continue
      const value = codexServiceTier(raw)
      if (tiers.some((tier) => tier.value === value)) continue
      const tier: HarnessSelectValue = {
        value,
        label: presentString(entry.name) ?? value,
      }
      if (value === "priority") tier.aliases = ["fast"]
      if (entry.description) tier.description = entry.description
      tiers.push(tier)
    }
    for (const raw of row.additionalSpeedTiers ?? []) {
      const value = codexServiceTier(raw)
      if (!value || tiers.some((entry) => entry.value === value)) continue
      const tier: HarnessSelectValue = {
        value,
        label: value === "priority" ? "Fast" : value,
      }
      if (value === "priority") tier.aliases = ["fast"]
      tiers.push(tier)
    }
    if (tiers.length > 0) {
      if (!tiers.some((entry) => entry.value === "default")) {
        tiers.unshift({ value: "default", label: "Standard" })
      }
      // Codex names a model's default tier only when it is an elevated one;
      // `null` is the standard tier, the same reading `config/read` gets for
      // an absent `service_tier`. Without it every model except the
      // configured one showed "Speed unavailable".
      const preferred = codexServiceTier(row.defaultServiceTier ?? "default")
      const current = tiers.some((entry) => entry.value === preferred)
        ? preferred
        : "default"
      for (const tier of tiers) {
        if (tier.value === current) tier.default = true
      }
      options.push({
        kind: "select",
        id: "serviceTier",
        label: "Speed",
        role: "speed",
        current,
        booleanValues: tiers.some((entry) => entry.value === "priority")
          ? { on: "priority", off: "default" }
          : tiers.some((entry) => entry.value === "fast")
            ? { on: "fast", off: "default" }
            : undefined,
        values: tiers,
      })
    }
    const model: HarnessModel = {
      id,
      label: presentString(row.displayName) ?? id,
      options,
    }
    if (row.description) model.description = row.description
    byId.set(id, model)
  }
  const catalog: HarnessModelCatalog = { models: [...byId.values()] }
  if (defaultModel) catalog.defaultModel = defaultModel
  return catalog
}

export function normalizeCursorModels(
  result: CursorModelListResponse,
  configuredModel?: string
): HarnessModelCatalog {
  if (!Array.isArray(result.models))
    throw new Error("Cursor did not return its model catalog")
  const byId = new Map<string, HarnessModel>()
  for (const row of result.models) {
    const wireId = presentString(row.value)
    if (!wireId) continue
    const id = wireId
    if (byId.has(id)) continue
    const model: HarnessModel = {
      id,
      label: presentString(row.name) ?? id,
      options: normalizeAcpOptions(row.configOptions),
    }
    byId.set(id, model)
  }
  const models = [...byId.values()]
  const catalog: HarnessModelCatalog = { models }
  const configured = harnessModelByIdentity(models, configuredModel)?.id
  if (configured) {
    catalog.configuredModel = configured
    catalog.settings = {
      model: configured,
      options: Object.fromEntries(
        (byId.get(configured)?.options ?? []).flatMap((option) =>
          option.current === undefined ? [] : [[option.id, option.current]]
        )
      ),
    }
  }
  return catalog
}

export function normalizeGrokModels(
  output: string,
  cache: GrokModelCache | null
): HarnessModelCatalog {
  const listed = new Set<string>()
  let defaultModel: string | undefined
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim()
    const item = /^(?:\*|-)\s+([^\s]+)(?:\s+\(default\))?$/.exec(trimmed)
    if (item?.[1]) {
      listed.add(item[1])
      if (trimmed.endsWith("(default)")) defaultModel = item[1]
    }
    const explicitDefault = /^Default model:\s*(\S+)/.exec(trimmed)
    if (explicitDefault?.[1]) defaultModel = explicitDefault[1]
  }
  const models = [...listed].map((id): HarnessModel => {
    const info = cache?.models?.[id]?.info
    const efforts: HarnessSelectValue[] = []
    for (const entry of info?.reasoning_efforts ?? []) {
      const value = presentString(entry.value)
      if (!value) continue
      const effort: HarnessSelectValue = {
        value,
        label: presentString(entry.label) ?? effortLabel(value),
      }
      if (entry.description) effort.description = entry.description
      if (entry.default) effort.default = true
      efforts.push(effort)
    }
    const model: HarnessModel = {
      id,
      label: presentString(info?.name) ?? id,
      options: [],
    }
    if (info?.description) model.description = info.description
    const contextWindow = positiveNumber(info?.context_window)
    if (contextWindow) model.contextWindow = contextWindow
    const maxOutputTokens = positiveNumber(info?.max_completion_tokens)
    if (maxOutputTokens) model.maxOutputTokens = maxOutputTokens
    if (efforts.length > 0) {
      model.options.push({
        kind: "select",
        id: "effort",
        label: "Reasoning",
        role: "reasoning",
        current: presentString(info?.reasoning_effort),
        values: efforts,
      })
    }
    return model
  })
  const catalog: HarnessModelCatalog = { models }
  if (defaultModel && listed.has(defaultModel)) {
    catalog.defaultModel = defaultModel
    const effort = models
      .find((model) => model.id === defaultModel)
      ?.options.find((option) => option.id === "effort")?.current
    catalog.settings = {
      model: defaultModel,
      options: effort === undefined ? {} : { effort },
    }
  }
  return catalog
}

export function normalizeOpenCodeModels(
  rows: OpenCodeModelRow[]
): HarnessModelCatalog {
  const models = rows.flatMap((row): HarnessModel[] => {
    const id = presentString(row.id)
    const provider = presentString(row.providerID)
    if (!id || !provider || row.status === "deprecated") return []
    const launchId = `${provider}/${id}`
    const variants = Object.keys(row.variants ?? {})
    const options: HarnessModelOption[] = []
    if (variants.length > 0) {
      options.push({
        kind: "select",
        id: "effort",
        label: "Reasoning",
        role: "reasoning",
        current: row.defaultVariant && variants.includes(row.defaultVariant) ? row.defaultVariant : undefined,
        values: variants.map((value) => ({
          value,
          label: effortLabel(value),
        })),
      })
    }
    const model: HarnessModel = {
      id: launchId,
      launchId,
      label: presentString(row.name) ?? launchId,
      options,
    }
    const contextWindow = positiveNumber(row.limit?.context)
    if (contextWindow) model.contextWindow = contextWindow
    const maxOutputTokens = positiveNumber(row.limit?.output)
    if (maxOutputTokens) model.maxOutputTokens = maxOutputTokens
    const details = [
      presentString(row.family),
      row.capabilities?.reasoning ? "reasoning" : null,
      row.capabilities?.input?.image ? "images" : null,
    ].filter(Boolean)
    if (details.length > 0) model.description = details.join(" · ")
    return [model]
  })
  return { models }
}

export function normalizeDevinModels(
  parsed: DevinModelListResponse
): HarnessModelCatalog {
  const byId = new Map<string, HarnessModel>()
  let reportedDefault =
    presentString(parsed.default_model) ?? presentString(parsed.defaultModel)
  for (const family of parsed.families ?? []) {
    const id = presentString(family.slug)
    if (!id || byId.has(id)) continue
    const variants = normalizeDevinVariants(family.variants)
    if (variants.length === 0) continue
    const declaredDefault = family.variants?.find(
      (variant) => variant.is_default
    )?.model_uid
    const initial =
      variants.find((variant) => variant.id === reportedDefault) ??
      variants.find((variant) => variant.id === declaredDefault) ??
      variants[0]!
    const efforts = uniqueStrings(
      variants.flatMap((variant) => variantEffort(variant))
    ).sort(reasoningSort)
    const options: HarnessModelOption[] = []
    if (efforts.length > 0) {
      options.push({
        kind: "select",
        id: "effort",
        label: "Reasoning",
        role: "reasoning",
        current: variantEffort(initial)[0],
        values: efforts.map((value) => ({ value, label: effortLabel(value) })),
      })
    }
    if (variants.some((variant) => variant.values.fast === true)) {
      options.push({
        kind: "boolean",
        id: "fast",
        label: "Fast mode",
        role: "speed",
        current: initial.values.fast === true,
      })
    }
    const model: HarnessModel = {
      id,
      launchId: initial.id,
      label: presentString(family.family_label) ?? id,
      options,
      variants,
    }
    const aliases = uniqueStrings(
      (family.aliases ?? []).filter((alias) => alias !== id)
    )
    if (aliases.length > 0) model.aliases = aliases
    if (variants.length === 1 && variants[0]?.description) {
      model.description = variants[0].description
    }
    const contextWindows = uniqueNumbers(
      variants.map((variant) => variant.contextWindow)
    )
    if (contextWindows.length === 1) model.contextWindow = contextWindows[0]
    const outputLimits = uniqueNumbers(
      variants.map((variant) => variant.maxOutputTokens)
    )
    if (outputLimits.length === 1) model.maxOutputTokens = outputLimits[0]
    byId.set(id, model)
    if (family.is_default) reportedDefault = id
    const defaultVariant = family.variants?.find(
      (variant) => variant.is_default
    )
    if (family.is_default && defaultVariant?.model_uid)
      reportedDefault = defaultVariant.model_uid
  }
  const models = [...byId.values()]
  const defaultModel = canonicalDevinDefault(models, reportedDefault)
  models.sort((left, right) =>
    left.id === "adaptive" ? -1 : right.id === "adaptive" ? 1 : 0
  )
  const catalog: HarnessModelCatalog = { models }
  if (defaultModel) {
    catalog.defaultModel = defaultModel
    const selected = modelByIdentity(models, reportedDefault)
    catalog.settings = {
      model:
        selected && reportedDefault === selected.id
          ? selected.launchId
          : reportedDefault,
    }
  }
  return catalog
}

export function normalizeAcpOptions(
  options: AcpConfigOptionInput[] | undefined
): HarnessModelOption[] {
  if (!Array.isArray(options)) return []
  const normalized: HarnessModelOption[] = []
  for (const option of options) {
    const wireId = presentString(option.id)
    if (!wireId) continue
    const role = acpOptionRole(option)
    const id =
      option.category === "model"
        ? "model"
        : role === "reasoning"
          ? "effort"
          : role === "speed" && option.type === "boolean"
            ? "fast"
            : wireId
    const label = presentString(option.name) ?? id
    if (option.type === "boolean") {
      normalized.push({
        kind: "boolean",
        id,
        wireId,
        label,
        role,
        current:
          option.currentValue === true || option.currentValue === false
            ? option.currentValue
            : undefined,
      })
      continue
    }
    if (option.type !== "select") continue
    const entries = Array.isArray(option.options)
      ? option.options
      : Object.values(option.options ?? {}).flat()
    const flat = entries.flatMap((entry) =>
      "options" in entry ? entry.options : [entry]
    )
    const values: HarnessSelectValue[] = []
    for (const entry of flat) {
      const value = presentString(entry.value)
      if (!value) continue
      const item: HarnessSelectValue = {
        value,
        label: presentString(entry.name) ?? value,
      }
      if (entry.description) item.description = entry.description
      values.push(item)
    }
    if (values.length === 0) continue
    const wireValues = new Set(values.map((value) => value.value))
    const select: HarnessModelOption = {
      kind: "select",
      id,
      wireId,
      label,
      role,
      current: selectCurrentValue(option.currentValue),
      values,
    }
    if (
      wireValues.size === 2 &&
      wireValues.has("true") &&
      wireValues.has("false")
    ) {
      select.presentation = "toggle"
      select.booleanValues = { on: "true", off: "false" }
    }
    normalized.push(select)
  }
  return normalized
}

function normalizeDevinVariants(
  raw: DevinVariantRow[] | undefined
): HarnessModelVariant[] {
  const byId = new Map<string, HarnessModelVariant>()
  for (const row of raw ?? []) {
    const id = presentString(row.model_uid)
    if (!id || byId.has(id)) continue
    const label = presentString(row.label) ?? id
    const effort = reasoningFrom(`${id} ${label}`)
    const fast = /(?:^|[- ])(?:fast|priority)(?:$|[- ])/i.test(`${id} ${label}`)
    const values: Record<string, string | boolean> = {}
    if (effort) values.effort = effort
    values.fast = fast
    const variant: HarnessModelVariant = { id, label, values }
    const contextWindow = positiveNumber(row.max_context_tokens)
    if (contextWindow) variant.contextWindow = contextWindow
    const maxOutputTokens = positiveNumber(row.max_output_tokens)
    if (maxOutputTokens) variant.maxOutputTokens = maxOutputTokens
    if (row.description) variant.description = row.description
    byId.set(id, variant)
  }
  return [...byId.values()]
}

function canonicalDevinDefault(
  models: HarnessModel[],
  identity: string | undefined
): string | undefined {
  const direct = harnessModelByIdentity(models, identity)?.id
  if (direct) return direct
  if (!identity) return undefined
  return models.find((model) =>
    model.variants?.some((variant) => variant.id === identity)
  )?.id
}

function acpOptionRole(
  option: AcpConfigOptionInput
): HarnessModelOption["role"] {
  // Thinking is an independent enable switch, even under thought_level.
  if (option.id === "thinking") return undefined
  for (const id of [option.id, option.category]) {
    if (
      id === "thought_level" ||
      id === "reasoning" ||
      id === "effort" ||
      id === "reasoning_effort"
    )
      return "reasoning"
    if (
      id === "fast" ||
      id === "fastMode" ||
      id === "speed" ||
      id === "serviceTier"
    )
      return "speed"
    if (id === "context" || id === "context_window" || id === "contextWindow")
      return "context"
  }
  return undefined
}

function variantEffort(variant: HarnessModelVariant): string[] {
  const effort = variant.values.effort
  return effort === true || effort === false || effort === undefined
    ? []
    : [effort]
}

function selectOption(
  id: string,
  label: string,
  values: string[]
): HarnessModelOption {
  return {
    kind: "select",
    id,
    label,
    role: "reasoning",
    values: values.map((value) => ({ value, label: effortLabel(value) })),
  }
}

function reasoningFrom(value: string): string | undefined {
  return REASONING_ORDER.find((effort) =>
    new RegExp(`(?:^|[- ])${effort}(?:$|[- ])`, "i").test(value)
  )
}

function reasoningSort(left: string, right: string): number {
  const leftIndex = REASONING_ORDER.indexOf(left)
  const rightIndex = REASONING_ORDER.indexOf(right)
  return (
    (leftIndex < 0 ? REASONING_ORDER.length : leftIndex) -
    (rightIndex < 0 ? REASONING_ORDER.length : rightIndex)
  )
}

function effortLabel(value: string): string {
  if (value === "xhigh") return "Extra high"
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function presentString(value: string | undefined): string | undefined {
  return value?.trim() ? value : undefined
}

function positiveNumber(value: number | null | undefined): number | undefined {
  return value && Number.isFinite(value) && value > 0 ? value : undefined
}

function selectCurrentValue(
  value: string | boolean | undefined
): string | undefined {
  return value === true || value === false ? undefined : value
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)]
}

function uniqueNumbers(values: Array<number | undefined>): number[] {
  return [...new Set(values.filter((value) => value !== undefined))]
}
