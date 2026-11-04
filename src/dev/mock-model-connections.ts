import {
  MODEL_CONNECTION_PROVIDERS,
  type ConnectionModel,
  type LocalModelServer,
  type ModelConnectionCheck,
  type ModelConnectionCheckInput,
  type ModelConnectionInput,
  type ModelConnectionsSnapshot,
  type ModelConnectionTest,
  type ModelConnectionView,
} from "@mako/host/contracts/model-connections"
import { routeAccepted, type HarnessModelRoutes } from "@mako/host/contracts/model-routes"

const OPENROUTER_MODELS: ConnectionModel[] = [
  { id: "anthropic/claude-sonnet-4.5", name: "Anthropic: Claude Sonnet 4.5", contextTokens: 1_000_000 },
  { id: "deepseek/deepseek-v3.2", name: "DeepSeek: DeepSeek V3.2", contextTokens: 163_840 },
  { id: "google/gemini-3-pro-preview", name: "Google: Gemini 3 Pro Preview", contextTokens: 1_048_576 },
  { id: "moonshotai/kimi-k2-thinking", name: "MoonshotAI: Kimi K2 Thinking", contextTokens: 262_144 },
  { id: "openai/gpt-5.1-codex", name: "OpenAI: GPT-5.1-Codex", contextTokens: 400_000 },
  { id: "qwen/qwen3-coder", name: "Qwen: Qwen3 Coder 480B A35B", contextTokens: 262_144 },
  { id: "x-ai/grok-code-fast-1", name: "xAI: Grok Code Fast 1", contextTokens: 256_000 },
  { id: "z-ai/glm-4.6", name: "Z.AI: GLM 4.6", contextTokens: 202_752 },
]
/** What each harness's driver declares, as the host reports it. */
const HARNESSES: HarnessModelRoutes[] = [
  { harness: "claude", routes: { kind: "planned", wires: ["anthropic"], via: "`ANTHROPIC_BASE_URL` and a key in one launch's environment." } },
  { harness: "codex", routes: { kind: "planned", wires: ["openai-chat", "openai-responses"], via: "A provider in `config.model_providers` and `modelProvider` on `thread/start`." } },
  { harness: "cursor", routes: { kind: "absent", reason: "Cursor's SDK runs its models through Cursor's own service." } },
  { harness: "opencode", routes: { kind: "accepts", wires: ["openai-chat"], kinds: ["gateway", "local", "custom"], via: "Each connection is a provider of its own in OpenCode's inline config." } },
  { harness: "grok", routes: { kind: "absent", reason: "The Grok CLI runs on xAI's models through the person's Grok sign-in." } },
  { harness: "devin", routes: { kind: "absent", reason: "Devin runs its models through Devin's own service." } },
]
const OLLAMA_MODELS: ConnectionModel[] = [{ id: "gpt-oss:20b" }, { id: "qwen3-coder:30b" }, { id: "llama3.2:latest" }]

/**
 * Settings › Models › Connections for `?mock`: an OpenRouter key and Ollama on
 * this Mac, with Ollama running and LM Studio not. `connections=0` starts with
 * none. Check access answers after a moment; a key ending `refused` is
 * refused, and a URL on port 9 has nothing listening, so each error can be seen.
 */
export function mockModelConnections() {
  const empty = new URLSearchParams(globalThis.location?.search).get("connections") === "0"
  const serving = (view: Omit<ModelConnectionView, "serves">): ModelConnectionView => ({
    ...view,
    serves: view.enabled ? HARNESSES.filter(({ routes }) => routeAccepted(routes, view.kind, view.wire)).map(({ harness }) => ({ harness, models: view.models.length })) : [],
  })
  let kept: ModelConnectionView[] = empty ? [] : [
    serving({ id: "openrouter", provider: "openrouter", kind: "gateway", name: "OpenRouter", wire: "openai-chat", baseUrl: "https://openrouter.ai/api/v1", models: Array.from({ length: 42 }, (_, index) => OPENROUTER_MODELS[index % OPENROUTER_MODELS.length]!).map((model, index) => index < OPENROUTER_MODELS.length ? model : { ...model, id: `${model.id}-${index}` }), enabled: true, credential: { kind: "keychain", name: "connection/openrouter" }, addedAt: "2026-10-28T10:00:00.000Z" }),
    serving({ id: "ollama", provider: "ollama", kind: "local", name: "Ollama", wire: "openai-chat", baseUrl: "http://localhost:11434/v1", models: OLLAMA_MODELS, enabled: true, credential: null, addedAt: "2026-11-01T09:00:00.000Z" }),
  ]
  const pause = (ms = 700) => new Promise((resolve) => setTimeout(resolve, ms))
  const listed = (input: ModelConnectionCheckInput): ModelConnectionCheck => {
    const provider = MODEL_CONNECTION_PROVIDERS.find((entry) => entry.id === input.provider)
    if (!provider) throw new Error("Subscriptions connect through their harness's own sign-in.")
    const baseUrl = (input.baseUrl?.trim() || provider.baseUrl || "").replace(/\/+$/, "")
    if (!baseUrl) throw new Error("Enter the endpoint's full base URL, including /v1 if it needs one.")
    if (provider.key === "required" && !input.apiKey?.trim()) throw new Error(`Paste your ${provider.name} API key.`)
    if (input.apiKey?.endsWith("refused")) throw new Error("The endpoint refused this key. Check the key and its permissions.")
    if (/:9\//.test(`${baseUrl}/`)) throw new Error("Couldn't reach the endpoint. Check the URL and that it's running.")
    if (provider.id === "lmstudio") throw new Error("Couldn't reach the endpoint. Check the URL and that it's running.")
    return { baseUrl, models: provider.kind === "local" ? OLLAMA_MODELS : OPENROUTER_MODELS }
  }
  return {
    modelConnections: async (): Promise<ModelConnectionsSnapshot> => ({ connections: kept, issues: [], secureStorage: true, harnesses: HARNESSES }),
    checkModelConnection: async (input: ModelConnectionCheckInput) => {
      await pause()
      return listed(input)
    },
    addModelConnection: async (input: ModelConnectionInput) => {
      await pause(400)
      const { baseUrl } = listed(input)
      const provider = MODEL_CONNECTION_PROVIDERS.find((entry) => entry.id === input.provider)!
      const id = provider.kind === "custom" || provider.id === "local" ? `${provider.id === "local" ? "local" : "custom"}-${kept.length}` : provider.id
      if (kept.some((connection) => connection.id === id)) throw new Error(`${provider.name} is already connected. Remove it to connect it again.`)
      const view = serving({ id, provider: provider.id, kind: provider.kind, name: input.name?.trim() || provider.name, wire: provider.wire ?? "openai-chat", baseUrl, models: input.models, enabled: true, credential: input.apiKey ? { kind: "keychain", name: `connection/${id}` } : null, addedAt: new Date().toISOString() })
      kept = [...kept, view]
      return view
    },
    enableModelConnection: async (id: string, enabled: boolean) => {
      kept = kept.map((connection) => (connection.id === id ? serving({ ...connection, enabled }) : connection))
    },
    removeModelConnection: async (id: string) => {
      await pause(300)
      kept = kept.filter((connection) => connection.id !== id)
    },
    testModelConnection: async (id: string): Promise<ModelConnectionTest> => {
      await pause()
      const connection = kept.find((entry) => entry.id === id)
      if (!connection) throw new Error("That connection is gone. Refresh to see your connections.")
      return connection.kind === "local" ? { listed: 3, missing: [] } : { listed: 341, missing: connection.models.slice(0, 1).map((model) => model.id) }
    },
    localModelServers: async (): Promise<LocalModelServer[]> => {
      await pause(300)
      return [
        { provider: "ollama", running: true, models: OLLAMA_MODELS },
        { provider: "lmstudio", running: false, models: [] },
      ]
    },
  }
}
