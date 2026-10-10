import type { DatabaseSync } from "node:sqlite"
import { createHash } from "node:crypto"
import { openNativeStore } from "@mako/sessions/read-only-sqlite"
import { z } from "zod"

const LegacyMetaSchema = z.object({
  agentId: z.string().optional(),
  latestRootBlobId: z.string().min(1),
  name: z.string().optional(),
  createdAt: z.union([z.string(), z.number()]).optional(),
  blobEncryptionKey: z.string().optional(),
})
export type LegacyStoreMeta = z.infer<typeof LegacyMetaSchema>

const MetaRowSchema = z.object({
  value: z.union([
    z.string().transform(raw => /^[0-9a-f]+$/i.test(raw) ? Buffer.from(raw, "hex").toString("utf8") : raw),
    z.instanceof(Uint8Array).transform(raw => Buffer.from(raw).toString("utf8")),
  ]),
})
const CountSchema = z.object({ n: z.number().int().nonnegative() })

export class CursorImportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CursorImportError"
  }
}

/** Root and blob count from one SQLite read snapshot, including committed WAL.
 * This is Cursor's native checkpoint, not a byte hash or execution lease.
 */
export function readLegacyStoreSnapshot(path: string, nativeId: string) {
  let database: DatabaseSync | undefined
  try {
    database = openNativeStore(path)
    database.exec("BEGIN")
    const row = MetaRowSchema.safeParse(database.prepare("SELECT value FROM meta WHERE key = '0'").get())
    if (!row.success) throw new CursorImportError("The Cursor session store has no meta row to import from.")
    const meta = LegacyMetaSchema.safeParse(JSON.parse(row.data.value))
    if (!meta.success) throw new CursorImportError("The Cursor session store's meta row names no root blob.")
    if (meta.data.agentId && meta.data.agentId !== nativeId)
      throw new CursorImportError("The Cursor session store names a different agent. The saved source was preserved.")
    const count = CountSchema.parse(database.prepare("SELECT count(*) AS n FROM blobs").get())
    const revision = createHash("sha256").update(JSON.stringify([nativeId, meta.data.latestRootBlobId, count.n])).digest("hex")
    return { meta: meta.data, revision }
  } catch (error) {
    if (error instanceof CursorImportError) throw error
    throw new CursorImportError(`The Cursor session snapshot could not be read: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    database?.close()
  }
}

export type LegacyStoreSnapshot = ReturnType<typeof readLegacyStoreSnapshot>
