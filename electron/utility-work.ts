import { createHash } from "node:crypto"
import { z } from "zod"
import type { JsonSchema } from "@mako/git"
import {
  AUTOMATIC,
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

export interface UtilityRequest {
  instructions: string
  prompt: string
  /** A JSON Schema the reply must match; the reply is then that JSON's text. */
  schema?: JsonSchema
  maxOutputTokens: number
  /** `high` only when the person asks for a deeper answer, such as a deep commit draft. */
  reasoning: "low" | "high"
}

/** A model ready to answer. */
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
  | { kind: "unavailable"; reason: string }

export interface UtilityWorkOptions {
  models: Pick<UtilityModelStore, "choices" | "choose" | "settings" | "load">
}

const TASK_NAMES = { commit: "commit messages" } satisfies Record<UtilityTask, string>

/**
 * Which model does each small task: one of the person's API connections,
 * called directly through the AI SDK. Harnesses don't do this work: each
 * request would start a whole agent process on the person's subscription,
 * and a chunked draft makes dozens. `auto` takes the first connection; a
 * connection the person chose is used only while it's there, and nothing
 * stands in for it when it goes.
 */
export class UtilityWork {
  private readonly options: UtilityWorkOptions

  constructor(options: UtilityWorkOptions) {
    this.options = options
  }

  async settings(): Promise<UtilityWorkSettings> {
    const [choices, connections] = await Promise.all([this.options.models.choices(), this.connections()])
    const options = connections.map(optionOf)
    const state = (task: UtilityTask): UtilityTaskState => {
      const found = find(task, choices[task], connections)
      return {
        choice: choices[task],
        options,
        resolved: found.kind === "ready" ? optionOf(found.connection) : undefined,
        reason: found.kind === "unavailable" ? found.reason : undefined,
      }
    }
    return { commit: state("commit") }
  }

  /** Save what does `task`: `auto`, or one of the connections Settings lists now. */
  async choose(task: UtilityTask, choice: string): Promise<void> {
    if (choice !== AUTOMATIC && !(await this.connections()).some((connection) => connectionId(connection) === choice))
      throw new Error("That model isn't connected now. Connect its API key, then choose it again.")
    await this.options.models.choose(task, choice)
  }

  /**
   * The model that does `task` now. `requested` is a window's own pick;
   * without one, the saved choice.
   */
  async resolve(task: UtilityTask, requested?: string): Promise<UtilityResolution> {
    const choice = requested ?? (await this.options.models.choices())[task]
    const found = find(task, choice, await this.connections())
    if (found.kind !== "ready") return found
    const stored = await this.options.models.load(found.connection.provider)
    const id = connectionId(found.connection)
    if (!stored || connectionId(stored) !== id) throw new UtilityModelError("auth", `${id} is no longer connected. Connect it again in Settings › Git.`)
    return {
      kind: "ready",
      model: languageUtilityModel(utilityLanguageModel(stored, stored.apiKey), {
        connection: stored,
        via: providerName(stored),
        countTokens: utilityTokenCounter(stored, stored.apiKey),
      }),
    }
  }

  /** The connections the host can open now, in provider order. */
  private async connections(): Promise<UtilityConnection[]> {
    const settings = await this.options.models.settings()
    return settings.connections.filter((connection) => !settings.issues.some(({ provider }) => provider === connection.provider))
  }
}

type Found =
  | { kind: "ready"; connection: UtilityConnection }
  | { kind: "unavailable"; reason: string }

function find(task: UtilityTask, choice: string, connections: readonly UtilityConnection[]): Found {
  const connection = choice === AUTOMATIC ? connections[0] : connections.find((entry) => connectionId(entry) === choice)
  if (connection) return { kind: "ready", connection }
  return {
    kind: "unavailable",
    reason: choice === AUTOMATIC
      ? `Connect an API key in Settings › Git to generate ${TASK_NAMES[task]}.`
      : `${choice} is no longer connected. Connect it again, or choose another, in Settings › Git.`,
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

function optionOf(connection: UtilityConnection): UtilityModelOption {
  return { id: connectionId(connection), label: connection.model, via: providerName(connection), source: connection.provider }
}

function providerName(connection: Pick<UtilityConnection, "provider">): string {
  return utilityProviders.find(({ id }) => id === connection.provider)?.name ?? connection.provider
}

function connectionId(connection: Pick<UtilityConnection, "provider" | "model">): string {
  return `${connection.provider}/${connection.model}`
}

function digest(parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex")
}
