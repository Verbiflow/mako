import assert from "node:assert/strict"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, delimiter } from "node:path"
import { mock } from "node:test"
import { providerHost } from "../electron/providers/index.js"
import { discoverMcpRegistry } from "../electron/mcp-registry.js"
import type { ProviderMcpSource } from "../electron/providers/mcp-source.js"

// A provider CLI's MCP listing merges with Mako's managed definitions.
const root = await mkdtemp(join(tmpdir(), "mako-mcp-startup-"))
await writeFile(
  join(root, "fixture-provider"),
  `#!${process.execPath}
console.log(${JSON.stringify(JSON.stringify({ mcpServers: { fixture: { url: "http://127.0.0.1:9/mcp" } } }))});
`,
  { mode: 0o700 }
)
const source: ProviderMcpSource = {
  provider: "startup-mcp-fixture",
  command: () => join(root, "fixture-provider"),
  userFiles: () => [],
  workspaceFiles: () => [],
  readsCli: true,
  write: { kind: "none" },
}
providerHost.mcpSources.register(source)
const listing = mock.method(providerHost.mcpSources, "list", () => [source])
const previousPath = process.env.PATH
process.env.PATH = `${root}${delimiter}${previousPath ?? ""}`
try {
  const snapshot = await discoverMcpRegistry(root)
  assert.ok(
    snapshot.servers.some((server) => server.name === "fixture"),
    "Provider CLI discovery contributes its servers"
  )
  assert.ok(
    snapshot.servers.some((server) => server.name === "mako-backend" && server.managed),
    "Mako's managed servers merge with provider discovery"
  )
  assert.ok(
    !snapshot.servers.some((server) => ["mako-control", "mako-local-tools"].includes(server.name)),
    "Local control is attached per task with a scoped endpoint, never as an unscoped registry server"
  )
  console.log(
    "MCP startup: provider discovery merges with managed servers; local control stays task-scoped"
  )
} finally {
  listing.mock.restore()
  if (previousPath === undefined) delete process.env.PATH
  else process.env.PATH = previousPath
  await rm(root, { recursive: true, force: true })
}
