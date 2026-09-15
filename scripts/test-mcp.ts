import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import {
  acpMcpServers,
  atomicMergeMcpJson,
  codexMcpConfig,
  managedMcpDefinitions,
  mergeMcpDefinitions,
  parseProviderJson,
  previewMcpSync,
} from "../electron/mcp.js"
import { integrationCatalog } from "../electron/integrations.js"
import { BROWSER_TOOL_INPUTS } from "../electron/browser-tools-main.js"
import { COMPUTER_TOOL_INPUTS } from "../electron/computer-tools-main.js"
import {
  cuaEmbeddedSocket,
  ensureCuaEmbedded,
  stopCuaEmbedded,
} from "../electron/cua-embedded.js"
import { atomicJsonMcpMerge, mergeJsonMcpConfig } from "../electron/mcp-sync.js"
import type { McpDiscoveredDefinition } from "../electron/mcp-registry.js"
import type { JsonValue } from "../electron/codex-app-json.js"
import type { McpProvider, McpRegistrySnapshot } from "../electron/shared.js"

function discovered(
  provider: McpProvider,
  name: string,
  config: JsonValue
): McpDiscoveredDefinition {
  const [definition] = parseProviderJson(
    provider,
    JSON.stringify({ mcpServers: { [name]: config } })
  )
  assert.ok(definition)
  return {
    definition,
    origin: {
      provider,
      account: "default",
      scope: "user",
      provenance: `${provider} test config`,
    },
  }
}

function testProtocolVersion(): void {
  assert.equal(LATEST_PROTOCOL_VERSION, "2025-11-25")
}

function testProviderFixtures(): void {
  const json = JSON.stringify({
    mcpServers: { shared: { command: "/bin/server", args: ["serve"] } },
  })
  for (const provider of ["claude", "cursor", "devin"] as const) {
    const [definition] = parseProviderJson(provider, json)
    assert.equal(definition?.name, "shared")
    assert.equal(definition?.transport, "stdio")
  }
  const [codex] = parseProviderJson(
    "codex",
    JSON.stringify([
      {
        name: "remote",
        transport: { type: "streamable_http", url: "https://example.test/mcp" },
      },
    ])
  )
  const [grok] = parseProviderJson(
    "grok",
    JSON.stringify([
      {
        name: "events",
        transport: { type: "sse", url: "https://example.test/events" },
      },
    ])
  )
  const [opencode] = parseProviderJson(
    "opencode",
    JSON.stringify({
      mcp: {
        local: {
          type: "local",
          command: ["node", "server.js"],
          environment: { API_KEY: "secret" },
        },
      },
    })
  )
  assert.equal(codex?.transport, "http")
  assert.equal(grok?.transport, "sse")
  assert.equal(opencode?.transport, "stdio")
  assert.equal(opencode?.command, "node")
  assert.deepEqual(opencode?.args, ["server.js"])
  assert.deepEqual(opencode?.envNames, ["API_KEY"])
}

function testAxiomPreview(): void {
  const definition = parseProviderJson(
    "codex",
    JSON.stringify([
      {
        name: "axiom",
        enabled: true,
        auth_status: "o_auth",
        transport: {
          type: "streamable_http",
          url: "https://mcp.axiom.co/mcp",
        },
      },
    ])
  )[0]
  assert.deepEqual(definition, {
    name: "axiom",
    transport: "http",
    url: "https://mcp.axiom.co/mcp",
    envNames: [],
    headerNames: [],
    portable: true,
  })
  const claude = z
    .object({
      mcpServers: z.record(
        z.string(),
        z.object({ type: z.string(), url: z.string() })
      ),
    })
    .parse(JSON.parse(mergeJsonMcpConfig("", definition, "claude")))
  assert.deepEqual(claude.mcpServers.axiom, {
    type: "http",
    url: "https://mcp.axiom.co/mcp",
  })
  const opencode = z
    .object({
      mcp: z.record(
        z.string(),
        z.object({ type: z.string(), url: z.string() })
      ),
    })
    .parse(JSON.parse(mergeJsonMcpConfig("", definition, "opencode")))
  assert.deepEqual(opencode.mcp.axiom, {
    type: "remote",
    url: "https://mcp.axiom.co/mcp",
  })
}

async function testAxiomSyncPreview(): Promise<void> {
  const servers = mergeMcpDefinitions([
    {
      ...discovered("codex", "axiom", {
        transport: { type: "streamable_http", url: "https://mcp.axiom.co/mcp" },
      }),
      origin: {
        provider: "codex",
        account: "work",
        scope: "effective",
        provenance: "codex fixture",
      },
    },
  ])
  const snapshot: McpRegistrySnapshot = {
    cwd: tmpdir(),
    generatedAt: 1,
    servers,
    providers: [
      {
        id: "claude",
        label: "Claude Code",
        account: "default",
        available: true,
        source: "fixture",
      },
    ],
  }
  const preview = await previewMcpSync(snapshot, servers[0]!.id, {
    provider: "claude",
    account: "default",
    scope: "user",
  })
  assert.equal(preview.action, "add")
  const isolated = await previewMcpSync(snapshot, servers[0]!.id, {
    provider: "claude",
    account: "another-account",
    scope: "user",
  })
  assert.equal(isolated.action, "blocked")
  assert.match(isolated.blockReason ?? "", /selected account/)
}

function testRedaction(): void {
  const secret = "sk-test-never-cross-the-bridge"
  const records = mergeMcpDefinitions([
    discovered("claude", "private", {
      command: process.execPath,
      args: ["server.js", `--token=${secret}`, "--api-key", secret],
      env: { API_KEY: secret, MODE: "test" },
    }),
    discovered("cursor", "remote", {
      url: `https://user:pass@example.test/mcp?api_key=${secret}`,
    }),
  ])
  const serialized = JSON.stringify(records)
  assert.equal(serialized.includes(secret), false)
  assert.equal(serialized.includes("pass"), false)
  assert.equal(
    records.every((server) => !server.portable),
    true
  )
  assert.deepEqual(
    records.find((server) => server.name === "private")?.envNames,
    ["API_KEY", "MODE"]
  )
  const [authenticated] = parseProviderJson(
    "codex",
    JSON.stringify([
      {
        name: "authenticated",
        transport: {
          type: "streamable_http",
          url: "https://secure.example.test/mcp",
          bearer_token_env_var: "MCP_TOKEN",
          env_http_headers: { "X-Workspace": "WORKSPACE_ID" },
        },
      },
    ])
  )
  assert.equal(authenticated?.portable, false)
  assert.deepEqual(authenticated?.envNames, ["MCP_TOKEN", "WORKSPACE_ID"])
  assert.deepEqual(authenticated?.headerNames, ["X-Workspace"])
}

function testDedupeAndConflicts(): void {
  const same = { command: process.execPath, args: ["same-server.js"] }
  const records = mergeMcpDefinitions([
    discovered("claude", "shared", same),
    discovered("cursor", "shared", same),
    discovered("codex", "drift", {
      command: process.execPath,
      args: ["one.js"],
    }),
    discovered("grok", "drift", {
      command: process.execPath,
      args: ["two.js"],
    }),
  ])
  const shared = records.find((server) => server.name === "shared")
  assert.equal(shared?.origins.length, 2)
  assert.equal(records.filter((server) => server.name === "shared").length, 1)
  assert.equal(
    records
      .filter((server) => server.name === "drift")
      .every((server) => server.conflict === "drift"),
    true
  )
}

async function testAtomicConcurrency(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "mako-mcp-"))
  const file = join(directory, "mcp.json")
  try {
    await Promise.all([
      atomicMergeMcpJson(file, { alpha: { command: "alpha" } }),
      atomicMergeMcpJson(file, { beta: { command: "beta" } }),
    ])
    const value = z
      .object({ mcpServers: z.record(z.string(), z.object({}).passthrough()) })
      .parse(JSON.parse(await readFile(file, "utf8")))
    assert.deepEqual(Object.keys(value.mcpServers).sort(), ["alpha", "beta"])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function testSerializedGuardedMerge(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "mako-mcp-serialized-"))
  const file = join(directory, "mcp.json")
  const original = `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`
  const expected = createHash("sha256").update(original).digest("hex")
  const definition = (name: string) => ({
    name,
    transport: "stdio" as const,
    command: `/bin/${name}`,
    args: [],
    envNames: [],
    headerNames: [],
    portable: true,
  })
  try {
    await writeFile(file, original)
    const settled = await Promise.allSettled([
      atomicJsonMcpMerge(file, expected, definition("alpha")),
      atomicJsonMcpMerge(file, expected, definition("beta")),
    ])
    assert.deepEqual(settled.map((result) => result.status).sort(), [
      "fulfilled",
      "rejected",
    ])
    const value = z
      .object({ mcpServers: z.record(z.string(), z.json()) })
      .parse(JSON.parse(await readFile(file, "utf8")))
    assert.equal(Object.keys(value.mcpServers).length, 1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function testGuardedAtomicMerge(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "mako-mcp-guard-"))
  const file = join(directory, "mcp.json")
  const original = `${JSON.stringify({ mcpServers: { alpha: { command: "alpha" } } }, null, 2)}\n`
  const definition = {
    name: "beta",
    transport: "stdio" as const,
    command: "/bin/beta",
    args: [],
    envNames: [],
    headerNames: [],
    portable: true,
  }
  try {
    await writeFile(file, original, { mode: 0o644 })
    const expected = createHash("sha256").update(original).digest("hex")
    await atomicJsonMcpMerge(file, expected, definition)
    assert.equal((await stat(file)).mode & 0o777, 0o600)
    const current = await readFile(file, "utf8")
    const stale = createHash("sha256").update(current).digest("hex")
    await writeFile(
      file,
      mergeJsonMcpConfig(current, { ...definition, name: "gamma" })
    )
    await assert.rejects(
      atomicJsonMcpMerge(file, stale, { ...definition, name: "delta" }),
      /changed after preview/
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

function testAcpProjection(): void {
  const servers = mergeMcpDefinitions([
    discovered("claude", "local", {
      command: process.execPath,
      args: ["server.js"],
    }),
    discovered("cursor", "docs", {
      type: "http",
      url: "https://docs.example.test/mcp",
    }),
  ])
  const snapshot: McpRegistrySnapshot = {
    cwd: tmpdir(),
    generatedAt: 1,
    servers,
    providers: [],
  }
  assert.deepEqual(acpMcpServers(snapshot, "devin", ["stdio", "http"]), [
    {
      name: "docs",
      type: "http",
      url: "https://docs.example.test/mcp",
      headers: [],
    },
    {
      name: "local",
      command: process.execPath,
      args: ["server.js"],
      env: [],
    },
  ])
  assert.deepEqual(acpMcpServers(snapshot, "claude", ["stdio", "http"]), [
    {
      name: "docs",
      type: "http",
      url: "https://docs.example.test/mcp",
      headers: [],
    },
  ])
}

async function testManagedDefinitions(): Promise<void> {
  const definitions = await managedMcpDefinitions("/app", "/electron", {
    PATH: "",
  })
  assert.equal(
    definitions.some((entry) => entry.definition.name === "browser-use"),
    false
  )
  assert.equal(
    definitions.some((entry) => entry.definition.name === "mako-browser-use"),
    true
  )
  assert.equal(
    definitions.some((entry) => entry.definition.name === "mako-local-tools"),
    false,
    "the macOS harness server is gone; native control is the driver alone"
  )
  assert.equal(
    definitions.some((entry) => entry.definition.name === "mako-local-control"),
    true
  )
  const browserTools = definitions.find(
    (entry) => entry.definition.name === "mako-browser-use"
  )
  assert.ok(browserTools)
  const managedSnapshot: McpRegistrySnapshot = {
    cwd: tmpdir(),
    generatedAt: 1,
    servers: mergeMcpDefinitions(definitions),
    providers: [],
  }
  assert.deepEqual(
    acpMcpServers(managedSnapshot, "claude", ["stdio", "http"])
      .map((server) => server.name)
      .sort(),
    definitions
      .filter(
        (entry) =>
          !entry.definition.blockReason &&
          entry.definition.name === "mako-browser-use"
      )
      .map((entry) => entry.definition.name)
      .sort()
  )
  const cursor = z
    .object({
      mcpServers: z.record(
        z.string(),
        z.object({ env: z.record(z.string(), z.string()) })
      ),
    })
    .parse(
      JSON.parse(mergeJsonMcpConfig("", browserTools.definition, "cursor"))
    )
  assert.deepEqual(cursor.mcpServers["mako-browser-use"]?.env, {
    ELECTRON_RUN_AS_NODE: "1",
  })
}

async function testManagedCommandIsolation(): Promise<void> {
  if (process.platform !== "darwin") return
  const directory = await mkdtemp(join(tmpdir(), "mako-mcp-command-env-"))
  const report = join(directory, "environment.json")
  const command = join(directory, "cua-driver")
  const keys = ["MAKO_BACKEND_TOKEN", "MAKO_CUA_SOCKET"]
  await writeFile(
    command,
    `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(report)}, JSON.stringify(${JSON.stringify(keys)}.filter(key => process.env[key])))\n`
  )
  await chmod(command, 0o755)
  try {
    await managedMcpDefinitions("/app", "/electron", {
      PATH: directory,
      MAKO_BACKEND_TOKEN: "backend-secret",
      MAKO_CUA_SOCKET: "/tmp/cua.sock",
    })
    assert.deepEqual(JSON.parse(await readFile(report, "utf8")), [])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function testMakoRuntimeProjection(): Promise<void> {
  const managed = (
    name: "mako-browser-use" | "mako-local-control",
    command: string,
    args: string[]
  ): McpDiscoveredDefinition => ({
    definition: {
      name,
      transport: "stdio",
      command,
      args,
      envNames: name === "mako-browser-use" ? ["ELECTRON_RUN_AS_NODE"] : [],
      headerNames: [],
      portable: true,
    },
    origin: {
      provider: "mako",
      account: "local",
      scope: "managed",
      provenance: "Mako managed (test)",
    },
  })
  const snapshot: McpRegistrySnapshot = {
    cwd: tmpdir(),
    generatedAt: 1,
    providers: [],
    servers: mergeMcpDefinitions([
      managed("mako-browser-use", process.execPath, ["browser-tools.js"]),
      managed("mako-local-control", "cua-driver", [
        "mcp",
        "--embedded",
        "--socket",
        "/tmp/mako-cua.sock",
      ]),
    ]).map((server) => ({
      ...server,
      managed: true,
      availability: "available" as const,
    })),
  }
  const acpServers = acpMcpServers(snapshot, "claude", ["stdio"])
  assert.deepEqual(
    acpServers.map((server) => server.name),
    ["mako-browser-use", "mako-local-control"]
  )
  assert.deepEqual(
    acpServers.find((server) => server.name === "mako-browser-use")?.env,
    [{ name: "ELECTRON_RUN_AS_NODE", value: "1" }]
  )
  const conversationUrl = "http://127.0.0.1:43123/mcp"
  const scopedServers = z
    .object({ mcp_servers: z.record(z.string(), z.json()) })
    .parse(codexMcpConfig(snapshot, conversationUrl)).mcp_servers
  assert.deepEqual(scopedServers["mako-conversations"], {
    url: conversationUrl,
    bearer_token_env_var: "MAKO_CONVERSATIONS_TOKEN",
  })
  const codex = codexMcpConfig(snapshot)
  const servers = z
    .object({ mcp_servers: z.record(z.string(), z.json()) })
    .parse(codex).mcp_servers
  for (const [name, definition] of Object.entries(servers))
    assert.deepEqual(
      scopedServers[name],
      definition,
      "conversation tools preserve existing server configuration"
    )
  assert.deepEqual(Object.keys(servers).sort(), [
    "mako-browser-use",
    "mako-local-control",
  ])
  const localControl = snapshot.servers.find(
    (server) => server.name === "mako-local-control"
  )
  assert.ok(localControl)
  const preview = await previewMcpSync(snapshot, localControl.id, {
    provider: "claude",
    account: "default",
    scope: "user",
  })
  assert.equal(preview.action, "blocked")
  assert.match(preview.blockReason ?? "", /sessions launched by Mako/)

  const nativeSnapshot: McpRegistrySnapshot = {
    ...snapshot,
    servers: mergeMcpDefinitions([
      managed("mako-browser-use", process.execPath, ["browser-tools.js"]),
      managed("mako-local-control", "cua-driver", [
        "mcp",
        "--embedded",
        "--socket",
        "/tmp/mako-cua.sock",
      ]),
      discovered("claude", "node_repl", { command: process.execPath }),
    ]).map((server) => ({
      ...server,
      managed: server.origins.some((origin) => origin.provider === "mako"),
      availability: "available" as const,
    })),
  }
  assert.deepEqual(
    acpMcpServers(nativeSnapshot, "claude", ["stdio"]).map(
      (server) => server.name
    ),
    ["mako-browser-use", "mako-local-control"]
  )
}

async function testMakoBackendProjection(): Promise<void> {
  const previousUrl = process.env.MAKO_BACKEND_URL
  const previousToken = process.env.MAKO_BACKEND_TOKEN
  const url = "https://mako.example/api/mcp"
  const token = "mako-backend-test-token".padEnd(64, "x")
  process.env.MAKO_BACKEND_URL = url
  process.env.MAKO_BACKEND_TOKEN = token
  try {
    const definitions = await managedMcpDefinitions("/app", "/electron", {
      PATH: "",
      MAKO_BACKEND_URL: url,
      MAKO_BACKEND_TOKEN: token,
    })
    const snapshot: McpRegistrySnapshot = {
      cwd: tmpdir(),
      generatedAt: 1,
      providers: [],
      servers: mergeMcpDefinitions(definitions).map((server) => ({
        ...server,
        managed: true,
        availability: server.blockReason ? "unavailable" : "available",
      })),
    }
    assert.equal(JSON.stringify(snapshot).includes(token), false)
    const acp = acpMcpServers(snapshot, "claude", ["http"])
    assert.deepEqual(acp, [
      {
        type: "http",
        name: "mako-backend",
        url,
        headers: [{ name: "Authorization", value: `Bearer ${token}` }],
      },
    ])
    const codex = z
      .object({ mcp_servers: z.record(z.string(), z.json()) })
      .parse(codexMcpConfig(snapshot)).mcp_servers
    assert.deepEqual(codex["mako-backend"], {
      url,
      http_headers: { Authorization: `Bearer ${token}` },
    })
    const backend = snapshot.servers.find(
      (server) => server.name === "mako-backend"
    )
    assert.ok(backend)
    const preview = await previewMcpSync(snapshot, backend.id, {
      provider: "claude",
      account: "default",
      scope: "user",
    })
    assert.equal(preview.action, "blocked")
  } finally {
    if (previousUrl) process.env.MAKO_BACKEND_URL = previousUrl
    else delete process.env.MAKO_BACKEND_URL
    if (previousToken) process.env.MAKO_BACKEND_TOKEN = previousToken
    else delete process.env.MAKO_BACKEND_TOKEN
  }
}

async function testEmbeddedCuaHost(): Promise<void> {
  const previousSocket = process.env.MAKO_CUA_SOCKET
  const directory = await mkdtemp(join(tmpdir(), "mako-cua-embedded-"))
  const command = join(directory, "cua-driver")
  const state = join(directory, "state")
  const source = `#!${process.execPath}\nconst net = require("node:net")\nif (process.env.CUA_DRIVER_EMBEDDED !== "1") process.exit(2)\nif (process.env.CUA_DRIVER_HOST_BUNDLE_ID !== "dev.mako.test") process.exit(3)\nif (!process.argv.includes("--no-overlay")) process.exit(4)\nconst index = process.argv.indexOf("--socket")\nconst socket = process.argv[index + 1]\nconst server = net.createServer(connection => connection.end())\nserver.listen(socket)\nprocess.on("SIGTERM", () => server.close(() => process.exit(0)))\n`
  try {
    await writeFile(command, source)
    await chmod(command, 0o755)
    const socket = await ensureCuaEmbedded(state, "dev.mako.test", {
      PATH: directory,
    })
    assert.ok(socket)
    assert.equal(cuaEmbeddedSocket(), socket)
    assert.equal(process.env.MAKO_CUA_SOCKET, previousSocket)
  } finally {
    stopCuaEmbedded()
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(cuaEmbeddedSocket(), null)
    assert.equal(process.env.MAKO_CUA_SOCKET, previousSocket)
    await rm(directory, { recursive: true, force: true })
  }
}

function testIntegrationCatalog(): void {
  const snapshot: McpRegistrySnapshot = {
    cwd: tmpdir(),
    generatedAt: 1,
    providers: [],
    servers: [
      ...mergeMcpDefinitions([
        discovered("codex", "slack", {
          type: "http",
          url: "https://mcp.slack.com/mcp",
        }),
      ]),
      {
        id: "local-control",
        name: "mako-local-control",
        transport: "stdio",
        command: "cua-driver",
        args: ["mcp"],
        envNames: [],
        headerNames: [],
        origins: [
          {
            provider: "mako",
            account: "local",
            scope: "managed",
            provenance: "fixture",
          },
        ],
        portable: true,
        availability: "available",
        managed: true,
      },
      {
        id: "local-browser",
        name: "mako-browser-use",
        transport: "stdio",
        command: "browser-use",
        args: [],
        envNames: [],
        headerNames: [],
        origins: [
          {
            provider: "mako",
            account: "local",
            scope: "managed",
            provenance: "fixture",
          },
        ],
        portable: true,
        availability: "available",
        managed: true,
      },
    ],
  }
  const granted = integrationCatalog(
    snapshot,
    {
      supported: true,
      persistentAcrossUpdates: true,
      accessibility: true,
      screenRecording: "granted",
    },
    false,
    {
      kind: "connected",
      url: "https://mako.example/api/mcp",
      version: "0.1.0",
      environment: "test",
    },
    [
      {
        id: "chrome",
        name: "Google Chrome",
        connection: { status: "connected", generation: "fixture" },
      },
    ]
  )
  assert.deepEqual(
    granted.integrations.find((entry) => entry.id === "slack")?.connection,
    { kind: "ready", detail: "test · 0.1.0" }
  )
  assert.equal(
    granted.integrations.find((entry) => entry.id === "local-browser")
      ?.connection.kind,
    "ready"
  )
  const denied = integrationCatalog(
    snapshot,
    {
      supported: true,
      persistentAcrossUpdates: false,
      accessibility: false,
      screenRecording: "denied",
    },
    false,
    {
      kind: "connected",
      url: "https://mako.example/api/mcp",
      version: "0.1.0",
      environment: "test",
    }
  )
  assert.equal(
    denied.integrations.find((entry) => entry.id === "local-browser")
      ?.connection.kind,
    "setup",
    "Installed browser tools must not imply an approved Chrome connection"
  )
  assert.equal(
    denied.integrations.find((entry) => entry.id === "computer-use")?.connection
      .kind,
    "needs-permission"
  )
}

function testLocalSchemas(): void {
  assert.equal(BROWSER_TOOL_INPUTS.help.safeParse({}).success, true)
  assert.equal(
    BROWSER_TOOL_INPUTS.exec.safeParse({
      source: "return await browser.status()",
    }).success,
    true
  )
  for (const source of ["", "x".repeat(100_001)]) {
    assert.equal(BROWSER_TOOL_INPUTS.exec.safeParse({ source }).success, false)
    assert.equal(COMPUTER_TOOL_INPUTS.exec.safeParse({ source }).success, false)
  }
  assert.equal(
    BROWSER_TOOL_INPUTS.help.safeParse({ action: "click", extra: 1 }).success,
    false
  )
  assert.equal(COMPUTER_TOOL_INPUTS.help.safeParse({}).success, true)
  assert.equal(
    COMPUTER_TOOL_INPUTS.help.safeParse({ tool: "hotkey" }).success,
    true
  )
  assert.equal(COMPUTER_TOOL_INPUTS.status.safeParse({ a: 1 }).success, false)
}

testProtocolVersion()
testProviderFixtures()
testAxiomPreview()
await testAxiomSyncPreview()
testRedaction()
testDedupeAndConflicts()
await testAtomicConcurrency()
await testSerializedGuardedMerge()
await testGuardedAtomicMerge()
testAcpProjection()
await testManagedDefinitions()
await testManagedCommandIsolation()
await testMakoRuntimeProjection()
await testMakoBackendProjection()
await testEmbeddedCuaHost()
testIntegrationCatalog()
testLocalSchemas()
console.log("MCP tests passed")
