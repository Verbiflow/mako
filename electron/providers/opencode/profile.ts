import { statSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import {
  normalizeOpenCodeModels,
  type OpenCodeModelRow,
} from "@mako/sessions/model-catalog"
import {
  availableProviderProfile,
  type ProviderProfileLoader,
} from "../profile-loader.js"
import { runDiscovery } from "../profile-transport.js"
import { resolveOpenCodeInstallation } from "./installation.js"

const ModelSchema = z.object({
  id: z.string(),
  providerID: z.string(),
  name: z.string().optional(),
  family: z.string().optional(),
  status: z.string().optional(),
  variants: z
    .record(
      z.string(),
      z.object({ reasoningEffort: z.string().optional() }).passthrough()
    )
    .optional(),
  limit: z
    .object({ context: z.number().optional(), output: z.number().optional() })
    .optional(),
  capabilities: z
    .object({
      reasoning: z.boolean().optional(),
      input: z
        .object({ text: z.boolean().optional(), image: z.boolean().optional() })
        .optional(),
    })
    .optional(),
})

const CacheModelSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    family: z.string().optional(),
    status: z.string().optional(),
    reasoning: z.boolean().optional(),
    reasoning_options: z
      .union([
        z.record(z.string(), z.unknown()),
        z.array(
          z.object({
            type: z.string(),
            values: z.array(z.string()),
          })
        ),
      ])
      .optional(),
    attachment: z.boolean().optional(),
    limit: z
      .object({
        context: z.number().optional(),
        output: z.number().optional(),
      })
      .optional(),
  })
  .passthrough()

const CacheProviderSchema = z
  .object({ models: z.record(z.string(), z.unknown()) })
  .passthrough()
const CacheSchema = z.record(z.string(), z.unknown())
const ConfigSchema = z.object({
  model: z.string().optional(),
  default_agent: z.string().optional(),
  agent: z
    .record(
      z.string(),
      z.object({ model: z.string().optional(), variant: z.string().optional() })
    )
    .optional(),
})
const DefaultModelSchema = z.object({
  data: z.object({
    id: z.string().min(1),
    providerID: z.string().min(1),
    variants: z.array(z.object({ id: z.string().min(1) })).optional(),
  }),
})

export const openCodeProfileLoader: ProviderProfileLoader = {
  provider: "opencode",
  label: "OpenCode",
  transport: "acp",
  capabilities: [
    "start",
    "resume",
    "fork",
    "stream",
    "interrupt",
    "permissions",
    "images",
    "commands",
    "mcp",
    "models",
    "agents",
  ],
  cacheKey: (env) => {
    const configuration = JSON.stringify([env.XDG_DATA_HOME, env.XDG_CACHE_HOME, env.OPENCODE_BIN_PATH, env.OPENCODE1_BIN_PATH, env.OPENCODE2_BIN_PATH])
    try {
      const info = statSync(
        join(env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode", "auth.json")
      )
      return `${configuration}:${info.mtimeMs}:${info.size}`
    } catch {
      return `${configuration}:missing`
    }
  },
  async load(env, cwd) {
    const installation = await resolveOpenCodeInstallation(undefined, env)
    let output = await runDiscovery(
      installation.command,
      installation.generation === "v2" ? ["models"] : ["models", "--verbose"],
      env,
      undefined,
      cwd
    )
    // OpenCode v2 registers a cold workspace on its first request and can
    // return an empty successful response. Read again after that completes.
    if (installation.generation === "v2" && !output.trim()) {
      output = await runDiscovery(
        installation.command,
        ["models"],
        env,
        undefined,
        cwd
      )
    }
    const rows =
      installation.generation === "v2"
        ? await v2Models(output, env)
        : parseModels(output)
    const catalog = normalizeOpenCodeModels(rows)
    if (!catalog.models.length)
      throw new Error(
        "OpenCode did not report any models after workspace initialization"
      )
    try {
      if (installation.generation === "v2") {
        const query = cwd
          ? `?location[directory]=${encodeURIComponent(cwd)}`
          : ""
        const response = DefaultModelSchema.parse(
          JSON.parse(
            await runDiscovery(
              installation.command,
              ["api", "GET", `/api/model/default${query}`],
              env,
              undefined,
              cwd
            )
          )
        )
        const identity = `${response.data.providerID}/${response.data.id}`
        const model = catalog.models.find((model) => model.id === identity)
        if (!model)
          throw new Error(
            "OpenCode's default model is missing from its catalog"
          )
        if (response.data.variants) {
          const variants = response.data.variants.map((variant) => variant.id)
          model.options = normalizeOpenCodeModels([
            {
              id: response.data.id,
              providerID: response.data.providerID,
              variants: Object.fromEntries(variants.map((id) => [id, {}])),
              defaultVariant: variants.includes("default")
                ? "default"
                : variants[0],
            },
          ]).models.flatMap((entry) => entry.options)
        }
        catalog.defaultModel = identity
        catalog.settings = {
          model: identity,
          options: Object.fromEntries(
            model.options.flatMap((option) =>
              option.current === undefined ? [] : [[option.id, option.current]]
            )
          ),
        }
        return availableProviderProfile(openCodeProfileLoader, catalog)
      }
      const config = ConfigSchema.parse(
        JSON.parse(
          await runDiscovery(
            installation.command,
            ["debug", "config"],
            env,
            undefined,
            cwd
          )
        )
      )
      const agent = config.agent?.[config.default_agent ?? "build"]
      const configured = agent?.model ?? config.model
      if (configured) {
        catalog.configuredModel = configured
        catalog.settings = {
          model: configured,
          options: agent?.variant ? { effort: agent.variant } : {},
        }
      }
    } catch {
      catalog.configurationError =
        "OpenCode did not report its resolved configuration. Its defaults will be confirmed when the session opens."
    }
    return availableProviderProfile(openCodeProfileLoader, catalog)
  },
}

async function v2Models(output: string, env: NodeJS.ProcessEnv): Promise<OpenCodeModelRow[]> {
  let cached: z.infer<typeof CacheSchema> = {}
  try {
    const parsed = CacheSchema.safeParse(
      JSON.parse(
        await readFile(
          join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), "opencode", "models.json"),
          "utf8"
        )
      )
    )
    if (parsed.success) cached = parsed.data
  } catch {
    cached = {}
  }

  return output.split(/\r?\n/).flatMap((line): OpenCodeModelRow[] => {
    const identity = line.trim()
    const separator = identity.indexOf("/")
    if (separator <= 0) return []
    const providerID = identity.slice(0, separator)
    const id = identity.slice(separator + 1)
    const cachedProvider = CacheProviderSchema.safeParse(cached[providerID])
    const cachedModel = CacheModelSchema.safeParse(
      cachedProvider.success ? cachedProvider.data.models[id] : undefined
    )
    const baseId = id.endsWith("-fast") ? id.slice(0, -5) : id
    const cachedBase = CacheModelSchema.safeParse(
      cachedProvider.success ? cachedProvider.data.models[baseId] : undefined
    )
    const model = cachedModel.success
      ? cachedModel.data
      : cachedBase.success
        ? cachedBase.data
        : undefined
    const name = model && baseId !== id ? `${model.name} Fast` : model?.name
    const reasoning = Array.isArray(model?.reasoning_options)
      ? model.reasoning_options.flatMap((option) => option.values)
      : Object.keys(model?.reasoning_options ?? {})
    return [
      {
        providerID,
        id,
        name,
        family: model?.family,
        status: model?.status,
        defaultVariant: reasoning.includes("default")
          ? "default"
          : reasoning[0],
        variants:
          reasoning.length > 0
            ? Object.fromEntries(reasoning.map((value) => [value, {}]))
            : undefined,
        limit: model?.limit,
        capabilities: {
          reasoning: model?.reasoning,
          input: { text: true, image: model?.attachment },
        },
      },
    ]
  })
}

function parseModels(output: string): OpenCodeModelRow[] {
  const rows: OpenCodeModelRow[] = []
  let start = output.indexOf("{")
  while (start >= 0) {
    let depth = 0
    let quoted = false
    let escaped = false
    let end = start
    for (; end < output.length; end += 1) {
      const character = output[end]!
      if (escaped) {
        escaped = false
        continue
      }
      if (character === "\\" && quoted) {
        escaped = true
        continue
      }
      if (character === '"') quoted = !quoted
      if (quoted) continue
      if (character === "{") depth += 1
      if (character === "}") depth -= 1
      if (depth === 0) {
        end += 1
        break
      }
    }
    try {
      const parsed = ModelSchema.safeParse(JSON.parse(output.slice(start, end)))
      if (parsed.success) rows.push(parsed.data)
    } catch {
      return rows
    }
    start = output.indexOf("{", end)
  }
  return rows
}
