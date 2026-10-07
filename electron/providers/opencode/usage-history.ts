import { existsSync } from "node:fs"
import type { DatabaseSync } from "node:sqlite"
import { basename } from "node:path"
import { openCodeDatabasePaths } from "@mako/sessions"
import { OpenCodeSavedTokens, openCodeTokens } from "@mako/sessions/harnesses"
import { z } from "zod"
import { numberValue, objectValue, stringValue, type JsonObject } from "../../codex-app-json.js"
import { openNativeStore } from "@mako/sessions/read-only-sqlite"
import { parseObject, tokenTotal, usageCounts, yieldToMain, type UsageEvent, type UsageScan } from "../../usage-scan.js"
import type { ProviderUsageHistory } from "../usage-history.js"

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

export const openCodeUsageHistory: ProviderUsageHistory = {
  provider: "opencode",
  scan,
}

/** A message's last change in epoch ms; OpenCode has stored both seconds and milliseconds. */
const CHANGED_MS = (alias: string, updated: string) =>
  `(CASE WHEN coalesce(${updated}, ${alias}.time_created) < 10000000000 THEN coalesce(${updated}, ${alias}.time_created) * 1000 ELSE coalesce(${updated}, ${alias}.time_created) END)`

/**
 * Each database is read from the last change the previous read saw. A
 * message still streaming changes again and is read again; its key keeps
 * the larger counts. The newer database is read first: a message both
 * hold counts in the session the newer one files it under.
 */
async function scan(scan: UsageScan): Promise<void> {
  for (const path of openCodeDatabasePaths(scan.env, scan.homeRoot).reverse()) {
    if (!existsSync(path)) continue
    const name = basename(path)
    await scan.store(path, async (cursor) => {
      const db = openNativeStore(path)
      try {
        db.exec("PRAGMA query_only = ON")
        const from = Math.max(cursor ?? 0, scan.since)
        let latest = cursor
        for (const row of selectOpenCodeRows(db, name, from)) {
          const changed = openCodeMillis(row.time_updated ?? row.time_created)
          if (latest === undefined || changed > latest) latest = changed
          const event = parseOpenCodeEvent(scan.source, row)
          if (event) scan.record(event)
        }
        return latest
      } finally {
        db.close()
      }
    })
    await yieldToMain()
  }
}

function openCodeMillis(value: number): number {
  return value < 10_000_000_000 ? value * 1000 : value
}

function selectOpenCodeRows(
  db: DatabaseSync,
  databaseName: string,
  from: number
): OpenCodeRow[] {
  if (!databaseName.endsWith("opencode-next.db")) {
    return [
      ...openCodeTableRows(db, "message", from),
      ...openCodeTableRows(db, "session_message", from, "session_v2", true),
    ]
  }
  return openCodeTableRows(db, "session_message", from)
}

function openCodeTableRows(
  db: DatabaseSync,
  table: "message" | "session_message",
  from: number,
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
       WHERE ${assistant}${shadow} AND ${CHANGED_MS(alias, updated)} >= ?
       ORDER BY ${alias}.time_created, ${alias}.id`
    )
    .all(from)
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

function parseOpenCodeEvent(source: string, row: OpenCodeRow): UsageEvent | null {
  const data = parseObject(row.data)
  if (!data) return null
  const assistant = objectValue(objectValue(data.metadata)?.assistant)
  const tokens = OpenCodeSavedTokens.parse(data.tokens ?? assistant?.tokens)
  if (!tokens) return null
  const counts = usageCounts(openCodeTokens(tokens))
  const cost = numberValue(data.cost) ?? numberValue(assistant?.cost)
  if (tokenTotal(counts) === 0 && (cost === undefined || cost < 0)) return null
  const timestamp = openCodeTimestamp(
    objectValue(data.time) ?? objectValue(assistant?.time),
    row.time_updated ?? row.time_created
  )
  const event: UsageEvent = {
    ...counts,
    key: `${source}:${row.id}`,
    source,
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
