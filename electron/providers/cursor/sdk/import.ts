import { randomUUID } from "node:crypto"
import { mkdirSync, rmSync } from "node:fs"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"
import {
  CURSOR_SDK_IMPORT_METADATA_KEY,
  cursorSdkStorePath,
  type CursorSdkImport,
} from "@mako/sessions"
import { z } from "zod"
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
    z.string().transform((raw) => (/^[0-9a-f]+$/i.test(raw) ? Buffer.from(raw, "hex").toString("utf8") : raw)),
    z.instanceof(Uint8Array).transform((raw) => Buffer.from(raw).toString("utf8")),
  ]),
})

export class CursorImportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CursorImportError"
  }
}

/** The legacy store's own record of itself, or a typed refusal naming what is missing. */
export function readLegacyStoreMeta(path: string): LegacyStoreMeta {
  let database: DatabaseSync | undefined
  try {
    database = new DatabaseSync(path, { readOnly: true })
    const row = MetaRowSchema.safeParse(database.prepare("SELECT value FROM meta WHERE key = '0'").get())
    if (!row.success) throw new CursorImportError("The Cursor session store has no meta row to import from.")
    const meta = LegacyMetaSchema.safeParse(JSON.parse(row.data.value))
    if (!meta.success) throw new CursorImportError("The Cursor session store's meta row names no root blob.")
    return meta.data
  } catch (error) {
    if (error instanceof CursorImportError) throw error
    throw new CursorImportError(
      `The Cursor session store could not be read: ${error instanceof Error ? error.message : String(error)}`
    )
  } finally {
    database?.close()
  }
}

/** Copy the legacy store, WAL folded in, to where the SDK will look for `agentId`. */
export function copyLegacyStore(sourcePath: string, stateRoot: string, agentId: string): string {
  const target = cursorSdkStorePath(stateRoot, agentId)
  mkdirSync(dirname(target), { recursive: true })
  // A half-finished earlier import leaves a store with no index row; replace it.
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${target}${suffix}`, { force: true })
  let source: DatabaseSync | undefined
  try {
    source = new DatabaseSync(sourcePath, { readOnly: true })
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
  meta: LegacyStoreMeta
  now: number
}): ImportedAgentDocument {
  const record: CursorSdkImport = {
    path: input.source.path,
    identity: input.source.identity,
    agentId: input.meta.agentId ?? input.agentId,
  }
  const sdkMetadata: ImportedSdkMetadata = { [CURSOR_SDK_IMPORT_METADATA_KEY]: record }
  if (input.meta.blobEncryptionKey) sdkMetadata.blobEncryptionKey = input.meta.blobEncryptionKey
  const name = input.source.name ?? (input.meta.name && input.meta.name !== "New Agent" ? input.meta.name : undefined)
  return {
    agentId: input.agentId,
    cwd: input.source.cwd ?? "",
    name: name ?? null,
    createdAt: epochOf(input.meta.createdAt, input.now),
    latestRootBlobId: input.meta.latestRootBlobId,
    sdkMetadata,
  }
}

/** An agent the index already has, as far as the import cares. */
export interface KnownAgent {
  agentId: string
  importedFrom?: string
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
}

export function resolveImportAgentId(
  requested: string,
  sourcePath: string,
  known: readonly KnownAgent[]
): ImportAgentTarget {
  const byPath = known.find((agent) => agent.importedFrom === sourcePath)
  if (byPath) return { agentId: byPath.agentId, existing: true }
  const held = known.find((agent) => agent.agentId === requested)
  if (!held) return { agentId: requested, existing: false }
  return { agentId: randomUUID(), existing: false }
}
