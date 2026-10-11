import type { NativeStores } from "@mako/sessions/read-only-sqlite"
import {
  normalizeDevinModels,
  type DevinModelListResponse,
} from "@mako/sessions/model-catalog"
import {
  availableProviderProfile,
  type ProviderProfileLoader,
} from "../profile-loader.js"
import { runDiscovery } from "../profile-transport.js"
import type { DiscoveryProcesses } from "../discovery-process.js"
import { devinExecutable } from "./executable.js"
import { devinDefaultModel } from "./settings.js"
import { homedir } from "node:os"
import { devinEnvironment } from "./environment.js"

export function devinProfileLoader(stores: NativeStores, processes: DiscoveryProcesses): ProviderProfileLoader {
  const loader: ProviderProfileLoader = {
    provider: "devin",
    label: "Devin",
    defaults: {
      work: [{ model: "swe-2", options: { effort: "high" } }],
    },
    transport: "acp",
    cacheKey: (env) => JSON.stringify(["standalone", devinExecutable(), env.XDG_CONFIG_HOME ?? "", env.XDG_DATA_HOME ?? ""]),
    async load(base, cwd, context) {
      const env = devinEnvironment(base)
      const executable = devinExecutable()
      if (!executable) throw new Error("Devin CLI is not installed")
      const parsed: DevinModelListResponse = JSON.parse(
        await runDiscovery(
          processes,
          executable,
          ["models", "list", "--format", "json"],
          env,
          undefined,
          cwd,
          context?.signal
        )
      )
      parsed.default_model = await devinDefaultModel(
        stores,
        processes,
        executable,
        env,
        cwd ?? homedir(),
        context?.signal
      )
      return availableProviderProfile(
        loader,
        normalizeDevinModels(parsed)
      )
    },
  }
  return loader
}
