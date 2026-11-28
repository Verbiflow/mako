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

/**
 * The levels Antigravity offers, least to most: a model's own list comes in
 * the order its legacy ids were written (agy 1.5.16 names Neon's
 * high, xhigh, medium, low), which reads as no order at all.
 */
const LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"]
const levelRank = (value: string) => {
  const rank = LEVELS.indexOf(value)
  return rank === -1 ? LEVELS.length : rank
}

/** One model's thinking levels as its session reports them once it runs that model, and the one it starts on. */
export interface AntigravityLevels {
  values: readonly { value: string; label: string }[]
  current?: string
}

/**
 * The model picker, and each model's own thinking levels. agy reports the
 * levels (`thought_level`) of the model its session runs only, and starts every
 * model it switches to on its first level (1.5.16: Low). `levels` holds what it
 * reported for each model once switched to it; a model it holds nothing for
 * reads its levels from the legacy list, which names every model/level pair by
 * a full wire id (`gemini-4-neon-xhigh`, "Gemini 4 Neon (XHigh)").
 */
export function antigravityCatalog(session: Pick<NewSessionResponse, "configOptions">, levels: ReadonlyMap<string, AntigravityLevels> = new Map()): HarnessModelCatalog {
  const options = normalizeAcpOptions(session.configOptions ?? [])
  const model = options.find((option) => option.id === "model")
  if (model?.kind !== "select") throw new Error("Antigravity did not return its model picker. Update the CLI and refresh.")
  const current = selectedModel.safeParse(model.current).data
  const legacy = legacyModels.safeParse(session).data?.models.availableModels ?? []
  const effort = options.find((option) => option.role === "reasoning")
  const reported = (id: string): AntigravityLevels | undefined => {
    const known = levels.get(id)
    if (known) return known
    if (id === current && effort?.kind === "select") return { values: effort.values, current: selectedModel.safeParse(effort.current).data }
    const values = legacy.filter((entry) => entry.modelId.startsWith(id + "-")).map((entry) => {
      const value = entry.modelId.slice(id.length + 1)
      return { value, label: entry.name.match(/\(([^()]+)\)$/)?.[1] ?? value }
    })
    return values.length ? { values } : undefined
  }
  return {
    models: model.values.map(({ value: id, label }) => {
      const own = reported(id)
      if (effort?.kind !== "select" || !own?.values.length) return { id, label, options: [] }
      const values = [...own.values].sort((a, b) => levelRank(a.value) - levelRank(b.value))
      // The level the model starts on is its default; without a report, the least, which is where agy starts one.
      const first = own.current && values.some((entry) => entry.value === own.current) ? own.current : values[0]!.value
      return { id, label, options: [{ ...effort, current: id === current ? effort.current : undefined,
        values: values.map((entry) => ({ value: entry.value, label: entry.label, ...entry.value === first && { default: true } })) }] }
    }),
    ...(current && { defaultModel: current, settings: { model: current, options: {} } }),
  }
}

const ReasoningOption = z.object({ id: z.string(), category: z.literal("thought_level"), type: z.literal("select"), currentValue: z.string().optional(),
  options: z.array(z.object({ value: z.string(), name: z.string() })) })

/** The thinking option of a session's options, as `antigravityCatalog` keeps it per model. */
export function antigravityLevels(configOptions: readonly unknown[] | null | undefined): AntigravityLevels | undefined {
  const option = (configOptions ?? []).map((entry) => ReasoningOption.safeParse(entry).data).find(Boolean)
  return option && { values: option.options.map(({ value, name }) => ({ value, label: name })), ...option.currentValue && { current: option.currentValue } }
}

export function antigravityProfile(processes: DiscoveryProcesses, dataRoot: string): ProviderProfileLoader {
  const keyTokens = new KeyTokens()
  const loader: ProviderProfileLoader = {
    provider: "antigravity", label: "Antigravity", transport: "acp",
    // agy 1.5.16's newest Gemini: first of the models its own config names to lead a task (`orchestrator-model-roles`:
    // gemini-4-neon, gemini-4-carbon, gemini-4-argon), first in its picker, and one of two with an XHigh level.
    defaults: { work: [{ model: "gemini-4-neon", options: { effort: "high" } }, { model: "gemini-3.1-pro", options: { effort: "high" } }] },
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
          const sessionId = previous?.sessionId ?? ("sessionId" in opened ? selectedModel.parse(opened.sessionId) : undefined)
          return antigravityCatalog(opened, sessionId ? await modelLevels(opened, (value) => client.setSessionConfigOption({ sessionId, configId: "model", value })) : undefined)
        } catch (error) {
          if (error instanceof RequestError && error.code === RequestError.authRequired().code)
            return { models: [], signInRequired: true, configurationError: "Antigravity isn't signed in. Send a message to sign in, or add a Gemini API key in Settings → Agents." } satisfies HarnessModelCatalog
          throw error
        }
      })
      return availableProviderProfile(loader, catalog)
    },
  }
  return loader
}

/**
 * Each model's thinking levels, read by switching the empty discovery session
 * to it: agy reports a model's levels only while its session runs that model.
 * A switch sends no prompt. The session is left on the model it had.
 */
async function modelLevels(session: Pick<NewSessionResponse, "configOptions">, select: (model: string) => Promise<{ configOptions?: readonly unknown[] | null }>): Promise<Map<string, AntigravityLevels>> {
  const levels = new Map<string, AntigravityLevels>()
  const picker = normalizeAcpOptions(session.configOptions ?? []).find((option) => option.id === "model")
  if (picker?.kind !== "select") return levels
  const current = selectedModel.safeParse(picker.current).data
  const own = antigravityLevels(session.configOptions)
  if (current && own) levels.set(current, own)
  for (const { value } of picker.values) {
    if (levels.has(value)) continue
    // A model the account can't switch to keeps the levels the legacy list names.
    const reported = antigravityLevels((await select(value).catch(() => ({ configOptions: [] }))).configOptions)
    if (reported) levels.set(value, reported)
  }
  if (current && picker.values.length > 1) await select(current).catch(() => undefined)
  return levels
}
