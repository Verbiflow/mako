import type { OpenCodeClient } from "@opencode/client"
import { normalizeOpenCodeModels } from "@mako/sessions/model-catalog"
import type { SessionModel, SessionSettings } from "@mako/sessions/settings"
import type { LiveSessionCommand } from "../../shared.js"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { z } from "zod"

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

export async function loadOpenCodeCatalog(
  client: OpenCodeClient,
  directory: string,
  signal: AbortSignal,
  env: NodeJS.ProcessEnv = process.env
): Promise<OpenCodeCatalog> {
  const location = { directory }
  const options = { signal }
  const [models, fallback, agents, commands, skills, config, recent] = await Promise.all([
    client.model.list({ location }, options),
    client.model.default({ location }, options),
    client.agent.list({ location }, options),
    client.command.list({ location }, options),
    client.skill.list({ location }, options),
    client.config.get({ location }, options).catch(() => []),
    recentOpenCodeModels(env),
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
  // OpenCode's own order for a new session: a configured `model`, then the
  // newest recent model it still offers, then its provider default. The
  // server's default skips the recent list, which can land on a provider the
  // account has credentials for but can't use.
  const configured = config.some(entry => entry.type === "document" && entry.info.model !== undefined)
  const used = configured ? undefined : recent.find(ref => limits.has(openCodeLaunchId(ref)))
  return {
    models: catalog.models,
    limits,
    defaultModel: used ?? (fallback.data ? { id: fallback.data.id, providerID: fallback.data.providerID } : undefined),
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

const RecentModelsSchema = z.object({
  recent: z.array(z.object({ providerID: z.string().min(1), modelID: z.string().min(1) })).catch([]),
})

/** The models OpenCode's own interface last used, newest first, from its state file. */
async function recentOpenCodeModels(env: NodeJS.ProcessEnv): Promise<OpenCodeModelRef[]> {
  const state = env.XDG_STATE_HOME || join(homedir(), ".local", "state")
  try {
    const parsed = RecentModelsSchema.safeParse(JSON.parse(await readFile(join(state, "opencode", "model.json"), "utf8")))
    return parsed.success ? parsed.data.recent.map(entry => ({ id: entry.modelID, providerID: entry.providerID })) : []
  } catch {
    return []
  }
}

/** The effort a request names; other setting values aren't an effort. */
function requestedEffort(settings: SessionSettings | undefined): string | undefined {
  return z.string().safeParse(settings?.options?.effort).data
}

/** `provider/model` and an effort variant, resolved against the catalog. */
export function openCodeModelRef(catalog: Pick<OpenCodeCatalog, "models">, settings: SessionSettings | undefined, fallback: OpenCodeModelRef | undefined): OpenCodeModelRef {
  const requested = settings?.model
  if (!requested) {
    if (!fallback) throw new Error("OpenCode reported no default model. Choose a model for this conversation.")
    const effort = requestedEffort(settings)
    return effort !== undefined && effort !== NATIVE_DEFAULT_VARIANT ? { ...fallback, variant: effort } : fallback
  }
  const model = catalog.models.find(candidate => candidate.id === requested)
  if (!model) throw new Error(`OpenCode does not offer the model "${requested}" in this workspace`)
  const separator = requested.indexOf("/")
  const ref: OpenCodeModelRef = { providerID: requested.slice(0, separator), id: requested.slice(separator + 1) }
  const effort = requestedEffort(settings)
  const option = model.options.find(candidate => candidate.id === "effort")
  if (effort !== undefined && effort !== NATIVE_DEFAULT_VARIANT && option?.kind === "select" && option.values.some(value => value.value === effort))
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
  const variant = requestedEffort(settings) ?? (current && model === openCodeLaunchId(current) ? current.variant : undefined)
  const ref: OpenCodeModelRef = { providerID: model.slice(0, separator), id: model.slice(separator + 1) }
  if (variant && variant !== NATIVE_DEFAULT_VARIANT) ref.variant = variant
  return ref
}

export function openCodeLaunchId(ref: Pick<OpenCodeModelRef, "id" | "providerID">): string {
  return `${ref.providerID}/${ref.id}`
}

export interface OpenCodeReportedSettings { settings: SessionSettings; configOptions: SessionModel["options"] }

/** The settings and composer options a native model selection means. */
export function openCodeReportedSettings(catalog: Pick<OpenCodeCatalog, "models">, ref: OpenCodeModelRef): OpenCodeReportedSettings {
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
