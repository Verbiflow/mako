import { BinaryReader, WireType } from "@bufbuild/protobuf"
import { existsSync, readdirSync } from "node:fs"
import { readdir, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import type { Entry, ThreadRef } from "../format.js"
import { agyStoredTokens, type ProtoFields } from "../harnesses/antigravity.js"
import { tokenSum, type HarnessTokens } from "../harnesses/tokens.js"
import type { NativeStores } from "../read-only-sqlite.js"
import type { NativeFile, SessionProvider } from "./types.js"

const idFile = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.db$/i
export const AGY_KEY_DATA = "mako-antigravity-key"
/** Where `agy acp` keeps a Google sign-in's conversations without `--app-data-dir`; the terminal CLI's own are beside it. */
export const AGY_ACP_DATA = "antigravity-acp"
export const AGY_CLI_DATA = "antigravity-cli"
const DATA_DIRECTORIES = [AGY_ACP_DATA, AGY_CLI_DATA, AGY_KEY_DATA]
const keyProfile = /^mako-antigravity-key\.[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/
/** Each saved credential gets a separate native session store. The terminal can also supply its own key. */
export function agyDataDirectory(env: NodeJS.ProcessEnv): string {
  if (!env.GEMINI_API_KEY) return AGY_ACP_DATA
  const profile = env.MAKO_AGY_DATA_DIRECTORY
  return profile && keyProfile.test(profile) ? profile : AGY_KEY_DATA
}
export function agyConversationPath(env: NodeJS.ProcessEnv, id: string): string | undefined {
  if (!idFile.test(id + ".db")) return undefined
  return join(env.GEMINI_HOME || join(env.HOME || homedir(), ".gemini"), agyDataDirectory(env), "conversations", id + ".db")
}

function bytesField(bytes: Uint8Array, field: number): Uint8Array | undefined {
  return messageFields(bytes).bytes.get(field)?.[0]
}

/** A protobuf message's fields by number, its varints apart from its length-delimited values; fixed-width ones skipped. */
function messageFields(bytes: Uint8Array): ProtoFields {
  const varints = new Map<number, number>()
  const delimited = new Map<number, Uint8Array[]>()
  const reader = new BinaryReader(bytes)
  while (reader.pos < reader.len) {
    const [number, type] = reader.tag()
    if (type === WireType.Varint) {
      const value = Number(reader.uint64())
      if (!varints.has(number)) varints.set(number, value)
    } else if (type === WireType.LengthDelimited) delimited.set(number, [...delimited.get(number) ?? [], reader.bytes()])
    else reader.skip(type, number)
  }
  return { varints, bytes: delimited }
}

const NO_FIELDS: ProtoFields = { varints: new Map(), bytes: new Map() }
const numberAt = (fields: ProtoFields, field: number) => fields.varints.get(field) ?? 0
const messageAt = (fields: ProtoFields, field: number): ProtoFields => {
  const bytes = fields.bytes.get(field)?.[0]
  return bytes ? messageFields(bytes) : NO_FIELDS
}
const textAt = (fields: ProtoFields, field: number) => {
  const bytes = fields.bytes.get(field)?.[0]
  return bytes ? new TextDecoder().decode(bytes).trim() : ""
}
/** A `google.protobuf.Timestamp`'s instant, in epoch ms. */
const instantAt = (fields: ProtoFields) => numberAt(fields, 1) * 1000 + Math.floor(numberAt(fields, 2) / 1e6) || undefined

/** One model call's spend as the CLI's store keeps it, under the ids it gives the call. */
export interface AgyStoredCall {
  ids: string[]
  model: string
  at?: number
  tokens: HarnessTokens
}

/**
 * The calls one row of a conversation's database records. A step's `metadata`
 * holds its call's usage (9), each retry's (28, under 2), the model (24) and
 * when (8, else 1); a `gen_metadata` row holds the same under 1, as usage (4),
 * retries (17, under 2), the model's names (19, 21) and when (9, under 4). A
 * call recorded both ways carries the same ids (11, 12, 7), so it counts once.
 */
export function agyStoredCalls(blob: Uint8Array, row: "step" | "generation"): AgyStoredCall[] {
  const root = messageFields(blob)
  const data = row === "step" ? root : messageAt(root, 1)
  const model = row === "step" ? messageAt(data, 24) : data
  const names = row === "step" ? [textAt(model, 12), textAt(model, 8)] : [textAt(model, 19), textAt(model, 21)]
  const at = row === "step" ? instantAt(messageAt(data, 8)) ?? instantAt(messageAt(data, 1)) : instantAt(messageAt(messageAt(data, 9), 4))
  const usages = [messageAt(data, row === "step" ? 9 : 4), ...(data.bytes.get(row === "step" ? 28 : 17) ?? [])
    .map((retry) => messageAt(messageFields(retry), 2))]
  return usages.flatMap((usage) => {
    const tokens = agyStoredTokens(usage)
    if (!tokenSum(tokens)) return []
    return [{ ids: [11, 12, 7].map((field) => textAt(usage, field)).filter(Boolean), model: names.find(Boolean) ?? "", ...(at && { at }), tokens }]
  })
}

function stepEntry(idx: number, kind: number, payload: Uint8Array | null): Entry {
  const id = `agy-step-${idx}`
  const path = kind === 14 ? [19, 2] : kind === 15 ? [20, 1] : kind === 17 ? [24, 3, 2] : []
  if (path.length) {
    let field: Uint8Array | undefined = payload ?? undefined
    try {
      for (const tag of path) field = field && bytesField(field, tag)
      if (field) {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(field)
        if (kind === 17) return { type: "event", id, label: "Turn failed", detail: text.split("\n")[0] }
        return { type: kind === 14 ? "user" : "text", id, text }
      }
    } catch { /* Preserve the step's position when a newer build changes its payload. */ }
  }
  return { type: "unread", id, kind: `Antigravity step ${kind}`, reason: path.length ? "unreadable" : "undrawn" }
}

/** The conversation's workspace folders, as the summary keeps them: a JSON list of `file:` URIs. */
const Workspaces = z.string().transform((text, context) => {
  try { return JSON.parse(text) }
  catch {
    context.addIssue({ code: "custom", message: "not JSON" })
    return z.NEVER
  }
}).pipe(z.array(z.string()))
const tableNames = z.array(z.object({ name: z.string() }))
const summary = z.object({ title: z.string(), preview: z.string(), workspace_uris: z.string(), last_modified_time: z.string(), step_count: z.number() })
const step = z.object({ idx: z.number(), step_type: z.number(), step_payload: z.instanceof(Uint8Array).nullable() })
const metadataRow = z.object({ data: z.instanceof(Uint8Array) })
export class AntigravityProvider implements SessionProvider {
  readonly harness = "antigravity"
  readonly displayName = "Antigravity"
  constructor(private readonly stores: NativeStores, private readonly home = process.env.GEMINI_HOME || join(homedir(), ".gemini")) {}
  recordRoots() {
    const profiles = existsSync(this.home) ? readdirSync(this.home).filter(name => keyProfile.test(name)) : []
    return [...DATA_DIRECTORIES, ...profiles].map((name) => ({ name, path: join(this.home, name) }))
  }
  roots() { return this.recordRoots().map(({ path }) => join(path, "conversations")) }
  private root(path: string) {
    if (!idFile.test(basename(path))) return undefined
    const directory = dirname(dirname(path))
    const name = basename(directory)
    if (!DATA_DIRECTORIES.includes(name) && !keyProfile.test(name)) return undefined
    return join(this.home, name, "conversations") === dirname(path) ? { name, path: directory } : undefined
  }
  watchTarget(path: string) {
    const db = path.replace(/-(?:wal|shm)$/, "")
    return this.root(db) ? db : null
  }
  observationPaths(path: string) { return [path, path + "-wal"] }
  async stat(path: string): Promise<NativeFile | null> {
    if (!this.root(path)) return null
    const [database, wal] = await Promise.all(this.observationPaths(path).map((part) => stat(part).catch(() => null)))
    return database ? { path, bytes: database.size + (wal?.size ?? 0), mtimeMs: Math.max(database.mtimeMs, wal?.mtimeMs ?? 0) } : null
  }
  async discover() {
    const files: NativeFile[] = []
    for (const root of this.roots()) {
      for (const name of await readdir(root).catch(() => [])) {
        if (!idFile.test(name)) continue
        const file = await this.stat(join(root, name))
        if (file) files.push(file)
      }
    }
    return files
  }
  async peek(file: NativeFile): Promise<ThreadRef | null> {
    const root = this.root(file.path)
    if (!root) return null
    const nativeId = basename(file.path, ".db")
    const db = this.stores.open(join(root.path, "conversation_summaries.db"))
    try {
      const row = summary.safeParse(db.prepare("SELECT title, preview, workspace_uris, last_modified_time, step_count FROM conversation_summaries WHERE conversation_id = ?").get(nativeId)).data
      if (!row || !row.step_count) return null
      const uri = Workspaces.safeParse(row.workspace_uris).data?.[0]
      return { harness: this.harness, nativeId, path: file.path, title: row.title || row.preview.slice(0, 120),
        cwd: uri?.startsWith("file:") ? fileURLToPath(uri) : undefined, updatedAt: row.last_modified_time, bytes: file.bytes }
    } finally { db.close() }
  }
  async read(path: string) {
    const file = await this.stat(path)
    const ref = file && await this.peek(file)
    if (!ref) return null
    const db = this.stores.open(path)
    try {
      const entries: Entry[] = []
      for (const raw of db.prepare("SELECT idx, step_type, step_payload FROM steps ORDER BY idx").iterate()) {
        const row = step.parse(raw)
        entries.push(stepEntry(row.idx, row.step_type, row.step_payload))
      }
      return { ref, entries }
    } finally { db.close() }
  }
  /**
   * The calls a conversation's database records, as `agyStoredCalls` reads its
   * steps and generations, one row's at a time: a generation's row can hold
   * megabytes of context, so a caller on the host's event loop yields between them.
   */
  *calls(path: string): Generator<AgyStoredCall[]> {
    if (!this.root(path)) return
    const db = this.stores.open(path)
    try {
      const tables = new Set(tableNames.parse(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).map(({ name }) => name))
      const sources = [["steps", "step", "SELECT metadata AS data FROM steps WHERE metadata IS NOT NULL ORDER BY idx"],
        ["gen_metadata", "generation", "SELECT data FROM gen_metadata ORDER BY idx"]] as const
      for (const [table, row, query] of sources) {
        if (!tables.has(table)) continue
        for (const raw of db.prepare(query).iterate()) {
          const blob = metadataRow.safeParse(raw).data?.data
          if (blob) yield agyStoredCalls(blob, row)
        }
      }
    } finally { db.close() }
  }
  async records(path: string) {
    const root = this.root(path)
    if (!root) return null
    const db = this.stores.open(path)
    try {
      const tables = tableNames.parse(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all())
      return { roots: [root], files: [], databases: [
        { path, tables: tables.map(({ name }) => ({ table: name })) },
        { path: join(root.path, "conversation_summaries.db"), tables: [{ table: "conversation_summaries", where: "conversation_id = ?", params: [basename(path, ".db")] }] },
      ] }
    } finally { db.close() }
  }
}
