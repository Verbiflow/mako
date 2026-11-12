import { createHash } from "node:crypto"
import { join } from "node:path"
import type { DatabaseSync } from "node:sqlite"
import { cursorSdkAgentIdForDirectory, cursorSdkIndexPath, readCursorSdkAgentRoot } from "@mako/sessions"
import type { NativeStores } from "@mako/sessions/read-only-sqlite"
import { z } from "zod"
import { readLegacyStoreSnapshot } from "./legacy-store.js"

/**
 * Checkpoints for Cursor's stores: what the conversation's head was when a
 * binding was saved, so a resume can say whether it moved since.
 *
 * Every writer of this store format — `cursor-agent acp`, `cursor-agent -p`,
 * the SDK — moves a root blob with each turn, and the digest is that root
 * plus the blob count (an SDK agent's is its root alone,
 * `cursorSdkCheckpoint`), never a hash of the file: the store is SQLite in WAL
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
export function cursorLegacyCheckpoint(stores: NativeStores, path: string, id: string): string | undefined {
  try {
    return readLegacyStoreSnapshot(stores, path, id).revision
  } catch {
    return undefined
  }
}

/** An SDK agent's head as its agent and root alone. */
const SDK_HEAD = "sdk-head:"
const RowidSchema = z.object({ rowid: z.number().nullable() })

/**
 * The head of an SDK agent, named by its `agent-<hash>` directory. The SDK
 * writes the store in the same format but leaves the meta row's
 * `latestRootBlobId` empty: the head it moves with each step is
 * `latest_checkpoint_ref_json` in the state root's `index.db`, and that root
 * is all a resume continues from. The store's blob count is no part of it:
 * Mako collects the roots the SDK leaves behind (`cursor-sdk-collect`), and
 * a count would read every collected agent as continued elsewhere. The
 * directory rather than the meta row names the agent because an imported
 * store keeps the `cursor-agent` session's meta, and the SDK agent may sit
 * under another id. An agent whose first turn never ended has no root yet;
 * that is its head, not a missing store.
 *
 * A binding saved before this form (`previous` without `SDK_HEAD`) hashed
 * the blob count with the root, and is compared in that form: collecting
 * only lowers the count, and never below what the store holds now nor above
 * its newest rowid, so a binding whose root hasn't moved still reads as it did.
 */
export function cursorSdkCheckpoint(stores: NativeStores, stateRoot: string, directoryName: string, previous?: string): string | undefined {
  const index = cursorSdkIndexPath(stateRoot)
  const agentId = cursorSdkAgentIdForDirectory(stores, index, directoryName)
  if (!agentId) return undefined
  // Read at every Cursor turn's end on the host's thread: the agent's root by its key, and the store's blobs counted
  // only for a binding saved in the older form. Listing its runs and counting every blob held it 60-400 ms on a 2.7 GB
  // index.
  const record = readCursorSdkAgentRoot(stores, index, agentId)
  if (!record) return undefined
  const root = record.rootId ?? null
  let db: DatabaseSync | undefined
  try {
    db = stores.open(join(stateRoot, "agents", directoryName, "store.db"))
    if (previous === undefined || previous.startsWith(SDK_HEAD)) return `${SDK_HEAD}${digest([agentId, root])}`
    const count = blobCount(db)
    if (count === null) return digest([agentId, root, count])
    const newest = RowidSchema.parse(db.prepare("SELECT max(rowid) AS rowid FROM blobs").get()).rowid ?? count
    for (let counted = count; counted <= newest; counted += 1)
      if (digest([agentId, root, counted]) === previous) return previous
    return digest([agentId, root, count])
  } catch {
    return undefined
  } finally {
    db?.close()
  }
}
