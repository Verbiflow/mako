import { mkdirSync } from "node:fs"
import { open, stat } from "node:fs/promises"
import { extname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { imageSize } from "image-size"
import mimeTypes from "mime"
import { z } from "zod"
import { keepFileCopy } from "@mako/sessions/attachment-storage"
import { mediaKind, type MediaKind } from "@mako/sessions/turn-media"
import type { KeptMedia, MediaCheck, MediaConfirmation } from "../contracts/turn-media.js"
import { keepPage, keptPage } from "./page-copy.js"

/** A file changed this long before its call started still counts as the call's: clocks and file systems round. */
const BEFORE_MS = 2_000
/** And this long after it ended: a recording's last write lands as the call returns. */
const AFTER_MS = 5_000
/** Copied whole: images, pages, PDFs and audio up to this. */
const MAX_COPY = 25 * 1024 * 1024
/** A video up to this is copied too (a clone on APFS); a larger one is shown where it is. */
const MAX_VIDEO_COPY = 500 * 1024 * 1024
/** Files checked at once. */
const PARALLEL = 8
/** What an image's header is read from for its size. */
const HEADER_BYTES = 512 * 1024

const KeptSchema = z.object({
  path: z.string(),
  file: z.string(),
  digest: z.string().optional(),
  kind: z.enum(["image", "video", "audio", "html", "pdf"]),
  mimeType: z.string(),
  bytes: z.number(),
  width: z.number().optional(),
  height: z.number().optional(),
})
const AnswerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("kept"), media: KeptSchema }),
  z.object({ kind: z.literal("dropped"), reason: z.string() }),
])

/**
 * The media turns made, confirmed against the disk and kept: each file a
 * turn's records name (`MediaCheck`) is checked once, copied into a
 * content-addressed folder, and the answer kept by the call and path. A
 * turn then points at its own bytes: a file the agent overwrites in a later
 * turn, or one `/tmp` loses, still shows what this turn made, and a
 * reopened conversation reads the answer instead of the disk.
 *
 * A file a command line only named is the turn's when it changed while the
 * command ran; any file that changed after its call ended is no longer the
 * turn's to show, unless it was kept before that.
 */
export class TurnMedia {
  private readonly db: DatabaseSync
  private readonly root: string
  private readonly now: () => number

  constructor(root: string, now: () => number = Date.now) {
    this.root = root
    this.now = now
    mkdirSync(root, { recursive: true })
    this.db = new DatabaseSync(join(root, "media.db"))
    this.db.exec([
      "PRAGMA journal_mode=WAL",
      "CREATE TABLE IF NOT EXISTS answers (call TEXT NOT NULL, path TEXT NOT NULL, answer TEXT NOT NULL, PRIMARY KEY (call, path))",
      "CREATE TABLE IF NOT EXISTS shown (path TEXT NOT NULL, at INTEGER NOT NULL, media TEXT NOT NULL, PRIMARY KEY (path, at))",
    ].join(";"))
  }

  close(): void {
    this.db.close()
  }

  /** Each check's answer, in order. */
  async confirm(checks: readonly MediaCheck[]): Promise<MediaConfirmation[]> {
    const answers: MediaConfirmation[] = Array.from({ length: checks.length }, () => ({ kind: "pending" }))
    let next = 0
    const work = async () => {
      while (next < checks.length) {
        const index = next++
        answers[index] = await this.check(checks[index]!).catch((error: Error): MediaConfirmation => ({ kind: "dropped", reason: error.message }))
      }
    }
    await Promise.all(Array.from({ length: Math.min(PARALLEL, checks.length) }, work))
    return answers
  }

  /**
   * Keeps a file `show` is putting in front of the person now, and notes
   * that it did, so a harness that keeps no `_meta` still finds this copy by
   * the call's path and time.
   */
  async show(path: string): Promise<KeptMedia> {
    const kind = mediaKind(path)
    if (!kind) throw new Error(`${path} isn't an image, video, audio file, HTML page or PDF.`)
    const found = await stat(path).catch(() => undefined)
    if (!found?.isFile()) throw new Error(`No file at ${path}.`)
    const media = await this.keep(path, kind, found.size)
    this.db.prepare("INSERT OR REPLACE INTO shown VALUES (?, ?, ?)").run(path, this.now(), JSON.stringify(media))
    return media
  }

  private async check(check: MediaCheck): Promise<MediaConfirmation> {
    const kind = mediaKind(check.path)
    if (!kind) return { kind: "dropped", reason: "Not an image, video, audio file, HTML page or PDF" }
    const row = this.db.prepare("SELECT answer FROM answers WHERE call = ? AND path = ?").get(check.callId, check.path)
    if (row) {
      const answer = AnswerSchema.safeParse(JSON.parse(z.object({ answer: z.string() }).parse(row).answer))
      if (answer.success) return answer.data
    }
    const answer = await this.decide(check, kind)
    // A call still running may yet write the file; only a finished call's answer stands.
    if (answer.kind !== "pending" && check.endedAt !== undefined)
      this.db.prepare("INSERT OR REPLACE INTO answers VALUES (?, ?, ?)").run(check.callId, check.path, JSON.stringify(answer))
    return answer
  }

  private async decide(check: MediaCheck, kind: MediaKind): Promise<MediaConfirmation> {
    const end = (check.endedAt ?? this.now()) + AFTER_MS
    if (check.evidence === "shown" || check.digest) {
      const kept = check.digest ? await this.kept(check.path, check.digest, kind) : this.shownBetween(check.path, (check.startedAt ?? 0) - BEFORE_MS, end)
      if (kept) return { kind: "kept", media: kept }
    }
    const found = await stat(check.path).catch(() => undefined)
    if (!found) return check.endedAt === undefined ? { kind: "pending" } : { kind: "dropped", reason: `No file at ${check.path}` }
    if (!found.isFile()) return { kind: "dropped", reason: `${check.path} isn't a file` }
    if (check.endedAt !== undefined && found.mtimeMs > end) return { kind: "dropped", reason: "It changed after the turn made it" }
    if (check.evidence === "named") {
      if (check.startedAt === undefined) return { kind: "dropped", reason: "The call's records don't say when it ran" }
      if (found.mtimeMs < check.startedAt - BEFORE_MS) return check.endedAt === undefined ? { kind: "pending" } : { kind: "dropped", reason: "The command named it but didn't change it" }
    }
    const media = await this.keep(check.path, kind, found.size)
    // The turn's record names the bytes it left: a file holding others since isn't what the turn made.
    if (check.evidence !== "shown" && check.digest && media.digest && media.digest !== check.digest) return { kind: "dropped", reason: "It changed after the turn made it" }
    return { kind: "kept", media }
  }

  /** The copy `show` kept of `path` between two times, the latest. */
  private shownBetween(path: string, from: number, to: number): KeptMedia | undefined {
    const row = this.db.prepare("SELECT media FROM shown WHERE path = ? AND at BETWEEN ? AND ? ORDER BY at DESC LIMIT 1").get(path, from, to)
    if (!row) return undefined
    const media = KeptSchema.safeParse(JSON.parse(z.object({ media: z.string() }).parse(row).media))
    return media.success ? media.data : undefined
  }

  /** The copy named `digest`, when it is still here. */
  private async kept(path: string, digest: string, kind: MediaKind): Promise<KeptMedia | undefined> {
    const file = kind === "html" ? await keptPage(path, digest, this.root) : join(this.root, `${digest}${extname(path).toLowerCase()}`)
    if (!file) return undefined
    const found = await stat(file).catch(() => undefined)
    if (!found?.isFile()) return undefined
    return this.described({ path, file, digest, kind, mimeType: mimeOf(path, kind), bytes: found.size })
  }

  private async keep(path: string, kind: MediaKind, bytes: number): Promise<KeptMedia> {
    const limit = kind === "video" ? MAX_VIDEO_COPY : MAX_COPY
    const media: KeptMedia = { path, file: path, kind, mimeType: mimeOf(path, kind), bytes }
    if (bytes <= limit) {
      const copy = await keepFileCopy(path, this.root, extname(path).toLowerCase())
      // A page is drawn from a folder of its own, with the styles and pictures it links.
      media.file = kind === "html" ? await keepPage(path, copy.path, copy.digest, this.root) : copy.path
      media.digest = copy.digest
    }
    return this.described(media)
  }

  /** `media` with an image's size in pixels, from its header. */
  private async described(media: KeptMedia): Promise<KeptMedia> {
    if (media.kind !== "image") return media
    const file = await open(media.file, "r")
    try {
      const head = Buffer.alloc(Math.min(HEADER_BYTES, media.bytes))
      const { bytesRead } = await file.read(head, 0, head.length, 0)
      const size = imageSize(head.subarray(0, bytesRead))
      if (size.width && size.height) {
        // Rotated JPEG and HEIC frames report their stored size; the picture is turned.
        const turned = size.orientation !== undefined && size.orientation >= 5
        media.width = turned ? size.height : size.width
        media.height = turned ? size.width : size.height
      }
    } catch {
      // A header image-size can't read leaves the size unsaid; the preview measures it.
    } finally {
      await file.close()
    }
    return media
  }
}

function mimeOf(path: string, kind: MediaKind): string {
  return mimeTypes.getType(path) ?? (kind === "html" ? "text/html" : kind === "pdf" ? "application/pdf" : `${kind}/*`)
}
