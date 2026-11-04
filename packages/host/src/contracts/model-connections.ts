/**
 * Every way the person pays for models, in one list. A subscription is a
 * harness's own sign-in (its accounts); a gateway, a local server or a custom
 * endpoint is a connection Mako keeps once, its key in the keychain, and hands
 * to the harnesses that accept any provider.
 */
export type ModelConnectionKind = "subscription" | "gateway" | "local" | "custom"

/** Whether a provider asks for a key: always, when its server is set up to, or never. */
export type ModelConnectionKey = "required" | "optional" | "none"

/** One entry of the Add a connection list. */
export interface ModelConnectionProvider {
  id: string
  name: string
  kind: ModelConnectionKind
  description: string
  /** Where its OpenAI-compatible API is, when Mako knows it. */
  baseUrl?: string
  /** The person enters or changes the URL to their own gateway, region or server; `<…>` marks what they fill in. */
  urlHint?: string
  key: ModelConnectionKey
  /** Where a key is made. */
  keyUrl?: string
  /** A subscription: the harness whose sign-in it is. */
  harness?: string
  /** A subscription served through OpenCode: the provider OpenCode signs in to. */
  openCodeProvider?: string
}

export const MODEL_CONNECTION_PROVIDERS: readonly ModelConnectionProvider[] = [
  { id: "claude", name: "Claude", kind: "subscription", harness: "claude", key: "none", description: "Pro or Max, through Claude Code's own sign-in" },
  { id: "codex", name: "Codex", kind: "subscription", harness: "codex", key: "none", description: "ChatGPT Plus, Pro or Business, through the Codex CLI's sign-in" },
  { id: "cursor", name: "Cursor", kind: "subscription", harness: "cursor", key: "none", description: "Your Cursor plan, through Cursor's sign-in" },
  { id: "grok", name: "Grok", kind: "subscription", harness: "grok", key: "none", description: "SuperGrok or X Premium, through the Grok CLI's sign-in" },
  { id: "devin", name: "Devin", kind: "subscription", harness: "devin", key: "none", description: "Your Devin plan, through Devin's sign-in" },
  { id: "github-copilot", name: "GitHub Copilot", kind: "subscription", harness: "opencode", openCodeProvider: "github-copilot", key: "none", description: "Your Copilot plan, served through OpenCode" },
  { id: "chatgpt", name: "ChatGPT", kind: "subscription", harness: "opencode", openCodeProvider: "openai", key: "none", description: "Your ChatGPT plan, served through OpenCode" },
  { id: "openrouter", name: "OpenRouter", kind: "gateway", baseUrl: "https://openrouter.ai/api/v1", key: "required", keyUrl: "https://openrouter.ai/settings/keys", description: "Hundreds of models behind one key" },
  { id: "vercel", name: "Vercel AI Gateway", kind: "gateway", baseUrl: "https://ai-gateway.vercel.sh/v1", key: "required", keyUrl: "https://vercel.com/dashboard", description: "Models from every major lab, billed through Vercel" },
  { id: "cloudflare", name: "Cloudflare AI Gateway", kind: "gateway", urlHint: "https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/compat", key: "required", keyUrl: "https://dash.cloudflare.com", description: "Your gateway's OpenAI-compatible endpoint" },
  { id: "bedrock", name: "Amazon Bedrock", kind: "gateway", baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1", urlHint: "https://bedrock-runtime.<region>.amazonaws.com/openai/v1", key: "required", keyUrl: "https://console.aws.amazon.com/bedrock/home#/api-keys", description: "A Bedrock API key in your region" },
  { id: "together", name: "Together AI", kind: "gateway", baseUrl: "https://api.together.xyz/v1", key: "required", keyUrl: "https://api.together.ai/settings/api-keys", description: "Open models, served fast" },
  { id: "deepinfra", name: "DeepInfra", kind: "gateway", baseUrl: "https://api.deepinfra.com/v1/openai", key: "required", keyUrl: "https://deepinfra.com/dash/api_keys", description: "Open models at low cost" },
  { id: "fireworks", name: "Fireworks", kind: "gateway", baseUrl: "https://api.fireworks.ai/inference/v1", key: "required", keyUrl: "https://fireworks.ai/account/api-keys", description: "Open models and your fine-tunes" },
  { id: "baseten", name: "Baseten", kind: "gateway", baseUrl: "https://inference.baseten.co/v1", key: "required", keyUrl: "https://app.baseten.co/settings/api_keys", description: "Model APIs and your own deployments" },
  { id: "ollama", name: "Ollama", kind: "local", baseUrl: "http://localhost:11434/v1", key: "none", description: "Models you pulled with Ollama, on this Mac" },
  { id: "lmstudio", name: "LM Studio", kind: "local", baseUrl: "http://localhost:1234/v1", key: "none", description: "The models LM Studio's server has loaded" },
  { id: "local", name: "Other local server", kind: "local", baseUrl: "http://localhost:8080/v1", urlHint: "http://localhost:<port>/v1", key: "optional", description: "Any OpenAI-compatible server on this Mac" },
  { id: "openai-compatible", name: "Custom endpoint", kind: "custom", urlHint: "https://your-endpoint/v1", key: "optional", description: "Any OpenAI-compatible base URL and key" },
]

/** A model a connection serves. */
export interface ConnectionModel {
  id: string
  name?: string
  contextTokens?: number
}

/** Where a connection's key is kept; never the key itself. */
export interface ConnectionCredential {
  kind: "keychain"
  /** The saved key's name in the host's secrets. */
  name: string
}

/** A connection as it's kept: the same shape whatever reads it, a harness's launch or Settings. */
export interface ModelConnection {
  /** Stable: the provider's id, or `custom-…` for each custom endpoint. */
  id: string
  /** Its `MODEL_CONNECTION_PROVIDERS` entry. */
  provider: string
  kind: ModelConnectionKind
  name: string
  baseUrl: string
  /** What it serves: the models the person kept when they added it. */
  models: ConnectionModel[]
  enabled: boolean
  credential: ConnectionCredential | null
  addedAt: string
}

/** A harness a connection is put to work in, and how many of its models it offers there. */
export interface ConnectionServes {
  harness: string
  models: number
}

export interface ModelConnectionView extends ModelConnection {
  /** Empty while it's turned off. */
  serves: ConnectionServes[]
}

export interface ModelConnectionsSnapshot {
  connections: ModelConnectionView[]
  /** A connection that can't be served as it is, and why. */
  issues: Array<{ id: string; message: string }>
  /** Whether a key can be kept: the keychain answers. */
  secureStorage: boolean
}

/** What Check access asks: the provider, its URL as entered, and a key to try. */
export interface ModelConnectionCheckInput {
  provider: string
  baseUrl?: string
  apiKey?: string
}

export interface ModelConnectionCheck {
  baseUrl: string
  models: ConnectionModel[]
  notice?: string
}

export interface ModelConnectionInput extends ModelConnectionCheckInput {
  name?: string
  models: ConnectionModel[]
}

/** A saved connection's test: what its endpoint lists now, against what it serves. */
export interface ModelConnectionTest {
  listed: number
  /** Served models the endpoint no longer lists. */
  missing: string[]
}

/** A local server Mako looked for on its usual port. */
export interface LocalModelServer {
  provider: string
  running: boolean
  models: ConnectionModel[]
}
