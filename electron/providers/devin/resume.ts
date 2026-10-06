import { createHash } from "node:crypto"
import { open, realpath } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import type { DatabaseSync } from "node:sqlite"
import { openNativeStore } from "@mako/sessions/read-only-sqlite"
import { z } from "zod"
import type { ProviderBinding } from "../../contracts/conversation-control.js"
import type { NativeResumeEvidence } from "../../native-continuation.js"

const rowSchema = z.object({ main_chain_id: z.number().nullable(), model: z.string().nullable(), working_directory: z.string() })

const devinDirectory = (env: NodeJS.ProcessEnv) => join(env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "devin", "cli")

export function devinResumePolicy(configured?: string) {
  const directory = configured ?? devinDirectory(process.env)
  const database = join(directory, "sessions.db")
  const nativeSource = (path: string, nativeId: string | undefined) => {
    const split = path.lastIndexOf("#")
    const file = path.slice(0, split)
    const id = path.slice(split + 1)
    return split > 0 && isAbsolute(file) && /^[\w-]+$/.test(id) && id === nativeId
      ? { path: file, record: id } : undefined
  }
  const identity = async (path: string) => {
    const source = nativeSource(path, path.slice(path.lastIndexOf("#") + 1))
    if (!source) return undefined
    if (source.path !== database) {
      const files = await Promise.all([realpath(source.path).catch(() => undefined), realpath(database).catch(() => undefined)])
      if (!files[0] || files[0] !== files[1]) return undefined
    }
    return source.record
  }
  const checkpoint = async (path: string): Promise<string | undefined> => {
    const id = await identity(path)
    if (!id) return undefined
    let db: DatabaseSync | undefined
    try {
      db = openNativeStore(database)
      const row = rowSchema.safeParse(db.prepare("SELECT main_chain_id, model, working_directory FROM sessions WHERE id = ? AND hidden = 0").get(id))
      return row.success ? createHash("sha256").update(JSON.stringify([id, row.data])).digest("hex") : undefined
    } catch {
      return undefined
    } finally {
      db?.close()
    }
  }
  /** Devin's own lock: a live pid holds the session, a dead one's lock is stale, an unreadable one is not trusted. */
  const lockVerdict = async (nativeId: string): Promise<Exclude<NativeResumeEvidence, { kind: "available" }> | null> => {
    const unreadable: NativeResumeEvidence = { kind: "unavailable", reason: "Devin's session lock could not be read." }
    try {
      const file = await open(join(directory, "session_locks", `${nativeId}.lock`), "r")
      let pid: number
      try {
        const bytes = Buffer.alloc(65)
        const read = await file.read(bytes, 0, bytes.length, 0)
        if (read.bytesRead === bytes.length) return unreadable
        const value = bytes.subarray(0, read.bytesRead).toString("utf8").trim()
        if (!/^\d+$/.test(value)) return unreadable
        pid = Number(value)
        if (!Number.isSafeInteger(pid) || pid <= 0) return unreadable
      } finally {
        await file.close()
      }
      try {
        process.kill(pid, 0)
        return { kind: "held", by: `a Devin process (pid ${pid})` }
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") return unreadable
      }
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") return unreadable
    }
    return null
  }
  const inspectNativeSession = async (binding: ProviderBinding): Promise<NativeResumeEvidence> => {
    if (!binding.nativeId || !binding.path || await identity(binding.path) !== binding.nativeId)
      return { kind: "unavailable", reason: "The saved binding does not name a Devin session." }
    const locked = await lockVerdict(binding.nativeId)
    if (locked) return locked
    const current = await checkpoint(binding.path)
    if (current === undefined)
      return { kind: "unavailable", reason: "The Devin session is missing from its database." }
    return { kind: "available", checkpoint: current, strategy: "same-session" }
  }
  /** `<database>#<id>` in the account's store, once Devin has saved the session's row. */
  const locateSession = ({ nativeId, env }: { nativeId: string; env: NodeJS.ProcessEnv }): string | undefined => {
    if (!/^[\w-]+$/.test(nativeId)) return undefined
    const store = join(configured ?? devinDirectory(env), "sessions.db")
    let db: DatabaseSync | undefined
    try {
      db = openNativeStore(store)
      return db.prepare("SELECT 1 FROM sessions WHERE id = ? AND hidden = 0").get(nativeId) ? `${store}#${nativeId}` : undefined
    } catch {
      return undefined
    } finally {
      db?.close()
    }
  }
  return { checkpoint, inspect: inspectNativeSession, locate: locateSession, nativeSource }
}
