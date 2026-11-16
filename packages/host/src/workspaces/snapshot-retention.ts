import { rm } from "node:fs/promises"
import { join } from "node:path"
import type { DatabaseSync } from "node:sqlite"
import { z } from "zod"
import { WorkspaceSnapshotSchema } from "../contracts/workspace-snapshots.js"
import { snapshotPayloadBytes } from "./snapshot-git.js"

const oid = z.string().regex(/^[a-f0-9]{40,64}$/)
export const SnapshotRecordSchema = WorkspaceSnapshotSchema.extend({
  gitDir: z.string(),
  head: z.string(),
  tree: oid,
  commit: oid.optional(),
  storage: z
    .object({
      kind: z.literal("private"),
      bytes: z.number().int().nonnegative(),
    })
    .optional(),
  indexDigest: z.union([
    z.literal("absent"),
    z.string().regex(/^[a-f0-9]{64}$/),
  ]),
  retainUntil: z.number().finite().optional(),
})
export type SnapshotRecord = z.infer<typeof SnapshotRecordSchema>
export const SnapshotRetentionPolicySchema = z.object({
  maxSnapshots: z.number().int().positive().default(1000),
  maxStorageBytes: z
    .number()
    .int()
    .positive()
    .default(1024 ** 3),
  maxSnapshotBytes: z
    .number()
    .int()
    .positive()
    .default(512 * 1024 ** 2),
  maxAgeMs: z
    .number()
    .int()
    .positive()
    .default(30 * 24 * 60 * 60 * 1000),
  previewTtlMs: z
    .number()
    .int()
    .positive()
    .default(30 * 60 * 1000),
})
export type SnapshotRetentionPolicy = z.infer<
  typeof SnapshotRetentionPolicySchema
>
const RowSchema = z.object({ value: z.string() })

function* records(db: DatabaseSync, scope: string) {
  for (const row of db
    .prepare(
      `SELECT value FROM snapshots WHERE json_extract(value, '$.scope') = ?
    ORDER BY json_extract(value, '$.createdAt') DESC, id DESC`
    )
    .iterate(scope))
    yield SnapshotRecordSchema.parse(JSON.parse(RowSchema.parse(row).value))
}
async function recordBytes(
  root: string,
  record: SnapshotRecord
): Promise<number> {
  if (record.storage) return record.storage.bytes
  try {
    return await snapshotPayloadBytes(join(root, record.id))
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return 0
    throw error
  }
}
export async function retainedSnapshotBytes(
  db: DatabaseSync,
  root: string,
  scope: string
): Promise<number> {
  let bytes = 0
  for (const record of records(db, scope))
    bytes += await recordBytes(root, record)
  return bytes
}

export async function pruneSnapshotRecords({
  db,
  root,
  scope,
  gitDir,
  protectedIds,
  policy,
  removeRefs,
  additionalBytes = 0,
}: {
  db: DatabaseSync
  root: string
  scope: string
  gitDir: string
  protectedIds: ReadonlySet<string>
  policy: SnapshotRetentionPolicy
  additionalBytes?: number
  removeRefs: (records: readonly SnapshotRecord[]) => Promise<void>
}): Promise<number> {
  const now = Date.now()
  const protectedRecord = (record: SnapshotRecord) =>
    protectedIds.has(record.id) || (record.retainUntil ?? 0) > now
  let budget = policy.maxStorageBytes - additionalBytes
  for (const record of records(db, scope)) {
    if (protectedRecord(record)) budget -= await recordBytes(root, record)
  }
  const expired: SnapshotRecord[] = []
  let position = 0
  for (const record of records(db, scope)) {
    position++
    if (protectedRecord(record)) continue
    const bytes = await recordBytes(root, record)
    if (
      position <= policy.maxSnapshots &&
      record.createdAt > now - policy.maxAgeMs &&
      bytes <= budget
    ) {
      budget -= bytes
      continue
    }
    if (record.gitDir !== gitDir)
      throw new Error(
        "The checkpoint repository location changed. Cleanup was refused."
      )
    expired.push(record)
    if (expired.length === 64) break
  }
  if (expired.length) await removeRefs(expired)
  for (const record of expired) {
    await rm(join(root, record.id), { recursive: true, force: true })
    db.prepare("DELETE FROM snapshots WHERE id=?").run(record.id)
  }
  return expired.length
}
