import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { followHostLog, mirrorConsole, type HostLogLine } from "@mako/host/base/host-log"
import { memorySecrets, SecretLocked, type Secrets } from "@mako/host/base/secrets"
import { ConnectionError, connectionProvider, connectionUrl, ModelConnections, modelConnectionsPath } from "@mako/host/harnesses/model-connections"
import { applyOpenCodeRoutes, openCodeConnectionKeyVariable, openCodeConnectionProvider, openCodeModelRoutes } from "@mako/host/harnesses/opencode/connections"
import { configureOpenCodePermissions } from "@mako/host/harnesses/opencode/permissions"
import { createProviderHost } from "@mako/host/harnesses/host"
import { createHarnessHost, detachedHarnessContext } from "@mako/host/harnesses/harness-host"
import { NativeStores } from "@mako/sessions/read-only-sqlite"
import type { ModelRouteAdapter } from "@mako/host/harnesses/model-routes"
import type { ProviderLiveDriver } from "@mako/host/harnesses/live-driver"
import { declaredModelRoutes } from "@mako/host/harnesses/model-routes"
import { MODEL_CONNECTION_PROVIDERS } from "@mako/host/contracts/model-connections"
import type { HarnessModelRoutes } from "@mako/host/contracts/model-routes"
import { NO_NATIVE_EXCLUSION } from "@mako/host/contracts/execution-context"
import { NO_NATIVE_PROMPT_IDENTITY } from "@mako/host/contracts/native-prompt-identity"
import { fixtureResume, noCapabilities } from "./fixtures/driver-capabilities.ts"

/**
 * The model connections' store and what OpenCode launches with: a key kept in
 * the secrets and nowhere else, a locked keychain, removal, Check access
 * against a stand-in endpoint, the routes each harness's declared adapter
 * takes, the one launch hook that applies them for any harness, and the
 * OpenCode providers its adapter makes of them. No line logged on the way
 * holds a key.
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

/** What three harnesses declare: one takes OpenAI chat routes, one has a way in no adapter uses yet, one has none. */
const harnesses: HarnessModelRoutes[] = [
  { harness: "opencode", routes: declaredModelRoutes(openCodeModelRoutes) },
  { harness: "claude", routes: { kind: "planned", wires: ["anthropic"], via: "ANTHROPIC_BASE_URL" } },
  { harness: "cursor", routes: { kind: "absent", reason: "its own service" } },
]

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
  const store = new ModelConnections(path, secrets, { request: gateway.request, harnesses: () => harnesses })
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
  assert.equal(added.wire, "openai-chat")
  assert.deepEqual(added.serves, [{ harness: "opencode", models: 2 }], "served by every harness whose adapter takes it, and no other")
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
  assert.deepEqual(snapshot.harnesses, harnesses, "Settings reads what each harness declares")
  const routed = await store.routes(openCodeModelRoutes)
  assert.deepEqual(routed.routes.map((route) => [route.connection, route.model, route.wire, route.kind]), [
    ["openrouter", "anthropic/claude-sonnet-4.5", "openai-chat", "gateway"],
    ["openrouter", "qwen/qwen3-coder", "openai-chat", "gateway"],
    ["ollama", "llama3.2:latest", "openai-chat", "local"],
    ["ollama", "qwen3-coder:30b", "openai-chat", "local"],
    [own.id, "local-model", "openai-chat", "local"],
  ], "a route for every model of every connection the adapter takes")
  assert.deepEqual(routed.routes[0]!.credential, { kind: "keychain", name: "connection/openrouter" }, "a route carries where its key is")
  assert.ok(!JSON.stringify(routed.routes).includes(KEY), "never the key")
  assert.deepEqual(routed.routes.map((route) => routed.key(route)), [KEY, KEY, undefined, undefined, LOCAL_KEY], "the launch alone opens it")
  assert.deepEqual((await store.routes({ kind: "planned", wires: ["anthropic"], via: "x" })).routes, [], "a planned adapter takes nothing yet")
  assert.deepEqual((await store.routes({ kind: "accepts", wires: ["anthropic"], kinds: ["gateway"], via: "x" })).routes, [], "nor one that takes another wire")
  assert.deepEqual((await store.routes({ kind: "accepts", wires: ["openai-chat"], kinds: ["gateway"], via: "x" })).routes.map((route) => route.connection), ["openrouter", "openrouter"], "nor another kind")

  /* A row's test: what it lists now against what it serves. */
  assert.deepEqual(await store.test("openrouter"), { listed: 2, missing: [] })
  assert.equal(gateway.requests.at(-1)?.authorization, `Bearer ${KEY}`, "a test sends the saved key to the saved URL")

  /* Turned off: still listed, served nowhere. */
  await store.setEnabled("ollama", false)
  assert.deepEqual((await store.snapshot()).connections.find((connection) => connection.id === "ollama")?.serves, [])
  assert.deepEqual([...new Set((await store.routes(openCodeModelRoutes)).routes.map((route) => route.connection))], ["openrouter", own.id])
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
  const before = new ModelConnections(lockedPath, unlocked, { request: gateway.request })
  await before.add({ provider: "openrouter", apiKey: KEY, models: checked.models })
  await before.add({ provider: "ollama", models: [{ id: "llama3.2:latest" }] })
  const locked: Secrets = {
    durable: async () => false,
    read: async () => { throw new SecretLocked("unavailable") },
    write: async () => { throw new SecretLocked("unavailable") },
    delete: async () => { throw new SecretLocked("unavailable") },
    list: async () => [],
  }
  const after = new ModelConnections(lockedPath, locked, { request: gateway.request })
  await assert.rejects(after.add({ provider: "together", apiKey: KEY, models: together.models }), /keychain is locked/)
  const lockedSnapshot = await after.snapshot()
  assert.equal(lockedSnapshot.secureStorage, false)
  assert.deepEqual(lockedSnapshot.issues.map((issue) => issue.id), ["openrouter"])
  assert.deepEqual((await after.routes(openCodeModelRoutes)).routes.map((route) => route.connection), ["ollama"], "a key that won't open is left out; the rest are routed")
  await assert.rejects(after.test("openrouter"), /Unlock your keychain/)
  await assert.rejects(after.remove("openrouter"), SecretLocked, "a key that can't be deleted keeps its connection listed")
  assert.deepEqual((await after.snapshot()).connections.map((connection) => connection.id), ["openrouter", "ollama"])

  /* OpenCode's adapter: each connection a provider of its own; its key in its own variable, never in the config's text. */
  const env: NodeJS.ProcessEnv = { OPENCODE_CONFIG_CONTENT: JSON.stringify({ providers: { "mako-ollama": { name: "Mine" } }, model: "anthropic/claude" }) }
  configureOpenCodePermissions(env, "ask")
  const lmstudio = { connection: "lmstudio", connectionName: "LM Studio", kind: "local" as const, wire: "openai-chat" as const, baseUrl: "http://localhost:1234/v1", model: "qwen2.5-coder-7b", credential: null }
  const launch = { routes: [...routed.routes, lmstudio], key: routed.key }
  applyOpenCodeRoutes(env, launch)
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
  assert.equal(env[openCodeConnectionKeyVariable(own.id)], LOCAL_KEY)
  assert.equal(openCodeConnectionKeyVariable("local-a1b2c3"), "MAKO_CONNECTION_KEY_LOCAL_A1B2C3")
  assert.ok(!env.OPENCODE_CONFIG_CONTENT!.includes(KEY), "the inline config holds no key")
  const untouched = { OPENCODE_CONFIG_CONTENT: "{ not json" }
  applyOpenCodeRoutes(untouched, launch)
  assert.equal(untouched.OPENCODE_CONFIG_CONTENT, "{ not json", "a config OpenCode would refuse is left for it to refuse")

  /* The one launch hook: every harness's launch environment gets the routes its own adapter takes, whichever harness it is. */
  const hostRoot = join(root, "host")
  const host = createProviderHost({ userRoot: hostRoot, secrets: { secrets: memorySecrets(), adoptLegacy: () => {} } })
  const applied: string[][] = []
  const fake = (provider: string, modelRoutes: ModelRouteAdapter): ProviderLiveDriver => ({
    ...noCapabilities,
    modelRoutes,
    resume: fixtureResume(),
    approvalEvidence: { kind: "submission-only", reason: "Injected driver fixture" },
    launchEnvironment: { kind: "unavailable", reason: "Injected driver fixture" },
    nativeIdentity: { kind: "unavailable", reason: "Injected driver fixture" },
    nativeExclusion: NO_NATIVE_EXCLUSION,
    nativePromptIdentity: NO_NATIVE_PROMPT_IDENTITY,
    planning: { via: "setting", option: "plan", proposal: "Injected driver fixture", feedback: { kind: "next-message", reason: "Injected driver fixture" } },
    backgroundStop: { kind: "ends-with-turn", evidence: "Injected driver fixture" },
    turnRecovery: { kind: "manual", reason: "Injected driver fixture" },
    provider, available: () => true,
    start: async () => { throw new Error("not started") },
    prompt: async () => {}, permission: async () => {}, cancel: async () => {}, setMode: async () => {}, close: async () => {},
  })
  host.liveDrivers.register(fake("routes-fixture", {
    kind: "accepts", wires: ["openai-chat"], kinds: ["local"], via: "Injected driver fixture",
    apply: (launchEnv, taken) => {
      applied.push(taken.routes.map((route) => `${route.connection}/${route.model}`))
      return { ...launchEnv, ROUTED: String(taken.routes.length), ROUTED_KEY: taken.key(taken.routes[0]!) ?? "" }
    },
  }))
  host.liveDrivers.register(fake("planned-fixture", { kind: "planned", wires: ["anthropic"], via: "Injected driver fixture" }))
  assert.throws(() => host.liveDrivers.register(fake("empty-fixture", { kind: "planned", wires: [], via: "Injected driver fixture" })), /name the wires/)
  const hostConnections = host.modelConnections
  await hostConnections.add({ provider: "local", apiKey: LOCAL_KEY, baseUrl: "http://localhost:8080/v1", models: [{ id: "local-model" }] })
  const routedEnv = await host.accounts.env("routes-fixture", { PATH: "/usr/bin" })
  assert.equal(routedEnv.ROUTED, "1")
  assert.equal(routedEnv.ROUTED_KEY, LOCAL_KEY, "its adapter, alone, gets the key")
  assert.match(applied[0]![0]!, /^local-[0-9a-f]{6}\/local-model$/)
  assert.equal((await host.accounts.env("planned-fixture", { PATH: "/usr/bin" })).ROUTED, undefined, "a harness that takes nothing yet launches as before")
  assert.deepEqual((await hostConnections.snapshot()).connections[0]!.serves, [{ harness: "routes-fixture", models: 1 }], "Settings names the harnesses that take it, from their declarations")
  await hostConnections.setEnabled((await hostConnections.snapshot()).connections[0]!.id, false)
  assert.equal((await host.accounts.env("routes-fixture", { PATH: "/usr/bin" })).ROUTED, undefined, "a connection turned off is routed nowhere")

  /* What each harness Mako ships declares: OpenCode's adapter is built; Claude's and Codex's ways in are named; the rest have none. */
  const shipped = createHarnessHost(detachedHarnessContext(new NativeStores(false), join(root, "shipped")))
  const declared = Object.fromEntries(shipped.liveDrivers.list().map((driver) => {
    const routes = declaredModelRoutes(driver.modelRoutes)
    return [driver.provider, routes.kind === "absent" ? "absent" : `${routes.kind} ${routes.wires.join(",")}${routes.kind === "accepts" ? ` (${routes.kinds.join(",")})` : ""}`]
  }))
  assert.deepEqual(declared, {
    claude: "planned anthropic",
    codex: "planned openai-chat,openai-responses",
    cursor: "absent",
    opencode: "accepts openai-chat (gateway,local,custom)",
    grok: "absent",
    devin: "absent",
  })

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
