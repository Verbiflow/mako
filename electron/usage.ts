import { readdir, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { exclusiveTokens, tokenCount } from "@mako/sessions/harnesses"
import { z } from "zod"
import { objectValue, stringValue } from "./codex-app-json.js"
import { hostWarn } from "./host-log.js"
import { harnessLabel } from "./providers/harness-descriptors.js"
import type { ProviderHost } from "./providers/host.js"
import type { ProviderUsageHistory } from "./providers/usage-history.js"
import type { UsageSummary, UsageTotals } from "./shared.js"
import { UsageLedger } from "./usage-ledger.js"
import { estimateUsageCost } from "./usage-pricing.js"
import {
  DAYS,
  discover,
  fingerprint,
  parseObject,
  readAppended,
  tokenTotal,
  usageCounts,
  validTimestamp,
  yieldToMain,
  type JsonlReader,
  type UsageEvent,
  type UsageScan,
} from "./usage-scan.js"

interface Bucket extends UsageTotals {
  key: string
  reportedCost: number
  estimatedCost: number
  pricedTokens: number
  unpricedTokens: number
}

/** A harness the usage table counts, under the name Settings shows for it. */
export interface UsageHarness {
  provider: string
  label: string
  /** How its own store's records are read; without one, Mako's measurements are the record. */
  history?: ProviderUsageHistory
}

/** Every installed harness, as `usageSummary` counts it. */
export function usageHarnesses(host: ProviderHost): UsageHarness[] {
  return host.harnesses.list().map(({ provider }) => ({
    provider,
    label: harnessLabel(host, provider),
    history: host.usageHistories.get(provider),
  }))
}

export interface UsageSummaryOptions {
  /** Kept between summaries so each reads only what changed; a summary without one reads everything once. */
  ledger?: UsageLedger
  now?: number
  /** The environment harnesses run with; the process's own for the default home, none for another (a fixture's). */
  env?: NodeJS.ProcessEnv
}

/** Where the harnesses' stores are: the home, and the variables that move a store from it. */
interface UsageHome {
  homeRoot: string
  env: NodeJS.ProcessEnv
}

/** A record some reader could not read. */
interface Unread {
  source: string
  path: string
  reason: string
}

export async function usageSummary(
  harnesses: readonly UsageHarness[],
  sessionsRoot: string,
  homeRoot = homedir(),
  conversationsRoot?: string,
  options: UsageSummaryOptions = {}
): Promise<UsageSummary> {
  const ledger = options.ledger ?? new UsageLedger()
  try {
    const env = options.env ?? (homeRoot === homedir() ? process.env : {})
    return await ledger.exclusive(() => summarize(ledger, harnesses, sessionsRoot, { homeRoot, env }, conversationsRoot, options.now ?? Date.now()))
  } finally {
    if (!options.ledger) ledger.close()
  }
}

async function summarize(
  ledger: UsageLedger,
  harnesses: readonly UsageHarness[],
  sessionsRoot: string,
  home: UsageHome,
  conversationsRoot: string | undefined,
  now: number
): Promise<UsageSummary> {
  const since = windowStart(now)
  const unread: Unread[] = []
  const recorded = new Map(harnesses.flatMap((harness) => harness.history ? [] : [[harness.provider, harness.label] as const]))
  await Promise.all([
    scanSource(ledger, "Mako", home, since, unread, (scan) => scan.jsonl([sessionsRoot], BUILT_IN)),
    ...harnesses.flatMap(({ label, history }) => history ? [scanSource(ledger, label, home, since, unread, (scan) => history.scan(scan))] : []),
    conversationsRoot && recorded.size
      ? scanSource(ledger, "Mako journals", home, since, unread, (scan) => scanRecorded(scan, conversationsRoot, recorded))
      : undefined,
  ])
  ledger.forgetBefore(since)
  for (const { source, path, reason } of unread.slice(0, 20)) hostWarn("usage", "Usage record unread", { source, path, reason })
  if (unread.length > 20) hostWarn("usage", "More usage records unread", { count: unread.length - 20 })
  const harnessOf = new Map(harnesses.map(({ provider, label }) => [label, provider]))
  return aggregate(ledger.events(since), ledger.sessions(since), unread.length > 0 || ledger.unreadFiles() > 0, harnessOf, now)
}

/** UTC midnight of the summary's first day, so the total covers exactly the days it charts. */
function windowStart(now: number): number {
  const today = new Date(now)
  today.setUTCHours(0, 0, 0, 0)
  return today.getTime() - (DAYS - 1) * 86_400_000
}

async function scanSource(
  ledger: UsageLedger,
  source: string,
  home: UsageHome,
  since: number,
  unread: Unread[],
  read: (scan: UsageScan) => Promise<void>
): Promise<void> {
  const seen = new Set<string>()
  let batch: UsageEvent[] = []
  const unreadable = (path: string, reason: string) => {
    unread.push({ source, path, reason })
  }
  const scan: UsageScan = {
    homeRoot: home.homeRoot,
    env: home.env,
    source,
    since,
    record: (event) => {
      batch.push(event)
    },
    unreadable,
    async jsonl(roots, reader, name) {
      for (const [index, file] of (await discover(roots, since, name)).entries()) {
        seen.add(file.identity)
        try {
          const cursor = ledger.cursor(source, file.identity)
          const resumes = cursor !== undefined && cursor.offset <= file.size
          const state = resumes ? reader.restore(cursor.state) : reader.start(file)
          if (resumes && cursor.offset === file.size) continue
          const events: UsageEvent[] = []
          const read = await readAppended(file.path, resumes ? cursor.offset : 0, reader, (line) => {
            const out = reader.line(line, state, file)
            if (Array.isArray(out)) events.push(...out)
            else if (out) events.push(out)
          })
          const oversized = read.oversized ? `${read.oversized} line(s) over 64 MB` : undefined
          if (oversized) unreadable(file.path, oversized)
          const skipped = oversized ?? (resumes ? cursor.unread : undefined)
          ledger.advance(source, file.identity, { offset: read.end, state, ...skipped && { unread: skipped } }, events)
        } catch (error) {
          unreadable(file.path, error instanceof Error ? error.message : String(error))
        }
        if ((index + 1) % 8 === 0) await yieldToMain()
      }
    },
    async store(id, read) {
      const outer = batch
      batch = []
      try {
        const cursor = await read(ledger.storeCursor(source, id))
        ledger.advanceStore(source, id, cursor, batch)
      } catch (error) {
        unreadable(id, error instanceof Error ? error.message : String(error))
      } finally {
        batch = outer
      }
    },
  }
  try {
    await read(scan)
  } catch (error) {
    unreadable(source, error instanceof Error ? error.message : String(error))
  }
  if (batch.length) ledger.advanceStore(source, "", undefined, batch)
  ledger.keepFiles(source, seen)
}

/** Mako's built-in sessions: a `session` header names the session and its folder, and each message may carry usage. */
const BuiltInContextSchema = z.object({ cwd: z.string(), session: z.string() })
/** A built-in message's `usage`, in Mako's own names: `input` leaves out what the cache supplied. */
const BuiltInUsage = z.object({
  input: tokenCount,
  output: tokenCount,
  cacheRead: tokenCount,
  cacheWrite: tokenCount,
  cost: z.object({ total: z.number().nonnegative() }).nullish().catch(undefined),
})
const BUILT_IN: JsonlReader<z.infer<typeof BuiltInContextSchema>> = {
  needles: ['"usage"', '"type":"session"'],
  start: (file) => ({ cwd: "unknown", session: basename(file.path, ".jsonl") }),
  restore: (state) => BuiltInContextSchema.parse(state),
  line(line, state, file) {
    const root = parseObject(line)
    if (!root) return null
    if (stringValue(root.type) === "session") {
      state.cwd = stringValue(root.cwd) ?? state.cwd
      state.session = stringValue(root.id) ?? state.session
      return null
    }
    const message = objectValue(root.message)
    const usage = BuiltInUsage.safeParse(message?.usage).data
    if (!message || !usage) return null
    const counts = usageCounts(exclusiveTokens(usage))
    const cost = usage.cost?.total
    if (tokenTotal(counts) === 0 && !cost) return null
    const id = stringValue(root.id)
    const timestamp = validTimestamp(root.timestamp, file.mtimeMs)
    const event: UsageEvent = {
      ...counts,
      key: `Mako:${id ?? fingerprint(timestamp, stringValue(message.model), counts)}`,
      source: "Mako",
      session: state.session,
      timestamp,
      model: stringValue(message.model) ?? "unknown",
      cwd: state.cwd,
    }
    if (cost !== undefined) event.reportedCost = cost
    return event
  },
}

/** A journal row: one JSON document in `value`. */
const JournalRowSchema = z.object({ value: z.string() })

const RecordedSpendSchema = z.object({
  id: z.string(),
  spend: z.object({
    provider: z.string(),
    model: z.string().optional(),
    at: z.number(),
    tokens: z.object({ input: z.number(), cacheRead: z.number(), cacheWrite: z.number(), output: z.number() }).optional(),
    cost: z.number().optional(),
    unrecorded: z.enum(["tokens", "cost"]).optional(),
  }),
})

/**
 * What Mako measured while running harnesses whose own stores keep no token
 * counts, read from each conversation's journal; a journal is read again
 * only after it changes.
 */
async function scanRecorded(scan: UsageScan, root: string, recorded: ReadonlyMap<string, string>): Promise<void> {
  let names: string[]
  try {
    names = (await readdir(root)).filter((name) => name.endsWith(".sqlite"))
  } catch {
    return
  }
  for (const [index, name] of names.entries()) {
    const path = join(root, name)
    let modified: number
    try {
      const [main, wal] = await Promise.all([stat(path), stat(`${path}-wal`).catch(() => undefined)])
      modified = Math.max(main.mtimeMs, wal?.mtimeMs ?? 0)
    } catch {
      continue
    }
    if (modified < scan.since) continue
    await scan.store(path, async (cursor) => {
      if (cursor !== undefined && modified <= cursor) return cursor
      readJournal(scan, path, basename(name, ".sqlite"), recorded)
      return modified
    })
    if ((index + 1) % 16 === 0) await yieldToMain()
  }
}

function readJournal(scan: UsageScan, path: string, conversation: string, recorded: ReadonlyMap<string, string>): void {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const rows = db.prepare(`SELECT value FROM requests WHERE value LIKE '%"spend"%'`).all()
    if (!rows.length) return
    const metadata = JournalRowSchema.safeParse(db.prepare("SELECT value FROM metadata WHERE id=1").get()).data
    const cwd = (metadata && stringValue(objectValue(parseObject(metadata.value)?.session)?.cwd)) ?? "unknown"
    for (const row of rows) {
      const value = JournalRowSchema.safeParse(row).data?.value
      if (value === undefined) continue
      const parsed = RecordedSpendSchema.safeParse(parseObject(value))
      const source = parsed.success ? recorded.get(parsed.data.spend.provider) : undefined
      if (!parsed.success || !source || parsed.data.spend.at < scan.since) continue
      const { spend } = parsed.data
      const event: UsageEvent = {
        input: spend.tokens?.input ?? 0,
        output: spend.tokens?.output ?? 0,
        cacheRead: spend.tokens?.cacheRead ?? 0,
        cacheWrite: spend.tokens?.cacheWrite ?? 0,
        key: `${source}:${conversation}:${parsed.data.id}`,
        source,
        session: conversation,
        timestamp: new Date(spend.at).toISOString(),
        model: spend.model ?? "unknown",
        cwd,
        summed: true,
      }
      if (spend.cost !== undefined && spend.cost >= 0) event.reportedCost = spend.cost
      if (spend.unrecorded) event.incomplete = true
      scan.record(event)
    }
  } finally {
    db.close()
  }
}

function aggregate(
  events: Iterable<UsageEvent>,
  sessions: number,
  truncated: boolean,
  /** Each harness's id by the label its events carry as their source. */
  harnessOf: ReadonlyMap<string, string>,
  now: number
): UsageSummary {
  const total = empty("total")
  const days = new Map<string, Bucket>()
  const models = new Map<string, Bucket>()
  const projects = new Map<string, Bucket>()
  const sources = new Map<string, Bucket>()
  const incomplete = new Set<string>()

  for (const event of events) {
    // The same call contributes to five buckets; price and count it once.
    const tokens = tokenTotal(event)
    const estimate = event.reportedCost === undefined ? estimateUsageCost(event.model, event) : null
    add(total, event, tokens, estimate)
    addTo(days, dayOf(event.timestamp), event, tokens, estimate)
    addTo(models, event.model, event, tokens, estimate)
    addTo(projects, event.cwd, event, tokens, estimate)
    addTo(sources, event.source, event, tokens, estimate)
    if (event.incomplete) incomplete.add(event.source)
  }

  const summary: UsageSummary = {
    total: totalsOf(total),
    days: recentDays(days, now),
    models: rank(models).map((bucket) => ({
      model: bucket.key,
      ...totalsOf(bucket),
    })),
    projects: rank(projects).map((bucket) => ({
      cwd: bucket.key,
      ...totalsOf(bucket),
    })),
    sources: rank(sources).map((bucket) => {
      const source: NonNullable<UsageSummary["sources"]>[number] = { source: bucket.key, ...totalsOf(bucket) }
      const harness = harnessOf.get(bucket.key)
      if (harness) source.harness = harness
      return source
    }),
    sessions,
    truncated,
  }
  if (incomplete.size) summary.incomplete = [...incomplete].sort()
  return summary
}

function empty(key: string): Bucket {
  return {
    key,
    cost: 0,
    reportedCost: 0,
    estimatedCost: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    messages: 0,
    pricedTokens: 0,
    unpricedTokens: 0,
  }
}

function add(bucket: Bucket, event: UsageEvent, tokens: number, estimate: number | null): void {
  if (event.reportedCost !== undefined) {
    bucket.reportedCost += event.reportedCost
    bucket.cost += event.reportedCost
    bucket.pricedTokens += tokens
  } else if (estimate !== null) {
    bucket.estimatedCost += estimate
    bucket.cost += estimate
    bucket.pricedTokens += tokens
  } else {
    bucket.unpricedTokens += tokens
  }
  bucket.input += event.input
  bucket.output += event.output
  bucket.cacheRead += event.cacheRead
  bucket.cacheWrite += event.cacheWrite
  bucket.messages += 1
}

function addTo(buckets: Map<string, Bucket>, key: string, event: UsageEvent, tokens: number, estimate: number | null): void {
  const bucket = buckets.get(key) ?? empty(key)
  add(bucket, event, tokens, estimate)
  buckets.set(key, bucket)
}

function totalsOf(bucket: Bucket): UsageTotals {
  return {
    cost: bucket.cost,
    reportedCost: bucket.reportedCost,
    estimatedCost: bucket.estimatedCost,
    input: bucket.input,
    output: bucket.output,
    cacheRead: bucket.cacheRead,
    cacheWrite: bucket.cacheWrite,
    messages: bucket.messages,
    pricedTokens: bucket.pricedTokens,
    unpricedTokens: bucket.unpricedTokens,
  }
}

function recentDays(days: Map<string, Bucket>, now: number): UsageSummary["days"] {
  const result: UsageSummary["days"] = []
  const today = new Date(now)
  today.setUTCHours(0, 0, 0, 0)
  for (let offset = DAYS - 1; offset >= 0; offset -= 1) {
    const date = new Date(today)
    date.setUTCDate(date.getUTCDate() - offset)
    const key = date.toISOString().slice(0, 10)
    result.push({ date: key, ...totalsOf(days.get(key) ?? empty(key)) })
  }
  return result
}

function rank(buckets: Map<string, Bucket>): Bucket[] {
  return [...buckets.values()]
    .sort(
      (left, right) =>
        right.cost - left.cost ||
        right.pricedTokens + right.unpricedTokens -
          (left.pricedTokens + left.unpricedTokens)
    )
    .slice(0, 12)
}

function dayOf(timestamp: string): string {
  return timestamp.slice(0, 10)
}
