import { createReadStream } from "node:fs"
import { readdir, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"
import { createInterface } from "node:readline"
import { DatabaseSync } from "node:sqlite"
import { z } from "zod"
import type { JsonObject, JsonValue } from "./codex-app-json.js"
import type { UsageSummary, UsageTotals } from "./shared.js"
import {
  estimateUsageCost,
  type UsageTokenCounts,
} from "./usage-pricing.js"

const DAYS = 30
const MAX_FILES_PER_SOURCE = 1_000
const MAX_BYTES_PER_FILE = 32 * 1024 * 1024
const MAX_BYTES_PER_SOURCE = 128 * 1024 * 1024
const MAX_DISCOVERY_ENTRIES = 25_000
const MAX_OPENCODE_ROWS = 100_000

interface FileCandidate {
  path: string
  mtimeMs: number
  size: number
}

interface DiscoveryState {
  entries: number
  truncated: boolean
  files: FileCandidate[]
  aliases: Set<string>
}

interface UsageEvent extends UsageTokenCounts {
  key: string
  source: string
  session: string
  timestamp: string
  model: string
  cwd: string
  reportedCost?: number
}

interface Bucket extends UsageTotals {
  key: string
  reportedCost: number
  estimatedCost: number
  pricedTokens: number
  unpricedTokens: number
}

interface RawCodexUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

interface CodexContext {
  session: string
  cwd: string
  model: string
  previous: RawCodexUsage | null
  partial: boolean
}

interface ScanResult {
  files: FileCandidate[]
  truncated: boolean
}

interface BuiltInMetadata {
  cwd?: string
  session?: string
}

const OpenCodeRowSchema = z.object({
  id: z.string(),
  session_id: z.string(),
  time_created: z.number(),
  time_updated: z.number().nullable(),
  data: z.string(),
  directory: z.string().nullable(),
  worktree: z.string().nullable(),
  session_model: z.string().nullable(),
})
type OpenCodeRow = z.infer<typeof OpenCodeRowSchema>

export async function usageSummary(
  sessionsRoot: string,
  homeRoot = homedir(),
  conversationsRoot?: string
): Promise<UsageSummary> {
  const [builtIn, claude, codex, grok] = await Promise.all([
    discover([sessionsRoot]),
    discover([
      join(homeRoot, ".claude", "projects"),
      join(homeRoot, ".claude", "transcripts"),
    ]),
    discover([join(homeRoot, ".codex", "sessions")]),
    discover([join(homeRoot, ".grok", "sessions")], GROK_UPDATES),
  ])
  const events = new Map<string, UsageEvent>()
  const sessions = new Set<string>()

  await scanBuiltIn(builtIn.files, events, sessions)
  await scanClaude(claude.files, events, sessions)
  await scanCodex(codex.files, events, sessions)
  await scanGrok(grok.files, events, sessions)
  const openCodeTruncated = await scanOpenCode(homeRoot, events, sessions)
  const recordedTruncated = conversationsRoot ? await scanRecorded(conversationsRoot, events, sessions) : false

  return aggregate(
    events.values(),
    sessions.size,
    builtIn.truncated || claude.truncated || codex.truncated || grok.truncated || openCodeTruncated || recordedTruncated
  )
}

async function discover(roots: string[], name?: string): Promise<ScanResult> {
  const state: DiscoveryState = {
    entries: 0,
    truncated: false,
    files: [],
    aliases: new Set(),
  }
  for (const root of roots) await walkJsonl(root, state)
  if (name) state.files = state.files.filter((file) => basename(file.path) === name)
  state.files.sort(
    (left, right) => right.mtimeMs - left.mtimeMs || right.path.localeCompare(left.path)
  )

  const files: FileCandidate[] = []
  let bytes = 0
  for (const file of state.files) {
    const readBytes = Math.min(file.size, MAX_BYTES_PER_FILE)
    if (
      files.length >= MAX_FILES_PER_SOURCE ||
      (files.length > 0 && bytes + readBytes > MAX_BYTES_PER_SOURCE)
    ) {
      state.truncated = true
      break
    }
    files.push(file)
    bytes += readBytes
    if (file.size > MAX_BYTES_PER_FILE) state.truncated = true
  }
  if (files.length < state.files.length) state.truncated = true
  return { files, truncated: state.truncated }
}

async function walkJsonl(root: string, state: DiscoveryState): Promise<void> {
  if (state.entries >= MAX_DISCOVERY_ENTRIES) {
    state.truncated = true
    return
  }
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return
  }
  entries.sort((left, right) => right.name.localeCompare(left.name))
  for (const entry of entries) {
    if (state.entries >= MAX_DISCOVERY_ENTRIES) {
      state.truncated = true
      return
    }
    state.entries += 1
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      await walkJsonl(path, state)
      continue
    }
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue
    try {
      const info = await stat(path)
      const alias = info.ino === 0 ? `path:${path}` : `${info.dev}:${info.ino}`
      if (state.aliases.has(alias)) continue
      state.aliases.add(alias)
      state.files.push({ path, mtimeMs: info.mtimeMs, size: info.size })
    } catch {
      // One unreadable transcript must not hide the rest of local history.
    }
  }
}

async function scanBuiltIn(
  files: FileCandidate[],
  events: Map<string, UsageEvent>,
  sessions: Set<string>
): Promise<void> {
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
      const event = parseBuiltInEvent(line, cwd, session, file.mtimeMs)
      if (event) mergeEvent(events, event)
    })
    if (read) sessions.add(`Mako:${session}`)
    if ((index + 1) % 8 === 0) await yieldToMain()
  }
}

async function scanClaude(
  files: FileCandidate[],
  events: Map<string, UsageEvent>,
  sessions: Set<string>
): Promise<void> {
  for (const [index, file] of files.entries()) {
    const fallbackSession = basename(file.path, ".jsonl")
    await readLines(file, (line) => {
      if (!line.includes('"usage"') || !line.includes('"assistant"')) return
      const event = parseClaudeEvent(line, fallbackSession, file.mtimeMs)
      if (!event) return
      sessions.add(`Claude Code:${event.session}`)
      mergeEvent(events, event)
    })
    if ((index + 1) % 8 === 0) await yieldToMain()
  }
}

async function scanCodex(
  files: FileCandidate[],
  events: Map<string, UsageEvent>,
  sessions: Set<string>
): Promise<void> {
  for (const [index, file] of files.entries()) {
    const context: CodexContext = {
      session: basename(file.path, ".jsonl"),
      cwd: "unknown",
      model: "unknown",
      previous: null,
      partial: file.size > MAX_BYTES_PER_FILE,
    }
    const read = await readLines(file, (line) => {
      if (
        !line.includes('"session_meta"') &&
        !line.includes('"turn_context"') &&
        !line.includes('"token_count"')
      )
        return
      const event = parseCodexRecord(line, context, file.mtimeMs)
      if (event) mergeEvent(events, event)
    })
    if (read) sessions.add(`Codex:${context.session}`)
    if ((index + 1) % 8 === 0) await yieldToMain()
  }
}

/** Grok writes each session's live transcript here; its siblings repeat it or hold no usage. */
const GROK_UPDATES = "updates.jsonl"
/** Grok's own unit: `costUsdTicks` are ten-billionths of a dollar. */
const GROK_TICKS_PER_USD = 1e10

async function scanGrok(
  files: FileCandidate[],
  events: Map<string, UsageEvent>,
  sessions: Set<string>
): Promise<void> {
  for (const [index, file] of files.entries()) {
    // sessions/<url-encoded cwd>/<session id>/updates.jsonl
    const cwd = decodedDirectory(basename(dirname(dirname(file.path))))
    const read = await readLines(file, (line) => {
      if (!line.includes('"turn_completed"')) return
      for (const event of parseGrokTurn(line, cwd, file.mtimeMs)) mergeEvent(events, event)
    })
    if (read) sessions.add(`Grok:${basename(dirname(file.path))}`)
    if ((index + 1) % 8 === 0) await yieldToMain()
  }
}

function decodedDirectory(name: string): string {
  try {
    const decoded = decodeURIComponent(name)
    return decoded.startsWith("/") ? decoded : "unknown"
  } catch {
    return "unknown"
  }
}

/** One event per model a turn used; Grok counts cached input inside `inputTokens`. */
function parseGrokTurn(line: string, cwd: string, fallbackTime: number): UsageEvent[] {
  const root = parseObject(line)
  const params = objectValue(root?.params)
  const update = objectValue(params?.update)
  const usage = objectValue(update?.usage)
  if (!root || !params || !update || !usage || stringValue(update.sessionUpdate) !== "turn_completed") return []
  const session = stringValue(params.sessionId) ?? "unknown"
  const turn = stringValue(update.prompt_id) ?? fingerprint(String(root.timestamp), session, grokCounts(usage))
  const seconds = numberValue(root.timestamp)
  const timestamp = seconds !== undefined && seconds > 0
    ? new Date(seconds < 10_000_000_000 ? seconds * 1000 : seconds).toISOString()
    : new Date(fallbackTime).toISOString()
  const perModel = Object.entries(objectValue(usage.modelUsage) ?? {})
    .flatMap(([model, value]) => {
      const counts = objectValue(value)
      return counts ? [[model, counts] as const] : []
    })
  return (perModel.length ? perModel : [["unknown", usage] as const]).flatMap(([model, counts]) => {
    const tokens = grokCounts(counts)
    const ticks = numberValue(counts.costUsdTicks)
    if (tokenTotal(tokens) === 0 && !ticks) return []
    const event: UsageEvent = {
      ...tokens,
      key: `Grok:${session}:${turn}:${model}`,
      source: "Grok",
      session,
      timestamp,
      model,
      cwd,
    }
    if (ticks !== undefined && ticks >= 0) event.reportedCost = ticks / GROK_TICKS_PER_USD
    return [event]
  })
}

function grokCounts(usage: JsonObject): UsageTokenCounts {
  const cacheRead = tokenValue(usage.cachedReadTokens)
  const cacheWrite = tokenValue(usage.cacheCreationTokens)
  return {
    input: Math.max(0, tokenValue(usage.inputTokens) - cacheRead - cacheWrite),
    output: tokenValue(usage.outputTokens),
    cacheRead,
    cacheWrite,
  }
}

/**
 * Harnesses whose own stores keep no token counts: Cursor's SDK store and
 * Devin's CLI database. What Mako measured while running them is the record.
 */
const RECORDED_BY_MAKO = new Map([["cursor", "Cursor"], ["devin", "Devin"]])

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

async function scanRecorded(
  root: string,
  events: Map<string, UsageEvent>,
  sessions: Set<string>
): Promise<boolean> {
  let names: string[]
  try {
    names = (await readdir(root)).filter((name) => name.endsWith(".sqlite"))
  } catch {
    return false
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
        const source = parsed.success ? RECORDED_BY_MAKO.get(parsed.data.spend.provider) : undefined
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
  return truncated
}

async function scanOpenCode(
  homeRoot: string,
  events: Map<string, UsageEvent>,
  sessions: Set<string>
): Promise<boolean> {
  const root = join(homeRoot, ".local", "share", "opencode")
  let truncated = false
  for (const name of ["opencode-next.db", "opencode.db"]) {
    let db: DatabaseSync | undefined
    try {
      db = new DatabaseSync(join(root, name), { readOnly: true })
      db.exec("PRAGMA query_only = ON")
      const rows = selectOpenCodeRows(db, name)
      if (rows.length >= MAX_OPENCODE_ROWS) truncated = true
      for (const row of rows) {
        const event = parseOpenCodeEvent(row)
        if (!event) continue
        sessions.add(`OpenCode:${event.session}`)
        mergeEvent(events, event)
      }
    } catch {
      continue
    } finally {
      db?.close()
    }
    await yieldToMain()
  }
  return truncated
}

function selectOpenCodeRows(
  db: DatabaseSync,
  databaseName: string
): OpenCodeRow[] {
  if (!databaseName.endsWith("opencode-next.db")) {
    return [
      ...openCodeTableRows(db, "message"),
      ...openCodeTableRows(db, "session_message", "session_v2", true),
    ]
  }
  return openCodeTableRows(db, "session_message")
}

function openCodeTableRows(
  db: DatabaseSync,
  table: "message" | "session_message",
  sessionTable = "session",
  excludeShadowed = false
): OpenCodeRow[] {
  if (!tableExists(db, sessionTable) || !tableExists(db, table)) return []
  const alias = table === "message" ? "m" : "sm"
  const hasProject =
    tableExists(db, "project") &&
    columnExists(db, sessionTable, "project_id") &&
    columnExists(db, "project", "worktree")
  const projectJoin = hasProject
    ? "LEFT JOIN project p ON p.id = s.project_id"
    : ""
  const worktree = hasProject ? "p.worktree" : "NULL"
  const directory = columnExists(db, sessionTable, "directory")
    ? "s.directory"
    : "NULL"
  const sessionModel = columnExists(db, sessionTable, "model")
    ? "s.model"
    : "NULL"
  const updated = columnExists(db, table, "time_updated")
    ? `${alias}.time_updated`
    : "NULL"
  const assistant =
    table === "session_message" && columnExists(db, table, "type")
      ? `${alias}.type = 'assistant'`
      : `json_valid(${alias}.data) AND json_extract(${alias}.data, '$.role') = 'assistant'`
  const shadow =
    excludeShadowed && tableExists(db, "session")
      ? ` AND NOT EXISTS (SELECT 1 FROM session legacy WHERE legacy.id = ${alias}.session_id)`
      : ""
  return db
    .prepare(
      `SELECT ${alias}.id, ${alias}.session_id, ${alias}.time_created,
              ${updated} AS time_updated, ${alias}.data,
              ${directory} AS directory, ${worktree} AS worktree,
              ${sessionModel} AS session_model
       FROM ${table} ${alias}
       JOIN ${sessionTable} s ON s.id = ${alias}.session_id
       ${projectJoin}
       WHERE ${assistant}${shadow}
       ORDER BY ${alias}.time_created DESC, ${alias}.id DESC
       LIMIT ?`
    )
    .all(MAX_OPENCODE_ROWS)
    .flatMap((row) => {
      const parsed = OpenCodeRowSchema.safeParse(row)
      return parsed.success ? [parsed.data] : []
    })
}

function tableExists(db: DatabaseSync, table: string): boolean {
  return Boolean(
    db
      .prepare(
        "SELECT 1 AS found FROM sqlite_schema WHERE type = 'table' AND name = ? LIMIT 1"
      )
      .get(table)
  )
}

function columnExists(db: DatabaseSync, table: string, column: string): boolean {
  return db
    .prepare("SELECT name FROM pragma_table_info(?)")
    .all(table)
    .some((row) => row.name === column)
}

function parseOpenCodeEvent(row: OpenCodeRow): UsageEvent | null {
  const data = parseObject(row.data)
  if (!data) return null
  const assistant = objectValue(objectValue(data.metadata)?.assistant)
  const tokens = objectValue(data.tokens) ?? objectValue(assistant?.tokens)
  if (!tokens) return null
  const cache = objectValue(tokens.cache)
  const counts: UsageTokenCounts = {
    input: tokenValue(tokens.input),
    output: tokenValue(tokens.output) + tokenValue(tokens.reasoning),
    cacheRead: tokenValue(cache?.read),
    cacheWrite: tokenValue(cache?.write),
  }
  const cost = numberValue(data.cost) ?? numberValue(assistant?.cost)
  if (tokenTotal(counts) === 0 && (cost === undefined || cost < 0)) return null
  const timestamp = openCodeTimestamp(
    objectValue(data.time) ?? objectValue(assistant?.time),
    row.time_updated ?? row.time_created
  )
  const event: UsageEvent = {
    ...counts,
    key: `OpenCode:${row.id}`,
    source: "OpenCode",
    session: row.session_id,
    timestamp,
    model: openCodeModel(data, assistant, row.session_model),
    cwd:
      stringValue(objectValue(data.path)?.cwd) ??
      stringValue(objectValue(assistant?.path)?.cwd) ??
      row.directory ??
      row.worktree ??
      "unknown",
  }
  if (cost !== undefined && Number.isFinite(cost) && cost >= 0)
    event.reportedCost = cost
  return event
}

function openCodeModel(
  data: JsonObject,
  assistant: JsonObject | undefined,
  storedModel: string | null
): string {
  const model =
    objectValue(data.model) ??
    objectValue(assistant?.model) ??
    (storedModel ? parseObject(storedModel) : undefined)
  const id =
    stringValue(data.modelID) ??
    stringValue(data.modelId) ??
    stringValue(assistant?.modelID) ??
    stringValue(assistant?.modelId) ??
    stringValue(model?.id) ??
    stringValue(model?.modelID) ??
    stringValue(data.model)
  const provider =
    stringValue(data.providerID) ??
    stringValue(data.providerId) ??
    stringValue(assistant?.providerID) ??
    stringValue(assistant?.providerId) ??
    stringValue(model?.providerID) ??
    stringValue(model?.providerId)
  return id ? (provider ? `${provider}/${id}` : id) : "unknown"
}

function openCodeTimestamp(time: JsonObject | undefined, fallback: number): string {
  for (const value of [time?.completed, time?.created]) {
    const numeric = numberValue(value)
    if (numeric !== undefined && numeric > 0) {
      const millis = numeric < 10_000_000_000 ? numeric * 1000 : numeric
      if (!Number.isNaN(new Date(millis).getTime())) return new Date(millis).toISOString()
    }
    const timestamp = stringValue(value)
    if (timestamp && !Number.isNaN(Date.parse(timestamp)))
      return new Date(timestamp).toISOString()
  }
  const millis = fallback < 10_000_000_000 ? fallback * 1000 : fallback
  return new Date(millis).toISOString()
}

async function readLines(
  file: FileCandidate,
  visit: (line: string) => void
): Promise<boolean> {
  const start = Math.max(0, file.size - MAX_BYTES_PER_FILE)
  const input = createReadStream(file.path, {
    encoding: "utf8",
    start,
    end: Math.max(file.size - 1, 0),
  })
  const lines = createInterface({ input, crlfDelay: Infinity })
  let first = true
  try {
    for await (const line of lines) {
      if (first && start > 0) {
        first = false
        continue
      }
      first = false
      visit(line)
    }
    return true
  } catch {
    return false
  }
}

async function firstLine(path: string): Promise<string | undefined> {
  const input = createReadStream(path, { encoding: "utf8", start: 0, end: 65_535 })
  const lines = createInterface({ input, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      lines.close()
      input.destroy()
      return line
    }
  } catch {
    return undefined
  }
  return undefined
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
    key: `Mako:${id ?? fingerprint(timestamp, stringValue(message.model), counts)}`,
    source: "Mako",
    session,
    timestamp,
    model: stringValue(message.model) ?? "unknown",
    cwd,
  }
  if (cost !== undefined) event.reportedCost = cost
  return event
}

function parseClaudeEvent(
  line: string,
  fallbackSession: string,
  fallbackTime: number
): UsageEvent | null {
  const root = parseObject(line)
  const message = objectValue(root?.message)
  const usage = objectValue(message?.usage)
  if (!root || stringValue(root.type) !== "assistant" || !message || !usage)
    return null
  const counts = tokenCounts(
    usage,
    "input_tokens",
    "output_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens"
  )
  if (tokenTotal(counts) === 0) return null
  const timestamp = validTimestamp(root.timestamp, fallbackTime)
  const messageId = stringValue(message.id)
  const requestId = stringValue(root.requestId)
  const uuid = stringValue(root.uuid)
  const stableId =
    messageId && requestId
      ? `${messageId}:${requestId}`
      : messageId
        ? `message:${messageId}`
        : uuid
          ? `row:${uuid}`
          : fingerprint(timestamp, stringValue(message.model), counts)
  return {
    ...counts,
    key: `Claude Code:${stableId}`,
    source: "Claude Code",
    session:
      stringValue(root.sessionId) ?? stringValue(root.session_id) ?? fallbackSession,
    timestamp,
    model: stringValue(message.model) ?? "unknown",
    cwd: stringValue(root.cwd) ?? "unknown",
  }
}

function parseCodexRecord(
  line: string,
  context: CodexContext,
  fallbackTime: number
): UsageEvent | null {
  const root = parseObject(line)
  const payload = objectValue(root?.payload)
  if (!root || !payload) return null
  const type = stringValue(root.type)
  if (type === "session_meta") {
    context.session = stringValue(payload.id) ?? context.session
    context.cwd = stringValue(payload.cwd) ?? context.cwd
    return null
  }
  if (type === "turn_context") {
    context.cwd = stringValue(payload.cwd) ?? context.cwd
    context.model = codexModel(payload) ?? context.model
    return null
  }
  if (type !== "event_msg" || stringValue(payload.type) !== "token_count")
    return null
  const info = objectValue(payload.info)
  if (!info) return null
  const total = rawCodexUsage(info.total_token_usage)
  const last = rawCodexUsage(info.last_token_usage)
  const delta = codexDelta(total, last, context)
  if (!delta || rawCodexTotal(delta) === 0) return null

  const timestamp = validTimestamp(root.timestamp, fallbackTime)
  const model = codexModel(payload) ?? context.model
  const cacheRead = Math.min(delta.cacheRead, delta.input)
  const cacheWrite = Math.min(delta.cacheWrite, Math.max(delta.input - cacheRead, 0))
  const counts: UsageTokenCounts = {
    input: Math.max(delta.input - cacheRead - cacheWrite, 0),
    output: delta.output,
    cacheRead,
    cacheWrite,
  }
  return {
    ...counts,
    key: `Codex:${timestamp}:${rawCodexTuple(total)}:${rawCodexTuple(last)}`,
    source: "Codex",
    session: context.session,
    timestamp,
    model,
    cwd: context.cwd,
  }
}

function codexDelta(
  total: RawCodexUsage | null,
  last: RawCodexUsage | null,
  context: CodexContext
): RawCodexUsage | null {
  const previous = context.previous
  if (context.partial) {
    context.partial = false
    if (total && !last && !previous) {
      context.previous = total
      return null
    }
  }
  if (total && previous && rawCodexEqual(total, previous)) return null
  if (total && last && previous && !rawCodexMonotonic(total, previous)) {
    const previousSize = rawCodexTotal(previous)
    const currentSize = rawCodexTotal(total)
    const lastSize = rawCodexTotal(last)
    if (
      previousSize > 0 &&
      currentSize > 0 &&
      (currentSize * 100 >= previousSize * 98 ||
        currentSize + lastSize * 2 >= previousSize)
    )
      return null
  }
  if (total && last) {
    context.previous = total
    return last
  }
  if (total && previous) {
    context.previous = total
    if (!rawCodexMonotonic(total, previous)) return null
    return subtractCodex(total, previous)
  }
  if (total) {
    context.previous = total
    return total
  }
  if (last) {
    context.previous = previous ? addCodex(previous, last) : null
    return last
  }
  return null
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
  truncated: boolean
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
    sources: rank(sources).map((bucket) => ({
      source: bucket.key,
      ...totalsOf(bucket),
    })),
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

function parseObject(line: string): JsonObject | undefined {
  try {
    const value: JsonValue = JSON.parse(line)
    return objectValue(value)
  } catch {
    return undefined
  }
}

function tokenCounts(
  usage: JsonObject,
  inputKey: string,
  outputKey: string,
  cacheReadKey: string,
  cacheWriteKey: string
): UsageTokenCounts {
  return {
    input: tokenValue(usage[inputKey]),
    output: tokenValue(usage[outputKey]),
    cacheRead: tokenValue(usage[cacheReadKey]),
    cacheWrite: tokenValue(usage[cacheWriteKey]),
  }
}

function rawCodexUsage(value: JsonValue | undefined): RawCodexUsage | null {
  const usage = objectValue(value)
  if (!usage) return null
  return {
    input: tokenValue(usage.input_tokens),
    output: tokenValue(usage.output_tokens),
    cacheRead: tokenValue(
      usage.cached_input_tokens ?? usage.cache_read_input_tokens
    ),
    cacheWrite: tokenValue(usage.cache_write_input_tokens),
  }
}

function codexModel(payload: JsonObject): string | undefined {
  const direct = stringValue(payload.model) ?? stringValue(payload.model_name)
  if (direct) return direct
  const info = objectValue(payload.info)
  const metadata = objectValue(info?.metadata) ?? objectValue(payload.metadata)
  return (
    stringValue(info?.model) ??
    stringValue(info?.model_name) ??
    stringValue(metadata?.model)
  )
}

function rawCodexEqual(left: RawCodexUsage, right: RawCodexUsage): boolean {
  return (
    left.input === right.input &&
    left.output === right.output &&
    left.cacheRead === right.cacheRead &&
    left.cacheWrite === right.cacheWrite
  )
}

function rawCodexMonotonic(left: RawCodexUsage, right: RawCodexUsage): boolean {
  return (
    left.input >= right.input &&
    left.output >= right.output &&
    left.cacheRead >= right.cacheRead &&
    left.cacheWrite >= right.cacheWrite
  )
}

function subtractCodex(
  left: RawCodexUsage,
  right: RawCodexUsage
): RawCodexUsage {
  return {
    input: Math.max(left.input - right.input, 0),
    output: Math.max(left.output - right.output, 0),
    cacheRead: Math.max(left.cacheRead - right.cacheRead, 0),
    cacheWrite: Math.max(left.cacheWrite - right.cacheWrite, 0),
  }
}

function addCodex(left: RawCodexUsage, right: RawCodexUsage): RawCodexUsage {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
  }
}

function rawCodexTotal(usage: RawCodexUsage): number {
  return usage.input + usage.output
}

function rawCodexTuple(usage: RawCodexUsage | null): string {
  return usage
    ? `${usage.input},${usage.output},${usage.cacheRead},${usage.cacheWrite}`
    : ""
}

function fingerprint(
  timestamp: string,
  model: string | undefined,
  usage: UsageTokenCounts
): string {
  return `${timestamp}:${model ?? "unknown"}:${usage.input},${usage.output},${usage.cacheRead},${usage.cacheWrite}`
}

function tokenTotal(usage: UsageTokenCounts): number {
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite
}

function validTimestamp(
  value: JsonValue | undefined,
  fallbackTime: number
): string {
  const timestamp = stringValue(value)
  if (timestamp && !Number.isNaN(Date.parse(timestamp)))
    return new Date(timestamp).toISOString()
  return new Date(fallbackTime).toISOString()
}

function dayOf(timestamp: string): string {
  return timestamp.slice(0, 10)
}

function tokenValue(value: JsonValue | undefined): number {
  const parsed = numberValue(value)
  return parsed !== undefined && Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

function objectValue(value: JsonValue | undefined): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined
}

function stringValue(value: JsonValue | undefined): string | undefined {
  return isString(value) ? value : undefined
}

function numberValue(value: JsonValue | undefined): number | undefined {
  return isNumber(value) ? value : undefined
}

function isString(value: JsonValue | undefined): value is string {
  return Object.prototype.toString.call(value) === "[object String]"
}

function isNumber(value: JsonValue | undefined): value is number {
  return Object.prototype.toString.call(value) === "[object Number]"
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return (
    value !== undefined &&
    value !== null &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === "[object Object]"
  )
}

async function yieldToMain(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}
