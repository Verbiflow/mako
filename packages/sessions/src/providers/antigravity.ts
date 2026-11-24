import { BinaryReader, WireType } from "@bufbuild/protobuf"
import { existsSync, readdirSync } from "node:fs"
import { readdir, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import type { Entry, ThreadRef } from "../format.js"
import type { NativeStores } from "../read-only-sqlite.js"
import type { NativeFile, SessionProvider } from "./types.js"

const idFile = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.db$/i
export const AGY_KEY_DATA = "mako-antigravity-key"
export const AGY_CLI_DATA = "antigravity-cli"
const keyProfile = /^mako-antigravity-key\.[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/
/** Each saved credential gets a separate native session store. The terminal can also supply its own key. */
export function agyDataDirectory(env: NodeJS.ProcessEnv): string {
  if (!env.GEMINI_API_KEY) return AGY_CLI_DATA
  const profile = env.MAKO_AGY_DATA_DIRECTORY
  return profile && keyProfile.test(profile) ? profile : AGY_KEY_DATA
}
export function agyConversationPath(env: NodeJS.ProcessEnv, id: string): string | undefined {
  if (!idFile.test(id + ".db")) return undefined
  return join(env.GEMINI_HOME || join(env.HOME || homedir(), ".gemini"), agyDataDirectory(env), "conversations", id + ".db")
}

function bytesField(bytes: Uint8Array, field: number): Uint8Array | undefined {
  const reader = new BinaryReader(bytes)
  while (reader.pos < reader.len) {
    const [number, type] = reader.tag()
    if (number === field && type === WireType.LengthDelimited) return reader.bytes()
    reader.skip(type, number)
  }
  return undefined
}

function stepEntry(idx: number, kind: number, payload: Uint8Array): Entry {
  const id = `agy-step-${idx}`
  const path = kind === 14 ? [19, 2] : kind === 15 ? [20, 1] : kind === 17 ? [24, 3, 2] : []
  if (path.length) {
    let field: Uint8Array | undefined = payload
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

const workspaces = z.array(z.string())
const tableNames = z.array(z.object({ name: z.string() }))
const summary = z.object({ title: z.string(), preview: z.string(), workspace_uris: z.string(), last_modified_time: z.string(), step_count: z.number() })
const step = z.object({ idx: z.number(), step_type: z.number(), step_payload: z.instanceof(Uint8Array) })
export class AntigravityProvider implements SessionProvider {
  readonly harness = "antigravity"
  readonly displayName = "Antigravity"
  constructor(private readonly stores: NativeStores, private readonly home = process.env.GEMINI_HOME || join(homedir(), ".gemini")) {}
  recordRoots() {
    const profiles = existsSync(this.home) ? readdirSync(this.home).filter(name => keyProfile.test(name)) : []
    return [AGY_CLI_DATA, AGY_KEY_DATA, ...profiles].map((name) => ({ name, path: join(this.home, name) }))
  }
  roots() { return this.recordRoots().map(({ path }) => join(path, "conversations")) }
  private root(path: string) {
    if (!idFile.test(basename(path))) return undefined
    const directory = dirname(dirname(path))
    const name = basename(directory)
    if (name !== AGY_CLI_DATA && name !== AGY_KEY_DATA && !keyProfile.test(name)) return undefined
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
      const uri = workspaces.parse(JSON.parse(row.workspace_uris))[0]
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
