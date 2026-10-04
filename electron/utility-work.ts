import { createHash } from "node:crypto"
import { z } from "zod"
import type { SessionModel } from "@mako/sessions/settings"
import type { JsonSchema, ProviderUtilityRunner } from "./providers/utility-runner.js"
import {
  AUTOMATIC,
  OFF,
  agentModelId,
  parseAgentModelId,
  type UtilityModelOption,
  type UtilityTask,
  type UtilityTaskState,
  type UtilityWorkSettings,
} from "./contracts/utility-work.js"
import type { UtilityConnection } from "./contracts/utility-models.js"
import { UtilityModelError } from "./utility-model-error.js"
import { completeUtilityText, utilityLanguageModel, utilityProviders, type UtilityLanguageModel } from "./utility-models.js"
import type { UtilityModelStore } from "./utility-model-store.js"
import { utilityTokenCounter, type UtilityTokenCounter } from "./utility-token-count.js"

/** A signed-in agent app that can do small work, with its catalog. */
export interface UtilityAgent {
  harness: string
  label: string
  models: readonly SessionModel[]
  runner: ProviderUtilityRunner
}

export interface UtilityRequest {
  instructions: string
  prompt: string
  /** A JSON Schema the reply must match; the reply is then that JSON's text. */
  schema?: JsonSchema
  maxOutputTokens: number
  reasoning: "low" | "high"
}

/** A model ready to answer, whichever way it runs. */
export interface UtilityModel {
  id: string
  label: string
  via: string
  /** What the model reads at once; callers cut requests to fit. */
  contextTokens: number
  /** The same for every run of the same model and endpoint, for caches of earlier answers. */
  identity: string
  countTokens?: UtilityTokenCounter
  complete(request: UtilityRequest, signal: AbortSignal): Promise<string>
}

export type UtilityResolution =
  | { kind: "ready"; model: UtilityModel }
  | { kind: "off" }
  | { kind: "unavailable"; reason: string }

export interface UtilityWorkOptions {
  models: Pick<UtilityModelStore, "choices" | "choose" | "settings" | "load">
  /** Signed-in agent apps that can do small work, in the shared agent order (`agent-order.ts`). */
  agents(): Promise<UtilityAgent[]>
  now?: () => number
}

/** A catalog that doesn't say how much a model reads is assumed to read this much. */
const DEFAULT_CONTEXT_TOKENS = 128_000
/** Discovering agents can start processes; Settings and every title share one answer this long. */
const AGENTS_TTL_MS = 30_000

const TASK_NAMES = { title: "Thread titles", commit: "commit messages" } satisfies Record<UtilityTask, string>

/**
 * Which model does each small task, decided in one place. `auto` takes the
 * first signed-in agent in the shared order whose catalog offers a light
 * model, on that model and the person's own account; with none, the first
 * model connection. A model the person chose is used only while it is
 * there: when its agent signs out or its connection goes, the task is
 * unavailable and says why, and no other model stands in for it.
 */
export class UtilityWork {
  private readonly options: UtilityWorkOptions
  private agentsAt = Number.NEGATIVE_INFINITY
  private agentsFound?: Promise<UtilityAgent[]>

  constructor(options: UtilityWorkOptions) {
    this.options = options
  }

  async settings(): Promise<UtilityWorkSettings> {
    const [choices, options] = await Promise.all([this.options.models.choices(), this.available()])
    const state = async (task: UtilityTask): Promise<UtilityTaskState> => {
      const found = await this.find(task, choices[task], options)
      return {
        choice: choices[task],
        options: options.list,
        resolved: found.kind === "ready" ? found.option : undefined,
        reason: found.kind === "unavailable" ? found.reason : undefined,
      }
    }
    const [title, commit] = await Promise.all([state("title"), state("commit")])
    return { title, commit }
  }

  /** Save what does `task`: `auto`, `off` for titles, or one of the models Settings lists now. */
  async choose(task: UtilityTask, choice: string): Promise<void> {
    if (choice !== AUTOMATIC && choice !== OFF && !(await this.available()).list.some((option) => option.id === choice))
      throw new Error("That model isn't available now. Sign in to its agent app or connect it, then choose it again.")
    await this.options.models.choose(task, choice)
  }

  /**
   * The model that does `task` now. `requested` is a window's own pick, such
   * as the drafting model a commit box shows; without one, the saved choice.
   */
  async resolve(task: UtilityTask, requested?: string): Promise<UtilityResolution> {
    const choice = requested ?? (await this.options.models.choices())[task]
    const found = await this.find(task, choice, await this.available())
    if (found.kind !== "ready") return found
    return { kind: "ready", model: await found.open() }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  private agents(): Promise<UtilityAgent[]> {
    if (!this.agentsFound || this.now() - this.agentsAt > AGENTS_TTL_MS) {
      this.agentsAt = this.now()
      this.agentsFound = this.options.agents().catch(() => [])
    }
    return this.agentsFound
  }

  private async available(): Promise<Available> {
    const [agents, settings] = await Promise.all([this.agents(), this.options.models.settings()])
    const connections = settings.connections.filter((connection) => !settings.issues.some(({ provider }) => provider === connection.provider))
    const list: UtilityModelOption[] = []
    for (const agent of agents) {
      const light = agent.runner.light(agent.models)
      for (const model of light ? [light, ...agent.models.filter((entry) => entry !== light)] : agent.models)
        list.push({ id: agentModelId(agent.harness, model.id), label: model.label, via: agent.label, kind: "agent", source: agent.harness, light: model === light || undefined })
    }
    for (const connection of connections)
      list.push({ id: connectionId(connection), label: connection.model, via: utilityProviders.find(({ id }) => id === connection.provider)?.name ?? connection.provider, kind: "connection", source: connection.provider })
    return { agents, connections, list }
  }

  private async find(task: UtilityTask, choice: string, available: Available): Promise<Found> {
    if (choice === OFF) return task === "title" ? { kind: "off" } : this.find(task, AUTOMATIC, available)
    if (choice === AUTOMATIC) {
      for (const agent of available.agents) {
        const light = agent.runner.light(agent.models)
        if (light) return this.agentModel(agent, light, available)
      }
      const connection = available.connections[0]
      if (connection) return this.connectionModel(connection, available)
      return { kind: "unavailable", reason: `Nothing can write ${TASK_NAMES[task]}: no signed-in agent app offers a light model, and no model is connected. Sign in to one in Settings › Agents, or connect a model in Settings › Commit messages.` }
    }
    const agentChoice = parseAgentModelId(choice)
    if (agentChoice) {
      const agent = available.agents.find((entry) => entry.harness === agentChoice.harness)
      const model = agent?.models.find((entry) => entry.id === agentChoice.model)
      if (!agent || !model)
        return { kind: "unavailable", reason: `${agentChoice.model} isn't available: its agent app isn't signed in, or no longer offers it. Choose another model for ${TASK_NAMES[task]} in Settings.` }
      return this.agentModel(agent, model, available)
    }
    const connection = available.connections.find((entry) => connectionId(entry) === choice)
    if (!connection)
      return { kind: "unavailable", reason: `${choice} is no longer connected. Choose another model for ${TASK_NAMES[task]} in Settings.` }
    return this.connectionModel(connection, available)
  }

  private agentModel(agent: UtilityAgent, model: SessionModel, available: Available): Found {
    const id = agentModelId(agent.harness, model.id)
    return {
      kind: "ready",
      option: option(available, id),
      open: async () => ({
        id,
        label: model.label,
        via: agent.label,
        contextTokens: model.contextWindow ?? DEFAULT_CONTEXT_TOKENS,
        identity: digest([agent.harness, model.id]),
        complete: async (request, signal) => {
          const reply = await agent.runner.complete({
            model: model.launchId ?? model.id,
            instructions: request.instructions,
            prompt: request.prompt,
            schema: request.schema,
            reasoning: request.reasoning,
            signal,
          })
          if (request.schema) {
            try {
              JSON.parse(reply)
            } catch {
              throw new UtilityModelError("output", `${agent.label} replied with something other than the JSON asked for.`)
            }
          }
          return reply
        },
      }),
    }
  }

  private connectionModel(connection: UtilityConnection, available: Available): Found {
    const id = connectionId(connection)
    return {
      kind: "ready",
      option: option(available, id),
      open: async () => {
        const stored = await this.options.models.load(connection.provider)
        if (!stored || connectionId(stored) !== id) throw new UtilityModelError("auth", `${id} is no longer connected. Choose another model in Settings.`)
        return languageUtilityModel(utilityLanguageModel(stored, stored.apiKey), {
          connection: stored,
          via: option(available, id).via,
          countTokens: utilityTokenCounter(stored, stored.apiKey),
        })
      },
    }
  }
}

/** A model connection's language model as a `UtilityModel`. */
export function languageUtilityModel(
  language: UtilityLanguageModel,
  input: { connection: Pick<UtilityConnection, "provider" | "model" | "baseUrl" | "contextTokens">; via: string; countTokens?: UtilityTokenCounter }
): UtilityModel {
  const { connection } = input
  return {
    id: connectionId(connection),
    label: connection.model,
    via: input.via,
    contextTokens: connection.contextTokens,
    identity: digest([connection.provider, connection.model, connection.baseUrl, connection.contextTokens]),
    countTokens: input.countTokens,
    complete: (request, signal) => completeUtilityText(
      language,
      request.instructions,
      request.prompt,
      signal,
      request.maxOutputTokens,
      request.schema ? z.fromJSONSchema(request.schema) : undefined,
      request.reasoning
    ),
  }
}

interface Available {
  agents: UtilityAgent[]
  connections: UtilityConnection[]
  list: UtilityModelOption[]
}

type Found =
  | { kind: "ready"; option: UtilityModelOption; open(): Promise<UtilityModel> }
  | { kind: "off" }
  | { kind: "unavailable"; reason: string }

function connectionId(connection: Pick<UtilityConnection, "provider" | "model">): string {
  return `${connection.provider}/${connection.model}`
}

function option(available: Available, id: string): UtilityModelOption {
  const found = available.list.find((entry) => entry.id === id)
  if (!found) throw new Error(`${id} is missing from the models Mako listed`)
  return found
}

function digest(parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex")
}
