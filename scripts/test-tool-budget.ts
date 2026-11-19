import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Tiktoken } from "js-tiktoken/lite"
import o200kBase from "js-tiktoken/ranks/o200k_base"
import { z } from "zod"
import { AGENT_TOOL_ROLES, AGENT_TOOLS, ROLE_HIDES, type AgentToolRole } from "@mako/host/contracts/agent-tools"
import { makoToolList } from "./lib/mako-tool-list.ts"

/**
 * What Mako's `mako` server costs an agent's context, per role, held to a committed budget
 * (`scripts/tool-budget.json`): the server instructions and each tool as tools/list sends it, in o200k_base tokens and
 * UTF-8 bytes of its JSON. Harnesses load these per tool (Claude's ToolSearch, Codex's lookup, Cursor's and Grok's tool
 * search) or the whole server at once (Devin's listing), so each tool and the total are held. A tool over its line, a
 * total over its role's, or a tool the budget doesn't name fails. Lower numbers pass; lower the budget with them.
 *
 *   tsx scripts/test-tool-budget.ts            check
 *   tsx scripts/test-tool-budget.ts --write    write the budget as measured (an increase is a reviewed change)
 *   tsx scripts/test-tool-budget.ts --table    print each role's tools and totals as Markdown
 */

const BUDGET_FILE = join(import.meta.dirname, "tool-budget.json")
const encoder = new Tiktoken(o200kBase)

interface Cost { tokens: number; bytes: number }
const Cost = z.object({ tokens: z.number(), bytes: z.number() })
const Budget = z.object({
  tokenizer: z.literal("o200k_base"),
  roles: z.record(z.string(), z.object({ total: Cost, instructions: Cost, tools: z.record(z.string(), Cost) })),
})
type RoleCost = z.infer<typeof Budget>["roles"][string]

const cost = (text: string): Cost => ({ tokens: encoder.encode(text).length, bytes: Buffer.byteLength(text) })

async function measure(role: AgentToolRole): Promise<RoleCost> {
  const { instructions, tools } = await makoToolList(role)
  const each = Object.fromEntries(tools.map((tool) => [tool.name, cost(JSON.stringify(tool))]))
  const sum = (key: keyof Cost) => Object.values(each).reduce((total, one) => total + one[key], 0)
  const told = cost(instructions)
  return { total: { tokens: sum("tokens") + told.tokens, bytes: sum("bytes") + told.bytes }, instructions: told, tools: each }
}

const measured = Object.fromEntries(await Promise.all(AGENT_TOOL_ROLES.map(async (role) => [role, await measure(role)] as const)))

// Each role is offered every agents_* tool but those it hides, and every other tool alike.
const everyAgentTool = AGENT_TOOLS.map((tool) => tool.mcp.name)
const others = Object.keys(measured["fin-apex"].tools).filter((name) => !name.startsWith("agents_"))
for (const role of AGENT_TOOL_ROLES) {
  const hidden = new Set(ROLE_HIDES[role].map((verb) => `agents_${verb}`))
  assert.deepEqual(Object.keys(measured[role].tools).sort(), [...others, ...everyAgentTool.filter((name) => !hidden.has(name))].sort(), `${role}'s tools`)
}
assert.deepEqual(ROLE_HIDES.thread, ["report"], "a top-level Thread never has an Apex to report to")
assert.deepEqual(ROLE_HIDES.apex, ["report"], "nor does one with Fins")
// A harness lists a launch's tools once: a Thread that starts its first Fin mid-launch settles with what it was listed,
// and a Fin that does answers, links, moves and settles with it, so neither loses those verbs before it has Fins.
assert.deepEqual(ROLE_HIDES.fin, [], "a Fin keeps every verb: it may start or link Fins of its own mid-launch")
assert.deepEqual(ROLE_HIDES["fin-apex"], [], "a Fin that is an Apex of its own reports and keeps every Apex tool")

if (process.argv.includes("--table")) {
  for (const role of AGENT_TOOL_ROLES) {
    const { total, instructions, tools } = measured[role]
    console.log(`\n### ${role}: ${Object.keys(tools).length} tools, ${total.tokens.toLocaleString("en")} tokens (${total.bytes.toLocaleString("en")} bytes) with instructions (${instructions.tokens})\n`)
    console.log("| tool | tokens | bytes |\n|---|---:|---:|")
    for (const [name, one] of Object.entries(tools).sort(([, a], [, b]) => b.tokens - a.tokens)) console.log(`| \`${name}\` | ${one.tokens} | ${one.bytes} |`)
  }
}

if (process.argv.includes("--write")) {
  writeFileSync(BUDGET_FILE, `${JSON.stringify({ tokenizer: "o200k_base", roles: measured }, null, 2)}\n`)
  console.log(`wrote ${BUDGET_FILE}`)
} else {
  const budget = Budget.parse(JSON.parse(readFileSync(BUDGET_FILE, "utf8")))
  const over: string[] = []
  const hold = (what: string, now: Cost, line: Cost | undefined) => {
    if (!line) return void over.push(`${what}: not in the budget (${now.tokens} tokens, ${now.bytes} bytes)`)
    for (const key of ["tokens", "bytes"] as const) if (now[key] > line[key]) over.push(`${what}: ${now[key]} ${key}, budget ${line[key]}`)
  }
  for (const role of AGENT_TOOL_ROLES) {
    const now = measured[role], line = budget.roles[role]
    hold(`${role} total`, now.total, line?.total)
    hold(`${role} instructions`, now.instructions, line?.instructions)
    for (const [name, one] of Object.entries(now.tools)) hold(`${role} ${name}`, one, line?.tools[name])
  }
  assert.deepEqual(over, [], `Mako's tool definitions grew past scripts/tool-budget.json. Shorten them, or raise the budget in review with \`tsx scripts/test-tool-budget.ts --write\`:\n${over.join("\n")}`)
  for (const role of AGENT_TOOL_ROLES) console.log(`${role}: ${Object.keys(measured[role].tools).length} tools, ${measured[role].total.tokens} tokens, ${measured[role].total.bytes} bytes (budget ${budget.roles[role]!.total.tokens}, ${budget.roles[role]!.total.bytes})`)
}
