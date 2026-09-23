import { homedir } from "node:os"
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

export const grokProfileLoader: ProviderProfileLoader = {
  provider: "grok",
  label: "Grok",
  transport: "acp",
  capabilities: [
    "start",
    "resume",
    "fork",
    "stream",
    "interrupt",
    "steer",
    "permissions",
    "images",
    "commands",
    "mcp",
    "models",
    "memory",
  ],
  cacheKey: (env) => `${env.GROK_HOME ?? ""}\0${env.GROK_AUTH_PATH ?? ""}`,
  async load(env, cwd) {
    const executable = resolveExecutable("grok", env)
    if (!executable) throw new Error("Grok is not installed")
    const output = await runDiscovery(
      executable,
      ["models"],
      env,
      undefined,
      cwd
    )
    const cached = await readJson<GrokModelCache>(
      join(env.GROK_HOME ?? join(homedir(), ".grok"), "models_cache.json")
    )
    return availableProviderProfile(
      grokProfileLoader,
      normalizeGrokModels(output, cached)
    )
  },
}
