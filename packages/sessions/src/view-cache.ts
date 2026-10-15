import { createHash, randomUUID } from "node:crypto"
import { mkdir, open, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { constants, zstdCompress, zstdDecompress } from "node:zlib"
import { z } from "zod"
import type { Thread } from "./format.js"
import { ThreadSchema } from "./thread-schema.js"

const compress = promisify(zstdCompress)
const decompress = promisify(zstdDecompress)

/** Where Mako keeps decoded sessions on this machine, beside the records they're decoded from. */
export function makoViews(home = homedir()): string {
  return join(home, ".mako", "views")
}

/** What the cache holds at most, compressed; the views read longest ago go first. */
export const VIEW_CACHE_BYTES = 512 * 1024 * 1024
/**
 * A session that decodes faster than this isn't worth a file. A view reads
 * back in 0.3 to 3 ms, and a decode measured warm runs at about half its
 * cold time, so a session that decodes in 30 ms here costs 40 to 60 at launch.
 */
export const VIEW_MIN_DECODE_MS = 10
const MAGIC = "MAKOVIEW1\n"
const EXTENSION = ".view"
/** Enough for any header: a path, a stamp and a build hash. */
const HEAD_BYTES = 16 * 1024

/** The native file a view was decoded from, as the catalog stamps it. */
export interface ViewStamp {
  bytes: number
  mtimeMs: number
  revision?: string
}

const HeaderSchema = z.object({
  path: z.string(),
  bytes: z.number(),
  mtimeMs: z.number(),
  revision: z.string().optional(),
  translator: z.string(),
  decodeMs: z.number(),
  at: z.number(),
})
type ViewHeader = z.infer<typeof HeaderSchema>

export interface ViewCacheStats {
  views: number
  bytes: number
}

/** A view on disk, without its thread. */
export type ViewSummary = ViewHeader & { file: string; size: number; usedAt: number }

/**
 * Sessions as this build decodes them, so reading one again needn't decode
 * it again: a large Cursor agent takes seconds to decode and tens of
 * milliseconds to read back. A view is only a cache of its native file. It
 * is used while the file's stamp and the decoder build both match the ones
 * it was made from, and deleting any or all of them is always safe.
 */
export class ViewCache {
  private writes: Promise<void> = Promise.resolve()

  constructor(
    private readonly folder: string,
    private readonly translator: () => string,
    private readonly budget = VIEW_CACHE_BYTES
  ) {}

  /** The view of `path` made from exactly `stamp` by this build; null otherwise. */
  async read(path: string, stamp: ViewStamp): Promise<Thread | null> {
    return (await this.made(path, stamp, true))?.thread ?? null
  }

  /** The view of `path` made from exactly `stamp` by whichever build made it, and that build's `translatorBuild()`. */
  async readAny(path: string, stamp: ViewStamp): Promise<{ thread: Thread; translator: string } | null> {
    return this.made(path, stamp, false)
  }

  private async made(path: string, stamp: ViewStamp, current: boolean): Promise<{ thread: Thread; translator: string } | null> {
    const file = this.file(path)
    const bytes = await readFile(file).catch(() => null)
    if (!bytes) return null
    const parsed = parseView(bytes)
    if (!parsed) {
      await rm(file, { force: true })
      return null
    }
    const { header, body } = parsed
    if (header.path !== path || (current && header.translator !== this.translator()) || !sameStamp(header, stamp)) return null
    try {
      const thread = ThreadSchema.parse(JSON.parse((await decompress(body)).toString("utf8")))
      const now = new Date()
      await utimes(file, now, now).catch(() => undefined)
      return { thread, translator: header.translator }
    } catch {
      await rm(file, { force: true })
      return null
    }
  }

  /** Keeps `thread`, decoded from `stamp` in `decodeMs`, once the writes before it are done. */
  write(path: string, stamp: ViewStamp, thread: Thread, decodeMs: number): Promise<void> {
    const header: ViewHeader = {
      path, bytes: stamp.bytes, mtimeMs: stamp.mtimeMs, translator: this.translator(), decodeMs: Math.round(decodeMs), at: Date.now(),
    }
    if (stamp.revision !== undefined) header.revision = stamp.revision
    const run = this.writes.then(() => this.writeNow(header, thread))
    this.writes = run.catch(() => undefined)
    return run
  }

  async remove(path: string): Promise<void> {
    await this.writes
    await rm(this.file(path), { force: true })
  }

  /** Every view on disk, newest use first. */
  async list(): Promise<ViewSummary[]> {
    const views: ViewSummary[] = []
    for (const name of await readdir(this.folder).catch(() => [])) {
      if (!name.endsWith(EXTENSION)) continue
      const file = join(this.folder, name)
      const [head, info] = await Promise.all([readHead(file), stat(file).catch(() => null)])
      const parsed = head && parseView(head)
      if (parsed && info) views.push({ ...parsed.header, file, size: info.size, usedAt: info.mtimeMs })
    }
    return views.sort((a, b) => b.usedAt - a.usedAt)
  }

  async stats(): Promise<ViewCacheStats> {
    let views = 0
    let bytes = 0
    for (const { size } of await this.files()) {
      views++
      bytes += size
    }
    return { views, bytes }
  }

  /** Resolves once every write asked for so far is on disk. */
  settled(): Promise<void> {
    return this.writes
  }

  private async writeNow(header: ViewHeader, thread: Thread): Promise<void> {
    const body = await compress(Buffer.from(JSON.stringify(thread)), { params: { [constants.ZSTD_c_compressionLevel]: 3 } })
    await mkdir(this.folder, { recursive: true })
    const file = this.file(header.path)
    const temporary = `${file}.${randomUUID()}.tmp`
    await writeFile(temporary, Buffer.concat([Buffer.from(`${MAGIC}${JSON.stringify(header)}\n`), body]), { mode: 0o600 })
    await rename(temporary, file)
    await this.evict()
  }

  private async evict(): Promise<void> {
    const files = await this.files()
    let total = files.reduce((sum, file) => sum + file.size, 0)
    for (const file of files.sort((a, b) => a.usedAt - b.usedAt)) {
      if (total <= this.budget) return
      await rm(file.path, { force: true })
      total -= file.size
    }
  }

  private async files(): Promise<{ path: string; size: number; usedAt: number }[]> {
    const names = await readdir(this.folder).catch(() => [])
    const files = await Promise.all(names.filter((name) => name.endsWith(EXTENSION)).map(async (name) => {
      const path = join(this.folder, name)
      const info = await stat(path).catch(() => null)
      return info ? { path, size: info.size, usedAt: info.mtimeMs } : null
    }))
    return files.filter((file) => file !== null)
  }

  private file(path: string): string {
    return join(this.folder, `${createHash("sha256").update(path).digest("hex").slice(0, 40)}${EXTENSION}`)
  }
}

async function readHead(file: string): Promise<Buffer | null> {
  const handle = await open(file, "r").catch(() => null)
  if (!handle) return null
  try {
    const head = Buffer.alloc(HEAD_BYTES)
    const { bytesRead } = await handle.read(head, 0, HEAD_BYTES, 0)
    return head.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

function parseView(bytes: Buffer): { header: ViewHeader; body: Buffer } | null {
  if (bytes.subarray(0, MAGIC.length).toString("utf8") !== MAGIC) return null
  const end = bytes.indexOf(0x0a, MAGIC.length)
  if (end < 0) return null
  try {
    const header = HeaderSchema.parse(JSON.parse(bytes.subarray(MAGIC.length, end).toString("utf8")))
    return { header, body: bytes.subarray(end + 1) }
  } catch {
    return null
  }
}

function sameStamp(header: ViewHeader, stamp: ViewStamp): boolean {
  return header.bytes === stamp.bytes && header.mtimeMs === stamp.mtimeMs && header.revision === stamp.revision
}
