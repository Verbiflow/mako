import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { ORCHESTRATION_INSTRUCTIONS } from "@mako/host/contracts/agent-tools"
import { TOOL_FAMILIES, type ToolFamily } from "@mako/host/contracts/mako-layer"
import { startStubMako } from "./eval-orch-tools/stub-mako.ts"

/**
 * What the Mako layer costs an agent before its first message, held to a
 * committed budget: the bytes of each instruction block and of each tool
 * family's tools as the model reads them (name, description, input schema).
 * A change that grows one fails until `fixtures/layer-budget.json` is raised
 * in the same change, so growth is a decision in review; a change that
 * shrinks one fails until the budget is lowered, so savings stay won.
 */
const BUDGET = join(import.meta.dirname, "fixtures/layer-budget.json")
const Budget = z.object({ instructions: z.record(z.string(), z.number()), families: z.record(z.string(), z.number()) })

const bytes = (text: string) => Buffer.byteLength(text, "utf8")
const PREFIXES: ReadonlyArray<readonly [string, ToolFamily]> = [
  ["agents_", "agents"], ["worktree_", "worktree"], ["pull_request_", "pull-request"], ["app_", "app"], ["port_holder", "app"],
  ["recipe_", "recipe"], ["thread_history", "thread-history"], ["show", "show"],
]
const familyOf = (tool: string): ToolFamily => {
  const found = PREFIXES.find(([prefix]) => tool.startsWith(prefix))
  assert.ok(found, `${tool} belongs to a tool family in TOOL_FAMILIES: add its prefix here`)
  return found[1]
}

const stub = await startStubMako()
try {
  const { instructions, tools } = await stub.describe()
  const families: Record<string, number> = {}
  for (const tool of tools) {
    const family = familyOf(tool.name)
    assert.ok(family in TOOL_FAMILIES)
    families[family] = (families[family] ?? 0) + bytes(JSON.stringify({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }))
  }
  const measured = {
    instructions: { mako: bytes(instructions.replace(ORCHESTRATION_INSTRUCTIONS, "")), orchestration: bytes(ORCHESTRATION_INSTRUCTIONS) },
    families,
  }
  const budget = Budget.parse(JSON.parse(readFileSync(BUDGET, "utf8")))
  assert.deepEqual(measured, budget, `The Mako layer's context changed. Set ${BUDGET} to the measured values above in this change, and say why in the pull request; before cutting text to fit, run the orchestration evals that read it (eval:orch-tools).`)
  const total = Object.values(measured.instructions).reduce((sum, each) => sum + each, 0) + Object.values(measured.families).reduce((sum, each) => sum + each, 0)
  console.log(`layer budget: ok (${total} bytes before the first message: ${JSON.stringify(measured)})`)
} finally {
  await stub.close()
}
