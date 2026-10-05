import { readdir } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { z } from "zod"
import { numberValue, objectValue, stringValue } from "./codex-app-json.js"
import { harnessLabel } from "./providers/harness-descriptors.js"
import type { ProviderHost } from "./providers/host.js"
import type { ProviderUsageHistory } from "./providers/usage-history.js"
import type { UsageSummary, UsageTotals } from "./shared.js"
import { estimateUsageCost } from "./usage-pricing.js"
import {
  DAYS,
  discover,
  fingerprint,
  firstLine,
  MAX_BYTES_PER_FILE,
  MAX_FILES_PER_SOURCE,
  parseObject,
  readLines,
  tokenCounts,
  tokenTotal,
  validTimestamp,
  yieldToMain,
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

interface BuiltInMetadata {
  cwd?: string
  session?: string
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

/** One source's events and sessions, kept apart so sources scan concurrently. */
interface Collected {
  events: Map<string, UsageEvent>
  sessions: Set<string>
  truncated: boolean
}

export async function usageSummary(
  harnesses: readonly UsageHarness[],
  sessionsRoot: string,
  homeRoot = homedir(),
  conversationsRoot?: string
): Promise<UsageSummary> {
  const recorded = new Map(harnesses.flatMap((harness) => harness.history ? [] : [[harness.provider, harness.label] as const]))
  const parts = await Promise.all([
    collect("Mako", homeRoot, (scan) => scanBuiltIn(sessionsRoot, scan)),
    ...harnesses.flatMap(({ label, history }) => history ? [collect(label, homeRoot, (scan) => history.scan(scan))] : []),
    conversationsRoot ? scanRecorded(conversationsRoot, recorded) : undefined,
  ])
  // Merged in a fixed order: ranking breaks ties by insertion.
  const events = new Map<string, UsageEvent>()
  const sessions = new Set<string>()
  let truncated = false
  for (const part of parts) {
    if (!part) continue
    for (const event of part.events.values()) mergeEvent(events, event)
    for (const session of part.sessions) sessions.add(session)
    truncated ||= part.truncated
  }
  return aggregate(events.values(), sessions.size, truncated, new Set(recorded.values()))
}

async function collect(
  source: string,
  homeRoot: string,
  read: (scan: UsageScan) => Promise<{ truncated: boolean }>
): Promise<Collected> {
  const events = new Map<string, UsageEvent>()
  const sessions = new Set<string>()
  const { truncated } = await read({
    homeRoot,
    source,
    record: (event) => mergeEvent(events, event),
    session: (id) => {
      sessions.add(`${source}:${id}`)
    },
  })
  return { events, sessions, truncated }
}

async function scanBuiltIn(sessionsRoot: string, scan: UsageScan): Promise<{ truncated: boolean }> {
  const { files, truncated } = await discover([sessionsRoot])
  for (const [index, file] of files.entries()) {
    let cwd = "unknown"
    let session = basename(file.path, ".jsonl")
    const partial = file.size > MAX_BYTES_PER_FILE
    if (partial) {
      const header = await firstLine(file.path)
      if (header) {
        const metadata = parseBuiltInMetadata(header)
        cwd = metadata.cwd ?? cwd
        session = metadata.session ?? session
      }
    }
    const read = await readLines(file, (line) => {
      const metadata = parseBuiltInMetadata(line)
      cwd = metadata.cwd ?? cwd
      session = metadata.session ?? session
      if (!line.includes('"usage"')) return
      const event = parseBuiltInEvent(scan.source, line, cwd, session, file.mtimeMs)
      if (event) scan.record(event)
    })
    if (read) scan.session(session)
    if ((index + 1) % 8 === 0) await yieldToMain()
  }
  return { truncated }
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
  }),
})

/**
 * What Mako measured while running harnesses whose own stores keep no
 * token counts, read from each conversation's journal.
 */
async function scanRecorded(
  root: string,
  recorded: ReadonlyMap<string, string>
): Promise<Collected> {
  const events = new Map<string, UsageEvent>()
  const sessions = new Set<string>()
  let names: string[]
  try {
    names = (await readdir(root)).filter((name) => name.endsWith(".sqlite"))
  } catch {
    return { events, sessions, truncated: false }
  }
  const truncated = names.length > MAX_FILES_PER_SOURCE
  for (const [index, name] of names.slice(0, MAX_FILES_PER_SOURCE).entries()) {
    let db: DatabaseSync | undefined
    try {
      db = new DatabaseSync(join(root, name), { readOnly: true })
      const rows = db.prepare(`SELECT value FROM requests WHERE value LIKE '%"spend"%'`).all()
      if (!rows.length) continue
      const metadata = JournalRowSchema.safeParse(db.prepare("SELECT value FROM metadata WHERE id=1").get()).data
      const cwd = (metadata && stringValue(objectValue(parseObject(metadata.value)?.session)?.cwd)) ?? "unknown"
      const conversation = basename(name, ".sqlite")
      for (const row of rows) {
        const value = JournalRowSchema.safeParse(row).data?.value
        if (value === undefined) continue
        const parsed = RecordedSpendSchema.safeParse(parseObject(value))
        const source = parsed.success ? recorded.get(parsed.data.spend.provider) : undefined
        if (!parsed.success || !source) continue
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
        }
        if (spend.cost !== undefined && spend.cost >= 0) event.reportedCost = spend.cost
        sessions.add(`${source}:${conversation}`)
        mergeEvent(events, event)
      }
    } catch {
      continue
    } finally {
      db?.close()
    }
    if ((index + 1) % 16 === 0) await yieldToMain()
  }
  return { events, sessions, truncated }
}

function parseBuiltInMetadata(line: string): BuiltInMetadata {
  const root = parseObject(line)
  if (!root) return {}
  const type = stringValue(root.type)
  if (type !== "session") return {}
  return {
    cwd: stringValue(root.cwd),
    session: stringValue(root.id),
  }
}

function parseBuiltInEvent(
  source: string,
  line: string,
  cwd: string,
  session: string,
  fallbackTime: number
): UsageEvent | null {
  const root = parseObject(line)
  const message = objectValue(root?.message)
  const usage = objectValue(message?.usage)
  if (!root || !message || !usage) return null
  const counts = tokenCounts(usage, "input", "output", "cacheRead", "cacheWrite")
  const cost = numberValue(objectValue(usage.cost)?.total)
  if (tokenTotal(counts) === 0 && (!cost || cost <= 0)) return null
  const id = stringValue(root.id)
  const timestamp = validTimestamp(root.timestamp, fallbackTime)
  const event: UsageEvent = {
    ...counts,
    key: `${source}:${id ?? fingerprint(timestamp, stringValue(message.model), counts)}`,
    source,
    session,
    timestamp,
    model: stringValue(message.model) ?? "unknown",
    cwd,
  }
  if (cost !== undefined) event.reportedCost = cost
  return event
}

function mergeEvent(events: Map<string, UsageEvent>, event: UsageEvent): void {
  const existing = events.get(event.key)
  if (!existing) {
    events.set(event.key, event)
    return
  }
  existing.input = Math.max(existing.input, event.input)
  existing.output = Math.max(existing.output, event.output)
  existing.cacheRead = Math.max(existing.cacheRead, event.cacheRead)
  existing.cacheWrite = Math.max(existing.cacheWrite, event.cacheWrite)
  if (event.reportedCost !== undefined)
    existing.reportedCost = Math.max(existing.reportedCost ?? 0, event.reportedCost)
}

function aggregate(
  events: Iterable<UsageEvent>,
  sessions: number,
  truncated: boolean,
  recordedByMako: ReadonlySet<string>
): UsageSummary {
  const total = empty("total")
  const days = new Map<string, Bucket>()
  const models = new Map<string, Bucket>()
  const projects = new Map<string, Bucket>()
  const sources = new Map<string, Bucket>()

  for (const event of events) {
    add(total, event)
    addTo(days, dayOf(event.timestamp), event)
    addTo(models, event.model, event)
    addTo(projects, event.cwd, event)
    addTo(sources, event.source, event)
  }

  return {
    total: totalsOf(total),
    days: recentDays(days),
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
      if (recordedByMako.has(bucket.key)) source.recordedByMako = true
      return source
    }),
    sessions,
    truncated,
  }
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

function add(bucket: Bucket, event: UsageEvent): void {
  const tokens = tokenTotal(event)
  const estimate =
    event.reportedCost === undefined ? estimateUsageCost(event.model, event) : null
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

function addTo(buckets: Map<string, Bucket>, key: string, event: UsageEvent): void {
  const bucket = buckets.get(key) ?? empty(key)
  add(bucket, event)
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

function recentDays(days: Map<string, Bucket>): UsageSummary["days"] {
  const result: UsageSummary["days"] = []
  const today = new Date()
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
