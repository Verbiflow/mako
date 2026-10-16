/**
 * The bytes an entry was read from, as its harness wrote them: the lines of
 * a file by their plain byte ranges, and database rows by table and key.
 * Read on demand, read-only, and whole: an original is what a person opens
 * to see what the decoder saw.
 */

import type { DatabaseSync } from "node:sqlite"
import { z } from "zod"
import type { RecordRef } from "./entries.js"
import { encodedRecordPath, recordChunks, recordFilePath, statRecord, type RecordStat } from "./record-files.js"
import { lookupStatement, SqlValueSchema, type SqlValue } from "./record-rows.js"
import { openReadOnly } from "./read-only-sqlite.js"

/** A column's value, worded for reading: a blob as UTF-8 when it is valid UTF-8, else base64. */
export const OriginalValueSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("null") }),
  z.object({ type: z.literal("integer"), text: z.string() }),
  z.object({ type: z.literal("real"), text: z.string() }),
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("blob"), bytes: z.number(), encoding: z.enum(["utf8", "base64"]), text: z.string() }),
])
export type OriginalValue = z.infer<typeof OriginalValueSchema>

const Key = z.record(z.string(), z.union([z.string(), z.number()]))

export const OriginalPartSchema = z.discriminatedUnion("kind", [
  /** A run of a file's plain bytes, `[from, to)`. */
  z.object({ kind: z.literal("range"), file: z.string(), from: z.number(), to: z.number(), text: z.string() }),
  /** A row, by its key; `columns` is null when the database no longer has it. */
  z.object({ kind: z.literal("row"), file: z.string(), table: z.string(), key: Key, columns: z.record(z.string(), OriginalValueSchema).nullable() }),
  /** A part whose file is gone or couldn't be read, and why. */
  z.object({ kind: z.literal("missing"), file: z.string(), reason: z.string() }),
])
export type OriginalPart = z.infer<typeof OriginalPartSchema>

export const EntryOriginalSchema = z.object({
  /** Read from Mako's copy in the record store, because the harness no longer has the session. */
  kept: z.boolean(),
  parts: z.array(OriginalPartSchema),
})
export type EntryOriginal = z.infer<typeof EntryOriginalSchema>

const utf8 = new TextDecoder("utf-8", { fatal: true })

/**
 * The original of `record`, for an entry of the session at `sessionPath`
 * (the path its file names are relative to). Every range of a file is read,
 * then every row; a database is opened once for all its rows.
 */
export async function readOriginal(sessionPath: string, record: RecordRef, kept = false): Promise<EntryOriginal> {
  const parts: OriginalPart[] = []
  const file = recordFilePath(sessionPath, record)
  if (record.ranges?.length) {
    // Offsets count plain bytes, so a record the harness has since compressed in place reads the same.
    const found = await firstFile([file, encodedRecordPath(file, "zstd")])
    if (!found) parts.push({ kind: "missing", file, reason: "The file is gone." })
    else for (const [from, to] of record.ranges) parts.push(await readRange(found.file, from, Math.min(to, found.stat.bytes)))
  }
  if (record.rows?.length) {
    let database: DatabaseSync | undefined
    try {
      database = openReadOnly(file).database
      for (const row of record.rows) parts.push(readRow(database, file, row.table, row.key))
    } catch (error) {
      parts.push({ kind: "missing", file, reason: error instanceof Error ? error.message : String(error) })
    } finally {
      database?.close()
    }
  }
  return { kept, parts }
}

async function firstFile(files: readonly string[]): Promise<{ file: string; stat: RecordStat } | null> {
  for (const file of files) {
    const stat = await statRecord(file).catch(() => null)
    if (stat) return { file, stat }
  }
  return null
}

async function readRange(file: string, from: number, to: number): Promise<OriginalPart> {
  const chunks: Buffer[] = []
  for await (const chunk of recordChunks(file, from, to)) chunks.push(chunk.bytes)
  return { kind: "range", file, from, to: from + chunks.reduce((sum, chunk) => sum + chunk.length, 0), text: Buffer.concat(chunks).toString("utf8") }
}

function readRow(database: DatabaseSync, file: string, table: string, key: z.infer<typeof Key>): OriginalPart {
  const columns = Object.keys(key)
  const found = lookupStatement(database, table, columns).get(...Object.values(key))
  if (!found) return { kind: "row", file, table, key, columns: null }
  const values: Record<string, OriginalValue> = {}
  for (const [column, value] of Object.entries(found)) values[column] = worded(SqlValueSchema.parse(value))
  return { kind: "row", file, table, key, columns: values }
}

function worded(value: SqlValue): OriginalValue {
  switch (value.type) {
    case "null": return { type: "null" }
    case "integer": return { type: "integer", text: value.value.toString() }
    case "real": return { type: "real", text: String(value.value) }
    case "text": return { type: "text", text: value.value }
    case "blob": {
      const bytes = value.value.byteLength
      try {
        return { type: "blob", bytes, encoding: "utf8", text: utf8.decode(value.value) }
      } catch {
        return { type: "blob", bytes, encoding: "base64", text: Buffer.from(value.value).toString("base64") }
      }
    }
  }
}
