import { parseArgs } from "node:util"
import type { SessionProvider } from "../packages/sessions/src/providers/types.ts"
import { CodexProvider } from "../packages/sessions/src/providers/codex.ts"
import { ClaudeProvider } from "../packages/sessions/src/providers/claude.ts"
import { CursorProvider } from "../packages/sessions/src/providers/cursor.ts"
import { GrokProvider } from "../packages/sessions/src/providers/grok.ts"
import { OpenCodeProvider } from "../packages/sessions/src/providers/opencode.ts"
import { DevinCliProvider } from "../packages/sessions/src/providers/devin-cli.ts"
import { primaryArgument, toolLabel } from "../src/lib/tools.ts"

/**
 * How every harness's tool calls reach the transcript, read from this
 * machine's own native stores through Mako's history readers.
 *
 *   npx tsx scripts/audit-native-tools.ts [--harness grok] [--sessions 40]
 *
 * Prints tool names, labels and argument keys only, never argument values or
 * output, so the report is safe to paste. A name the transcript has no label
 * for is shown as `(raw)`: the row draws the native name as it came.
 */

const options = parseArgs({
  options: {
    harness: { type: "string" },
    sessions: { type: "string", default: "40" },
  },
}).values
const limit = Number(options.sessions)

const providers: SessionProvider[] = [
  new CodexProvider(), new ClaudeProvider(), new CursorProvider(),
  new GrokProvider(), new OpenCodeProvider(), new DevinCliProvider(),
]

interface ToolTally {
  count: number
  keys: Map<string, number>
  primary: Map<string, number>
  failed: number
}

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
        const tally = tools.get(block.name) ?? { count: 0, keys: new Map(), primary: new Map(), failed: 0 }
        tally.count += 1
        if (block.error) tally.failed += 1
        const keys = argumentKeys(block.input)
        for (const key of keys) tally.keys.set(key, (tally.keys.get(key) ?? 0) + 1)
        const primary = primaryKey(block.input)
        tally.primary.set(primary, (tally.primary.get(primary) ?? 0) + 1)
        tools.set(block.name, tally)
      }
    }
  }
  provider.close?.()
  console.log(`\n## ${provider.harness}: ${read} sessions, ${tools.size} tool names`)
  const rows = [...tools].sort((a, b) => b[1].count - a[1].count)
  for (const [name, tally] of rows) {
    const label = toolLabel(name)
    const shown = label === name ? "(raw)" : label
    const keys = [...tally.keys].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([key]) => key).join(",")
    const primary = [...tally.primary].sort((a, b) => b[1] - a[1]).map(([key, n]) => `${key}×${n}`).slice(0, 3).join(" ")
    console.log(`${String(tally.count).padStart(5)}  ${clip(name, 46).padEnd(46)} ${shown.padEnd(16)} primary: ${primary.padEnd(28)} keys: ${keys}`)
  }
}

function argumentKeys(input: string | undefined): string[] {
  if (!input) return ["(no input)"]
  try {
    const parsed: unknown = JSON.parse(input)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return Object.keys(parsed)
    return ["(not an object)"]
  } catch {
    return ["(not JSON)"]
  }
}

/** Which argument the collapsed row shows, by key, so values stay out of the report. */
function primaryKey(input: string | undefined): string {
  if (!input) return "(none)"
  const value = primaryArgument(input)
  if (!value) return "(none)"
  try {
    const parsed: unknown = JSON.parse(input)
    if (parsed && typeof parsed === "object")
      for (const [key, candidate] of Object.entries(parsed))
        if (candidate === value || (Array.isArray(candidate) && candidate.join(" ") === value)) return key
  } catch {
    return "(?)"
  }
  return "(?)"
}

function clip(text: string, width: number): string {
  const flat = text.replace(/\s+/g, " ")
  return flat.length > width ? `${flat.slice(0, width - 1)}…` : flat
}
