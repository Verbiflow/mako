import assert from "node:assert/strict"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, delimiter } from "node:path"
import { providerHost } from "../electron/providers/index.js"
import { mcpRegistry } from "../electron/mcp-registry.js"
import { toolHarnesses } from "../electron/providers/tool-harnesses.js"
import type { ProviderMcpSource } from "../electron/mcp-source.js"

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
  cliList: { inputs: () => [] },
  readFormat: "named-map-or-list",
  write: { kind: "none" },
}
const registry = mcpRegistry({ ...toolHarnesses(providerHost), mcpSources: { get: (provider) => provider === source.provider ? source : undefined, list: () => [source] } })
const previousPath = process.env.PATH
process.env.PATH = `${root}${delimiter}${previousPath ?? ""}`
try {
  const snapshot = await registry.discover(root)
  assert.ok(
    snapshot.servers.some((server) => server.name === "fixture"),
    "Provider CLI discovery contributes its servers"
  )
  assert.ok(
    !snapshot.servers.some((server) => ["mako-control", "mako-local-tools"].includes(server.name)),
    "Local control is attached per task with a scoped endpoint, never as an unscoped registry server"
  )
  console.log(
    "MCP startup: provider discovery lists its servers; local control stays task-scoped"
  )
} finally {
  if (previousPath === undefined) delete process.env.PATH
  else process.env.PATH = previousPath
  await rm(root, { recursive: true, force: true })
}
