import { execFileSync } from "node:child_process"
import { constants, copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs"
import { dirname, isAbsolute, relative, resolve } from "node:path"
import type { DatabaseSync } from "node:sqlite"
import { z } from "zod"
import { cursorSdkIndexPath, cursorSdkStorePath } from "@mako/sessions/cursor-sdk-paths"
import { CURSOR_SDK_IMPORT_METADATA_KEY } from "@mako/sessions/cursor-sdk-index"
import type { NativeStores } from "@mako/sessions/read-only-sqlite"
import type { NativeForkSource } from "../../live-driver.js"
import { onMac } from "../../../base/platform.js"
import type { LocalAgentDocument } from "@cursor/sdk"

/** The SDK's own metadata on an agent's index row, which stores keep as they were given it. */
type SdkMetadata = NonNullable<LocalAgentDocument["sdkMetadata"]>

/**
 * Forking a Cursor SDK agent at a run, from the SDK's own records only.
 *
 * Cursor keeps a conversation as content-addressed blobs in the agent's
 * `store.db` and names its head, the root blob, in `index.db`. Every run
 * records the root it started from and the last one it checkpointed
 * (`runs.start_checkpoint_ref_json`, `runs.latest_checkpoint_ref_json`), and
 * the next run starts from exactly that root, so a run's latest checkpoint is
 * the conversation as it stood right after the run. Blobs are only ever added,
 * so the source's store still holds every blob that root names. A fork is
 * therefore a new agent whose store is a copy of the source's and whose index
 * row starts at that root; the SDK resumes it (`Agent.resume`) and goes on
 * from there as its own conversation, writing everything after. Verified
 * against SDK 1.0.31 (`scripts/test-cursor-fork.ts`).
 *
 * Mako writes no conversation into it: the copy's only change is its meta
 * row's `agentId`, the identity the SDK writes for an agent it creates, so no
 * store in the state root claims to be another agent (the catalog's removal
 * and listing fall back to that id for a store the index doesn't name).
 */

/** A run as the fork reads it: how it ended and the roots it started from and last checkpointed. */
export interface CursorForkRun {
  status: string
  start?: string
  latest?: string
}

export type CursorForkPoint = { kind: "root"; rootBlobId: string } | { kind: "declined"; reason: string }

const TERMINAL = new Set(["finished", "error", "cancelled", "expired"])

/** The root a fork at `run` starts from, or why Cursor's record of the run holds none. */
export function cursorForkPoint(run: CursorForkRun | undefined): CursorForkPoint {
  if (!run) return { kind: "declined", reason: "Cursor's index has no record of this run, so it names no state of the conversation to fork from." }
  if (!TERMINAL.has(run.status.toLowerCase()))
    return { kind: "declined", reason: "Cursor's index still records this run as running, so the conversation it left isn't final yet." }
  if (!run.latest || run.latest === run.start)
    return { kind: "declined", reason: "Cursor checkpointed nothing of this run (it stopped before its first checkpoint), so no root of Cursor's holds the turn to fork from." }
  return { kind: "root", rootBlobId: run.latest }
}

const CheckpointRefSchema = z.object({ blobId: z.string().min(1) })
const RunRowSchema = z.object({
  status: z.string(),
  start: z.string().nullable(),
  latest: z.string().nullable(),
})

function blobIdOf(raw: string | null): string | undefined {
  if (!raw) return undefined
  try {
    const parsed = CheckpointRefSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data.blobId : undefined
  } catch {
    return undefined
  }
}

/** The run's row in the state root's `index.db`, read-only. */
export function readCursorForkRun(stores: NativeStores, stateRoot: string, agentId: string, runId: string): CursorForkRun | undefined {
  let database: DatabaseSync | undefined
  try {
    database = stores.open(cursorSdkIndexPath(stateRoot), { timeout: 2_000 })
    const row = RunRowSchema.safeParse(database
      .prepare("SELECT status, start_checkpoint_ref_json AS start, latest_checkpoint_ref_json AS latest FROM runs WHERE run_id = ? AND agent_id = ?")
      .get(runId, agentId))
    if (!row.success) return undefined
    const run: CursorForkRun = { status: row.data.status }
    const start = blobIdOf(row.data.start)
    const latest = blobIdOf(row.data.latest)
    if (start) run.start = start
    if (latest) run.latest = latest
    return run
  } catch {
    return undefined
  } finally {
    database?.close()
  }
}

/** Why the SDK can't fork this agent at this run itself, so the fork goes as a transcript; undefined when it can. */
export function cursorForkDeclined(stores: NativeStores, stateRoot: string, source: NativeForkSource): string | undefined {
  if (stores.strict) return "This host opens Cursor's stores read-only, so it can't make the new agent a fork needs."
  const store = cursorSdkStorePath(stateRoot, source.nativeId)
  if (source.path !== undefined && source.path !== store)
    return "The conversation's store isn't an SDK agent in this host's Cursor state root."
  if (!existsSync(store)) return "The conversation's Cursor store is missing."
  const point = cursorForkPoint(readCursorForkRun(stores, stateRoot, source.nativeId, source.runId))
  return point.kind === "declined" ? point.reason : undefined
}

export class CursorForkError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CursorForkError"
  }
}

/**
 * Copies a file the way the platform clones one: APFS `clonefile(2)` through
 * `cp -c` (Node's `COPYFILE_FICLONE` copies the bytes on macOS), a reflink
 * where Linux has one. Either falls back to copying the bytes.
 */
function cloneFile(from: string, to: string): void {
  if (onMac()) execFileSync("/bin/cp", ["-c", "-n", from, to], { stdio: "ignore" })
  else copyFileSync(from, to, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL)
}

/** The meta row's JSON and how it was stored: hex text (the SDK's and `cursor-agent`'s), plain text or bytes. */
const MetaValueSchema = z.union([
  z.string().regex(/^[0-9a-f]+$/i).transform((raw) => ({ encoding: "hex" as const, text: Buffer.from(raw, "hex").toString("utf8") })),
  z.string().transform((raw) => ({ encoding: "text" as const, text: raw })),
  z.instanceof(Uint8Array).transform((raw) => ({ encoding: "bytes" as const, text: Buffer.from(raw).toString("utf8") })),
])
type MetaValue = z.output<typeof MetaValueSchema>
const MetaSchema = z.looseObject({ agentId: z.string().optional() })
const WalCheckpointSchema = z.object({ busy: z.number() })

/** The meta row naming `agentId` instead, in the encoding it came in. */
function metaNaming(value: MetaValue, agentId: string): string | Uint8Array {
  const renamed = JSON.stringify({ ...MetaSchema.parse(JSON.parse(value.text)), agentId })
  switch (value.encoding) {
    case "hex": return Buffer.from(renamed, "utf8").toString("hex")
    case "text": return renamed
    case "bytes": return new Uint8Array(Buffer.from(renamed, "utf8"))
  }
}

/**
 * Makes the fork's store: a clone of the source's under the fork's folder,
 * holding `rootBlobId`, its meta row naming the fork.
 *
 * The source may be running a turn while it is cloned, so the clone is taken
 * inside a read transaction on it: while that lasts SQLite neither resets the
 * WAL nor checkpoints past it, so every frame the main file's clone may lack
 * is still in the WAL cloned after it, and opening the clone recovers it. A
 * torn last frame fails its checksum and is dropped with its transaction,
 * which only ever adds blobs. The clone is made under a staging name and
 * moved into place whole, so a crash leaves no `store.db` the index doesn't
 * know, and nothing existing is overwritten.
 */
export function cloneCursorForkStore(stores: NativeStores, fork: { source: string; target: string; agentId: string; rootBlobId: string }): void {
  const { source, target, rootBlobId } = fork
  refuseUnlessOwn(stores, target)
  if (existsSync(target)) throw new CursorForkError("The fork's Cursor agent already has a store; nothing was overwritten.")
  const staged = `${target}.forking`
  mkdirSync(dirname(target), { recursive: true })
  const discard = () => {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(`${staged}${suffix}`, { force: true })
  }
  discard()
  let reader: DatabaseSync | undefined
  try {
    reader = stores.open(source, { timeout: 5_000 })
    reader.exec("BEGIN")
    if (!reader.prepare("SELECT 1 AS held FROM blobs WHERE id = ?").get(rootBlobId))
      throw new CursorForkError("The source's Cursor store doesn't hold the root this run checkpointed.")
    cloneFile(source, staged)
    const wal = `${source}-wal`
    if (existsSync(wal) && statSync(wal).size > 0) cloneFile(wal, `${staged}-wal`)
    reader.exec("COMMIT")
  } catch (error) {
    discard()
    throw error instanceof CursorForkError ? error : new CursorForkError(`The Cursor agent's store could not be cloned: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    reader?.close()
  }
  let copy: DatabaseSync | undefined
  try {
    copy = stores.openForWriting(staged)
    if (!copy.prepare("SELECT 1 AS held FROM blobs WHERE id = ?").get(rootBlobId))
      throw new CursorForkError("The cloned Cursor store lost the root it was cloned for.")
    const row = copy.prepare("SELECT value FROM meta WHERE key = '0'").get()
    const value = MetaValueSchema.safeParse(row?.["value"])
    if (value.success) copy.prepare("UPDATE meta SET value = ? WHERE key = '0'").run(metaNaming(value.data, fork.agentId))
    // Everything into the main file, so the one file moved into place is the whole store.
    const checkpoint = WalCheckpointSchema.parse(copy.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get())
    if (checkpoint.busy !== 0) throw new CursorForkError("The cloned Cursor store could not be folded into one file.")
    copy.close()
    copy = undefined
    if (existsSync(`${staged}-wal`) && statSync(`${staged}-wal`).size > 0)
      throw new CursorForkError("The cloned Cursor store kept part of itself in its WAL.")
    for (const suffix of ["-wal", "-shm"]) rmSync(`${staged}${suffix}`, { force: true })
    renameSync(staged, target)
  } catch (error) {
    copy?.close()
    discard()
    throw error instanceof CursorForkError ? error : new CursorForkError(`The fork's Cursor store could not be prepared: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** A strict host writes no harness store but its own folder's (`NativeStores.openForWriting`), checked before anything is cloned. */
function refuseUnlessOwn(stores: NativeStores, target: string): void {
  const inside = stores.ownFolder === undefined ? undefined : relative(stores.ownFolder, resolve(target))
  if (inside === undefined || inside.startsWith("..") || isAbsolute(inside)) stores.refuseWrite("Cursor's agent stores")
}

/**
 * The fork's `sdkMetadata`: the source's, which carries the blob key its
 * blobs are read with, without Mako's import record, which names the
 * `cursor-agent` row the source came from and would fold the fork onto it.
 */
export function cursorForkMetadata(source: SdkMetadata | undefined): SdkMetadata | undefined {
  if (!source) return undefined
  return Object.fromEntries(Object.entries(source).filter(([key]) => key !== CURSOR_SDK_IMPORT_METADATA_KEY))
}
