import assert from "node:assert/strict"
import { identifyTool, type ToolIdentity, type ToolSource } from "@mako/sessions/tool-identity"
import { HARNESS_TOOL_SAMPLES } from "../src/dev/harness-tool-samples.ts"
import { VOCABULARIES, type NativeTool } from "@mako/sessions/harnesses"

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

// Every harness's code-mode wrapper reads the tool a script calls however the script names it: dotted, or in brackets
// (any quote, any spacing), which a server whose name isn't an identifier needs. A wrapper that draws its calls as rows
// of their own names the cell by the call; one that doesn't is the call itself, so a running js call draws its steps.
const scriptWrappers = VOCABULARIES.flatMap((vocabulary) =>
  Object.entries<NativeTool>(vocabulary.tools).flatMap(([name, tool]) => (tool.wraps?.form === "script" ? [{ harness: vocabulary.harness, name, wraps: tool.wraps }] : [])),
)
assert.ok(scriptWrappers.length >= 2, `script wrappers: ${scriptWrappers.map((wrapper) => `${wrapper.harness}/${wrapper.name}`).join(", ")}`)
const JS = `({ title: "Check the session", code: "await control.status()" })`
const spellings = [
  `tools["mako-computer"].js${JS}`,
  `tools['mako-computer']['js']${JS}`,
  `tools[ \`mako-computer\` ] . js${JS}`,
  `tools["mcp__mako-computer__js"]${JS}`,
]
for (const wrapper of scriptWrappers) {
  for (const spelling of spellings) {
    const code = `const result = await ${spelling}\nreturn result`
    const identity = identifyTool({ harness: wrapper.harness, name: wrapper.name, input: wrapper.wraps.key ? JSON.stringify({ [wrapper.wraps.key]: code }) : code })
    const where = `${wrapper.harness}/${wrapper.name}: ${spelling}`
    if (wrapper.wraps.callsShown) assert.deepEqual([identity.kind, identity.target], ["code", "Computer"], where)
    else assert.deepEqual([identity.kind, identity.tool, identity.server, identity.via, identity.target], ["computer", "js", "mako-computer", wrapper.name, "Check the session"], where)
  }
  // An MCP tool of a server named as an identifier, in brackets and dotted alike.
  for (const spelling of [`tools.mako["app_status"]()`, `tools.mako.app_status()`]) {
    const code = `return await ${spelling}`
    const identity = identifyTool({ harness: wrapper.harness, name: wrapper.name, input: wrapper.wraps.key ? JSON.stringify({ [wrapper.wraps.key]: code }) : code })
    const label = wrapper.wraps.callsShown ? identity.target : identity.label
    assert.equal(label, "Read the app's status", `${wrapper.harness}/${wrapper.name}: ${spelling}`)
  }
}
console.log(`tool identity: ${scriptWrappers.length} code-mode wrappers read bracketed calls (${scriptWrappers.map((wrapper) => `${wrapper.harness} ${wrapper.name}`).join(", ")})`)

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
assert.equal(clipped.label, "Read the app's status")
assert.equal(clipped.server, "mako")
assert.equal(clipped.tool, "app_status")
assert.equal(identifyTool({ harness: "cursor", name: "mcp", title: "Check my app please", input: "{" }).label, "MCP tool")
