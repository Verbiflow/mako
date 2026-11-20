import { fileSha256 } from "../base/file-hash.js"
import { findExecutable } from "../base/executable.js"
import { heavy } from "../base/heavy-packages.js"
import { hostExecFile } from "../base/host-command.js"
import { createHash } from "node:crypto"
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import type { FileIdentity } from "./file-previews.js"

/** A smaller picture of a file: a video's poster frame, an image a grid tile draws, or one drawn alone in the column. */
export type RenditionKind = "poster" | "thumbnail" | "inline"

/** Which rendition a URL's `?rendition=` asks for; anything else asks for the file. */
export function renditionKind(asked: string | null): RenditionKind | undefined {
  return asked === "poster" || asked === "thumbnail" || asked === "inline" ? asked : undefined
}

/**
 * The longer side of each, in pixels: a poster fills a 32rem player at 2x, a tile a third of the column, and a
 * picture alone its 30rem box at 3x (`INLINE_RENDITION_SIDE` in the window's `transcript-media.ts` is the same number).
 */
const SIDE = { poster: 1280, thumbnail: 640, inline: 1440 } as const satisfies Record<RenditionKind, number>
/** Two at a time keeps a gallery of forty recordings from starting forty decoders. */
const CONCURRENT = 2
const RENDER_TIMEOUT_MS = 15_000
/** Renditions kept on disk, newest first; each is tens of kilobytes. */
const KEPT = 2_000
const PRUNE_EVERY_MS = 10 * 60_000
/** A picture up to this size is kept by what it holds; a larger one, and any video, by which file it is. */
const HASHED_BELOW = 64 * 1024 * 1024
/** Pictures whose hash is remembered by which file they are, so a rendition asked for again reads none of it. */
const HASHES_KEPT = 512

/**
 * An FFmpeg already on this machine's PATH, looked for off the thread; none where there isn't one. Mako ships none: the
 * desktop app and a browser draw a video's own frame where it has no poster.
 */
export async function pathFfmpeg(): Promise<string | undefined> {
  return (await findExecutable("ffmpeg")) ?? undefined
}

/** Whether a video read here gets a poster (`posterUrl`): only where FFmpeg is on PATH to take its frame. */
export async function videoPosters(): Promise<boolean> {
  return Boolean(await pathFfmpeg())
}

export interface MediaRenditionsOptions {
  /** Where renditions are kept, as `<key>.<ext>`. */
  folder: string
  /** The FFmpeg a video's poster is taken with (`pathFfmpeg`); none for no posters. */
  ffmpeg?(): Promise<string | undefined>
}

/**
 * Posters and thumbnails, made once. A picture's are scaled with sharp and
 * kept by its content's hash, so the copies Mako makes of one attachment (the
 * staged file, the one a conversation keeps) share a rendition and a picture
 * sent again is never scaled twice; a video's poster is a frame FFmpeg takes
 * where one is on PATH, kept by the file's identity, since hashing a
 * recording costs more than its poster. Either way a file the agent rewrites
 * gets a new one. Made only when a preview asks for one, which it does only
 * near the viewport.
 */
export class MediaRenditions {
  private readonly folder: string
  private readonly ffmpeg: () => Promise<string | undefined>
  private readonly asking = new Map<string, Promise<string | null>>()
  private readonly making = new Map<string, Promise<string | null>>()
  private readonly hashes = new Map<string, string>()
  private readonly waiting: (() => void)[] = []
  private running = 0
  private prunedAt = 0

  constructor(options: MediaRenditionsOptions) {
    this.folder = options.folder
    this.ffmpeg = options.ffmpeg ?? pathFfmpeg
  }

  /** The rendition's path, or null when this file can't have one (no FFmpeg for a poster, no video frame, an unreadable file). */
  rendition(path: string, identity: FileIdentity, kind: RenditionKind): Promise<string | null> {
    const file = JSON.stringify([path, identity.dev, identity.ino, identity.size, Math.round(identity.mtimeMs)])
    const asked = `${kind}\0${file}`
    const known = this.asking.get(asked)
    if (known) return known
    const made = this.keyOf(path, file, identity, kind)
      .then((key) => (key ? this.once(path, join(this.folder, `${key}.${kind === "poster" ? "jpg" : "png"}`), kind) : null))
      .finally(() => this.asking.delete(asked))
    this.asking.set(asked, made)
    return made
  }

  /** What a rendition is kept by: its kind and the picture's hash, or the file's identity; null for a picture that can't be read. */
  private async keyOf(path: string, file: string, identity: FileIdentity, kind: RenditionKind): Promise<string | null> {
    const key = (of: string) => createHash("sha256").update(JSON.stringify([kind, of])).digest("hex").slice(0, 40)
    if (kind === "poster" || identity.size > HASHED_BELOW) return key(file)
    let digest = this.hashes.get(file)
    if (!digest) {
      try {
        digest = await fileSha256(path)
      } catch {
        return null
      }
      this.hashes.set(file, digest)
      if (this.hashes.size > HASHES_KEPT) {
        const oldest = this.hashes.keys().next().value
        if (oldest !== undefined) this.hashes.delete(oldest)
      }
    }
    return key(`sha256:${digest}`)
  }

  /** Two files holding one picture, asked for at once, wait on the same rendition. */
  private once(path: string, target: string, kind: RenditionKind): Promise<string | null> {
    const known = this.making.get(target)
    if (known) return known
    const made = this.make(path, target, kind).finally(() => this.making.delete(target))
    this.making.set(target, made)
    return made
  }

  private async make(path: string, target: string, kind: RenditionKind): Promise<string | null> {
    if (await stat(target).then((info) => info.size > 0, () => false)) return target
    const executable = kind === "poster" ? await this.ffmpeg() : undefined
    if (kind === "poster" && !executable) return null
    await mkdir(this.folder, { recursive: true })
    await this.turn()
    const partial = `${target}.${process.pid}.partial`
    try {
      const made = executable ? await poster(executable, path, partial) : await picture(path, partial, SIDE[kind])
      if (!made || !(await stat(partial).then((info) => info.size > 0, () => false))) return null
      await rename(partial, target)
      void this.prune()
      return target
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

/** A picture at most `side` on its longer side, as PNG so a screenshot's text stays sharp. */
async function picture(path: string, output: string, side: number): Promise<boolean> {
  try {
    const sharp = await heavy.sharp.load("a picture's thumbnail")
    await sharp(path, { animated: false, limitInputPixels: 268_402_689 })
      .rotate()
      .resize({ width: side, height: side, fit: "inside", withoutEnlargement: true })
      .png()
      .toFile(output)
    return true
  } catch {
    return false
  }
}

/** A video's frame half a second in (most recordings open on black), or its first for a shorter clip, as JPEG. */
async function poster(ffmpeg: string, path: string, output: string): Promise<boolean> {
  const side = SIDE.poster
  const scale = `scale=w='min(${side},iw)':h='min(${side},ih)':force_original_aspect_ratio=decrease`
  for (const seek of [["-ss", "0.5"], []])
    if (await run(ffmpeg, ["-v", "error", "-nostdin", ...seek, "-i", path, "-frames:v", "1", "-vf", scale, "-q:v", "4", "-f", "mjpeg", "-y", output])
      && await stat(output).then((info) => info.size > 0, () => false)) return true
  return false
}

function run(executable: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    hostExecFile(executable, args, { timeout: RENDER_TIMEOUT_MS, maxBuffer: 64 * 1024 }, (error) => resolve(!error))
  })
}
