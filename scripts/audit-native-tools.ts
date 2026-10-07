import { parseArgs } from "node:util"
import { z } from "zod"
import type { SessionProvider } from "../packages/sessions/src/providers/types.ts"
import { CodexProvider } from "../packages/sessions/src/providers/codex.ts"
import { ClaudeProvider } from "../packages/sessions/src/providers/claude.ts"
import { CursorProvider } from "../packages/sessions/src/providers/cursor.ts"
import { GrokProvider } from "../packages/sessions/src/providers/grok.ts"
import { OpenCodeProvider } from "../packages/sessions/src/providers/opencode.ts"
import { DevinCliProvider } from "../packages/sessions/src/providers/devin-cli.ts"
import { identifyTool, isDeclaredTool } from "../packages/sessions/src/tool-identity.ts"

/**
 * How every harness's tool calls resolve, read from this machine's own native
 * stores through Mako's history readers and `identifyTool`.
 *
 *   npm run audit:tools -- [--harness grok] [--sessions 40] [--unresolved]
 *
 * Prints names, kinds, labels and argument keys only, never argument values
 * or output, so the report is safe to paste. A name marked `undeclared` is
 * one its harness's vocabulary (packages/sessions/src/harnesses/) doesn't
 * declare, whatever the shared fallback made of it; `no target` counts calls
 * whose collapsed row would show only the label.
 */

const options = parseArgs({
  options: {
    harness: { type: "string" },
    sessions: { type: "string", default: "40" },
    unresolved: { type: "boolean", default: false },
  },
}).values
const limit = Number(options.sessions)

const providers: SessionProvider[] = [
  new CodexProvider(), new ClaudeProvider(), new CursorProvider(),
  new GrokProvider(), new OpenCodeProvider(), new DevinCliProvider(),
]

interface ToolTally {
  count: number
  kind: string
  label: string
  untargeted: number
  undeclared: boolean
  keys: Map<string, number>
}

const Arguments = z.record(z.string(), z.json())
let unresolvedTotal = 0

for (const provider of providers) {
  if (options.harness && provider.harness !== options.harness) continue
  const files = (await provider.discover().catch(() => []))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit)
  const tools = new Map<string, ToolTally>()
  let read = 0
  for (const file of files) {
    const thread = await provider.read(file.path).catch(() => null)
    if (!thread) continue
    read += 1
    for (const entry of thread.entries) {
      if (entry.kind !== "assistant") continue
      for (const block of entry.blocks) {
        if (block.type !== "tool") continue
        const identity = identifyTool({ harness: provider.harness, name: block.name, input: block.input })
        const row = identity.via ? `${block.name} → ${identity.server ? `${identity.server}/` : ""}${identity.tool}` : block.name
        const tally = tools.get(row) ?? { count: 0, kind: identity.kind, label: identity.label, untargeted: 0, undeclared: !isDeclaredTool(provider.harness, block.name), keys: new Map() }
        tally.count += 1
        if (!identity.target) tally.untargeted += 1
        for (const key of argumentKeys(identity.input ?? block.input)) tally.keys.set(key, (tally.keys.get(key) ?? 0) + 1)
        tools.set(row, tally)
      }
    }
  }
  provider.close?.()
  const rows = [...tools]
    .filter(([, tally]) => !options.unresolved || tally.undeclared)
    .sort((a, b) => b[1].count - a[1].count)
  const unresolved = rows.filter(([, tally]) => tally.undeclared).length
  unresolvedTotal += unresolved
  console.log(`\n## ${provider.harness}: ${read} sessions, ${tools.size} tools, ${unresolved} undeclared`)
  for (const [row, tally] of rows) {
    const keys = [...tally.keys].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([key]) => key).join(",")
    const untargeted = tally.untargeted ? `no target ×${tally.untargeted}` : ""
    console.log(`${String(tally.count).padStart(5)}  ${clip(row, 64).padEnd(64)} ${tally.kind.padEnd(13)} ${clip(tally.label, 22).padEnd(22)} ${untargeted.padEnd(16)} ${(tally.undeclared ? "undeclared" : "").padEnd(10)} keys: ${keys}`)
  }
}
console.log(`\n${unresolvedTotal} tool names their harness doesn't declare`)

function argumentKeys(input: string | undefined): string[] {
  if (!input) return ["(no input)"]
  try {
    const parsed = Arguments.safeParse(JSON.parse(input))
    return parsed.success ? Object.keys(parsed.data) : ["(not an object)"]
  } catch {
    return ["(script)"]
  }
}

function clip(text: string, width: number): string {
  const flat = text.replace(/\s+/g, " ")
  return flat.length > width ? `${flat.slice(0, width - 1)}…` : flat
}
