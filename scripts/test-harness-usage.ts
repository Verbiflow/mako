// Each harness maps its usage fields once, in its vocabulary
// (`@mako/sessions/harnesses`), and three readers count through that map:
// the live meter, the saved-history reader, and the usage scanner behind the
// 30-day summary. This holds the maps on real and damaged fields, then holds
// the three readers to the same spend on every recorded pair: a capture
// through the live decoder, its store through the history reader, the same
// store through the scanner. A difference a harness's own store forces is
// listed with its reason, and one that stops happening fails until removed.
import assert from "node:assert/strict"
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  claudeHourCacheWrites, claudeTokens, ClaudeUsage, CodexRolloutUsage, codexTokens, CodexWireUsage, DevinCallMetrics, devinStoredTokens,
  devinUsageReading, GrokCallUsage,
  grokCallTokens, grokCost, grokTokens, GrokTurnUsage, inclusiveTokens, openCodeTokens, OpenCodeTokens,
} from "@mako/sessions/harnesses"
import { DatabaseSync } from "node:sqlite"
import { ClaudeProvider, GrokProvider, OpenCodeProvider, type ThreadEntry } from "@mako/sessions"
import { DevinCliProvider } from "../packages/sessions/src/providers/devin-cli.ts"
import { providerHost } from "../electron/providers/index.ts"
import { usageHarnesses, usageSummary } from "../electron/usage.ts"
import { UsageLedger } from "../electron/usage-ledger.ts"
import { decoderFor, readRecording } from "./native-decoding.ts"
import { ownStore, PairSchema, storeReader } from "./decode-compare.ts"

// ── The maps ────────────────────────────────────────────────────────────────

const claudeCall = {
  input_tokens: 3, output_tokens: 310, cache_read_input_tokens: 45_000, cache_creation_input_tokens: 1_200,
  cache_creation: { ephemeral_1h_input_tokens: 400, ephemeral_5m_input_tokens: 800 }, service_tier: "standard", speed: "fast",
}
assert.deepEqual(claudeTokens(ClaudeUsage.parse(claudeCall)), { input: 3, output: 310, cacheRead: 45_000, cacheWrite: 1_200 })
assert.equal(claudeHourCacheWrites(ClaudeUsage.parse(claudeCall)), 400)
const claudeDamaged = { input_tokens: "7", output_tokens: -1, cache_read_input_tokens: null, cache_creation_input_tokens: 5, cache_creation: "none" }
assert.deepEqual(claudeTokens(ClaudeUsage.parse(claudeDamaged)), { input: 0, output: 0, cacheRead: 0, cacheWrite: 5 }, "Claude: a field that is not a count counts nothing; the rest still count")
assert.equal(claudeHourCacheWrites(ClaudeUsage.parse(claudeDamaged)), 0)

// Codex counts cached input inside input and reasoning inside output, on both of its wires.
const codexCall = { input: 10_000, cached: 8_000, write: 500, output: 300, reasoning: 120, total: 10_300 }
const codexLive = CodexWireUsage.parse({
  inputTokens: codexCall.input, cachedInputTokens: codexCall.cached, cacheWriteInputTokens: codexCall.write,
  outputTokens: codexCall.output, reasoningOutputTokens: codexCall.reasoning, totalTokens: codexCall.total,
})
const codexSaved = CodexRolloutUsage.parse({
  input_tokens: codexCall.input, cached_input_tokens: codexCall.cached, cache_write_input_tokens: codexCall.write,
  output_tokens: codexCall.output, reasoning_output_tokens: codexCall.reasoning, total_tokens: codexCall.total,
})
const codexCounted = { input: 1_500, output: 300, cacheRead: 8_000, cacheWrite: 500, reasoning: 120 }
assert.deepEqual(codexTokens(codexLive), codexCounted, "Codex's app-server wire")
assert.deepEqual(codexTokens(codexSaved), codexCounted, "Codex's rollout counts the same call the same")
assert.deepEqual(codexTokens(CodexRolloutUsage.parse({ input_tokens: 100, cached_input_tokens: 400, output_tokens: "9" })),
  { input: 0, output: 0, cacheRead: 100, cacheWrite: 0 }, "Codex: cache beyond input is clamped to it; a count as text counts nothing")
assert.equal(CodexRolloutUsage.parse({ input_tokens: 5 }).total, undefined, "a call without its total is not mistaken for an empty context")

// Grok's turn and each model's share count cache inside input; its per-call record does not.
const grokTurn = GrokTurnUsage.parse({
  inputTokens: 9_000, outputTokens: 200, cachedReadTokens: 6_000, cacheCreationTokens: 0, reasoningTokens: 50, costUsdTicks: 125_000_000,
  modelUsage: { "grok-build": { inputTokens: 9_000, outputTokens: 200, cachedReadTokens: 6_000, costUsdTicks: 125_000_000 }, broken: "x" },
})
assert.deepEqual(grokTokens(grokTurn), { input: 3_000, output: 200, cacheRead: 6_000, cacheWrite: 0, reasoning: 50 })
assert.equal(grokCost(grokTurn), 0.0125, "Grok's cost is in ten-billionths of a dollar")
assert.equal(grokTurn.modelUsage?.broken, null, "one unreadable model share leaves the others")
assert.equal(grokCost(GrokTurnUsage.parse({ inputTokens: 1 })), undefined, "no ticks is no reported cost, not a free turn")
assert.deepEqual(grokCallTokens(GrokCallUsage.parse({ input_tokens: 3_000, output_tokens: 200, cache_read_input_tokens: 6_000, cache_creation_input_tokens: 10 })),
  { input: 3_000, output: 200, cacheRead: 6_000, cacheWrite: 10 })

// OpenCode counts reasoning beside output; a bill counts it as output.
assert.deepEqual(openCodeTokens(OpenCodeTokens.parse({ input: 40, output: 300, reasoning: 120, cache: { read: 9_000, write: 70 } })),
  { input: 40, output: 420, cacheRead: 9_000, cacheWrite: 70, reasoning: 120 })
assert.deepEqual(openCodeTokens(OpenCodeTokens.parse({ input: 40, output: null, cache: "none" })), { input: 40, output: 0, cacheRead: 0, cacheWrite: 0 })

// Devin's live reading counts cache inside input; its store does not. One call, read both ways (3000.10.23).
assert.deepEqual(devinUsageReading({ "cognition.ai/inputTokens": 11_496, "cognition.ai/outputTokens": 147, "cognition.ai/cachedReadTokens": 327 }),
  { of: "agent", tokens: { input: 11_169, output: 147, cacheRead: 327, cacheWrite: 0 } })
assert.deepEqual(devinStoredTokens(DevinCallMetrics.parse({ input_tokens: 11_169, output_tokens: 147, cache_read_tokens: 327, cache_creation_tokens: 0, ttft_ms: 900 })),
  { input: 11_169, output: 147, cacheRead: 327, cacheWrite: 0 }, "the stored call counts what the live one did")
assert.deepEqual(devinStoredTokens(DevinCallMetrics.parse({ input_tokens: null, output_tokens: 40, cache_read_tokens: "4" })), { input: 0, output: 40, cacheRead: 0, cacheWrite: 0 },
  "Devin: a null count, which its store holds, and one as text count nothing; the rest still count")
assert.deepEqual(devinUsageReading({ "cognition.ai/inputTokens": 5, "cognition.ai/outputTokens": 5, "cognition.ai/subagent_context": { parentAgentId: "root" } }), { of: "repeat" })

assert.deepEqual(inclusiveTokens({ input: 100, cacheRead: 70, cacheWrite: 50, output: 5 }), { input: 0, output: 5, cacheRead: 70, cacheWrite: 30 },
  "cache writes beyond what input left after reads are clamped too")

// ── The three readers on every recorded pair ───────────────────────────────

/** The day after the pairs were recorded, so the summary's 30 days hold them all. */
const NOW = Date.parse("2026-10-08T00:00:00Z")
const PAIRS = join(import.meta.dirname, "fixtures", "native-decoding")
const HARNESSES = ["claude", "codex", "devin", "grok", "opencode"]
const harnesses = usageHarnesses(providerHost)

interface Tokens { input: number; output: number; cacheRead: number; cacheWrite: number }
type Reader = "live" | "saved" | "scanned"

/**
 * A pair whose readers cannot agree, with the reader that stands apart and
 * why. `stored` stands for the saved reader and the scanner together: the
 * store itself lacks what the live wire said.
 */
interface Apart { apart: Reader | "stored"; because: string }
const APART = new Map<string, Apart>([
  ["claude/compaction", { apart: "stored", because: "Claude Code saves no record of the call that wrote the compaction summary" }],
  ["devin/compaction", { apart: "scanned", because: "Devin reports no usage for the `compactor` call that wrote the summary, and keeps its row off the conversation; only the store holds what it spent" }],
  ["devin/rewound-turn", { apart: "saved", because: "a rewound turn leaves the conversation, but what it spent stays spent" }],
  ["grok/rewound-turn", { apart: "saved", because: "a rewound turn leaves the conversation, but what it spent stays spent" }],
  ["grok/stopped-shell", { apart: "stored", because: "Grok saves no spend for a turn it was stopped in, though it reports it live" }],
  ["opencode/rewound-turn", { apart: "stored", because: "OpenCode deletes a reverted turn's messages, and their spend with them" }],
])

function sum(entries: readonly ThreadEntry[]): Tokens {
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  for (const entry of entries) {
    if (entry.kind !== "assistant" || !entry.usage) continue
    total.input += entry.usage.input ?? 0
    total.output += entry.usage.output ?? 0
    total.cacheRead += entry.usage.cacheRead ?? 0
    total.cacheWrite += entry.usage.cacheWrite ?? 0
  }
  return total
}

const ZERO: Tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
const same = (left: Tokens, right: Tokens) =>
  left.input === right.input && left.output === right.output && left.cacheRead === right.cacheRead && left.cacheWrite === right.cacheWrite
const shown = (tokens: Tokens) => `${tokens.input} in, ${tokens.output} out, ${tokens.cacheRead} cache read, ${tokens.cacheWrite} cache write`

async function readers(harness: string, folder: string): Promise<Record<Reader, Tokens>> {
  const pair = PairSchema.parse(JSON.parse(await readFile(join(folder, "pair.json"), "utf8")))
  const recording = await readRecording(join(folder, "capture.jsonl"))
  const decoder = decoderFor(harness).open(recording.session)
  let live = ZERO
  for (const message of recording.messages)
    for (const item of decoder.decode(message))
      if (item.kind === "state" && item.patch.usage?.tokens) live = item.patch.usage.tokens
  const home = join(folder, "home")
  const thread = await storeReader(harness, home).read(join(home, ownStore(pair)))
  if (!thread) throw new Error(`${folder}: the history reader found no session at ${ownStore(pair)}`)
  const summary = await usageSummary(harnesses, join(folder, "no-sessions"), home, undefined, { now: NOW })
  if (summary.truncated) throw new Error(`${folder}: the scanner left records unread`)
  const { input, output, cacheRead, cacheWrite } = summary.total
  return { live: { input: live.input, output: live.output, cacheRead: live.cacheRead, cacheWrite: live.cacheWrite }, saved: sum(thread.entries), scanned: { input, output, cacheRead, cacheWrite } }
}

const failures: string[] = []
let pairs = 0
for (const harness of HARNESSES) {
  for (const scenario of (await readdir(join(PAIRS, harness, "pairs"))).sort()) {
    const name = `${harness}/${scenario}`
    const read = await readers(harness, join(PAIRS, harness, "pairs", scenario))
    pairs += 1
    const known = APART.get(name)
    const together: Reader[] = known?.apart === "stored" ? ["saved", "scanned"] : (["live", "saved", "scanned"] as const).filter((reader) => reader !== known?.apart)
    const disagree = together.some((reader) => !same(read[reader], read[together[0]!]))
    const apart = known && (known.apart === "stored" ? !same(read.live, read.saved) : !same(read[known.apart], read[together[0]!]))
    const report = (["live", "saved", "scanned"] as const).map((reader) => `  ${reader.padEnd(7)} ${shown(read[reader])}`).join("\n")
    if (disagree) failures.push(`${name}: the readers count different spend\n${report}`)
    else if (known && !apart) failures.push(`${name} is listed apart (${known.because}), yet its readers agree; remove it from APART\n${report}`)
  }
}
for (const name of APART.keys())
  if (!HARNESSES.some((harness) => name.startsWith(`${harness}/`))) failures.push(`${name} is listed apart but no such pair is read`)
if (failures.length) assert.fail(failures.join("\n\n"))

// ── Stores a harness's own variable moved ──────────────────────────────────

const scratch = await mkdtemp(join(tmpdir(), "mako-harness-usage-"))
try {
  const empty = join(scratch, "home")
  const spendOf = async (env: NodeJS.ProcessEnv, ledger?: UsageLedger) =>
    usageSummary(harnesses, join(scratch, "no-sessions"), empty, undefined, { now: NOW, env, ...ledger && { ledger } })

  const grokPair = join(PAIRS, "grok", "pairs", "read-and-answer")
  const grokStore = ownStore(PairSchema.parse(JSON.parse(await readFile(join(grokPair, "pair.json"), "utf8"))))
  const grokHome = join(scratch, "grok-elsewhere")
  await cp(join(grokPair, "home", ".grok"), grokHome, { recursive: true })
  const grokMoved = await spendOf({ GROK_HOME: grokHome })
  assert.deepEqual([grokMoved.total.input, grokMoved.total.output], [2_400, 80], "the scanner reads Grok's sessions where GROK_HOME moved them")
  assert.equal((await spendOf({})).total.input, 0, "without the variable the moved store is not the home's")
  const grokThread = await new GrokProvider(empty, { GROK_HOME: grokHome }).read(join(grokHome, grokStore.replace(/^\.grok\//, "")))
  assert.deepEqual(sum(grokThread?.entries ?? []), { input: 2_400, output: 80, cacheRead: 0, cacheWrite: 0 }, "the history reader follows GROK_HOME too")

  const openCodePair = join(PAIRS, "opencode", "pairs", "read-and-answer")
  const openCodeStore = ownStore(PairSchema.parse(JSON.parse(await readFile(join(openCodePair, "pair.json"), "utf8"))))
  const dataHome = join(scratch, "data-elsewhere")
  await cp(join(openCodePair, "home", ".local", "share"), dataHome, { recursive: true })
  const openCodeMoved = await spendOf({ XDG_DATA_HOME: dataHome })
  assert.deepEqual([openCodeMoved.total.input, openCodeMoved.total.output], [2_400, 80], "the scanner reads OpenCode's database where XDG_DATA_HOME moved it")
  const openCodeThread = await new OpenCodeProvider(empty, { XDG_DATA_HOME: dataHome }).read(join(dataHome, openCodeStore.replace(/^\.local\/share\//, "")))
  assert.deepEqual(sum(openCodeThread?.entries ?? []), { input: 2_400, output: 80, cacheRead: 0, cacheWrite: 0 }, "the history reader follows XDG_DATA_HOME too")

  // Claude's store moves only by declaration: Mako launches Claude without an exported CLAUDE_CONFIG_DIR, so neither reader follows one.
  const claudePair = join(PAIRS, "claude", "pairs", "read-and-answer")
  const claudeStore = ownStore(PairSchema.parse(JSON.parse(await readFile(join(claudePair, "pair.json"), "utf8"))))
  const claudeSpent = (await readers("claude", claudePair)).scanned
  const claudeElsewhere = join(scratch, "claude-elsewhere")
  await cp(join(claudePair, "home", ".claude"), claudeElsewhere, { recursive: true })
  assert.ok(claudeSpent.input + claudeSpent.cacheRead > 0)
  assert.ok(same((await spendOf({ CLAUDE_CONFIG_DIR: claudeElsewhere })).total, ZERO), "an exported CLAUDE_CONFIG_DIR adds no store to the scan")
  const declaring = join(scratch, "claude-declaring")
  await mkdir(join(declaring, ".mako"), { recursive: true })
  await writeFile(join(declaring, ".mako", "roots.json"), JSON.stringify({ claude: [join(claudeElsewhere, "projects")] }))
  const claudeDeclared = await usageSummary(harnesses, join(scratch, "no-sessions"), declaring, undefined, { now: NOW, env: {} })
  assert.ok(same(claudeDeclared.total, claudeSpent), "the scanner reads a store ~/.mako/roots.json declares")
  const claudeFile = join(claudeElsewhere, claudeStore.replace(/^\.claude\//, ""))
  assert.ok(new ClaudeProvider(declaring).roots().includes(await realpath(join(claudeElsewhere, "projects"))), "the history reader lists the declared store")
  assert.deepEqual(sum((await new ClaudeProvider(declaring).read(claudeFile))?.entries ?? []), claudeSpent, "and reads the same spend from it")

  const devinPair = join(PAIRS, "devin", "pairs", "read-and-answer")
  const devinStore = ownStore(PairSchema.parse(JSON.parse(await readFile(join(devinPair, "pair.json"), "utf8"))))
  const devinSpent = (await readers("devin", devinPair)).scanned
  const devinData = join(scratch, "devin-data-elsewhere")
  await cp(join(devinPair, "home", ".local", "share"), devinData, { recursive: true })
  const devinMoved = await spendOf({ XDG_DATA_HOME: devinData })
  assert.ok(devinSpent.input > 0 && same(devinMoved.total, devinSpent), "the scanner reads Devin's store where XDG_DATA_HOME moved it")
  const devinThread = await new DevinCliProvider(empty, { XDG_DATA_HOME: devinData }).read(join(devinData, devinStore.replace(/^\.local\/share\//, "")))
  assert.deepEqual(sum(devinThread?.entries ?? []), devinSpent, "the history reader follows XDG_DATA_HOME too")

  // Devin's scanner continues past the last row it read: a call added later is read alone, a
  // repeat of a call counts once, a call saved again with its metrics is read again, and a store
  // made again is read from the window's start. Writes use Devin 3000.10.23's own statement.
  const database = join(devinData, "devin", "cli", "sessions.db")
  const session = devinStore.slice(devinStore.indexOf("#") + 1)
  const saveCall = (path: string, node: number, request: string, input?: number) => {
    const db = new DatabaseSync(path)
    try {
      const metrics = input === undefined ? {} : { metrics: { input_tokens: input, output_tokens: 1 } }
      const chat = { role: "assistant", content: "", metadata: { request_id: request, created_at: "2026-10-07T12:00:00Z", generation_model: "swe-2-high", ...metrics } }
      db.prepare(`INSERT OR REPLACE INTO message_nodes
             (session_id, node_id, parent_node_id, chat_message, created_at, metadata)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)`)
        .run(session, node, null, JSON.stringify(chat), Date.parse("2026-10-07T12:00:00Z") / 1000, null)
    } finally {
      db.close()
    }
  }
  const devinLedger = new UsageLedger(join(scratch, "devin-usage.sqlite"))
  try {
    const devinSpend = async () => (await spendOf({ XDG_DATA_HOME: devinData }, devinLedger)).total.input
    assert.equal(await devinSpend(), devinSpent.input)
    saveCall(database, 9_001, "added-call", 1_000)
    saveCall(database, 9_002, "added-call", 1_000)
    assert.equal(await devinSpend(), devinSpent.input + 1_000, "the added call counts once, though stored twice")
    assert.equal(await devinSpend(), devinSpent.input + 1_000, "a read with nothing new adds nothing")
    saveCall(database, 9_003, "deferred-metrics")
    assert.equal(await devinSpend(), devinSpent.input + 1_000, "a call saved before its metrics adds nothing yet")
    saveCall(database, 9_003, "deferred-metrics", 200)
    assert.equal(await devinSpend(), devinSpent.input + 1_200, "the same node saved again with its metrics is read on the next scan")
    const devinCursor = () => {
      const db = new DatabaseSync(join(scratch, "devin-usage.sqlite"), { readOnly: true })
      try {
        return db.prepare("SELECT cursor FROM stores").all().map((row) => Number(row.cursor))
      } finally {
        db.close()
      }
    }
    const before = devinCursor()
    const store = new DatabaseSync(database)
    store.prepare("DELETE FROM message_nodes WHERE session_id = ?1").run(session)
    store.close()
    assert.equal(await devinSpend(), devinSpent.input + 1_200, "a deleted session keeps the spend already counted")
    assert.deepEqual(devinCursor(), before, "and isn't taken for a store made again, so nothing is read twice")
    await cp(join(devinPair, "home", ".local", "share", "devin", "cli", "sessions.db"), database)
    saveCall(database, 9_001, "after-remaking", 50)
    assert.equal(await devinSpend(), devinSpent.input + 1_250, "a store made again, its rows below where the last read stopped, is read again")
  } finally {
    devinLedger.close()
  }

  // Grok's word that its own record of a turn's usage misses calls reaches the summary, and outlives the read that found it.
  const updates = join(grokHome, grokStore.replace(/^\.grok\//, ""))
  const text = await readFile(updates, "utf8")
  const marked = text.split("\n").map((line) => {
    if (!line.includes('"turn_completed"')) return line
    const record = JSON.parse(line)
    record.params.update.usage.usageIsIncomplete = true
    return JSON.stringify(record)
  }).join("\n")
  assert.notEqual(marked, text, "the pair saved a completed turn to mark")
  await writeFile(updates, marked)
  const ledger = new UsageLedger(join(scratch, "usage.sqlite"))
  try {
    const first = await spendOf({ GROK_HOME: grokHome }, ledger)
    assert.deepEqual(first.incomplete, ["Grok"], "a turn Grok marks incomplete makes the summary say Grok's totals may be low")
    const again = await spendOf({ GROK_HOME: grokHome }, ledger)
    assert.deepEqual(again.incomplete, ["Grok"], "the ledger keeps the mark when the file is not read again")
    assert.equal(again.total.input, first.total.input)
  } finally {
    ledger.close()
  }
} finally {
  await rm(scratch, { recursive: true, force: true })
}

console.log(`harness usage: one field map per harness; live, saved and scanned spend agree on ${pairs} pairs (${APART.size} apart for their stores' reasons); moved stores and incomplete usage are read`)
