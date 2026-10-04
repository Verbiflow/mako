import { createHash } from "node:crypto"
import { join } from "node:path"
import type { DatabaseSync } from "node:sqlite"
import { cursorSdkAgentIdForDirectory, cursorSdkIndexPath, readCursorSdkAgent } from "@mako/sessions"
import { openNativeStore } from "@mako/sessions/read-only-sqlite"
import { z } from "zod"
import { readLegacyStoreSnapshot } from "./legacy-store.js"

/**
 * Checkpoints for Cursor's stores: what the conversation's head was when a
 * binding was saved, so a resume can say whether it moved since.
 *
 * Every writer of this store format — `cursor-agent acp`, `cursor-agent -p`,
 * the SDK — moves a root blob with each turn, and the digest is that root
 * plus the blob count, never a hash of the file: the store is SQLite in WAL
 * mode, so new turns sit in `store.db-wal` while `store.db` is unchanged,
 * and hashing a 45 MB file per turn is a cost with no information in it.
 */
const CountSchema = z.object({ n: z.number() })

function blobCount(db: DatabaseSync): number | null {
  const blobs = CountSchema.safeParse(db.prepare("SELECT count(*) AS n FROM blobs").get())
  return blobs.success ? blobs.data.n : null
}

function digest(parts: readonly (string | number | null)[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex")
}

/**
 * A `cursor-agent` store's head: `cursor-agent` keeps its `latestRootBlobId`
 * in the store's own meta row.
 */
export function cursorLegacyCheckpoint(path: string, id: string): string | undefined {
  try {
    return readLegacyStoreSnapshot(path, id).revision
  } catch {
    return undefined
  }
}

/**
 * The same digest for an SDK agent, named by its `agent-<hash>` directory.
 * The SDK writes the store in the same format but leaves the meta row's
 * `latestRootBlobId` empty: the head it moves with each turn is
 * `latest_checkpoint_ref_json` in the state root's `index.db`, so the root
 * comes from there and only the blob count from the store. The directory
 * rather than the meta row names the agent because an imported store keeps
 * the `cursor-agent` session's meta, and the SDK agent may sit under another id.
 */
export function cursorSdkCheckpoint(stateRoot: string, directoryName: string): string | undefined {
  const index = cursorSdkIndexPath(stateRoot)
  const agentId = cursorSdkAgentIdForDirectory(index, directoryName)
  if (!agentId) return undefined
  const record = readCursorSdkAgent(index, agentId)
  if (!record?.rootId) return undefined
  let db: DatabaseSync | undefined
  try {
    db = openNativeStore(join(stateRoot, "agents", directoryName, "store.db"))
    return digest([agentId, record.rootId, blobCount(db)])
  } catch {
    return undefined
  } finally {
    db?.close()
  }
}
