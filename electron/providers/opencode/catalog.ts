import type { OpenCodeClient } from "@opencode/client"
import { normalizeOpenCodeModels } from "@mako/sessions/model-catalog"
import type { SessionModel, SessionSettings } from "@mako/sessions/settings"
import type { LiveSessionCommand } from "../../shared.js"

export interface OpenCodeModelRef { id: string; providerID: string; variant?: string }

export interface OpenCodeCatalog {
  models: SessionModel[]
  /** Context window per launch id, for the usage reading. */
  limits: Map<string, number>
  defaultModel?: OpenCodeModelRef
  agents: Array<{ id: string; name: string; description?: string }>
  commands: LiveSessionCommand[]
  /** Slash names that invoke a skill rather than a command template. */
  skills: Map<string, { id: string; name: string }>
}

/** OpenCode's own default variant is its unnamed configuration, not a value to choose. */
const NATIVE_DEFAULT_VARIANT = "default"

export async function loadOpenCodeCatalog(client: OpenCodeClient, directory: string, signal: AbortSignal): Promise<OpenCodeCatalog> {
  const location = { directory }
  const options = { signal }
  const [models, fallback, agents, commands, skills] = await Promise.all([
    client.model.list({ location }, options),
    client.model.default({ location }, options),
    client.agent.list({ location }, options),
    client.command.list({ location }, options),
    client.skill.list({ location }, options),
  ])
  const enabled = models.data.filter(model => model.enabled && model.status !== "deprecated")
  const catalog = normalizeOpenCodeModels(enabled.map(model => ({
    id: model.id,
    providerID: model.providerID,
    name: model.name,
    family: model.family,
    status: model.status,
    variants: model.variants.length ? Object.fromEntries(model.variants.map(variant => [variant.id, {}])) : undefined,
    defaultVariant: model.variants.some(variant => variant.id === NATIVE_DEFAULT_VARIANT) ? NATIVE_DEFAULT_VARIANT : undefined,
    limit: model.limit,
    capabilities: { input: { text: model.capabilities.input.includes("text"), image: model.capabilities.input.includes("image") } },
  })))
  const limits = new Map(enabled.map(model => [`${model.providerID}/${model.id}`, model.limit.context]))
  const names = new Set(commands.data.map(command => command.name))
  const slashSkills = skills.data.filter(skill => skill.slash !== false && !names.has(skill.id))
  return {
    models: catalog.models,
    limits,
    defaultModel: fallback.data ? { id: fallback.data.id, providerID: fallback.data.providerID } : undefined,
    agents: agents.data.filter(agent => agent.mode !== "subagent" && !agent.hidden)
      .map(agent => ({ id: agent.id, name: agent.name, description: agent.description })),
    commands: [
      { name: "compact", description: "Summarize the conversation to free context" },
      ...commands.data.map(command => ({ name: command.name, description: command.description })),
      ...slashSkills.map(skill => ({ name: skill.id, description: skill.description ?? skill.name })),
    ],
    skills: new Map(slashSkills.map(skill => [skill.id, { id: skill.id, name: skill.name }])),
  }
}

/** `provider/model` and an effort variant, resolved against the catalog. */
export function openCodeModelRef(catalog: Pick<OpenCodeCatalog, "models">, settings: SessionSettings | undefined, fallback: OpenCodeModelRef | undefined): OpenCodeModelRef {
  const requested = settings?.model
  if (!requested) {
    if (!fallback) throw new Error("OpenCode reported no default model. Choose a model for this conversation.")
    const effort = settings?.options?.effort
    return typeof effort === "string" && effort !== NATIVE_DEFAULT_VARIANT ? { ...fallback, variant: effort } : fallback
  }
  const model = catalog.models.find(candidate => candidate.id === requested)
  if (!model) throw new Error(`OpenCode does not offer the model "${requested}" in this workspace`)
  const separator = requested.indexOf("/")
  const ref: OpenCodeModelRef = { providerID: requested.slice(0, separator), id: requested.slice(separator + 1) }
  const effort = settings?.options?.effort
  const option = model.options.find(candidate => candidate.id === "effort")
  if (typeof effort === "string" && effort !== NATIVE_DEFAULT_VARIANT && option?.kind === "select" && option.values.some(value => value.value === effort))
    ref.variant = effort
  return ref
}

/**
 * The model a request asks for. OpenCode resolves models when a turn runs,
 * from a catalog that refreshes after startup, so a model the current list
 * lacks is passed through for OpenCode to accept or fail natively.
 */
export function openCodeRequestedModel(catalog: Pick<OpenCodeCatalog, "models">, settings: SessionSettings | undefined, current: OpenCodeModelRef | undefined): OpenCodeModelRef {
  const model = settings?.model ?? (current && openCodeLaunchId(current))
  if (model === undefined || catalog.models.some(candidate => candidate.id === model)) return openCodeModelRef(catalog, { ...settings, model }, current)
  const separator = model.indexOf("/")
  if (separator <= 0 || separator === model.length - 1) throw new Error(`"${model}" is not an OpenCode provider/model id`)
  const effort = settings?.options?.effort
  const variant = typeof effort === "string" ? effort : current && model === openCodeLaunchId(current) ? current.variant : undefined
  return { providerID: model.slice(0, separator), id: model.slice(separator + 1), ...(variant && variant !== "default" ? { variant } : {}) }
}

export function openCodeLaunchId(ref: Pick<OpenCodeModelRef, "id" | "providerID">): string {
  return `${ref.providerID}/${ref.id}`
}

/** The settings and composer options a native model selection means. */
export function openCodeReportedSettings(catalog: Pick<OpenCodeCatalog, "models">, ref: OpenCodeModelRef): { settings: SessionSettings; configOptions: SessionModel["options"] } {
  const model = catalog.models.find(candidate => candidate.id === openCodeLaunchId(ref))
  const variant = ref.variant && ref.variant !== NATIVE_DEFAULT_VARIANT ? ref.variant : undefined
  const configOptions = (model?.options ?? []).map(option =>
    option.id === "effort" && option.kind === "select" ? { ...option, current: variant } : option)
  return {
    settings: { model: openCodeLaunchId(ref), options: variant ? { effort: variant } : {} },
    configOptions,
  }
}

export function sameOpenCodeModel(left: OpenCodeModelRef | undefined, right: OpenCodeModelRef): boolean {
  const variant = (ref: OpenCodeModelRef | undefined) => ref?.variant && ref.variant !== NATIVE_DEFAULT_VARIANT ? ref.variant : undefined
  return left?.id === right.id && left.providerID === right.providerID && variant(left) === variant(right)
}
