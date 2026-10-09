import {
  claudeDiscoveryArgs,
  claudeDiscoveryControl,
  claudeModelRefusal,
  ClaudeEffectiveSettingsSchema,
} from "./settings.js"
import { createHash } from "node:crypto"
import type { SessionSettings } from "@mako/sessions/settings"
import { normalizeClaudeModels } from "@mako/sessions/model-catalog"
import {
  availableProviderProfile,
  type ProviderProfileLoader,
} from "../profile-loader.js"
import { withDiscoveryStream } from "../profile-transport.js"
import { hostWarn } from "../../host-log.js"
import { claudeRuntime } from "./runtime.js"

import { z } from "zod"

const ModelsSchema = z.object({
  models: z.array(
    z.object({
      value: z.string(),
      resolvedModel: z.string().optional(),
      displayName: z.string().optional(),
      description: z.string().optional(),
      supportsEffort: z.boolean().optional(),
      supportedEffortLevels: z.array(z.string()).optional(),
      supportsFastMode: z.boolean().optional(),
    })
  ),
})

type Catalog = ReturnType<typeof normalizeClaudeModels>
const discoveries = new Map<
  string,
  { catalog: Promise<Catalog>; full: Promise<Catalog>; signal?: AbortSignal }
>()

// Native settings can depend on credentials, endpoint, executable and environment
// overrides. Hash the complete launch environment without persisting its values.
const environmentKey = (env: NodeJS.ProcessEnv) =>
  createHash("sha256")
    .update(
      JSON.stringify(
        Object.entries(env)
          .filter(([, value]) => value !== undefined)
          .sort(([left], [right]) => left.localeCompare(right))
      )
    )
    .digest("hex")
const discoveryKey = (env: NodeJS.ProcessEnv, cwd?: string) =>
  `${environmentKey(env)}:${cwd ?? process.cwd()}`

function discover(
  env: NodeJS.ProcessEnv,
  cwd?: string,
  publish?: (catalog: Catalog) => void,
  signal?: AbortSignal
) {
  // Only the executable sessions launch may name models: a newer `claude` on
  // PATH lists models the session runtime rejects.
  const runtime = claudeRuntime(env)
  if (!runtime)
    return Promise.reject(new Error("Claude Code is unavailable"))
  return withDiscoveryStream(
    {
      command: runtime.executable,
      args: claudeDiscoveryArgs,
      env,
      cwd,
      priority: publish ? "background" : "launch",
      signal,
    },
    async (stream) => {
      const control = claudeDiscoveryControl(stream)
      const catalog = normalizeClaudeModels(
        ModelsSchema.parse(await control({ subtype: "list_models" })).models
      )
      if (!publish) return catalog
      // Sending can use the immutable catalog while this process reads defaults.
      publish(structuredClone(catalog))
      for (const model of catalog.models) {
        // Claude Code lists models its version doesn't describe and refuses
        // to switch to them; its check with the API also fails now and then,
        // which a second try usually passes.
        const switchTo = () => control({ subtype: "set_model", model: model.id }).then(
          () => undefined,
          (error: Error) => error.message
        )
        let refused = await switchTo()
        if (refused !== undefined && claudeModelRefusal(refused) === undefined) refused = await switchTo()
        if (refused !== undefined) {
          const reason = claudeModelRefusal(refused)
          if (reason) model.unavailable = reason
          hostWarn("discovery", reason ? "Claude Code refused a model it listed" : "Claude Code couldn't confirm a model; its defaults stay unread", { model: model.id, error: refused })
          continue
        }
        try {
          const settings = ClaudeEffectiveSettingsSchema.parse(
            await control({ subtype: "get_settings" })
          )
          for (const option of model.options) {
            if (option.id === "effort" && option.kind === "select")
              option.current = settings.effort
            if (option.id === "fast" && option.kind === "boolean")
              option.current = option.disabledReason ? false : settings.fast
          }
          if (model.id === catalog.defaultModel) {
            const options: NonNullable<SessionSettings["options"]> = {}
            if (settings.effort) options.effort = settings.effort
            const speed = model.options.find((option) => option.id === "fast")
            if (speed?.current !== undefined) options.fast = speed.current
            catalog.settings = { model: model.id, options }
          }
        } catch {
          catalog.configurationError =
            "Claude Code could not report all model defaults. Unreported values remain unknown."
        }
      }
      return catalog
    }
  )
}

export const claudeProfileLoader: ProviderProfileLoader = {
  provider: "claude",
  label: "Claude Code",
  defaults: {
    work: [{ model: "claude-opus-5-5", options: { effort: "high", fast: false } }],
  },
  transport: "sdk",
  nativeModelIds: true,
  cacheKey: environmentKey,
  async loadForSend(env, cwd, context) {
    const entry = discoveries.get(discoveryKey(env, cwd))
    const catalog = await (entry && !entry.signal?.aborted ? entry.catalog : discover(env, cwd, undefined, context?.signal))
    context?.signal.throwIfAborted()
    return availableProviderProfile(claudeProfileLoader, catalog)
  },
  async load(env, cwd, context) {
    const key = discoveryKey(env, cwd)
    let entry = discoveries.get(key)
    if (entry?.signal?.aborted) { discoveries.delete(key); entry = undefined }
    if (!entry) {
      let publish!: (catalog: Catalog) => void
      let rejectCatalog!: (error: Error) => void
      const catalog = new Promise<Catalog>((resolve, reject) => {
        publish = resolve
        rejectCatalog = reject
      })
      // The display caller awaits full; a send may never subscribe to catalog.
      void catalog.catch(() => {})
      const full = discover(env, cwd, publish, context?.signal)
        .catch((error: Error) => {
          rejectCatalog(error)
          throw error
        })
        .finally(() => {
          if (discoveries.get(key)?.full === full) discoveries.delete(key)
        })
      entry = { catalog, full, signal: context?.signal }
      discoveries.set(key, entry)
    }
    return availableProviderProfile(
      claudeProfileLoader,
      structuredClone(await entry.full)
    )
  },
}
