import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { VOCABULARIES, type NativeTool } from "@mako/sessions/harnesses"
import { hasVocabulary, identifyTool, isDeclaredTool, nativeToolNames } from "@mako/sessions/tool-identity"
import { HARNESS_TOOL_SAMPLES } from "../src/dev/harness-tool-samples.ts"

// One spelling names one tool within a harness, and every declaration says what it was checked against.
for (const vocabulary of VOCABULARIES) {
  const seen = new Map<string, string>()
  for (const [name, tool] of Object.entries<NativeTool>(vocabulary.tools)) {
    for (const spelling of [name, ...(tool.aliases ?? [])]) {
      const key = spelling.toLowerCase()
      assert.equal(seen.get(key), undefined, `${vocabulary.harness}: ${spelling} names both ${seen.get(key)} and ${name}`)
      seen.set(key, name)
    }
  }
  assert.ok(vocabulary.checked.version && vocabulary.checked.on && vocabulary.checked.against, `${vocabulary.harness} says what its names were checked against`)
  for (const kind of ["shell", "read", "edit", "search"] as const)
    assert.ok(nativeToolNames(vocabulary.harness, kind).length > 0, `${vocabulary.harness} declares a ${kind} tool`)
}
console.log(`harness vocabulary: ${VOCABULARIES.length} harnesses, one spelling per tool`)

// Claude's own report of its tools at startup, recorded by `npm run harness:self-report -- claude`.
const ClaudeInit: { version: string; tools: string[] } = JSON.parse(readFileSync(new URL("./fixtures/native-vocabulary/claude-init.json", import.meta.url), "utf8"))
const unreported = ClaudeInit.tools.filter((tool) => !isDeclaredTool("claude", tool))
assert.deepEqual(unreported, [], `Claude ${ClaudeInit.version} reports tools its vocabulary doesn't declare`)
console.log(`harness vocabulary: Claude ${ClaudeInit.version}'s ${ClaudeInit.tools.length} reported tools are declared`)

// Every recorded sample is a name its own harness declares, not one the shared fallback happened to know.
const undeclared = HARNESS_TOOL_SAMPLES.flatMap(({ source, undeclared }) =>
  !undeclared && source.harness && source.name && hasVocabulary(source.harness) && !isDeclaredTool(source.harness, source.name) ? [`${source.harness}/${source.name}`] : [])
assert.deepEqual(undeclared, [], "samples whose harness doesn't declare them")
console.log(`harness vocabulary: ${HARNESS_TOOL_SAMPLES.length} samples are declared by their harness`)

// The inverse names a concept to each harness.
assert.deepEqual(nativeToolNames("claude", "question"), ["AskUserQuestion"])
assert.deepEqual(nativeToolNames("codex", "question"), ["request_user_input", "request_user_input_async"])
assert.deepEqual(nativeToolNames("devin", "plan-exit"), ["exit_plan_mode"])

// MCP names resolve only in the forms their harness uses.
const cursorMcp = identifyTool({ harness: "cursor", name: "mako-local-control-mako_computer_click", input: "{}" })
assert.deepEqual([cursorMcp.kind, cursorMcp.server, cursorMcp.tool], ["computer", "mako-local-control", "mako_computer_click"])
assert.equal(identifyTool({ harness: "cursor", name: "mako-browser-use-mako_browser_status" }).label, "Computer: status")
assert.equal(identifyTool({ harness: "claude", name: "some-hyphen-name" }).kind, "other")
assert.equal(identifyTool({ harness: "codex", name: "mcp__axiom__queryDataset", input: "{}" }).label, "axiom: query dataset")
assert.equal(identifyTool({ harness: "grok", name: "x_search" }).label, "X search")
console.log("harness vocabulary: MCP names resolve in each harness's own forms")
