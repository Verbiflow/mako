import { randomUUID } from "node:crypto"
import { mkdirSync, rmSync } from "node:fs"
import { dirname } from "node:path"
import type { DatabaseSync } from "node:sqlite"
import type { ToolName } from "@cursor/sdk"
import type { NativeStores } from "@mako/sessions/read-only-sqlite"
import { cursorSdkAgentDirectory, cursorSdkStorePath } from "@mako/sessions/cursor-sdk-paths"

/** What a side question's copy may use: it reads and searches, and changes nothing. */
export const SIDE_AGENT_TOOLS: ToolName[] = ["read", "grep", "glob", "ls", "semSearch", "readLints"]

/**
 * Copies an agent's blob store to a new agent id under the same state root,
 * WAL folded in, for a side conversation. Its blobs are content-addressed and
 * only ever added, so a checkpoint read before the copy is whole in it even
 * while a turn writes to the original.
 */
export function copySideStore(stores: NativeStores, stateRoot: string, agentId: string): string {
  const side = randomUUID()
  const target = cursorSdkStorePath(stateRoot, side)
  mkdirSync(dirname(target), { recursive: true })
  let source: DatabaseSync | undefined
  try {
    source = stores.open(cursorSdkStorePath(stateRoot, agentId))
    source.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`)
  } catch (cause) {
    removeSideStore(stateRoot, side)
    throw cause
  } finally {
    source?.close()
  }
  return side
}

/** The side agent's folder: its blob store and run records, none of which outlives the side conversation. */
export function removeSideStore(stateRoot: string, side: string): void {
  rmSync(cursorSdkAgentDirectory(stateRoot, side), { recursive: true, force: true })
}
