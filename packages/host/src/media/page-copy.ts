import { constants } from "node:fs"
import { copyFile, mkdir, readFile, realpath, rename, rm, stat } from "node:fs/promises"
import { createHash, randomUUID } from "node:crypto"
import { basename, dirname, extname, join, relative, sep } from "node:path"

/**
 * What a kept page takes along from beside it: the files it links to draw
 * (styles, scripts, pictures, fonts, media), never anything else there.
 */
const ASSETS = new Set([
  ".css", ".js", ".mjs",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg", ".ico", ".bmp",
  ".woff", ".woff2", ".ttf", ".otf",
  ".mp4", ".webm", ".mov", ".m4v", ".mp3", ".wav", ".ogg", ".m4a",
])
/** At most this many files, and this many bytes in all, go with one page. */
const MAX_ASSETS = 200
const MAX_BYTES = 50 * 1024 * 1024
/** A page or stylesheet larger than this is copied, never read for links. */
const MAX_READ = 2 * 1024 * 1024

const ATTRIBUTE = /\b(?:src|href|poster)\s*=\s*["']([^"']+)["']/gi
const CSS_URL = /url\(\s*["']?([^"')]+)["']?\s*\)|@import\s+["']([^"']+)["']/gi

/** A link as a path under `folder`, or undefined for one elsewhere (absolute, another site, data, above the folder, hidden). */
function local(link: string, from: string, folder: string): string | undefined {
  const bare = link.trim().split(/[?#]/, 1)[0]!
  if (!bare || /^[a-z][a-z0-9+.-]*:/i.test(bare) || bare.startsWith("/") || bare.startsWith("\\")) return undefined
  let decoded: string
  try {
    decoded = decodeURIComponent(bare)
  } catch {
    return undefined
  }
  const path = relative(folder, join(dirname(from), decoded))
  if (!path || path.startsWith("..") || path.split(sep).some((part) => part.startsWith("."))) return undefined
  return ASSETS.has(extname(path).toLowerCase()) ? path : undefined
}

/** The files beside `page` it links, and those its stylesheets link, relative to its folder. */
async function pageAssets(page: string): Promise<string[]> {
  const folder = dirname(page)
  const found = new Set<string>()
  const read = async (file: string, pattern: RegExp) => {
    const info = await stat(file).catch(() => undefined)
    if (!info?.isFile() || info.size > MAX_READ) return []
    const text = await readFile(file, "utf8")
    return [...text.matchAll(pattern)].map((match) => match[1] ?? match[2] ?? "").filter(Boolean)
  }
  const sheets: string[] = []
  for (const link of await read(page, ATTRIBUTE)) {
    const path = local(link, page, folder)
    if (path && !found.has(path)) {
      found.add(path)
      if (extname(path).toLowerCase() === ".css") sheets.push(path)
    }
  }
  for (const sheet of sheets)
    for (const link of await read(join(folder, sheet), CSS_URL)) {
      const path = local(link, join(folder, sheet), folder)
      if (path) found.add(path)
    }
  return [...found].slice(0, MAX_ASSETS)
}

/**
 * A copy of the page at `page`, whose bytes are `copy` (named `digest`),
 * in a folder of its own under `root` with the files beside it that it
 * links: drawn from there, it loads its own styles and pictures, as it did
 * when the turn made it, whatever has happened beside the original since.
 * The folder is published whole, so a page is never half kept.
 */
export async function keepPage(page: string, copy: string, digest: string, root: string): Promise<string> {
  const folder = pageFolder(page, digest, root)
  const kept = join(folder, basename(page))
  if (await stat(kept).then((info) => info.isFile(), () => false)) return kept
  const staging = `${folder}.${randomUUID()}.tmp`
  try {
    await mkdir(staging, { recursive: true })
    await copyFile(copy, join(staging, basename(page)), constants.COPYFILE_FICLONE)
    const from = await realpath(dirname(page))
    let bytes = 0
    for (const asset of await pageAssets(page)) {
      const source = await realpath(join(dirname(page), asset)).catch(() => undefined)
      if (!source || !source.startsWith(from + sep)) continue
      const info = await stat(source).catch(() => undefined)
      if (!info?.isFile() || (bytes += info.size) > MAX_BYTES) continue
      await mkdir(dirname(join(staging, asset)), { recursive: true })
      await copyFile(source, join(staging, asset), constants.COPYFILE_FICLONE)
    }
    await rename(staging, folder).catch(async (error: NodeJS.ErrnoException) => {
      // Another check kept the same page first: its folder stands.
      if (error.code !== "ENOTEMPTY" && error.code !== "EEXIST") throw error
    })
    return kept
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

/** One folder per page and content: the same bytes written in two places may link different files. */
function pageFolder(page: string, digest: string, root: string): string {
  return join(root, "pages", `${digest}-${createHash("sha256").update(page).digest("hex").slice(0, 12)}`)
}

/** The page kept as `digest`, when it is still here. */
export async function keptPage(page: string, digest: string, root: string): Promise<string | undefined> {
  const kept = join(pageFolder(page, digest, root), basename(page))
  return (await stat(kept).then((info) => info.isFile(), () => false)) ? kept : undefined
}
