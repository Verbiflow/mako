import { createHash } from "node:crypto"
import { open } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { z } from "zod"
import { compareNativeCheckpoint, resumable, type ProviderBinding, type ResumeVerdict } from "../../contracts/conversation-control.js"

const rowSchema = z.object({ main_chain_id: z.number().nullable(), model: z.string().nullable(), working_directory: z.string() })

export function devinResumePolicy(directory = join(homedir(), ".local", "share", "devin", "cli")) {
  const database = join(directory, "sessions.db")
  const identity = (path: string) => {
    const id = path.startsWith(`${database}#`) ? path.slice(database.length + 1) : ""
    return /^[\w-]+$/.test(id) ? id : undefined
  }
  const checkpoint = async (path: string): Promise<string | undefined> => {
    const id = identity(path)
    if (!id) return undefined
    let db: DatabaseSync | undefined
    try {
      db = new DatabaseSync(database, { readOnly: true })
      const row = rowSchema.safeParse(db.prepare("SELECT main_chain_id, model, working_directory FROM sessions WHERE id = ? AND hidden = 0").get(id))
      return row.success ? createHash("sha256").update(JSON.stringify([id, row.data])).digest("hex") : undefined
    } catch {
      return undefined
    } finally {
      db?.close()
    }
  }
  /** Devin's own lock: a live pid holds the session, a dead one's lock is stale, an unreadable one is not trusted. */
  const lockVerdict = async (nativeId: string): Promise<ResumeVerdict | null> => {
    const unreadable: ResumeVerdict = { kind: "unavailable", reason: "Devin's session lock could not be read." }
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
  const resumeVerdict = async (binding: ProviderBinding): Promise<ResumeVerdict> => {
    if (!binding.nativeId || !binding.path || identity(binding.path) !== binding.nativeId)
      return { kind: "unavailable", reason: "The saved binding does not name a Devin session." }
    const locked = await lockVerdict(binding.nativeId)
    if (locked) return locked
    const current = await checkpoint(binding.path)
    if (current === undefined)
      return { kind: "unavailable", reason: "The Devin session is missing from its database." }
    return { kind: "resumable", record: compareNativeCheckpoint(binding.checkpoint, current) }
  }
  /** The strict form: unowned and unchanged since the binding's checkpoint. */
  const canResumeBinding = async (binding: ProviderBinding): Promise<boolean> =>
    resumable(await resumeVerdict(binding), "same")
  return { checkpoint, resumeVerdict, canResumeBinding }
}
