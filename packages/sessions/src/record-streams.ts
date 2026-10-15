import { readdir, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, join, relative } from "node:path"
import type { SessionRecords } from "./harness-records.js"

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
