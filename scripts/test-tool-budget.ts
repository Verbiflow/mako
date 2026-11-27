import assert from "node:assert/strict"
import { Tiktoken } from "js-tiktoken/lite"
import o200kBase from "js-tiktoken/ranks/o200k_base"
import { AGENT_TOOL_ROLES, AGENT_TOOLS, ROLE_HIDES, type AgentToolRole } from "@mako/host/contracts/agent-tools"
import { makoToolList } from "./lib/mako-tool-list.ts"

/**
 * What Mako's `mako` server costs an agent's context, per role, held under fixed ceilings: the server instructions and
 * each tool as tools/list sends it, in o200k_base tokens. Harnesses load these per tool (Claude's ToolSearch, Codex's
 * lookup, Cursor's and Grok's tool search) or the whole server at once (Devin's listing), so each tool and each role's
 * total have a ceiling. They sit well above today's sizes: an ordinary wording change passes, a tool or role that
 * balloons fails. Each role's tool set is held exactly.
 *
 *   tsx scripts/test-tool-budget.ts            check
 *   tsx scripts/test-tool-budget.ts --table    print each role's tools and totals as Markdown
 */

/** A role's whole server, instructions included: about 17,000 tokens today. */
const ROLE_CEILING = 22_000
/** Any one tool: the largest, agents_start, is about 1,500 tokens today. */
const TOOL_CEILING = 2_000
/** The server instructions: about 750 tokens today. */
const INSTRUCTIONS_CEILING = 1_200

const encoder = new Tiktoken(o200kBase)

interface Cost { tokens: number; bytes: number }
interface RoleCost { total: Cost; instructions: Cost; tools: Record<string, Cost> }

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
  // A Fin works for an Apex and is never listed `apex` (`registerThreadTools`).
  const theirs = others.filter((name) => role !== "fin" || name !== "apex")
  assert.deepEqual(Object.keys(measured[role].tools).sort(), [...theirs, ...everyAgentTool.filter((name) => !hidden.has(name))].sort(), `${role}'s tools`)
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

const over: string[] = []
for (const role of AGENT_TOOL_ROLES) {
  const { total, instructions, tools } = measured[role]
  if (total.tokens > ROLE_CEILING) over.push(`${role} total: ${total.tokens} tokens, ceiling ${ROLE_CEILING}`)
  if (instructions.tokens > INSTRUCTIONS_CEILING) over.push(`${role} instructions: ${instructions.tokens} tokens, ceiling ${INSTRUCTIONS_CEILING}`)
  for (const [name, one] of Object.entries(tools)) if (one.tokens > TOOL_CEILING) over.push(`${role} ${name}: ${one.tokens} tokens, ceiling ${TOOL_CEILING}`)
}
assert.deepEqual(over, [], `Mako's tool definitions grew past their ceilings. Shorten them:\n${over.join("\n")}`)
for (const role of AGENT_TOOL_ROLES) console.log(`${role}: ${Object.keys(measured[role].tools).length} tools, ${measured[role].total.tokens} tokens (ceiling ${ROLE_CEILING})`)
