import { parse, type ParseError } from "jsonc-parser"
import { z } from "zod"
import type { ModelRoute } from "../../contracts/model-routes.js"
import type { ModelRouteAdapter, RoutedLaunch } from "../model-routes.js"

const Config = z.looseObject({ providers: z.record(z.string(), z.unknown()).optional() })

/** The OpenCode provider a connection is: its own id, apart from OpenCode's built-in providers of the same name. */
export function openCodeConnectionProvider(connection: string): string {
  return `mako-${connection}`
}

/** The variable a connection's key travels in, which its provider names in `env`: the config's text holds no key. */
export function openCodeConnectionKeyVariable(connection: string): string {
  return `MAKO_CONNECTION_KEY_${connection.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`
}

/** A provider in OpenCode 2's config (`Config.Provider` in `@opencode/schema`), as much of it as a connection fills. */
export interface OpenCodeProviderConfig {
  name: string
  package: "@ai-sdk/openai-compatible"
  settings: { baseURL: string }
  env?: string[]
  models: { [id: string]: { name?: string; limit?: { context: number } } }
}

/** One connection's routes as an OpenCode 2 provider (`providers` in its config): its endpoint and the models it serves. */
export function openCodeProviderConfig(name: string, routes: readonly ModelRoute[], keyed: boolean): OpenCodeProviderConfig {
  const [first] = routes
  return {
    name,
    package: "@ai-sdk/openai-compatible",
    settings: { baseURL: first?.baseUrl ?? "" },
    ...(keyed && first && { env: [openCodeConnectionKeyVariable(first.connection)] }),
    models: Object.fromEntries(routes.map((route) => [route.model, {
      ...(route.name && { name: route.name }),
      ...(route.contextTokens && { limit: { context: route.contextTokens } }),
    }])),
  }
}

/**
 * Hands a launch's routes to OpenCode through its inline config, beside what
 * is already there: a provider the person configured under the same id stays
 * theirs. Each key goes in its own variable, never into
 * `OPENCODE_CONFIG_CONTENT`, which discovery's cache key and a launch's
 * diagnostics read.
 */
export function applyOpenCodeRoutes(env: NodeJS.ProcessEnv, launch: RoutedLaunch): NodeJS.ProcessEnv {
  const byConnection = new Map<string, ModelRoute[]>()
  for (const route of launch.routes)
    if (route.wire === "openai-chat" && route.baseUrl) byConnection.set(route.connection, [...(byConnection.get(route.connection) ?? []), route])
  if (!byConnection.size) return env
  const errors: ParseError[] = []
  const parsed = Config.safeParse(parse(env.OPENCODE_CONFIG_CONTENT || "{}", errors, { allowTrailingComma: true }))
  // An inline config OpenCode would refuse is left for it to refuse, as it would without Mako's providers.
  if (errors.length || !parsed.success) return env
  const providers = { ...parsed.data.providers }
  for (const [connection, routes] of byConnection) {
    const id = openCodeConnectionProvider(connection)
    if (id in providers) continue
    const key = launch.key(routes[0]!)
    providers[id] = openCodeProviderConfig(routes[0]!.connectionName, routes, key !== undefined)
    if (key !== undefined) env[openCodeConnectionKeyVariable(connection)] = key
  }
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ ...parsed.data, providers })
  return env
}

/**
 * OpenCode accepts any provider in its config, so every gateway, local server
 * and endpoint that speaks OpenAI's chat API runs in it, its models listed by
 * OpenCode's own discovery. Its Anthropic and Responses providers are the next
 * wires to prove.
 */
export const openCodeModelRoutes: ModelRouteAdapter = {
  kind: "accepts",
  wires: ["openai-chat"],
  kinds: ["gateway", "local", "custom"],
  via: "Each connection is a provider of its own (`mako-<id>`, `@ai-sdk/openai-compatible`) in `OPENCODE_CONFIG_CONTENT`, its key in a variable the provider names in `env`; OpenCode's discovery lists its models.",
  apply: applyOpenCodeRoutes,
  model: (connection, model) => `${openCodeConnectionProvider(connection)}/${model}`,
}
