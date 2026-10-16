import { parseArgs } from "node:util"
import { SAVED_HISTORY_READERS } from "../packages/sessions/src/readers.ts"
import { identifyTool, toolKindWork } from "../packages/sessions/src/tool-identity.ts"
import { savedCallEffects, toolEffectsStatus } from "../packages/sessions/src/tool-effect-reading.ts"
import type { ToolEffect } from "../packages/sessions/src/tool-effects.ts"
import { NativeStores } from "../packages/sessions/src/read-only-sqlite.ts"

/**
 * How much of this machine's recent work reports its effects, per harness:
 * of the calls that change files (an edit, a write, a delete or a move by
 * their identity), how many report a file effect and how exactly (a patch
 * with line numbers, an edit's strings, whole content, or the bare path),
 * and of the commands, how many name their folder, exit and paths. Reads
 * each harness's recent sessions through its history reader, read-only.
 * Prints numbers only, never a path, a command or content.
 *
 *   npm run audit:effects -- [--harness grok] [--sessions 40]
 */

const options = parseArgs({ options: { harness: { type: "string" }, sessions: { type: "string", default: "40" } } }).values
const limit = Number(options.sessions)
const stores = new NativeStores(false)

interface Tally {
  sessions: number
  ms: number
  calls: number
  changes: number
  withEffects: number
  patch: number
  edits: number
  content: number
  bare: number
  commands: number
  withCwd: number
  withExit: number
  withNamed: number
  /** Commands that also report the files they changed (Claude's `bashEditDiff`). */
  commandFiles: number
  refused: number
  failed: number
}

const rows: [string, Tally][] = []
for (const make of SAVED_HISTORY_READERS) {
  const provider = make(stores)
  if (options.harness && provider.harness !== options.harness) continue
  const files = (await provider.discover().catch(() => [])).sort((left, right) => right.mtimeMs - left.mtimeMs).slice(0, limit)
  const tally: Tally = { sessions: 0, ms: 0, calls: 0, changes: 0, withEffects: 0, patch: 0, edits: 0, content: 0, bare: 0, commands: 0, withCwd: 0, withExit: 0, withNamed: 0, commandFiles: 0, refused: 0, failed: 0 }
  for (const file of files) {
    const started = performance.now()
    const thread = await provider.read(file.path).catch(() => null)
    if (!thread) continue
    tally.sessions++
    for (const block of thread.entries) {
      if (block.type !== "tool") continue
      tally.calls++
      const effects = savedCallEffects(provider.harness, block, thread.ref.cwd)
      const failed = block.status === "failed" || block.status === "canceled"
      const status = toolEffectsStatus(provider.harness, { finished: block.output !== undefined || failed, failed, output: block.output })
      if (status === "refused") tally.refused++
      if (status === "failed") tally.failed++
      const identity = identifyTool({ harness: provider.harness, name: block.name ?? block.title ?? "", input: block.input })
      const files = effects.filter(changesFile)
      if (toolKindWork(identity.kind) === "change") {
        tally.changes++
        if (files.length) tally.withEffects++
        const exactness = files.length ? exactnessOf(files) : undefined
        if (exactness) tally[exactness]++
      }
      const command = effects.find((effect) => effect.kind === "command")
      if (command?.kind === "command") {
        tally.commands++
        if (command.cwd) tally.withCwd++
        if (command.exitCode !== undefined) tally.withExit++
        if (command.named?.length) tally.withNamed++
        if (files.length) tally.commandFiles++
      }
    }
    tally.ms += performance.now() - started
  }
  provider.close?.()
  // Devin has two stores, its CLI's and Devin.app's journal: the reader names which.
  rows.push([`${provider.harness} ${provider.constructor.name.replace(/Provider$/, "")}`, tally])
}

/**
 * How exactly a call states its file changes, by its least exact one: the
 * bare path, an edit's strings, a patch with line numbers, or whole content
 * (a created or written file's, a delete or a rename, exact by nature).
 */
function exactnessOf(effects: readonly ToolEffect[]): "bare" | "edits" | "patch" | "content" {
  const bare = effects.some((effect) =>
    (effect.kind === "modify" && effect.patch === undefined && effect.edits === undefined) ||
    ((effect.kind === "create" || effect.kind === "write") && effect.content === undefined))
  if (bare) return "bare"
  if (effects.some((effect) => effect.kind === "modify" && effect.edits !== undefined)) return "edits"
  if (effects.some((effect) => effect.kind === "modify")) return "patch"
  return "content"
}

function changesFile(effect: ToolEffect): boolean {
  return effect.kind !== "read" && effect.kind !== "command"
}

const percent = (part: number, whole: number) => whole ? `${Math.round((part / whole) * 100)}%` : "-"
console.log("reader                   sessions  calls  change calls  with effects  line patch  edit strings  content  path only   commands  with folder  with exit  naming paths  file changes   refused  failed   read ms")
for (const [reader, tally] of rows) {
  console.log([
    reader.padEnd(24), String(tally.sessions).padStart(8), String(tally.calls).padStart(6), String(tally.changes).padStart(13),
    `${tally.withEffects} (${percent(tally.withEffects, tally.changes)})`.padStart(14), String(tally.patch).padStart(11), String(tally.edits).padStart(13),
    String(tally.content).padStart(8), String(tally.bare).padStart(10), String(tally.commands).padStart(10),
    `${tally.withCwd} (${percent(tally.withCwd, tally.commands)})`.padStart(12), `${tally.withExit} (${percent(tally.withExit, tally.commands)})`.padStart(10),
    String(tally.withNamed).padStart(13), String(tally.commandFiles).padStart(13), String(tally.refused).padStart(9), String(tally.failed).padStart(7), String(Math.round(tally.ms)).padStart(9),
  ].join(" "))
}
