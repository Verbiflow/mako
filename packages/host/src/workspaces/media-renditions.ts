import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import type { FileIdentity } from "./file-previews.js"

/** A smaller picture of a file: a video's poster frame, or an image a grid tile draws. */
export type RenditionKind = "poster" | "thumbnail"

/** The longer side of each, in pixels: a poster fills a 32rem player at 2x, a tile a third of the column. */
const SIDE = { poster: 1280, thumbnail: 640 } as const satisfies Record<RenditionKind, number>
/** One ffmpeg at a time per kind keeps a gallery of forty recordings from starting forty encoders. */
const CONCURRENT = 2
const RENDER_TIMEOUT_MS = 15_000
/** Renditions kept on disk, newest first; each is tens of kilobytes. */
const KEPT = 2_000
const PRUNE_EVERY_MS = 10 * 60_000

export interface MediaRenditionsOptions {
  /** Where renditions are kept, as `<key>.<ext>`. */
  folder: string
  /** The ffmpeg Mako records with; throws when there is none. */
  ffmpeg(): string
}

/**
 * Posters and thumbnails, made once per file version with the ffmpeg Mako
 * already ships for recordings, and kept by the file's identity, so a file
 * the agent rewrites gets a new one and an unchanged file never runs ffmpeg
 * twice. Made only when a preview asks for one, which it does only near
 * the viewport.
 */
export class MediaRenditions {
  private readonly folder: string
  private readonly ffmpeg: () => string
  private readonly making = new Map<string, Promise<string | null>>()
  private readonly waiting: (() => void)[] = []
  private running = 0
  private prunedAt = 0

  constructor(options: MediaRenditionsOptions) {
    this.folder = options.folder
    this.ffmpeg = options.ffmpeg
  }

  /** The rendition's path, or null when this file can't have one (no ffmpeg, no video frame, an unreadable file). */
  rendition(path: string, identity: FileIdentity, kind: RenditionKind): Promise<string | null> {
    const key = createHash("sha256").update(JSON.stringify([kind, path, identity.dev, identity.ino, identity.size, Math.round(identity.mtimeMs)])).digest("hex").slice(0, 40)
    const target = join(this.folder, `${key}.${kind === "poster" ? "jpg" : "png"}`)
    const known = this.making.get(target)
    if (known) return known
    const made = this.make(path, target, kind).finally(() => this.making.delete(target))
    this.making.set(target, made)
    return made
  }

  private async make(path: string, target: string, kind: RenditionKind): Promise<string | null> {
    if (await stat(target).then((info) => info.size > 0, () => false)) return target
    let executable: string
    try {
      executable = this.ffmpeg()
    } catch {
      return null
    }
    await mkdir(this.folder, { recursive: true })
    await this.turn()
    const partial = `${target}.${process.pid}.partial`
    try {
      const side = SIDE[kind]
      const scale = `scale=w='min(${side},iw)':h='min(${side},ih)':force_original_aspect_ratio=decrease`
      // A poster half a second in skips the black first frame most recordings open on; a clip shorter than that takes its first.
      const attempts = kind === "poster" ? [["-ss", "0.5"], []] : [[]]
      for (const seek of attempts) {
        const ok = await run(executable, ["-v", "error", "-nostdin", ...seek, "-i", path, "-frames:v", "1", "-vf", scale,
          ...(kind === "poster" ? ["-q:v", "4", "-f", "mjpeg"] : ["-f", "image2", "-c:v", "png"]), "-y", partial])
        if (ok && await stat(partial).then((info) => info.size > 0, () => false)) {
          await rename(partial, target)
          void this.prune()
          return target
        }
      }
      return null
    } finally {
      await rm(partial, { force: true })
      this.release()
    }
  }

  private async turn(): Promise<void> {
    if (this.running < CONCURRENT) {
      this.running += 1
      return
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve))
  }

  private release(): void {
    const next = this.waiting.shift()
    if (next) next()
    else this.running -= 1
  }

  private async prune(): Promise<void> {
    const now = Date.now()
    if (now - this.prunedAt < PRUNE_EVERY_MS) return
    this.prunedAt = now
    const names = await readdir(this.folder).catch(() => [])
    if (names.length <= KEPT) return
    const dated = await Promise.all(names.map(async (name) => ({ name, at: await stat(join(this.folder, name)).then((info) => info.mtimeMs, () => 0) })))
    dated.sort((a, b) => b.at - a.at)
    await Promise.all(dated.slice(KEPT).map(({ name }) => rm(join(this.folder, name), { force: true })))
  }
}

function run(executable: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(executable, args, { timeout: RENDER_TIMEOUT_MS, maxBuffer: 64 * 1024 }, (error) => resolve(!error))
  })
}
