import { existsSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import { parseArgs } from "node:util"
import type { DatabaseSync } from "node:sqlite"
import { openReadOnly } from "@mako/sessions/read-only-sqlite"
import { appDataFor } from "@mako/host/base/host-environment"
import { conversationSpend, contextOf, turnTrigger, TURN_TRIGGER_LABELS, type TurnSpend } from "@mako/host/contracts/usage-ledger"
import type { LiveRequest } from "@mako/host/contracts/live-conversations"
import type { LiveSessionState, TokenCounts } from "@mako/host/contracts/providers-acp"
import { priceEstimate } from "@mako/host/usage/pricing"
import { HelperRuns, helperRunsRoot } from "@mako/host/usage/helper-runs"

/**
 * One conversation's usage, every number with where it came from:
 *
 *   npm run usage -- <conversation id, its prefix, or the native session id>
 *   npm run usage -- <id> --all            every turn and native call, not the newest 20
 *   npm run usage -- <id> --json           the same as one JSON document
 *   npm run usage -- --list                the conversations with spend, newest first
 *   npm run usage -- <id> --data <dir>     another data root; `MAKO_PROFILE` or `MAKO_DATA_ROOT` pick one too
 *
 * Reads, never writes: the conversation's journal (what its context holds,
 * each turn's spend as Mako measured it, its side questions), the usage
 * ledger the Settings › Usage summary keeps (each native call the harness's
 * own store recorded, as of the last summary), and Mako's helper runs in the
 * conversation's folder. The data root defaults to the installed app's.
 */

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    all: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    list: { type: "boolean", default: false },
    data: { type: "string" },
    limit: { type: "string", default: "20" },
  },
})

const dataRoot = values.data ?? process.env.MAKO_DATA_ROOT ?? join(appDataFor(process.platform, homedir(), process.env), process.env.MAKO_PROFILE ? `mako-${process.env.MAKO_PROFILE}` : "mako")
const limit = values.all ? Infinity : Math.max(1, Number(values.limit) || 20)
const journals = join(dataRoot, "conversations")

interface Journal {
  path: string
  id: string
  session: LiveSessionState
  requests: LiveRequest[]
  side: number
  modified: number
}

function withDatabase<T>(path: string, read: (db: DatabaseSync) => T): T {
  const { database } = openReadOnly(path)
  try {
    return read(database)
  } finally {
    database.close()
  }
}

function readJournal(path: string, requests: boolean): Journal | undefined {
  try {
    return withDatabase(path, (db) => {
      const metadata = JSON.parse(String(db.prepare("SELECT value FROM metadata WHERE id=1").get()?.value ?? "null"))
      if (!metadata?.session) return undefined
      const rows = requests ? db.prepare("SELECT value FROM requests ORDER BY rowid").all() : []
      return {
        path,
        id: basename(path, ".sqlite"),
        session: metadata.session,
        requests: rows.map((row) => JSON.parse(String(row.value))),
        side: metadata.side?.exchanges?.length ?? 0,
        modified: statSync(path).mtimeMs,
      }
    })
  } catch {
    return undefined
  }
}

function journalPaths(): string[] {
  if (!existsSync(journals)) throw new Error(`No conversations under ${dataRoot}. Pass --data, or set MAKO_PROFILE.`)
  return readdirSync(journals).filter((name) => name.endsWith(".sqlite")).map((name) => join(journals, name))
}

function find(query: string): Journal {
  const direct = journalPaths().filter((path) => basename(path).startsWith(query))
  if (direct.length === 1) return readJournal(direct[0]!, true) ?? fail(`${direct[0]} could not be read`)
  if (direct.length > 1) fail(`${direct.length} conversations start with ${query}; give more of the id`)
  for (const path of journalPaths()) {
    const journal = readJournal(path, false)
    if (journal?.session.nativeId === query || journal?.session.nativePath === query) return readJournal(path, true)!
  }
  return fail(`No conversation ${query} under ${journals}`)
}

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

const tokensText = (tokens: TokenCounts | undefined) => tokens ? `${count(tokens.input)} in · ${count(tokens.cacheRead)} cache read · ${count(tokens.cacheWrite)} cache write · ${count(tokens.output)} out${tokens.reasoning ? ` (${count(tokens.reasoning)} reasoning)` : ""}` : "no tokens"
const count = (value: number) => value < 1000 ? String(value) : value < 1_000_000 ? `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k` : `${(value / 1_000_000).toFixed(1)}M`
const money = (value: number) => value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`
const when = (at: number) => new Date(at).toISOString().replace("T", " ").slice(0, 16)
const costText = (spend: Pick<TurnSpend, "cost" | "estimate" | "provider">) =>
  spend.cost !== undefined ? `${money(spend.cost)} (${spend.provider} priced it)` : spend.estimate ? `≈ ${money(spend.estimate.amount)} (Mako, table ${spend.estimate.table})` : "unpriced"

/** A native call the usage ledger holds for this session, as the harness's own store recorded it. */
interface StoreCall {
  key: string
  source: string
  at: number
  model: string
  tokens: TokenCounts
  cost?: number
  /** Mako's estimate as it was recorded, with its table; ledgers before version 4 have none. */
  estimate?: { amount: number; table: string }
  incomplete: boolean
}

/** The ledger's calls for a conversation, and the ledger they came from with when it last changed. */
interface StoreRead {
  calls: StoreCall[]
  ledger?: { path: string; modified: number }
}

function storeCalls(journal: Journal): StoreRead {
  const path = join(dataRoot, "usage-ledger.sqlite")
  if (!existsSync(path)) return { calls: [] }
  const ids = [journal.session.nativeId, journal.id].filter((id): id is string => Boolean(id))
  const calls = withDatabase(path, (db) => db.prepare(`SELECT * FROM events WHERE session IN (${ids.map(() => "?").join(",")}) ORDER BY at, key`).all(...ids)).map((row): StoreCall => ({
    key: String(row.key),
    source: String(row.source),
    at: Number(row.at),
    model: String(row.model),
    tokens: { input: Number(row.input), cacheRead: Number(row.cache_read), cacheWrite: Number(row.cache_write), output: Number(row.output) },
    ...row.cost !== null && { cost: Number(row.cost) },
    ...row.estimate !== undefined && row.estimate !== null && { estimate: { amount: Number(row.estimate), table: String(row.price_table) } },
    incomplete: Boolean(Number(row.incomplete)),
  }))
  return { calls, ledger: { path, modified: Math.max(statSync(path).mtimeMs, existsSync(`${path}-wal`) ? statSync(`${path}-wal`).mtimeMs : 0) } }
}

if (values.list) {
  const listed = journalPaths().flatMap((path) => {
    const journal = readJournal(path, true)
    if (!journal) return []
    const spend = conversationSpend(journal.requests)
    return spend.turns ? [{ journal, spend }] : []
  }).sort((left, right) => right.journal.modified - left.journal.modified).slice(0, limit)
  for (const { journal, spend } of listed)
    console.log(`${journal.id}  ${journal.session.harness.padEnd(8)}  ${String(spend.turns).padStart(4)} turns  ${count(spend.tokens ? contextOf(spend.tokens) : 0).padStart(6)} tokens  ${journal.session.title ?? ""}`.trimEnd())
  process.exit(0)
}

const query = positionals[0] ?? fail("Name a conversation: npm run usage -- <id>, or --list")
const journal = find(query)
const { session, requests } = journal
const spend = conversationSpend(requests)
const { calls, ledger } = storeCalls(journal)
const helpers = (await new HelperRuns(helperRunsRoot(dataRoot)).list(0, 500)).filter((run) => run.cwd === session.cwd)
const usage = session.usage
const turns = requests.flatMap((request, index) => request.spend ? [{ index: index + 1, request, spend: request.spend }] : [])

if (values.json) {
  console.log(JSON.stringify({
    dataRoot, journal: journal.path, conversation: journal.id, harness: session.harness, nativeId: session.nativeId,
    occupancy: { used: usage?.used, size: usage?.size, compactedFrom: usage?.compactedFrom, source: "the harness's last reading, kept in the journal" },
    harnessTotal: usage?.native && { ...usage.native, source: "the harness's own totals for its native session" },
    spend: { ...spend, source: "each turn's spend, measured by Mako between the harness's readings" },
    turns: turns.map(({ index, request, spend }) => ({ index, id: request.id, trigger: turnTrigger(request), status: request.status, ...spend })),
    sideQuestions: journal.side,
    store: { ledger, calls },
    helpers,
    changes: "not counted yet: the attribution journal's per-turn counts aren't wired",
  }, null, 2))
  process.exit(0)
}

const lines: string[] = []
const say = (line = "") => lines.push(line)
say(`${session.title ?? "(untitled)"} · ${session.harness} · ${journal.id}`)
say(`  journal      ${journal.path}`)
say(`  native       ${session.nativeId ?? "none yet"}${session.nativePath ? ` · ${session.nativePath}` : ""}`)
say(`  folder       ${session.cwd}`)
say()
say("Context now  (occupancy: the harness's last reading, kept in the journal)")
if (usage?.used !== undefined && usage.size) say(`  ${count(usage.used)} of ${count(usage.size)} tokens · ${Math.round((usage.used / usage.size) * 100)}%`)
else if (usage?.compactedFrom !== undefined) say(`  compacted from ${count(usage.compactedFrom)} of ${count(usage.size ?? 0)}; the harness didn't say what it left, so the next reply measures it`)
else say("  not measured")
if (usage?.native) {
  say()
  say("The harness's own total  (its native session's totals, turns outside Mako included)")
  say(`  ${tokensText(usage.native.tokens)}${usage.native.cost !== undefined ? ` · ${money(usage.native.cost)} as it priced it` : ""}`)
}
say()
say(`Spent in this conversation  (each turn's spend, Mako's measurement between the harness's readings)`)
say(`  ${spend.turns} turns · ${tokensText(spend.tokens)}`)
say(`  ${spend.cost !== undefined ? `${money(spend.cost)} as harnesses priced it` : "no cost reported"}${spend.estimate ? ` · ≈ ${money(spend.estimate.amount)} estimated by Mako (tables ${spend.estimate.tables.join(", ")}), not a bill` : ""}${spend.unpriced ? ` · ${spend.unpriced} turns unpriced` : ""}`)
if (spend.unrecorded.tokens || spend.unrecorded.cost) say(`  ${spend.unrecorded.tokens} turns left calls out of their counts, ${spend.unrecorded.cost} left cost out: these are floors`)
const unspent = requests.filter((request) => !request.spend && ["completed", "failed", "interrupted"].includes(request.status)).length
if (unspent) say(`  ${unspent} finished turns recorded no spend (journals before spend was kept for every harness, or a turn that spent nothing)`)
say()
const shown = turns.slice(-limit)
say(`Turns  (newest ${shown.length} of ${turns.length}; --all for every one)`)
for (const { index, request, spend: turn } of shown)
  say(`  ${String(index).padStart(4)}  ${when(turn.at)}  ${TURN_TRIGGER_LABELS[turnTrigger(request)].padEnd(31)}  ${request.status.padEnd(11)}  ${(turn.model ?? "?").padEnd(18)}  ${tokensText(turn.tokens)} · ${costText(turn)}${turn.unrecorded ? ` · left ${turn.unrecorded} out` : ""}`)
if (journal.side) {
  say()
  say(`Side questions  ${journal.side}, answered by the harness beside the session; their spend isn't reported apart from its own`)
}
say()
const ledgerAge = ledger ? `${Math.round((Date.now() - ledger.modified) / 60_000)} minutes ago` : ""
say(`The harness's own store  (the usage ledger Settings › Usage keeps${ledger ? `, last summarized ${ledgerAge}` : ": none yet, open Settings › Usage to make one"})`)
if (calls.length) {
  const storeTokens = calls.reduce<TokenCounts>((sum, call) => ({ input: sum.input + call.tokens.input, cacheRead: sum.cacheRead + call.tokens.cacheRead, cacheWrite: sum.cacheWrite + call.tokens.cacheWrite, output: sum.output + call.tokens.output }), { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 })
  const reported = calls.reduce((sum, call) => sum + (call.cost ?? 0), 0)
  const estimated = calls.reduce((sum, call) => sum + (call.cost === undefined ? call.estimate?.amount ?? priceEstimate(call.model, { ...call.tokens, summed: false })?.amount ?? 0 : 0), 0)
  // A harness whose store keeps no tokens is summarized from Mako's own journals, keyed by conversation.
  const fromJournal = calls.every((call) => call.key.includes(`:${journal.id}:`))
  say(`  ${calls.length} ${fromJournal ? "turns from Mako's journal, since its store keeps no tokens," : "calls"} from ${[...new Set(calls.map((call) => call.source))].join(", ")} · ${tokensText(storeTokens)}`)
  const tables = [...new Set(calls.flatMap((call) => call.cost === undefined && call.estimate ? [call.estimate.table] : []))]
  say(`  ${reported ? `${money(reported)} as recorded` : "no cost recorded"}${estimated ? ` · ≈ ${money(estimated)} estimated by Mako (${tables.length ? `tables ${tables.join(", ")}` : "today's table"}), not a bill` : ""}${calls.some((call) => call.incomplete) ? " · some records say they miss calls" : ""}`)
  if (spend.tokens) {
    const difference = contextOf(storeTokens) - contextOf(spend.tokens)
    say(`  against the turns: ${difference >= 0 ? "+" : "-"}${count(Math.abs(difference))} tokens${difference ? " (the store also counts turns outside Mako and subagents filed apart, and holds nothing since its last summary)" : ""}`)
  }
  for (const call of calls.slice(-Math.min(limit, 10))) say(`    ${when(call.at)}  ${call.model.padEnd(24)}  ${tokensText(call.tokens)}${call.cost !== undefined ? ` · ${money(call.cost)}` : ""}`)
} else say("  no calls for this session in the ledger")
say()
say(`Mako's helper runs in this folder  (model calls Mako made itself, from usage/helper-runs)`)
if (helpers.length)
  for (const run of helpers.slice(0, limit)) say(`  ${when(run.at)}  ${run.purpose.padEnd(16)}  ${run.trigger} · ${run.connection} · ${run.calls} calls · ${run.outcome} · ${tokensText(run.tokens)}${run.estimate ? ` · ≈ ${money(run.estimate.amount)} (table ${run.estimate.table})` : ""}`)
else say("  none")
say()
say("Changes made  not counted yet: the attribution journal's per-turn counts aren't wired to the ledger")
console.log(lines.join("\n"))
