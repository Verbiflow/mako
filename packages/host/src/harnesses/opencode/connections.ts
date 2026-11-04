import { parse, type ParseError } from "jsonc-parser"
import { z } from "zod"
import type { ServedConnection } from "../model-connections.js"

const Config = z.looseObject({ providers: z.record(z.string(), z.unknown()).optional() })

/** The OpenCode provider a connection is: its own id, apart from OpenCode's built-in providers of the same name. */
export function openCodeConnectionProvider(id: string): string {
  return `mako-${id}`
}

/** The variable a connection's key travels in, which its provider names in `env`: the config's text holds no key. */
export function openCodeConnectionKeyVariable(id: string): string {
  return `MAKO_CONNECTION_KEY_${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`
}

/** A provider in OpenCode 2's config (`Config.Provider` in `@opencode/schema`), as much of it as a connection fills. */
export interface OpenCodeProviderConfig {
  name: string
  package: "@ai-sdk/openai-compatible"
  settings: { baseURL: string }
  env?: string[]
  models: { [id: string]: { name?: string; limit?: { context: number } } }
}

/** One connection as an OpenCode 2 provider (`providers` in its config): an OpenAI-compatible endpoint and the models kept. */
export function openCodeProviderConfig({ connection, apiKey }: ServedConnection): OpenCodeProviderConfig {
  return {
    name: connection.name,
    package: "@ai-sdk/openai-compatible",
    settings: { baseURL: connection.baseUrl },
    ...(apiKey && { env: [openCodeConnectionKeyVariable(connection.id)] }),
    models: Object.fromEntries(connection.models.map((model) => [model.id, {
      ...(model.name && { name: model.name }),
      ...(model.contextTokens && { limit: { context: model.contextTokens } }),
    }])),
  }
}

/**
 * Hands `served` to OpenCode through its inline config, beside what is already
 * there: a provider the person configured under the same id stays theirs. Each
 * key goes in its own variable, never into `OPENCODE_CONFIG_CONTENT`, which
 * discovery's cache key and a launch's diagnostics read.
 */
export function applyOpenCodeConnections(env: NodeJS.ProcessEnv, served: readonly ServedConnection[]): NodeJS.ProcessEnv {
  if (!served.length) return env
  const errors: ParseError[] = []
  const parsed = Config.safeParse(parse(env.OPENCODE_CONFIG_CONTENT || "{}", errors, { allowTrailingComma: true }))
  // An inline config OpenCode would refuse is left for it to refuse, as it would without Mako's providers.
  if (errors.length || !parsed.success) return env
  const providers = { ...parsed.data.providers }
  for (const entry of served) {
    const id = openCodeConnectionProvider(entry.connection.id)
    if (id in providers) continue
    providers[id] = openCodeProviderConfig(entry)
    if (entry.apiKey) env[openCodeConnectionKeyVariable(entry.connection.id)] = entry.apiKey
  }
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ ...parsed.data, providers })
  return env
}
