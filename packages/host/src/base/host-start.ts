import { randomBytes } from "node:crypto"
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"

/**
 * One start of a host on its data root: its generation there, one more than the last start's, and the data root's own
 * name, so two starts are ordered only where both are of one data root (another device's, or a data root whose record
 * was lost, can't be). Windows order what a host said by it, then by revision (`LiveConversations.epoch`), never by a
 * clock: one moved back would have a newer host read as older.
 */
export const HostStartSchema = z.object({ generation: z.number().int().positive(), root: z.string().regex(/^[A-Za-z0-9_-]{8,16}$/) })
export type HostStart = z.infer<typeof HostStartSchema>

/**
 * The next start of the host on `dataRoot`, kept there before it's used: call it while holding the data root's lock
 * (`acquireHostLock`), so no two hosts take one generation. A record that can't be read starts again at 1 under a new
 * name, which no window orders against the old one's.
 */
export function takeHostStart(dataRoot: string): HostStart {
  const file = join(dataRoot, "host-start.json")
  const kept = keptStart(file)
  const start: HostStart = kept ? { generation: kept.generation + 1, root: kept.root } : { generation: 1, root: randomBytes(6).toString("base64url") }
  // Written whole and synced before it's used, so a start a crash cut short is never taken again.
  const next = `${file}.next`
  const descriptor = openSync(next, "w")
  try {
    writeSync(descriptor, JSON.stringify(start))
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
  renameSync(next, file)
  return start
}

/** The last start kept on the data root, or none where there's no record or it can't be read. */
function keptStart(file: string): HostStart | undefined {
  try {
    return HostStartSchema.safeParse(JSON.parse(readFileSync(file, "utf8"))).data
  } catch {
    return undefined
  }
}
