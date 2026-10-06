import { randomUUID } from "node:crypto"
import { closeSync, mkdirSync, openSync, rmSync } from "node:fs"
import { dirname } from "node:path"
import type { DatabaseSync } from "node:sqlite"
import { openNativeStore, refuseNativeWrite } from "@mako/sessions/read-only-sqlite"
import { CURSOR_SDK_IMPORT_METADATA_KEY, type CursorSdkImport } from "@mako/sessions/cursor-sdk-index"
import { cursorSdkStorePath } from "@mako/sessions/cursor-sdk-paths"
import { z } from "zod"
import { CursorImportError, type LegacyStoreSnapshot } from "../legacy-store.js"
export { CursorImportError } from "../legacy-store.js"
import type { SdkImportSource } from "./wire.js"

/**
 * Continuing a `cursor-agent` session through the SDK.
 *
 * `cursor-agent acp`, `cursor-agent -p` and the SDK all write the same blob
 * store: a SQLite file of content-addressed, encrypted blobs whose `meta` row
 * names the agent, the newest root blob and the blob key. What differs is the
 * index — `cursor-agent` keeps its head in that meta row, the SDK in the
 * state root's `index.db`. Verified 2026-09-13 (SDK 1.0.31): a legacy store
 * copied under the SDK's layout and registered in the index with its root and
 * blob key resumes with its whole history, under its own agent id or a fresh
 * one, and the SDK carries unknown keys in the agent's metadata through its
 * own turns. So a thread that ran under `cursor-agent acp` goes on in place:
 * the copy is made once, the legacy store is never written, and the catalog
 * folds the two rows into one through the identity recorded here.
 *
 * `VACUUM INTO` is the copy: it reads through the source's WAL, so a turn the
 * CLI committed but never checkpointed is included, and the source is opened
 * read-only so a `cursor-agent` that still has it open is undisturbed.
 */

/** Copy the legacy store, WAL folded in, to where the SDK will look for `agentId`. */
export function copyLegacyStore(sourcePath: string, stateRoot: string, agentId: string): string {
  refuseNativeWrite("Cursor's agent stores")
  const target = cursorSdkStorePath(stateRoot, agentId)
  mkdirSync(dirname(target), { recursive: true })
  // Reserve only this destination. Never delete another import/SDK history,
  // even if it appeared after the index was read. SQLite accepts an empty
  // output file; failed VACUUM cleanup applies only to our reservation.
  try {
    closeSync(openSync(target, "wx", 0o600))
  } catch {
    throw new CursorImportError("The Cursor import destination already exists or cannot be reserved. No history was overwritten. Open its SDK continuation or choose a separate import.")
  }
  let source: DatabaseSync | undefined
  try {
    source = openNativeStore(sourcePath)
    source.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`)
  } catch (error) {
    rmSync(target, { force: true })
    throw new CursorImportError(
      `The Cursor session store could not be copied: ${error instanceof Error ? error.message : String(error)}`
    )
  } finally {
    source?.close()
  }
  return target
}

/** What the index needs to know about an agent for `agents.create`. */
export interface ImportedAgentDocument {
  agentId: string
  cwd: string
  name: string | null
  createdAt: number
  latestRootBlobId: string
  sdkMetadata: ImportedSdkMetadata
}

/** The SDK's free-form `sdkMetadata`, as Mako writes it: its import record and the legacy blob key. */
export type ImportedSdkMetadata = {
  [CURSOR_SDK_IMPORT_METADATA_KEY]: CursorSdkImport
  blobEncryptionKey?: string
}

function epochOf(value: string | number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const numeric = z.number().safeParse(value)
  const parsed = numeric.success ? numeric.data : Date.parse(String(value))
  return Number.isFinite(parsed) ? parsed : fallback
}

/** The index row for an imported store: the legacy head, its blob key, and Mako's import record. */
export function importedAgentDocument(input: {
  agentId: string
  source: SdkImportSource
  snapshot: LegacyStoreSnapshot
  now: number
}): ImportedAgentDocument {
  const record: CursorSdkImport = {
    path: input.source.path,
    identity: input.source.identity,
    revision: input.snapshot.revision,
    agentId: input.snapshot.meta.agentId ?? input.agentId,
  }
  const sdkMetadata: ImportedSdkMetadata = { [CURSOR_SDK_IMPORT_METADATA_KEY]: record }
  if (input.snapshot.meta.blobEncryptionKey) sdkMetadata.blobEncryptionKey = input.snapshot.meta.blobEncryptionKey
  const name = input.source.name ?? (input.snapshot.meta.name && input.snapshot.meta.name !== "New Agent" ? input.snapshot.meta.name : undefined)
  return {
    agentId: input.agentId,
    cwd: input.source.cwd ?? "",
    name: name ?? null,
    createdAt: epochOf(input.snapshot.meta.createdAt, input.now),
    latestRootBlobId: input.snapshot.meta.latestRootBlobId,
    sdkMetadata,
  }
}

/** An agent the index already has, as far as the import cares. */
export interface KnownAgent {
  agentId: string
  importedFrom?: string
  importRevision?: string
}

/**
 * Which agent id continues a legacy store. The store's own id is preferred so
 * the catalog's `nativeId` does not change; it is taken when unused or when
 * it already names this very import (the idempotent case). When it names an
 * agent of another origin — the ACP store and its `chats/` fork share one id
 * — the fork's import gets a fresh id, and a later open of the same fork
 * finds it through the import record.
 */
export interface ImportAgentTarget {
  agentId: string
  /** The index already holds this import; open it instead of copying again. */
  existing: boolean
  revision?: string
}

export function resolveImportAgentId(
  requested: string,
  sourcePath: string,
  known: readonly KnownAgent[]
): ImportAgentTarget {
  const byPath = known.find((agent) => agent.importedFrom === sourcePath)
  if (byPath) return { agentId: byPath.agentId, existing: true, revision: byPath.importRevision }
  const held = known.find((agent) => agent.agentId === requested)
  if (!held) return { agentId: requested, existing: false }
  return { agentId: randomUUID(), existing: false }
}

/** Never overwrite an indexed SDK continuation when its legacy origin moved. */
export function verifyImportRevision(retained: string | undefined, current: string): string {
  if (!retained)
    throw new CursorImportError("This Cursor import predates revision receipts. Open its SDK continuation directly; the legacy source was preserved.")
  if (retained !== current)
    throw new CursorImportError("The original Cursor session changed after import. No prompt was sent and neither history was overwritten. Open the histories separately.")
  return retained
}
