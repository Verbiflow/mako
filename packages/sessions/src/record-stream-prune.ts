import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { open, rm, stat } from "node:fs/promises"
import { relative } from "node:path"
import { z } from "zod"
import { streamsStamp } from "./record-capture.js"
import type { RecordStore } from "./record-store.js"
import { STREAMS_ROOT, streamFiles, streamWriterGone, streamWriterOf, type StreamWriter } from "./record-streams.js"

/**
 * Loose stream files the record store holds whole, removed.
 *
 * A stream's file (`record-streams.ts`) is captured into the store as a unit
 * of its session, appended to as it grows. Once its launch is over and the
 * store holds every byte of it, the file is a second copy, and goes. The
 * rule, per file:
 *
 * - **its launch is over.** Its last line is `ended`, which the driver
 *   writes once the launch's process exits or its SDK stream ends
 *   (`NativeStream.ended`), and after which the writer never makes the file
 *   again. A host that crashed wrote no `ended`: then the header's writer
 *   (`claimStreamWriter`) being gone says the same. A file with neither, from
 *   before streams named their writer, is never removed.
 * - **the store holds it whole:** the unit's newest version is the file's
 *   size, and the bytes the store gives back hash as the file does.
 * - **it didn't change while it was checked.**
 *
 * Pruning moves the session's stamp (its streams' names and sizes), not
 * what the store holds, so the held stamp is moved with it
 * (`RecordStore.restamp`) and no capture follows.
 *
 * The session doesn't matter: one its harness deleted keeps its held stream
 * units (the store never forgets what a harness dropped), so its loose files
 * go by the same rule. One the person deleted in Mako loses its files and
 * units at once (`RecordCapture.forget`). A launch that never learned its
 * session is no unit of any, and stays.
 */

export interface PruneReport {
  /** Stream files bound to a session. */
  files: number
  pruned: number
  /** Of those, the files whose own last line said the launch ended; the rest were found finished because their writer was gone. */
  prunedEnded: number
  /** Bytes the pruned files took on disk. */
  bytes: number
  /** Sessions whose held stamp took the pruning in place, so no capture follows it. */
  restamped: number
  /** Files a running launch may still append to. */
  live: number
  /** Files with no `ended` line and from before streams named their writer. */
  unnamed: number
  /** Files the store doesn't hold at their size yet. */
  notHeld: number
  /** Files the store holds at their size whose bytes hash otherwise: kept, and reported. */
  differs: string[]
  /** Launches never bound to a session. */
  unbound: number
  ms: number
}

/** What a prune remembers between passes: a header never changes, and a verdict holds while the file doesn't. */
export class PruneMemory {
  readonly writers = new Map<string, StreamWriter | null>()
  readonly differs = new Map<string, string>()
}

/** A stream line that says the launch's transport is gone (`NativeStream.ended`). */
const EndedSchema = z.object({ ended: z.literal(true) })
/** The `ended` line is a timestamp and a flag; the last line of a file is read from this far back. */
const TAIL = 512

export async function pruneStreams(store: RecordStore, root: string, memory = new PruneMemory()): Promise<PruneReport> {
  const started = Date.now()
  const found = await streamFiles(root)
  const report: PruneReport = { files: found.sessions.length, pruned: 0, prunedEnded: 0, bytes: 0, restamped: 0, live: 0, unnamed: 0, notHeld: 0, differs: [], unbound: found.unbound.length, ms: 0 }
  const gone = new Map<string, boolean>()
  const listed = new Set(found.sessions.map((file) => file.path))
  for (const path of memory.writers.keys()) if (!listed.has(path)) memory.writers.delete(path)
  // A session's files in the order the folder lists them, the order its stamp digests them in.
  const sessions = new Map<string, { harness: string; nativeId: string; files: string[] }>()
  for (const file of found.sessions) {
    const key = `${file.harness}\n${file.nativeId}`
    const session = sessions.get(key)
    if (session) session.files.push(file.path)
    else sessions.set(key, { harness: file.harness, nativeId: file.nativeId, files: [file.path] })
  }
  for (const { harness, nativeId, files } of sessions.values()) {
    const before = await streamsStamp(files)
    const units = new Map(store.units(harness, nativeId).map((unit) => [unit.key, unit]))
    const pruned: string[] = []
    for (const path of files) {
      const info = await stat(path).catch(() => null)
      if (!info) continue
      let finished = await endedLine(path, info.size)
      if (!finished) {
        let writer = memory.writers.get(path)
        if (writer === undefined) memory.writers.set(path, writer = await streamWriterOf(path))
        if (!writer) {
          report.unnamed += 1
          continue
        }
        let ended = gone.get(writer.id)
        if (ended === undefined) gone.set(writer.id, ended = streamWriterGone(root, writer))
        if (!ended) {
          report.live += 1
          continue
        }
      }
      const key = `${STREAMS_ROOT}:${relative(root, path)}`
      const unit = units.get(key)
      if (!unit || unit.kind === "delete" || unit.size !== info.size) {
        report.notHeld += 1
        continue
      }
      const stamp = `${info.size}\t${info.mtimeMs}\t${info.ino}`
      if (memory.differs.get(path) === stamp) {
        report.differs.push(path)
        continue
      }
      const [loose, kept] = await Promise.all([fileDigest(path), storeDigest(store, harness, key)])
      const after = await stat(path).catch(() => null)
      if (!after || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ino !== info.ino) continue
      if (!loose.equals(kept)) {
        memory.differs.set(path, stamp)
        report.differs.push(path)
        continue
      }
      await rm(path, { force: true })
      memory.writers.delete(path)
      pruned.push(path)
      report.pruned += 1
      if (finished) report.prunedEnded += 1
      report.bytes += info.size
    }
    if (!pruned.length) continue
    // The store holds what it did; only what the stamp says of the streams moved. A capture that ran meanwhile kept a stamp of its own, and the compare leaves it.
    const held = store.heldStamp(harness, nativeId)
    const remaining = files.filter((path) => !pruned.includes(path))
    if (held?.endsWith(before) && (await store.restamp(harness, nativeId, held, `${held.slice(0, held.length - before.length)}${await streamsStamp(remaining)}`)))
      report.restamped += 1
  }
  report.ms = Date.now() - started
  return report
}

/** Whether the file's last line says its launch ended: the one line nothing follows. */
async function endedLine(path: string, size: number): Promise<boolean> {
  const handle = await open(path, "r").catch(() => null)
  if (!handle) return false
  try {
    const from = Math.max(0, size - TAIL)
    const buffer = Buffer.alloc(size - from)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, from)
    const text = buffer.subarray(0, bytesRead).toString("utf8")
    if (!text.endsWith("\n")) return false
    const last = text.slice(text.lastIndexOf("\n", text.length - 2) + 1, -1)
    try {
      return EndedSchema.safeParse(JSON.parse(last)).success
    } catch {
      return false
    }
  } finally {
    await handle.close()
  }
}

async function fileDigest(path: string): Promise<Buffer> {
  const digest = createHash("sha256")
  for await (const bytes of createReadStream(path, { highWaterMark: 1024 * 1024 })) digest.update(bytes)
  return digest.digest()
}

async function storeDigest(store: RecordStore, harness: string, key: string): Promise<Buffer> {
  const digest = createHash("sha256")
  for await (const bytes of store.content(harness, key)) digest.update(bytes)
  return digest.digest()
}
