import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import type { Stats } from "node:fs"
import { realpath, stat } from "node:fs/promises"
import { basename, dirname, extname, join, sep } from "node:path"
import { z } from "zod"

const secret = randomBytes(32)

/** How long a signed URL is honoured. A preview that outlives it reads its file again. */
export const FILE_PREVIEW_TTL_MS = 60 * 60_000

/** The file a URL was signed for, as `stat` saw it: a change of any of these refuses the URL. */
export interface FileIdentity {
  dev: number
  ino: number
  size: number
  mtimeMs: number
}

/**
 * What a grant lets a page load beside itself: the files a page links
 * (styles, scripts, pictures, fonts, media, data it fetches), nothing a
 * page doesn't need to draw, so a grant on `~/report.html` never serves
 * `~/.ssh/id_rsa` or `~/notes.txt`.
 */
const PAGE_ASSETS = new Set([
  ".css", ".js", ".mjs", ".map", ".json", ".wasm",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg", ".ico", ".bmp",
  ".woff", ".woff2", ".ttf", ".otf",
  ".mp4", ".webm", ".mov", ".m4v", ".mp3", ".wav", ".ogg", ".m4a",
  ".html", ".htm",
])
/** How deep below its page an asset may sit. */
const PAGE_ASSET_DEPTH = 8

export interface FilePreviewOptions {
  /** A page: the URL also serves the files beside it that it links, of the types it can use. */
  folder?: boolean
  /** When it was signed; tests move the clock. */
  now?: number
}

/** A signed file URL's verdict. */
export type FilePreviewGrant =
  /** `entry`: the signed file itself, rather than an asset of its page. */
  | { kind: "file"; path: string; entry: boolean }
  /** Not a URL this host signed, or its signature doesn't hold. */
  | { kind: "invalid" }
  /** Signed here, but no longer honoured: expired, or the file changed or moved since. */
  | { kind: "refused"; reason: "expired" | "changed" | "outside" | "type" }

export const fileIdentity = (info: Pick<Stats, "dev" | "ino" | "size" | "mtimeMs">): FileIdentity =>
  ({ dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs })

/**
 * Capability URL issued only after a source-aware file read authorizes this
 * exact file: `mako-file://asset/<payload>/<signature>/<name>`. The payload
 * names the path, the expiry and the file's identity, so a URL stops working
 * when the file is replaced, and an hour after it was issued. A page's URL
 * is a folder grant: `<name>` may be any asset path beside it.
 */
export function filePreviewUrl(path: string, identity: FileIdentity, options: FilePreviewOptions = {}): string {
  const expires = (options.now ?? Date.now()) + FILE_PREVIEW_TTL_MS
  const fields = [path, expires, identity.dev, identity.ino, identity.size, Math.round(identity.mtimeMs), options.folder ? 1 : 0]
  const payload = Buffer.from(JSON.stringify(fields)).toString("base64url")
  const signature = createHmac("sha256", secret).update(payload).digest("hex")
  return `mako-file://asset/${payload}/${signature}/${encodeURIComponent(basename(path))}`
}

/** A signed payload: path, expiry, device, inode, size, modification time, and whether it grants the folder. */
const SignedFields = z.tuple([z.string().min(1), z.number(), z.number(), z.number(), z.number(), z.number(), z.union([z.literal(0), z.literal(1)])])

interface Signed {
  path: string
  expires: number
  identity: FileIdentity
  folder: boolean
  rest: string[]
}

function readSigned(url: string): Signed | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== "mako-file:" || parsed.hostname !== "asset") return null
  const [payload, signature, ...rest] = parsed.pathname.slice(1).split("/")
  if (!payload || !signature || !/^[a-f0-9]{64}$/.test(signature)) return null
  const expected = createHmac("sha256", secret).update(payload).digest()
  if (!timingSafeEqual(expected, Buffer.from(signature, "hex"))) return null
  try {
    const fields = SignedFields.safeParse(JSON.parse(Buffer.from(payload, "base64url").toString()))
    if (!fields.success) return null
    const [path, expires, dev, ino, size, mtimeMs, folder] = fields.data
    return { path, expires, identity: { dev, ino, size, mtimeMs }, folder: folder === 1, rest: rest.map((part) => decodeURIComponent(part)) }
  } catch {
    return null
  }
}

/**
 * Which file a signed URL serves now, if any. The signed file must still be
 * the one signed (same device, inode, size and modification time); an asset
 * of a page must sit below the page's folder after symlinks are followed,
 * carry an asset type, and not be hidden.
 */
export async function verifyFilePreview(url: string, now = Date.now()): Promise<FilePreviewGrant> {
  const signed = readSigned(url)
  if (!signed) return { kind: "invalid" }
  if (now > signed.expires) return { kind: "refused", reason: "expired" }
  const parts = signed.rest.filter(Boolean)
  const entry = parts.length === 0 || (parts.length === 1 && parts[0] === basename(signed.path))
  if (entry) {
    const info = await stat(signed.path).catch(() => null)
    if (!info?.isFile()) return { kind: "refused", reason: "changed" }
    const current = fileIdentity(info)
    const same = current.dev === signed.identity.dev && current.ino === signed.identity.ino &&
      current.size === signed.identity.size && Math.round(current.mtimeMs) === signed.identity.mtimeMs
    return same ? { kind: "file", path: signed.path, entry: true } : { kind: "refused", reason: "changed" }
  }
  if (!signed.folder) return { kind: "invalid" }
  if (parts.length > PAGE_ASSET_DEPTH || parts.some((part) => part === "." || part === ".." || part.startsWith(".") || /[\\/\0]/.test(part)))
    return { kind: "refused", reason: "outside" }
  if (!PAGE_ASSETS.has(extname(parts.at(-1)!).toLowerCase())) return { kind: "refused", reason: "type" }
  const folder = dirname(signed.path)
  const root = await realpath(folder).catch(() => null)
  const target = await realpath(join(folder, ...parts)).catch(() => null)
  if (!root || !target || !target.startsWith(root + sep)) return { kind: "refused", reason: "outside" }
  const info = await stat(target).catch(() => null)
  return info?.isFile() ? { kind: "file", path: target, entry: false } : { kind: "refused", reason: "outside" }
}
