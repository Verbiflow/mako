import { join } from "node:path"
import {
  normalizeGrokModels,
  type GrokModelCache,
} from "@mako/sessions/model-catalog"
import {
  availableProviderProfile,
  type ProviderProfileLoader,
} from "../profile-loader.js"
import { resolveExecutable } from "../../executable.js"
import { readJson, runDiscovery } from "../profile-transport.js"
import { grokHome } from "@mako/sessions"

export const grokProfileLoader: ProviderProfileLoader = {
  provider: "grok",
  label: "Grok",
  defaults: {
    work: [{ model: "grok-4.7", options: { effort: "high" } }],
  },
  transport: "acp",
  cacheKey: (env) => `${env.GROK_HOME ?? ""}\0${env.GROK_AUTH_PATH ?? ""}`,
  async load(env, cwd, context) {
    const executable = resolveExecutable("grok", env)
    if (!executable) throw new Error("Grok is not installed")
    const output = await runDiscovery(
      executable,
      ["models"],
      env,
      undefined,
      cwd,
      context?.signal
    )
    const cached = await readJson<GrokModelCache>(
      join(grokHome(env), "models_cache.json")
    )
    return availableProviderProfile(
      grokProfileLoader,
      normalizeGrokModels(output, cached)
    )
  },
}
