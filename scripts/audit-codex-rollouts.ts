import { readdir, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { performance } from "node:perf_hooks"
import type { JsonObject, JsonValue } from "@mako/host/contracts/json"
import { CodexDecoder } from "@mako/host/harnesses/codex/decoder"
import { isJsonObject, objectValue, stringValue } from "@mako/host/base/json-values"
import { readLines } from "@mako/sessions/jsonl"
import { reduceLiveUpdates, type LiveUpdate } from "@mako/sessions/live-content"
import { NativeStores } from "@mako/sessions/read-only-sqlite"
import { CodexProvider } from "@mako/sessions"

/**
 * Every Codex rollout on this Mac through the one decoder both ways: as
 * saved history folds it into entries (`CodexProvider`), and as a live
 * session draws it (`CodexDecoder.records`, each turn announced as the
 * app-server announces it, the updates reduced as the window reduces
 * them). Prints counts only, never content.
 *
 *   npx tsx --tsconfig tsconfig.app.json scripts/audit-codex-rollouts.ts
 *   npx tsx --tsconfig tsconfig.app.json scripts/audit-codex-rollouts.ts --home <folder holding .codex>
 *
 * A rollout over the saved reader's 64 MB window, or one whose entries the
 * saved budget trimmed, is counted apart: saved history shows only its end.
 * Live leaves out the prompts Mako draws itself; saved history keeps them.
 * Records outside every turn are the history Codex copies into a forked or
 * resumed thread's rollout before its first turn, which saved history draws
 * and no live turn does; they are counted, and live plus them must be saved.
 */

const home = process.argv.includes("--home") ? process.argv[process.argv.indexOf("--home") + 1]! : homedir()
const WINDOW = 64 * 1024 * 1024

interface Counts {
  tools: number
  failed: number
  canceled: number
  text: number
  thinking: number
  plans: number
  markers: number
  attachments: number
}

const empty = (): Counts => ({ tools: 0, failed: 0, canceled: 0, text: 0, thinking: 0, plans: 0, markers: 0, attachments: 0 })
const KINDS: readonly (keyof Counts)[] = ["tools", "failed", "canceled", "text", "thinking", "plans", "markers", "attachments"]

async function rollouts(): Promise<string[]> {
  const found: string[] = []
  const walk = async (folder: string): Promise<void> => {
    for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
      const path = join(folder, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.name.endsWith(".jsonl")) found.push(path)
    }
  }
  await walk(join(home, ".codex", "sessions"))
  await walk(join(home, ".codex", "archived_sessions"))
  return found
}

/** What saved history draws of a rollout. */
function savedCounts(entries: Awaited<ReturnType<CodexProvider["read"]>>): Counts | undefined {
  if (!entries) return undefined
  const counts = empty()
  for (const entry of entries.entries) {
    if (entry.kind === "event") {
      if (!entry.opensTurn) counts.markers++
      continue
    }
    if (entry.kind !== "assistant") continue
    for (const block of entry.blocks) {
      if (block.type === "tool") {
        counts.tools++
        if (block.canceled) counts.canceled++
        else if (block.error) counts.failed++
      } else if (block.type === "text") counts.text++
      else if (block.type === "thinking") counts.thinking++
      else if (block.type === "proposed-plan") counts.plans++
      else if (block.type === "attachment") counts.attachments++
    }
  }
  return counts
}

/** What a live session draws of the same records, turn by turn, as the app-server announces each; and the replies and compactions outside every turn. */
async function liveCounts(path: string): Promise<{ live: Counts; outside: Counts }> {
  const outside = empty()
  let turnOpen = false
  /** A review mode entered outside a turn, which draws when its turn starts next and is history otherwise. */
  let review = false
  const decoder = new CodexDecoder({ threadId: "audit", state: {} })
  const updates: LiveUpdate[] = []
  let markers = 0
  const take = (decoded: ReturnType<CodexDecoder["records"]>) => {
    for (const item of decoded) {
      if (item.kind === "update") updates.push(item.update)
      else if (item.kind === "marker" || item.kind === "compacted") markers++
    }
  }
  await readLines(path, 0, (line) => {
    let value: JsonValue
    try {
      value = JSON.parse(line)
    } catch {
      return
    }
    if (!isJsonObject(value)) return
    const record: JsonObject = value
    const payload = objectValue(record["payload"])
    const type = stringValue(record["type"])
    const inner = stringValue(payload?.["type"])
    const turn = type === "event_msg" && ["task_started", "turn_started"].includes(inner ?? "") ? stringValue(payload?.["turn_id"]) : undefined
    if (review && !turn) outside.markers++
    review = false
    if (turn) {
      turnOpen = true
      take(decoder.decode({ method: "turn/started", params: { threadId: "audit", turn: { id: turn } } }))
    }
    if (!turnOpen && type === "compacted") outside.markers++
    if (!turnOpen && type === "event_msg" && ["task_complete", "turn_complete"].includes(inner ?? "") && objectValue(payload?.["error"])) outside.markers++
    if (!turnOpen && inner === "item_completed" && stringValue(objectValue(payload?.["item"])?.["type"]) === "EnteredReviewMode") review = true
    if (!turnOpen && type === "response_item" && inner === "message" && stringValue(payload?.["role"]) === "assistant") outside.text++
    take(decoder.records([record]))
    if (type === "event_msg" && ["task_complete", "turn_complete", "turn_aborted"].includes(inner ?? "")) turnOpen = false
  })
  if (review) outside.markers++
  const counts = empty()
  counts.markers = markers
  for (const block of reduceLiveUpdates([], updates)) {
    if (block.type === "tool") {
      counts.tools++
      if (/cancel/i.test(block.status)) counts.canceled++
      else if (block.status === "failed") counts.failed++
    } else if (block.type === "text") counts.text++
    else if (block.type === "thinking") counts.thinking++
    else if (block.type === "proposed-plan") counts.plans++
    else if (block.type === "attachment") counts.attachments++
  }
  return { live: counts, outside }
}

const provider = new CodexProvider(new NativeStores(false), home)
const totals = { live: empty(), saved: empty(), outside: empty() }
const differing = new Map<string, number>()
let compared = 0
let agreed = 0
let windowed = 0
let unread = 0
let liveMs = 0
let savedMs = 0
const files = await rollouts()
for (const path of files) {
  const info = await stat(path)
  let started = performance.now()
  const thread = await provider.read(path)
  savedMs += performance.now() - started
  const saved = savedCounts(thread)
  if (!saved) {
    unread++
    continue
  }
  if (info.size > WINDOW || thread?.entries[0]?.kind === "event" && thread.entries[0].label === "Earlier history not shown") {
    windowed++
    continue
  }
  started = performance.now()
  const { live, outside } = await liveCounts(path)
  liveMs += performance.now() - started
  compared++
  let same = true
  for (const key of KINDS) {
    totals.live[key] += live[key]
    totals.saved[key] += saved[key]
    totals.outside[key] += outside[key]
    if (live[key] + outside[key] !== saved[key]) {
      same = false
      differing.set(key, (differing.get(key) ?? 0) + 1)
    }
  }
  if (same) agreed++
}

console.log(`${files.length} rollouts: ${compared} compared, ${agreed} draw the same live and saved once the history copied in before any turn is counted; ${windowed} past saved history's window, ${unread} not a thread's (a subagent's or unreadable)`)
console.log(`decoding: saved ${Math.round(savedMs)} ms, live ${Math.round(liveMs)} ms`)
console.log("\n            live   outside turns      saved")
for (const key of KINDS)
  console.log(`${key.padEnd(12)}${String(totals.live[key]).padStart(8)}${String(totals.outside[key]).padStart(16)}${String(totals.saved[key]).padStart(11)}${differing.has(key) ? `   differs in ${differing.get(key)} rollouts` : ""}`)
