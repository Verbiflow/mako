import { randomUUID } from "node:crypto"
import { rmSync } from "node:fs"
import type { ToolName } from "@cursor/sdk"
import type { NativeStores } from "@mako/sessions/read-only-sqlite"
import { cursorSdkAgentDirectory, cursorSdkStorePath } from "@mako/sessions/cursor-sdk-paths"
import { cloneCursorForkStore } from "./fork.js"

/** What a side question's copy may use: it reads and searches, and changes nothing. */
export const SIDE_AGENT_TOOLS: ToolName[] = ["read", "grep", "glob", "ls", "semSearch", "readLints"]

/**
 * Clones an agent's blob store to a new agent id under the same state root
 * for a side conversation, as a fork is cloned (`cloneCursorForkStore`): the
 * file shares its blocks with the original until either writes, so a 10 GB
 * store costs a fraction of a second and no disk, where `VACUUM INTO` took
 * 40 s and 10 GB. The copy's meta names it, so nothing reads it as the
 * original. Blobs are only ever added, so `rootBlobId`, read before the
 * clone, is whole in it even while a turn writes to the original.
 */
export function copySideStore(stores: NativeStores, stateRoot: string, agentId: string, rootBlobId: string): string {
  const side = randomUUID()
  try {
    cloneCursorForkStore(stores, { source: cursorSdkStorePath(stateRoot, agentId), target: cursorSdkStorePath(stateRoot, side), agentId: side, rootBlobId })
  } catch (cause) {
    removeSideStore(stateRoot, side)
    throw cause
  }
  return side
}

/** The side agent's folder: its blob store and run records, none of which outlives the side conversation. */
export function removeSideStore(stateRoot: string, side: string): void {
  rmSync(cursorSdkAgentDirectory(stateRoot, side), { recursive: true, force: true })
}
