import { closeSync, constants, mkdirSync, openSync, unlinkSync } from "node:fs"
import { open, readdir, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, join, relative } from "node:path"
import { z } from "zod"
import type { SessionRecords } from "./harness-records.js"
import { onMac } from "./platform.js"
import { processStart } from "./record-locks.js"

/**
 * The second truth beside a harness's records: the frames each of Mako's
 * drivers received from its harness, before any decoding, as
 * `packages/host/src/harnesses/native-stream.ts` writes them. One file per
 * launch, `<records>/streams/<harness>/<native id>@<launch>.jsonl`, captured
 * into the record store as a unit of its session with the harness's records.
 * A launch that hasn't learned its native id yet writes
 * `<harness>/<launch>.jsonl` and renames it once it has. Every harness's
 * streams share one folder, so watching them costs one watch per harness.
 */
export const STREAMS = "streams"
/** The root the record store names stream paths by (`mako-streams:claude/…`). */
export const STREAMS_ROOT = "mako-streams"
/** Never in an encoded native id, so it ends one. */
const BOUND = "@"

/** Where Mako keeps the record store on this machine; the daemon, the catalog worker and the drivers all use it. */
export function makoRecords(home = homedir()): string {
  return join(home, ".mako", "records")
}

export function streamsRoot(records: string): string {
  return join(records, STREAMS)
}

/** The file a launch's stream goes to: `launch` alone until the harness names the session. */
export function streamPath(root: string, harness: string, launch: string, nativeId?: string): string {
  return join(root, harness, nativeId ? `${encodeURIComponent(nativeId)}${BOUND}${launch}` : launch)
}

/** The session a stream file is of; null for a launch not yet bound, or a path that isn't a stream. */
export function streamOwner(root: string, path: string): { harness: string; nativeId: string } | null {
  const harness = relative(root, dirname(path))
  const name = basename(path)
  const end = name.indexOf(BOUND)
  if (!harness || harness.startsWith("..") || harness.includes("/") || harness.includes("\\") || end <= 0) return null
  try {
    return { harness, nativeId: decodeURIComponent(name.slice(0, end)) }
  } catch {
    return null
  }
}

/** Each of a session's stream files, oldest launch first. */
export async function streamsOf(root: string, harness: string, nativeId: string): Promise<string[]> {
  if (!nativeId) return []
  const prefix = `${encodeURIComponent(nativeId)}${BOUND}`
  const names = await readdir(join(root, harness)).catch(() => [])
  return names.filter((name) => name.startsWith(prefix)).sort().map((name) => join(root, harness, name))
}

/**
 * Each harness folder's streams by session, listed again only when the
 * folder changed: a stream growing doesn't change it, a launch starting or
 * learning its session does. A capture that runs every quarter second while
 * a reply streams costs a `stat`, however many streams the folder holds.
 */
export class StreamListings {
  private readonly folders = new Map<string, { changed: bigint; sessions: Map<string, string[]> }>()

  constructor(readonly root: string) {}

  async of(harness: string, nativeId: string): Promise<string[]> {
    if (!nativeId) return []
    const folder = join(this.root, harness)
    const info = await stat(folder, { bigint: true }).catch(() => null)
    if (!info) {
      this.folders.delete(folder)
      return []
    }
    let listing = this.folders.get(folder)
    if (listing?.changed !== info.mtimeNs) {
      const sessions = new Map<string, string[]>()
      for (const name of (await readdir(folder)).sort()) {
        const end = name.indexOf(BOUND)
        if (end <= 0) continue
        const id = name.slice(0, end)
        const files = sessions.get(id)
        if (files) files.push(join(folder, name))
        else sessions.set(id, [join(folder, name)])
      }
      listing = { changed: info.mtimeNs, sessions }
      this.folders.set(folder, listing)
    }
    return listing.sessions.get(encodeURIComponent(nativeId)) ?? []
  }
}

/** `records` with `files`, streams under `root`, among its files and their root among its roots. */
export function withStreams(records: SessionRecords, root: string, files: readonly string[]): SessionRecords {
  if (!files.length) return records
  return { ...records, roots: [...records.roots, { name: STREAMS_ROOT, path: root }], files: [...records.files, ...files] }
}

export interface StreamFiles {
  /** Each bound file with the session it is of. */
  sessions: { harness: string; nativeId: string; path: string }[]
  /** Files of launches that never learned their native id: a launch that failed before the harness named its session. */
  unbound: string[]
}

/** Every stream file under `root`, for a report of the streams no known session holds. */
export async function streamFiles(root: string): Promise<StreamFiles> {
  const found: StreamFiles = { sessions: [], unbound: [] }
  for (const harness of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!harness.isDirectory()) continue
    for (const name of (await readdir(join(root, harness.name))).sort()) {
      const path = join(root, harness.name, name)
      const owner = streamOwner(root, path)
      if (owner) found.sessions.push({ ...owner, path })
      else found.unbound.push(path)
    }
  }
  return found
}

/**
 * The process that writes a stream, as the stream's header names it
 * (`writer`). A stream is finished once its writer is gone: the driver
 * appends with a fresh open each time, so a file removed under a live
 * launch would come back holding only what followed, at the wrong offsets.
 */
export const StreamWriterSchema = z.object({
  id: z.string().regex(/^[\w-]{1,64}$/),
  pid: z.number().int().positive(),
  /** When the process started, where the platform says (Linux's /proc): with the pid, one process, not whoever the kernel gave the pid to since. */
  start: z.number().optional(),
})
export type StreamWriter = z.infer<typeof StreamWriterSchema>

/** BSD's open(2) flag for an exclusive lock taken with the open; Node passes it through but doesn't name it. */
const O_EXLOCK = 0x20

/** Where a writer of the streams under `root` holds its lock: beside the streams, not among them. */
export function streamWriterLock(root: string, id: string): string {
  return join(dirname(root), "stream-writers", `${id}.lock`)
}

/**
 * This process as the writer of streams under `root`: its pid and when it
 * started, which no other process shares. On macOS the kernel holds an
 * `O_EXLOCK` lock on `streamWriterLock` for the process and drops it however
 * the process ends, so liveness needs no clock. The first launch takes it
 * and keeps it open; a later one finds it held, by this process, which is
 * the claim. Elsewhere the pid answers, with its start time on Linux, so a
 * pid the kernel reused for another process doesn't read as the writer; on
 * Windows a reused pid reads as alive, which only keeps a file longer. Null
 * when the lock can't be made: a stream that names no writer is never
 * pruned by this rule.
 */
export function claimStreamWriter(root: string): StreamWriter | null {
  const writer: StreamWriter = { id: `${process.pid}-${Math.round(performance.timeOrigin)}`, pid: process.pid }
  if (!onMac()) {
    const start = processStart(process.pid)
    return start === null ? writer : { ...writer, start }
  }
  const path = streamWriterLock(root, writer.id)
  try {
    mkdirSync(dirname(path), { recursive: true })
    // Never closed: the lock is the process's for as long as it lives.
    openSync(path, constants.O_RDWR | constants.O_CREAT | O_EXLOCK | constants.O_NONBLOCK, 0o600)
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined
    if (code !== "EAGAIN" && code !== "EWOULDBLOCK") return null
  }
  return writer
}

/**
 * Whether `writer` has ended, so a stream it names gets no more lines. A
 * lock taken here means its process is gone: the lock file is removed then,
 * and a later check finds none, which says the same.
 */
export function streamWriterGone(root: string, writer: StreamWriter): boolean {
  if (!onMac()) {
    try {
      process.kill(writer.pid, 0)
    } catch (error) {
      // EPERM: another user's process holds the pid, which isn't the writer when its start differs.
      if (error instanceof Error && "code" in error && error.code === "ESRCH") return true
    }
    return writer.start !== undefined && processStart(writer.pid) !== writer.start
  }
  const path = streamWriterLock(root, writer.id)
  let fd: number
  try {
    fd = openSync(path, constants.O_RDWR | O_EXLOCK | constants.O_NONBLOCK)
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT"
  }
  try {
    unlinkSync(path)
  } catch {
    // Another pruner removed it first; it found the writer gone too.
  } finally {
    closeSync(fd)
  }
  return true
}

const StreamHeaderSchema = z.object({ capture: z.number(), writer: StreamWriterSchema.optional() })
/** A header names the driver's session settings; none comes near this. */
const HEADER_LIMIT = 256 * 1024

/** The writer a stream's header names; null for a stream from before writers were named, or one whose header can't be read. */
export async function streamWriterOf(path: string): Promise<StreamWriter | null> {
  const handle = await open(path, "r").catch(() => null)
  if (!handle) return null
  try {
    const buffer = Buffer.alloc(HEADER_LIMIT)
    const { bytesRead } = await handle.read(buffer, 0, HEADER_LIMIT, 0)
    const end = buffer.subarray(0, bytesRead).indexOf(10)
    if (end < 0) return null
    const header = StreamHeaderSchema.safeParse(JSON.parse(buffer.subarray(0, end).toString("utf8")))
    return header.success ? header.data.writer ?? null : null
  } catch {
    return null
  } finally {
    await handle.close()
  }
}
