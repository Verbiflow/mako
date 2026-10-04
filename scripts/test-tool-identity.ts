import assert from "node:assert/strict"
import { identifyTool, type ToolIdentity, type ToolSource } from "@mako/sessions/tool-identity"
import { HARNESS_TOOL_SAMPLES } from "../src/dev/harness-tool-samples.ts"

const samples = HARNESS_TOOL_SAMPLES

let failures = 0
for (const sample of samples) {
  const identity = identifyTool(sample.source)
  for (const [key, value] of Object.entries(sample.expect)) {
    // SAFETY: `key` came from Object.entries of a Partial<ToolIdentity>.
    const actual = identity[key as keyof ToolIdentity]
    if (actual !== value) {
      failures += 1
      console.error(`${sample.source.harness}/${sample.source.name ?? sample.source.title}: ${key} is ${JSON.stringify(actual)}, expected ${JSON.stringify(value)}`)
    }
  }
}
assert.equal(failures, 0, `${failures} identity mismatches`)
console.log(`tool identity: ${samples.length} samples ok`)

// Blocks retained from before live tools carried `name` keep the native name in `toolKind`.
for (const [source, kind] of [
  [{ acpKind: "task", title: "Research Tembo" }, "agent"],
  [{ acpKind: "read_file", title: "Read file" }, "read"],
  [{ acpKind: "execute", title: "npm run build" }, "shell"],
  [{ acpKind: "read", title: "Read file" }, "read"],
  [{ acpKind: "other", title: "read_file" }, "read"],
  [{ acpKind: "question", title: "Which colour?" }, "question"],
  [{ title: "mako: app_start" }, "mcp"],
] satisfies [ToolSource, string][]) assert.equal(identifyTool(source).kind, kind, JSON.stringify(source))
console.log("tool identity: retained live blocks resolve")

// The SDK clips large arguments for live display but keeps its native route in
// the title. Only a declared wrapper may use that exact route as fallback.
const clipped = identifyTool({ harness: "cursor", name: "mcp", title: "mako: app_status", input: '{"providerIdentifier":"mako","toolName":"app_status","args":{"large":"' })
assert.equal(clipped.label, "App status")
assert.equal(clipped.server, "mako")
assert.equal(clipped.tool, "app_status")
assert.equal(identifyTool({ harness: "cursor", name: "mcp", title: "Check my app please", input: "{" }).label, "MCP tool")
