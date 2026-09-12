import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { join, sep } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { z } from "zod"
import type { ProviderBinding } from "../../contracts/conversation-control.js"
import { probeOpenFiles } from "../open-files-probe.js"

/**
 * When a Cursor ACP session may be picked up again with `session/load`.
 *
 * Verified 2026-09-12 against cursor-agent 2026.09.10: `session/load` reopens
 * a session whose store lives under `~/.cursor/acp-sessions/<id>/store.db`,
 * replays its history, keeps writing to that same store, and answers
 * "Session not found" for a store under `chats/`. So only an acp-sessions
 * store is resumable here; a chats store is the CLI's own and continues
 * through `cursor-agent --resume`.
 *
 * The checkpoint is the store's own head, not a hash of the file: the store
 * is SQLite in WAL mode, so new turns sit in `store.db-wal` while `store.db`
 * itself is unchanged, and hashing a 45 MB file per turn is a cost with no
 * information in it. The root blob id moves with every turn.
 */
const MetaSchema = z.object({
  agentId: z.string().optional(),
  latestRootBlobId: z.string().optional(),
})

/** Cursor stores the meta row as JSON text, sometimes hex-encoded, sometimes as bytes. */
const MetaRowSchema = z.object({
  value: z.union([
    z
      .string()
      .transform((raw) =>
        /^[0-9a-f]+$/i.test(raw) ? Buffer.from(raw, "hex").toString("utf8") : raw
      ),
    z.instanceof(Uint8Array).transform((raw) => Buffer.from(raw).toString("utf8")),
  ]),
})

const CountSchema = z.object({ n: z.number() })

interface CursorStoreHead {
  latestRootBlobId: string
  blobs: number | null
}

function readStoreHead(db: DatabaseSync): CursorStoreHead | undefined {
  const row = MetaRowSchema.safeParse(db.prepare("SELECT value FROM meta WHERE key = '0'").get())
  if (!row.success) return undefined
  let parsed: z.infer<typeof MetaSchema>
  try {
    const meta = MetaSchema.safeParse(JSON.parse(row.data.value))
    if (!meta.success) return undefined
    parsed = meta.data
  } catch {
    return undefined
  }
  if (!parsed.latestRootBlobId) return undefined
  const blobs = CountSchema.safeParse(db.prepare("SELECT count(*) AS n FROM blobs").get())
  return { latestRootBlobId: parsed.latestRootBlobId, blobs: blobs.success ? blobs.data.n : null }
}

export function cursorResumePolicy(home = homedir()) {
  const root = join(home, ".cursor", "acp-sessions")
  const identity = (path: string): string | undefined => {
    if (!path.startsWith(`${root}${sep}`)) return undefined
    const rest = path.slice(root.length + 1).split(sep)
    return rest.length === 2 && rest[1] === "store.db" && /^[\w-]+$/.test(rest[0] ?? "")
      ? rest[0]
      : undefined
  }
  const checkpoint = async (path: string): Promise<string | undefined> => {
    const id = identity(path)
    if (!id) return undefined
    let db: DatabaseSync | undefined
    try {
      db = new DatabaseSync(path, { readOnly: true })
      const head = readStoreHead(db)
      if (!head) return undefined
      return createHash("sha256")
        .update(JSON.stringify([id, head.latestRootBlobId, head.blobs]))
        .digest("hex")
    } catch {
      return undefined
    } finally {
      db?.close()
    }
  }
  const canResumeBinding = async (binding: ProviderBinding): Promise<boolean> => {
    if (!binding.nativeId || !binding.path || identity(binding.path) !== binding.nativeId) return false
    // Another cursor-agent with the store open is the owner; a second loader
    // would write the same SQLite file from two processes.
    const open = await probeOpenFiles({
      processNames: ["cursor-agent"],
      signal: AbortSignal.timeout(6_000),
      accept: (path) => path === binding.path,
    }).catch(() => ({ kind: "unavailable" as const }))
    if (open.kind !== "available" || open.paths.length > 0) return false
    const current = await checkpoint(binding.path)
    return current !== undefined && (binding.checkpoint === undefined || current === binding.checkpoint)
  }
  return { checkpoint, canResumeBinding }
}
