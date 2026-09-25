import { resolveCodexExecutable } from "./executable.js"
import {
  normalizeCodexModels,
  type CodexModelListResponse,
} from "@mako/sessions/model-catalog"
import {
  availableProviderProfile,
  type ProviderProfileLoader,
} from "../profile-loader.js"
import { withDiscoveryRpc } from "../profile-transport.js"
import { z } from "zod"
import { CodexConfigSchema, codexConfiguredSettings } from "./settings.js"

const ModelPageSchema = z.object({
  data: z.array(
    z.object({
      model: z.string(),
      displayName: z.string().optional(),
      description: z.string().optional(),
      isDefault: z.boolean().optional(),
      defaultReasoningEffort: z.string().optional(),
      supportedReasoningEfforts: z
        .array(z.object({ reasoningEffort: z.string() }))
        .optional(),
      defaultServiceTier: z
        .string()
        .nullish()
        .transform((value) => value ?? undefined),
      serviceTiers: z
        .array(
          z.object({
            id: z.string(),
            name: z.string().optional(),
            description: z.string().optional(),
          })
        )
        .optional(),
      additionalSpeedTiers: z.array(z.string()).optional(),
    })
  ),
  nextCursor: z.string().nullish(),
})

type ModelListParams = { limit: number; cursor?: string }
type ConfigReadParams = { includeLayers: boolean; cwd?: string }

export const codexProfileLoader: ProviderProfileLoader = {
  provider: "codex",
  label: "Codex",
  transport: "app-server",
  capabilities: [
    "start",
    "resume",
    "fork-at-turn",
    "stream",
    "steer",
    "interrupt",
    "permissions",
    "images",
    "audio",
    "skills",
    "mcp",
    "models",
    "review",
  ],
  cacheKey: (env) => `${env.CODEX_HOME ?? ""}\0${env.CODEX_EXECUTABLE ?? ""}`,
  async load(env, cwd) {
    const executable = await resolveCodexExecutable(env)
    if (!executable)
      throw new Error("The selected Codex executable is not available")
    return withDiscoveryRpc(
      { command: executable, args: ["app-server"], env, cwd, jsonrpc: false },
      async (rpc) => {
        const result: CodexModelListResponse = { data: [] }
        let cursor: string | undefined
        const seen = new Set<string>()
        do {
          const params: ModelListParams = { limit: 100 }
          if (cursor) params.cursor = cursor
          const page = ModelPageSchema.parse(
            await rpc.request("model/list", params)
          )
          result.data?.push(...page.data)
          cursor = page.nextCursor ?? undefined
          if (cursor && seen.has(cursor))
            throw new Error("Codex repeated its model catalog cursor")
          if (cursor) seen.add(cursor)
        } while (cursor)
        const catalog = normalizeCodexModels(result)
        try {
          const params: ConfigReadParams = { includeLayers: false }
          if (cwd) params.cwd = cwd
          const config = CodexConfigSchema.parse(
            await rpc.request("config/read", params)
          )
          catalog.settings = codexConfiguredSettings(catalog, config)
          catalog.configuredModel = config.config.model ?? undefined
        } catch {
          catalog.configurationError =
            "Codex configuration could not be read. Settings will be confirmed when the session opens."
        }
        return availableProviderProfile(codexProfileLoader, catalog)
      }
    )
  },
}
