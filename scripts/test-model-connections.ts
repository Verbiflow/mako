import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { followHostLog, mirrorConsole, type HostLogLine } from "@mako/host/base/host-log"
import { memorySecrets, SecretLocked, type Secrets } from "@mako/host/base/secrets"
import { ConnectionError, connectionProvider, connectionUrl, ModelConnections, modelConnectionsPath } from "@mako/host/harnesses/model-connections"
import { applyOpenCodeConnections, openCodeConnectionKeyVariable, openCodeConnectionProvider } from "@mako/host/harnesses/opencode/connections"
import { openCodeAccountCapability } from "@mako/host/harnesses/opencode/accounts"
import { configureOpenCodePermissions } from "@mako/host/harnesses/opencode/permissions"
import { MODEL_CONNECTION_PROVIDERS } from "@mako/host/contracts/model-connections"
import { NativeStores } from "@mako/sessions/read-only-sqlite"

/**
 * The model connections' store and what OpenCode launches with: a key kept in
 * the secrets and nowhere else, a locked keychain, removal, Check access
 * against a stand-in endpoint, and the OpenCode providers a set of
 * connections becomes. No line logged on the way holds a key.
 */

const KEY = "sk-or-fake-0123456789abcdef"
const LOCAL_KEY = "local-fake-key-feedface"
const logged: HostLogLine[] = []
const stopFollowing = followHostLog((line) => logged.push(line))
const restoreConsole = mirrorConsole()
const root = await mkdtemp(join(tmpdir(), "mako-model-connections-"))

/** A stand-in OpenAI-compatible endpoint: the JSON each URL's `/models` answers, and every request it was sent. */
function endpoint(answers: ReadonlyMap<string, string>) {
  const requests: Array<{ url: string; authorization: string | null }> = []
  const request: typeof fetch = async (input, init) => {
    const url = String(input)
    const headers = new Headers(init?.headers)
    requests.push({ url, authorization: headers.get("authorization") })
    if (headers.get("authorization") === "Bearer refused") return new Response("{}", { status: 401 })
    const body = answers.get(url)
    if (body === undefined) throw new TypeError("fetch failed")
    return new Response(body, { headers: { "content-type": "application/json" } })
  }
  return { request, requests }
}

const listings = (pages: Array<[string, unknown]>) => new Map(pages.map(([url, page]) => [url, JSON.stringify(page)]))
const gateway = endpoint(listings([
  ["https://openrouter.ai/api/v1/models", {
    data: [
      { id: "anthropic/claude-sonnet-4.5", name: "Anthropic: Claude Sonnet 4.5", context_length: 1_000_000 },
      { id: "qwen/qwen3-coder", name: "Qwen: Qwen3 Coder", context_length: 262_144 },
      { id: "has space", name: "Not a model id" },
    ],
  }],
  ["https://api.together.xyz/v1/models", [{ id: "meta-llama/Llama-3.3-70B-Instruct-Turbo", display_name: "Llama 3.3 70B", context_length: 131_072 }]],
  ["http://localhost:11434/v1/models", { object: "list", data: [{ id: "llama3.2:latest" }, { id: "qwen3-coder:30b" }] }],
  ["http://localhost:8080/v1/models", { data: [{ id: "local-model" }] }],
]))

try {
  /* URLs: HTTPS, or HTTP on this Mac; a gateway keeps to its own host; a template is filled in. */
  const openrouter = connectionProvider("openrouter")!
  const ollama = connectionProvider("ollama")!
  const cloudflare = connectionProvider("cloudflare")!
  const custom = connectionProvider("openai-compatible")!
  assert.equal(connectionUrl(openrouter, undefined), "https://openrouter.ai/api/v1")
  assert.equal(connectionUrl(ollama, "http://127.0.0.1:11434/v1/"), "http://127.0.0.1:11434/v1")
  assert.throws(() => connectionUrl(ollama, "http://192.168.1.4:11434/v1"), ConnectionError, "a local server is on this Mac")
  assert.throws(() => connectionUrl(openrouter, "https://openrouter.example.com/v1"), ConnectionError, "a gateway's key goes only to the gateway")
  assert.throws(() => connectionUrl(custom, "http://example.com/v1"), ConnectionError, "HTTP only on this Mac")
  assert.throws(() => connectionUrl(custom, "https://user:pass@example.com/v1"), ConnectionError, "no credentials in the URL")
  assert.throws(() => connectionUrl(cloudflare, cloudflare.urlHint), ConnectionError, "a template is filled in first")
  assert.equal(connectionUrl(cloudflare, "https://gateway.ai.cloudflare.com/v1/acct/gw/compat"), "https://gateway.ai.cloudflare.com/v1/acct/gw/compat")
  for (const provider of MODEL_CONNECTION_PROVIDERS.filter((entry) => entry.kind === "gateway" && !entry.urlHint))
    assert.doesNotThrow(() => connectionUrl(provider, undefined), `${provider.name}'s own URL is accepted`)

  /* Round trip: added, listed with a credential reference, served with its key, kept nowhere but the secrets. */
  const secrets = memorySecrets()
  const path = modelConnectionsPath(join(root, "user"))
  const store = new ModelConnections(path, secrets, gateway.request)
  await assert.rejects(store.check({ provider: "openrouter" }), /Paste your OpenRouter API key/)
  await assert.rejects(store.check({ provider: "claude" }), /own sign-in/, "a subscription is never a key")
  const checked = await store.check({ provider: "openrouter", apiKey: KEY })
  assert.deepEqual(checked.models.map((model) => model.id), ["anthropic/claude-sonnet-4.5", "qwen/qwen3-coder"], "an id with a space is left out")
  assert.equal(checked.models[0]!.contextTokens, 1_000_000)
  assert.equal(gateway.requests.at(-1)?.authorization, `Bearer ${KEY}`, "Check access sends the key it was given")
  const together = await store.check({ provider: "together", apiKey: KEY })
  assert.deepEqual(together.models, [{ id: "meta-llama/Llama-3.3-70B-Instruct-Turbo", name: "Llama 3.3 70B", contextTokens: 131_072 }], "a bare array lists too")
  await assert.rejects(store.check({ provider: "openrouter", apiKey: "refused" }), /refused this key/)
  await assert.rejects(store.check({ provider: "lmstudio" }), /Couldn't reach the endpoint/)

  const added = await store.add({ provider: "openrouter", apiKey: KEY, models: checked.models })
  assert.deepEqual(added.credential, { kind: "keychain", name: "connection/openrouter" })
  assert.deepEqual(added.serves, [{ harness: "opencode", models: 2 }])
  await assert.rejects(store.add({ provider: "openrouter", apiKey: KEY, models: checked.models }), /already connected/)
  await assert.rejects(store.add({ provider: "ollama", models: [] }), /at least one model/)
  const local = await store.add({ provider: "ollama", models: (await store.check({ provider: "ollama" })).models })
  assert.equal(local.credential, null, "a server with no key keeps none")
  const own = await store.add({ provider: "local", apiKey: LOCAL_KEY, models: [{ id: "local-model" }] })
  assert.match(own.id, /^local-[0-9a-f]{6}$/, "each other local server is its own connection")

  const file = await readFile(path, "utf8")
  assert.ok(!file.includes(KEY) && !file.includes(LOCAL_KEY), "the connections' file holds no key")
  assert.equal((await secrets.read("saved-key", "connection/openrouter"))?.value, KEY, "the key is in the secrets")
  const snapshot = await store.snapshot()
  assert.deepEqual(snapshot.connections.map((connection) => connection.id), ["openrouter", "ollama", own.id])
  assert.ok(!JSON.stringify(snapshot).includes(KEY), "Settings never reads a key back")
  assert.deepEqual(snapshot.issues, [])
  const served = await store.served()
  assert.deepEqual(served.map((entry) => [entry.connection.id, entry.apiKey]), [["openrouter", KEY], ["ollama", undefined], [own.id, LOCAL_KEY]])

  /* A row's test: what it lists now against what it serves. */
  assert.deepEqual(await store.test("openrouter"), { listed: 2, missing: [] })
  assert.equal(gateway.requests.at(-1)?.authorization, `Bearer ${KEY}`, "a test sends the saved key to the saved URL")

  /* Turned off: still listed, served nowhere. */
  await store.setEnabled("ollama", false)
  assert.deepEqual((await store.snapshot()).connections.find((connection) => connection.id === "ollama")?.serves, [])
  assert.deepEqual((await store.served()).map((entry) => entry.connection.id), ["openrouter", own.id])
  await store.setEnabled("ollama", true)

  /* Removal takes the key with it. */
  await store.remove("openrouter")
  assert.equal(await secrets.read("saved-key", "connection/openrouter"), null, "the key is gone from the secrets")
  assert.deepEqual((await store.snapshot()).connections.map((connection) => connection.id), ["ollama", own.id])
  await store.remove("openrouter")
  await store.remove(own.id)
  assert.equal(await secrets.read("saved-key", `connection/${own.id}`), null)

  /* Keychain locked: no key is taken, a saved one is named and left out of a launch, the rest still serve. */
  const unlocked = memorySecrets()
  const lockedPath = modelConnectionsPath(join(root, "locked"))
  const before = new ModelConnections(lockedPath, unlocked, gateway.request)
  await before.add({ provider: "openrouter", apiKey: KEY, models: checked.models })
  await before.add({ provider: "ollama", models: [{ id: "llama3.2:latest" }] })
  const locked: Secrets = {
    durable: async () => false,
    read: async () => { throw new SecretLocked("unavailable") },
    write: async () => { throw new SecretLocked("unavailable") },
    delete: async () => { throw new SecretLocked("unavailable") },
    list: async () => [],
  }
  const after = new ModelConnections(lockedPath, locked, gateway.request)
  await assert.rejects(after.add({ provider: "together", apiKey: KEY, models: together.models }), /keychain is locked/)
  const lockedSnapshot = await after.snapshot()
  assert.equal(lockedSnapshot.secureStorage, false)
  assert.deepEqual(lockedSnapshot.issues.map((issue) => issue.id), ["openrouter"])
  assert.deepEqual((await after.served()).map((entry) => entry.connection.id), ["ollama"], "a key that won't open is left out; the rest are served")
  await assert.rejects(after.test("openrouter"), /Unlock your keychain/)
  await assert.rejects(after.remove("openrouter"), SecretLocked, "a key that can't be deleted keeps its connection listed")
  assert.deepEqual((await after.snapshot()).connections.map((connection) => connection.id), ["openrouter", "ollama"])

  /* OpenCode: each connection a provider of its own; its key in its own variable, never in the config's text. */
  const env: NodeJS.ProcessEnv = { OPENCODE_CONFIG_CONTENT: JSON.stringify({ providers: { "mako-ollama": { name: "Mine" } }, model: "anthropic/claude" }) }
  configureOpenCodePermissions(env, "ask")
  const opencodeServed = [
    { connection: { ...added, models: checked.models }, apiKey: KEY },
    { connection: { ...local, id: "ollama" } },
    { connection: { ...local, id: "lmstudio", provider: "lmstudio", name: "LM Studio", baseUrl: "http://localhost:1234/v1", models: [{ id: "qwen2.5-coder-7b" }] } },
  ]
  applyOpenCodeConnections(env, opencodeServed)
  const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT!)
  assert.equal(config.model, "anthropic/claude", "the person's own configuration stays")
  assert.ok(config.agents.build.permissions.length > 0, "the launch tier's rules stay")
  assert.deepEqual(config.providers["mako-ollama"], { name: "Mine" }, "a provider the person named the same stays theirs")
  assert.deepEqual(config.providers[openCodeConnectionProvider("openrouter")], {
    name: "OpenRouter",
    package: "@ai-sdk/openai-compatible",
    settings: { baseURL: "https://openrouter.ai/api/v1" },
    env: [openCodeConnectionKeyVariable("openrouter")],
    models: {
      "anthropic/claude-sonnet-4.5": { name: "Anthropic: Claude Sonnet 4.5", limit: { context: 1_000_000 } },
      "qwen/qwen3-coder": { name: "Qwen: Qwen3 Coder", limit: { context: 262_144 } },
    },
  })
  assert.deepEqual(config.providers["mako-lmstudio"], {
    name: "LM Studio",
    package: "@ai-sdk/openai-compatible",
    settings: { baseURL: "http://localhost:1234/v1" },
    models: { "qwen2.5-coder-7b": {} },
  }, "a server with no key names no variable")
  assert.equal(env[openCodeConnectionKeyVariable("openrouter")], KEY)
  assert.equal(openCodeConnectionKeyVariable("local-a1b2c3"), "MAKO_CONNECTION_KEY_LOCAL_A1B2C3")
  assert.ok(!env.OPENCODE_CONFIG_CONTENT!.includes(KEY), "the inline config holds no key")
  const untouched = { OPENCODE_CONFIG_CONTENT: "{ not json" }
  applyOpenCodeConnections(untouched, opencodeServed)
  assert.equal(untouched.OPENCODE_CONFIG_CONTENT, "{ not json", "a config OpenCode would refuse is left for it to refuse")

  /* Every OpenCode launch and discovery gets them, through its account's environment. */
  const capability = openCodeAccountCapability(new NativeStores(false), async () => [{ connection: { ...added, models: checked.models }, apiKey: KEY }])
  const launched = await capability.accountEnv(null, { PATH: "/usr/bin" })
  assert.ok(JSON.parse(launched.OPENCODE_CONFIG_CONTENT!).providers["mako-openrouter"], "a launch's config names the connection")
  assert.equal(launched[openCodeConnectionKeyVariable("openrouter")], KEY)
  const failing = openCodeAccountCapability(new NativeStores(false), async () => { throw new Error("store unreadable") })
  assert.deepEqual(await failing.accountEnv(null, { PATH: "/usr/bin" }), { PATH: "/usr/bin" }, "a store that can't be read never stops a launch")

  for (const line of logged) {
    const text = JSON.stringify(line)
    assert.ok(!text.includes(KEY) && !text.includes(LOCAL_KEY), `no key in a log line: ${line.scope} ${line.message}`)
  }
  assert.ok(logged.some((line) => line.scope === "model-connections" && line.message === "added"), "changes are logged, by id")
  assert.ok(logged.some((line) => line.message === "a connection's key could not be opened"), "a locked key is logged, by id")
  console.log(`model connections: ${logged.length} log lines, none with a key`)
} finally {
  stopFollowing()
  restoreConsole()
  await rm(root, { recursive: true, force: true })
}
