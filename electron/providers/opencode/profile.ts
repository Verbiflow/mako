import { existsSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { OpenCodeEvent } from "@opencode/client"
import type { HarnessModelCatalog } from "@mako/sessions/model-catalog"
import {
  availableProviderProfile,
  type ProviderProfileLoader,
} from "../profile-loader.js"
import { ProviderLaunchTrace } from "../../provider-launch.js"
import { resolveOpenCodeInstallation } from "./installation.js"
import { startOpenCodeApi } from "./native-api.js"
import { loadOpenCodeCatalog, openCodeLaunchId, type OpenCodeCatalog } from "./catalog.js"

const CATALOG_EVENTS = new Set<OpenCodeEvent["type"]>(["catalog.updated", "agent.updated", "command.updated", "skill.updated"])

export const openCodeProfileLoader: ProviderProfileLoader = {
  provider: "opencode",
  label: "OpenCode",
  transport: "sdk",
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
    const configuration = JSON.stringify([env.XDG_DATA_HOME, env.XDG_CACHE_HOME, env.XDG_CONFIG_HOME, env.OPENCODE_CONFIG_DIR,
      env.OPENCODE_CONFIG, env.OPENCODE_CONFIG_CONTENT, env.OPENCODE_BIN_PATH, env.OPENCODE2_BIN_PATH])
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
    const installation = await resolveOpenCodeInstallation(env)
    const directory = cwd && existsSync(cwd) ? cwd : homedir()
    const catalog = await discoverOpenCodeCatalog(installation.command, env, directory)
    if (!catalog.models.length)
      throw new Error("OpenCode reported no enabled models for this workspace")
    const profile: HarnessModelCatalog = { models: catalog.models }
    const fallback = catalog.defaultModel && openCodeLaunchId(catalog.defaultModel)
    const model = fallback ? catalog.models.find((candidate) => candidate.id === fallback) : undefined
    if (model) {
      profile.defaultModel = model.id
      profile.settings = {
        model: model.id,
        options: Object.fromEntries(
          model.options.flatMap((option) =>
            option.current === undefined ? [] : [[option.id, option.current]]
          )
        ),
      }
    } else {
      profile.configurationError = fallback
        ? "OpenCode's default model is not in its enabled catalog. Choose a model for this conversation."
        : "OpenCode has no default model configured. Choose a model for this conversation."
    }
    return availableProviderProfile(openCodeProfileLoader, profile)
  },
}

/**
 * The same native catalog a session reads, from a short-lived server. A
 * catalog change reported while loading (OpenCode refreshes models after
 * startup) is read again rather than answered from the older list.
 */
async function discoverOpenCodeCatalog(command: string, env: NodeJS.ProcessEnv, directory: string): Promise<OpenCodeCatalog> {
  const trace = new ProviderLaunchTrace({ provider: "opencode", conversation: "model-discovery" }, { report() {} })
  const api = await startOpenCodeApi({ command, cwd: directory, env, conversationId: "model-discovery", trace })
  const stream = new AbortController()
  try {
    const events = api.client.event.subscribe({ signal: AbortSignal.any([stream.signal, api.signal]) })[Symbol.asyncIterator]()
    const hello = await api.watch.step("event stream", events.next())
    if (hello.done || hello.value.type !== "server.connected") throw new Error("OpenCode's event stream did not open")
    let changes = 0
    void (async () => {
      for (;;) {
        const next = await events.next()
        if (next.done) return
        if (CATALOG_EVENTS.has(next.value.type) && (!next.value.location || next.value.location.directory === directory)) changes++
      }
    })().catch(() => {})
    await api.watch.step("plugin activation", api.client.plugin.awaitActivation({ location: { directory } }))
    for (;;) {
      const seen = changes
      const catalog = await api.watch.step("catalog", loadOpenCodeCatalog(api.client, directory, api.signal))
      if (seen === changes) return catalog
    }
  } finally {
    stream.abort()
    await api.close()
  }
}
