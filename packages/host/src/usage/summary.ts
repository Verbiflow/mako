import { readdir, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { exclusiveTokens, tokenCount } from "@mako/sessions/harnesses"
import { z } from "zod"
import { objectValue, stringValue } from "../base/json-values.js"
import { hostWarn } from "../base/host-log.js"
import { USAGE_WINDOWS, type UsageAmount, type UsagePeriod, type UsageSummary, type UsageTotals, type UsageWindow, type UsageWindowId } from "../contracts/automations-usage-updates.js"
import { HELPER_RUNS } from "./helper-runs.js"
import { UsageLedger } from "./ledger.js"
import { priceEstimate } from "./pricing.js"
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
  type ProviderUsageHistory,
  type UsageEvent,
  type UsageScan,
} from "./scan.js"

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

export interface UsageSummaryOptions {
  /** Kept between summaries so each reads only what changed; a summary without one reads everything once. */
  ledger?: UsageLedger
  now?: number
  /** The environment harnesses run with; the process's own for the default home, none for another (a fixture's). */
  env?: NodeJS.ProcessEnv
  /** Where the host keeps the model calls Mako made on its own behalf (`HelperRuns`). */
  helperRuns?: string
}

/** Where the harnesses' stores are: the home, the variables that move a store from it, and Mako's user root. */
interface UsageHome {
  homeRoot: string
  env: NodeJS.ProcessEnv
  userRoot: string
}

/** A record some reader could not read. */
interface Unread {
  source: string
  path: string
  reason: string
}

/**
 * `userRoot` is the host's (`HostEnvironment.userRoot`): it holds the
 * built-in runtime's old sessions and the stores Mako places for a harness
 * (Cursor's SDK agents); `homeRoot` holds each harness's own.
 */
export async function usageSummary(
  harnesses: readonly UsageHarness[],
  userRoot: string,
  homeRoot = homedir(),
  conversationsRoot?: string,
  options: UsageSummaryOptions = {}
): Promise<UsageSummary> {
  const ledger = options.ledger ?? new UsageLedger()
  try {
    const env = options.env ?? (homeRoot === homedir() ? process.env : {})
    return await ledger.exclusive(() => summarize(ledger, harnesses, { homeRoot, env, userRoot }, conversationsRoot, options.helperRuns, options.now ?? Date.now()))
  } finally {
    if (!options.ledger) ledger.close()
  }
}

async function summarize(
  ledger: UsageLedger,
  harnesses: readonly UsageHarness[],
  home: UsageHome,
  conversationsRoot: string | undefined,
  helperRuns: string | undefined,
  now: number
): Promise<UsageSummary> {
  const spans = windowSpans(now)
  const since = spans.at(-1)?.since ?? now
  const unread: Unread[] = []
  const recorded = new Map(harnesses.flatMap((harness) => harness.history ? [] : [[harness.provider, harness.label] as const]))
  await Promise.all([
    scanSource(ledger, "Mako", home, since, unread, (scan) => scan.jsonl([join(home.userRoot, "sessions")], BUILT_IN)),
    ...harnesses.flatMap(({ label, history }) => history ? [scanSource(ledger, label, home, since, unread, (scan) => history.scan(scan))] : []),
    conversationsRoot && recorded.size
      ? scanSource(ledger, "Mako journals", home, since, unread, (scan) => scanRecorded(scan, conversationsRoot, recorded))
      : undefined,
    helperRuns ? scanSource(ledger, "Mako helpers", home, since, unread, (scan) => scan.jsonl([helperRuns], HELPER_RUNS)) : undefined,
  ])
  ledger.forgetBefore(since)
  for (const { source, path, reason } of unread.slice(0, 20)) hostWarn("usage", "Usage record unread", { source, path, reason })
  if (unread.length > 20) hostWarn("usage", "More usage records unread", { count: unread.length - 20 })
  const harnessOf = new Map(harnesses.map(({ provider, label }) => [label, provider]))
  return {
    windows: aggregate(spans, ledger.events(since), ledger.sessions(since), harnessOf),
    truncated: unread.length > 0 || ledger.unreadFiles() > 0,
  }
}

/** Where one window starts and ends, and the start of each of its periods, oldest first. */
interface WindowSpan {
  id: UsageWindowId
  since: number
  until: number
  resolution: UsageWindow["resolution"]
  starts: number[]
}

const HOUR = 3_600_000
const WINDOW_DAYS = { week: 7, month: DAYS } as const

/**
 * Each window over this machine's clock, shortest first: the last 24 hours
 * from the top of each hour, and the last 7 and 30 days from local midnight,
 * so a day in the chart is the day the person lived. The longest window's
 * start is what the ledger keeps.
 */
export function windowSpans(now: number): WindowSpan[] {
  return USAGE_WINDOWS.map((id) => {
    if (id === "day") {
      const hour = new Date(now)
      hour.setMinutes(0, 0, 0)
      const starts = Array.from({ length: 24 }, (_, index) => hour.getTime() - (23 - index) * HOUR)
      return { id, since: starts[0] ?? now, until: now, resolution: "hour", starts }
    }
    const starts = Array.from({ length: WINDOW_DAYS[id] }, (_, index) => {
      const day = new Date(now)
      day.setHours(0, 0, 0, 0)
      day.setDate(day.getDate() - (WINDOW_DAYS[id] - 1 - index))
      return day.getTime()
    })
    return { id, since: starts[0] ?? now, until: now, resolution: "day", starts }
  })
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
    userRoot: home.userRoot,
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
    estimate: z.object({ amount: z.number().nonnegative(), currency: z.literal("USD"), table: z.string() }).optional(),
    unrecorded: z.enum(["tokens", "cost"]).optional(),
  }),
})

/**
 * What Mako measured while running harnesses whose own stores keep no token
 * counts, read from each conversation's journal (its requests' turns and
 * the harness's own); a journal is read again only after it changes.
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
    // Mako's requests, and the turns the harness ran without one; a journal from before those were kept has no such table.
    const turns = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='harness_turns'").get()
      ? db.prepare("SELECT value FROM harness_turns").all()
      : []
    const rows = [...db.prepare(`SELECT value FROM requests WHERE value LIKE '%"spend"%'`).all(), ...turns]
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
      else if (spend.estimate) event.estimate = spend.estimate
      if (spend.unrecorded) event.incomplete = true
      scan.record(event)
    }
  } finally {
    db.close()
  }
}

/** One window's buckets while the events pass. */
interface WindowBuckets {
  span: WindowSpan
  total: Bucket
  periods: { total: UsageAmount; sources: Map<string, UsageAmount> }[]
  models: Map<string, Bucket & { model: string; source: string }>
  projects: Map<string, Bucket>
  sources: Map<string, Bucket>
  sessions: Map<string, number>
  incomplete: Set<string>
  tables: Set<string>
}

/** Every window from one pass over the ledger's events: each event is priced once and added to each window it falls in. */
function aggregate(
  spans: readonly WindowSpan[],
  events: Iterable<UsageEvent>,
  sessions: Iterable<{ source: string; at: number }>,
  /** Each harness's id by the label its events carry as their source. */
  harnessOf: ReadonlyMap<string, string>
): UsageWindow[] {
  const windows: WindowBuckets[] = spans.map((span) => ({
    span,
    total: empty("total"),
    periods: span.starts.map(() => ({ total: amount(), sources: new Map() })),
    models: new Map(),
    projects: new Map(),
    sources: new Map(),
    sessions: new Map(),
    incomplete: new Set(),
    tables: new Set(),
  }))
  for (const event of events) {
    // An estimate made when the call was recorded keeps its table; otherwise today's.
    const at = Date.parse(event.timestamp)
    const tokens = tokenTotal(event)
    const priced = event.reportedCost === undefined ? event.estimate ?? priceEstimate(event.model, event) : null
    const estimate = priced?.amount ?? null
    const modelKey = `${event.source}\u0000${event.model}`
    for (const window of windows) {
      if (at < window.span.since) continue
      add(window.total, event, tokens, estimate)
      const model = window.models.get(modelKey) ?? { ...empty(modelKey), model: event.model, source: event.source }
      add(model, event, tokens, estimate)
      window.models.set(modelKey, model)
      addTo(window.projects, event.cwd, event, tokens, estimate)
      addTo(window.sources, event.source, event, tokens, estimate)
      const period = window.periods[periodOf(window.span.starts, at)]
      if (period) {
        addAmount(period.total, event, tokens, estimate)
        const part = period.sources.get(event.source) ?? amount()
        addAmount(part, event, tokens, estimate)
        period.sources.set(event.source, part)
      }
      if (event.incomplete) window.incomplete.add(event.source)
      if (priced) window.tables.add(priced.table)
    }
  }
  for (const session of sessions)
    for (const window of windows)
      if (session.at >= window.span.since) window.sessions.set(session.source, (window.sessions.get(session.source) ?? 0) + 1)

  return windows.map((window) => {
    const { span } = window
    const projects = rank(window.projects)
    const shown = projects.slice(0, PROJECTS_SHOWN)
    const rest = projects.slice(PROJECTS_SHOWN)
    const result: UsageWindow = {
      id: span.id,
      since: span.since,
      until: span.until,
      resolution: span.resolution,
      total: totalsOf(window.total),
      sessions: [...window.sessions.values()].reduce((sum, count) => sum + count, 0),
      periods: span.starts.map((start, index): UsagePeriod => {
        const period = window.periods[index]
        return { start, total: period?.total ?? amount(), sources: Object.fromEntries(period?.sources ?? []) }
      }),
      sources: rank(window.sources).map((bucket) => {
        const source: UsageWindow["sources"][number] = { source: bucket.key, sessions: window.sessions.get(bucket.key) ?? 0, ...totalsOf(bucket) }
        const harness = harnessOf.get(bucket.key)
        if (harness) source.harness = harness
        return source
      }),
      models: rank(window.models).map((bucket) => ({ model: bucket.model, source: bucket.source, ...totalsOf(bucket) })),
      projects: shown.map((bucket) => ({ cwd: bucket.key, ...totalsOf(bucket) })),
    }
    if (rest.length) {
      const other = empty("other")
      for (const bucket of rest) merge(other, bucket)
      result.otherProjects = { count: rest.length, ...totalsOf(other) }
    }
    if (window.incomplete.size) result.incomplete = [...window.incomplete].sort()
    if (window.total.estimatedCost > 0 && window.tables.size) result.priceTables = [...window.tables].sort()
    return result
  })
}

/** The projects a window lists by name; the rest are summed as one. */
const PROJECTS_SHOWN = 12

/** The period a moment falls in: the last start at or before it. */
function periodOf(starts: readonly number[], at: number): number {
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const middle = (low + high + 1) >> 1
    if ((starts[middle] ?? Infinity) <= at) low = middle
    else high = middle - 1
  }
  return low
}

function amount(): UsageAmount {
  return { cost: 0, estimatedCost: 0, tokens: 0 }
}

function addAmount(target: UsageAmount, event: UsageEvent, tokens: number, estimate: number | null): void {
  if (event.reportedCost !== undefined) target.cost += event.reportedCost
  else if (estimate !== null) {
    target.cost += estimate
    target.estimatedCost += estimate
  }
  target.tokens += tokens
}

function merge(target: Bucket, bucket: Bucket): void {
  target.cost += bucket.cost
  target.reportedCost += bucket.reportedCost
  target.estimatedCost += bucket.estimatedCost
  target.input += bucket.input
  target.output += bucket.output
  target.cacheRead += bucket.cacheRead
  target.cacheWrite += bucket.cacheWrite
  target.messages += bucket.messages
  target.pricedTokens += bucket.pricedTokens
  target.unpricedTokens += bucket.unpricedTokens
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

function rank<T extends Bucket>(buckets: Map<string, T>): T[] {
  return [...buckets.values()].sort(
    (left, right) =>
      right.cost - left.cost ||
      right.pricedTokens + right.unpricedTokens -
        (left.pricedTokens + left.unpricedTokens)
  )
}
