import { z } from "zod"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import type { NewSessionResponse } from "@agentclientprotocol/sdk"
import { normalizeAcpOptions, type HarnessModelCatalog } from "@mako/sessions/model-catalog"
import { childInput } from "@mako/sessions/child-input"
import { heavy } from "../../base/heavy-packages.js"
import { resolveExecutable } from "../../base/executable.js"
import { acpReadable, acpWritable } from "../acp-stream.js"
import { credentialFingerprint, KeyTokens } from "../accounts-common.js"
import type { DiscoveryProcesses } from "../discovery-process.js"
import { availableProviderProfile, type ProviderProfileLoader } from "../profile-loader.js"
import { agyArgs } from "./acp.js"

const legacyModels = z.object({ models: z.object({ availableModels: z.array(z.object({ modelId: z.string(), name: z.string() })) }) })
const selectedModel = z.string()

export function antigravityCatalog(session: Pick<NewSessionResponse, "configOptions">): HarnessModelCatalog {
  const options = normalizeAcpOptions(session.configOptions ?? [])
  const model = options.find((option) => option.id === "model")
  if (model?.kind !== "select") throw new Error("Antigravity did not return its model picker. Update the CLI and refresh.")
  const current = selectedModel.safeParse(model.current).data
  const levels = legacyModels.safeParse(session).data?.models.availableModels ?? []
  const effort = options.find((option) => option.role === "reasoning")
  const nano = model.values.find(({ value, label }) => value === "gemini-nano" || label.trim().toLowerCase() === "gemini nano")
  const preferred = selectedModel.safeParse(nano?.value ?? current).data
  return {
    models: model.values.map(({ value: id, label }) => {
      // The current model's picker omits levels other models support. The legacy list
      // names every allowed model/effort pair using its full wire id.
      const values = levels.filter((entry) => entry.modelId.startsWith(id + "-")).map((entry) => {
        const value = entry.modelId.slice(id.length + 1)
        return { value, label: entry.name.match(/\(([^()]+)\)$/)?.[1] ?? value }
      })
      return { id, label, options: effort?.kind === "select" && values.length
        ? [{ ...effort, current: id === model.current ? effort.current : undefined, values }] : [] }
    }),
    ...(current && { defaultModel: current }),
    ...(preferred && { settings: { model: preferred, options: {} } }),
  }
}

export function antigravityProfile(processes: DiscoveryProcesses, dataRoot: string): ProviderProfileLoader {
  const keyTokens = new KeyTokens()
  const loader: ProviderProfileLoader = {
    provider: "antigravity", label: "Antigravity", transport: "acp",
    defaults: { work: [], none: "Use Gemini Nano when the account offers it, otherwise the agent's selected model." },
    cacheKey: (env) => credentialFingerprint([env.GEMINI_HOME ?? null, keyTokens.of(env.GEMINI_API_KEY), env.PATH ?? null]),
    async load(env, _cwd, context) {
      const command = resolveExecutable("agy", env)
      if (!command) throw new Error("Install Antigravity CLI to use this harness.")
      const cwd = join(dataRoot, "antigravity-models")
      await mkdir(cwd, { recursive: true, mode: 0o700 })
      const { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION, RequestError } = await heavy.acpSdk.load("Antigravity models")
      const catalog: HarnessModelCatalog = await processes.run({ command, args: agyArgs(env), env, cwd, signal: context?.signal }, async ({ child }) => {
        const client = new ClientSideConnection(() => ({
          requestPermission: async () => ({ outcome: { outcome: "cancelled" } }), sessionUpdate: async () => {},
        }), ndJsonStream(acpWritable(childInput(child)), acpReadable(child.stdout)))
        await client.initialize({ protocolVersion: PROTOCOL_VERSION, clientInfo: { name: "mako", version: "1" }, clientCapabilities: {} })
        if (env.GEMINI_API_KEY) await client.authenticate({ methodId: "gemini-api-key" })
        // Only reuse our empty discovery session. No prompt or project MCP server runs.
        try {
          const previous = (await client.listSessions({ cwd })).sessions.find((entry) => entry.cwd === cwd)
          const request = { cwd, mcpServers: [] }
          const opened = previous ? await client.loadSession({ ...request, sessionId: previous.sessionId }) : await client.newSession(request)
          return antigravityCatalog(opened)
        } catch (error) {
          if (error instanceof RequestError && error.code === RequestError.authRequired().code)
            return { models: [], configurationError: "Antigravity isn't signed in. Sign in or add a Gemini API key in Settings → Agents." } satisfies HarnessModelCatalog
          throw error
        }
      })
      return availableProviderProfile(loader, catalog)
    },
  }
  return loader
}
