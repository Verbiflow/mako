import {
  normalizeDevinModels,
  type DevinModelListResponse,
} from "@mako/sessions/model-catalog"
import {
  availableProviderProfile,
  type ProviderProfileLoader,
} from "../profile-loader.js"
import { runDiscovery } from "../profile-transport.js"
import { devinExecutable } from "./executable.js"
import { devinDefaultModel } from "./settings.js"
import { homedir } from "node:os"
import { devinEnvironment } from "./environment.js"

export const devinProfileLoader: ProviderProfileLoader = {
  provider: "devin",
  label: "Devin",
  transport: "acp",
  capabilities: [
    "start",
    "resume",
    "stream",
    "interrupt",
    "steer",
    "permissions",
    "images",
    "commands",
    "mcp",
    "models",
  ],
  cacheKey: (env) => JSON.stringify(["standalone", devinExecutable(), env.XDG_CONFIG_HOME ?? "", env.XDG_DATA_HOME ?? ""]),
  async load(base, cwd, context) {
    const env = devinEnvironment(base)
    const executable = devinExecutable()
    if (!executable) throw new Error("Devin CLI is not installed")
    const parsed: DevinModelListResponse = JSON.parse(
      await runDiscovery(
        executable,
        ["models", "list", "--format", "json"],
        env,
        undefined,
        cwd,
        context?.signal
      )
    )
    parsed.default_model = await devinDefaultModel(
      executable,
      env,
      cwd ?? homedir(),
      context?.signal
    )
    return availableProviderProfile(
      devinProfileLoader,
      normalizeDevinModels(parsed)
    )
  },
}
