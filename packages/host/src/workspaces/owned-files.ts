import { createHash, randomUUID } from "node:crypto"
import { createWriteStream } from "node:fs"
import { mkdir, readdir, rename, rm, stat, utimes } from "node:fs/promises"
import { join } from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { z } from "zod"
import { hostWarn } from "../base/host-log.js"
import { decodeRuntimeValue, encodeRuntimeValue, type EncodedValue } from "../contracts/runtime-value.js"
import { ownedFilePreviewUrl, type FileOwner, type FilePreviewGrant } from "./file-previews.js"
import { fileResponse, localFile } from "./file-response.js"

/** What this host keeps of other hosts' files before the least recently loaded go. */
const KEPT_BYTES = 512 * 1024 * 1024
/** A file larger than this is passed on as its owner answers, never kept. */
const LARGEST_KEPT = 128 * 1024 * 1024

export interface OwnedFilesOptions {
  /** Where the copies are kept. */
  folder: string
  /** The owner's answer to its own signed URL, as that host serves it to this one; `range` asks for part of it. */
  fetch(owner: FileOwner, url: string, init: { signal: AbortSignal; range?: string }): Promise<Response>
  keptBytes?: number
}

/**
 * The files other hosts signed, served here as this host's own (`ownedFilePreviewUrl`): a cloud Thread's screenshot,
 * another device's recording, another profile's page. Each is fetched from its owner the first time it's loaded and
 * kept by what it is, not by its URL: the same file read again, under a new signature, loads from the copy. A file its
 * owner no longer has, or won't serve, answers as the owner did, and nothing is kept.
 */
export class OwnedFiles {
  readonly #options: OwnedFilesOptions
  readonly #fetching = new Map<string, Promise<Kept>>()

  constructor(options: OwnedFilesOptions) {
    this.#options = options
  }

  async serve(grant: Extract<FilePreviewGrant, { kind: "owned" }>, request: Request): Promise<Response> {
    const key = keyOf(grant)
    let fetching = this.#fetching.get(key)
    if (!fetching) {
      fetching = this.#keep(key, grant).finally(() => this.#fetching.delete(key))
      this.#fetching.set(key, fetching)
    }
    const kept = await fetching
    if (kept.kind === "failed") return new Response(kept.text, { status: kept.status, headers: { "content-type": "text/plain; charset=utf-8" } })
    if (kept.kind === "large") {
      const range = request.headers.get("range")
      return this.#options.fetch(grant.owner, grant.url, { signal: request.signal, ...range && { range } })
    }
    return fileResponse(await localFile(kept.path, request.signal), kept.path, request, { cacheable: true, crossOrigin: !grant.entry, fitted: true })
  }

  async #keep(key: string, grant: Extract<FilePreviewGrant, { kind: "owned" }>): Promise<Kept> {
    const folder = join(this.#options.folder, key)
    const name = safeName(new URL(grant.url).pathname.split("/").at(-1))
    const path = join(folder, name)
    const kept = await stat(path).catch(() => null)
    if (kept?.isFile()) {
      const now = new Date()
      await utimes(folder, now, now).catch(() => undefined)
      return { kind: "kept", path }
    }
    const abort = new AbortController()
    let answer: Response
    try {
      answer = await this.#options.fetch(grant.owner, grant.url, { signal: abort.signal })
    } catch (error) {
      hostWarn("owned-files", "another host's file couldn't be fetched", { owner: grant.owner.kind, error: error instanceof Error ? error.message : String(error) })
      return { kind: "failed", status: 502, text: "The computer that has it couldn't be reached" }
    }
    if (!answer.ok || !answer.body) {
      // Said as its owner said it: gone, refused, or asleep.
      const text = await answer.text().catch(() => "")
      return { kind: "failed", status: answer.ok ? 404 : answer.status, text: text || "Not found" }
    }
    const size = Number(answer.headers.get("content-length"))
    if (size > LARGEST_KEPT) {
      abort.abort()
      return { kind: "large" }
    }
    await mkdir(folder, { recursive: true, mode: 0o700 })
    const part = join(folder, `.${randomUUID()}.part`)
    try {
      // SAFETY: a fetch body is the runtime's own web ReadableStream; only the DOM and Node typings differ.
      await pipeline(Readable.fromWeb(answer.body as import("node:stream/web").ReadableStream<Uint8Array>), createWriteStream(part, { mode: 0o600 }))
      await rename(part, path)
    } catch (error) {
      await rm(part, { force: true })
      throw error
    }
    void this.#prune().catch((error: Error) => hostWarn("owned-files", "couldn't trim the copies of other hosts' files", { error: error.message }))
    return { kind: "kept", path }
  }

  /** Keeps the copies under their bound, the least recently loaded going first. */
  async #prune(): Promise<void> {
    const bound = this.#options.keptBytes ?? KEPT_BYTES
    const entries = await readdir(this.#options.folder, { withFileTypes: true })
    const kept = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
      const folder = join(this.#options.folder, entry.name)
      const files = await readdir(folder)
      const sizes = await Promise.all(files.map((file) => stat(join(folder, file)).then((info) => info.size, () => 0)))
      const info = await stat(folder)
      return { folder, bytes: sizes.reduce((sum, size) => sum + size, 0), used: info.mtimeMs }
    }))
    let total = kept.reduce((sum, entry) => sum + entry.bytes, 0)
    for (const entry of kept.sort((a, b) => a.used - b.used)) {
      if (total <= bound) return
      await rm(entry.folder, { recursive: true, force: true })
      total -= entry.bytes
    }
  }
}

const SIGNED_URLS = ["previewUrl", "posterUrl", "thumbnailUrl"] as const
const OwnerReadSchema = z.looseObject(Object.fromEntries(SIGNED_URLS.map((key) => [key, z.string().optional()])))

/**
 * A file read another host answered (`mako:read-live-file` routed to its owner), as this host's windows load it: each
 * URL the owner signed, signed here for that owner (`ownedFilePreviewUrl`). Without it a window asks this host for a
 * URL only its owner can verify, and every picture of a cloud Thread or another computer draws as broken.
 */
export function ownerFileRead(owner: FileOwner, value: EncodedValue): EncodedValue {
  const read = OwnerReadSchema.safeParse(decodeRuntimeValue(value))
  if (!read.success) return value
  const owned = Object.fromEntries(SIGNED_URLS.flatMap((key) => {
    const url = read.data[key]
    const signed = url ? ownedFilePreviewUrl(owner, url) : undefined
    return signed ? [[key, signed]] : []
  }))
  return Object.keys(owned).length ? encodeRuntimeValue({ ...read.data, ...owned }) : value
}

type Kept = { kind: "kept"; path: string } | { kind: "failed"; status: number; text: string } | { kind: "large" }

/**
 * What a copy is kept by: its owner, the file as the owner signed it but for when that signature ends, the asset of
 * its page asked for, and the rendition. A file replaced since has another identity, so another copy.
 */
function keyOf(grant: Extract<FilePreviewGrant, { kind: "owned" }>): string {
  const url = new URL(grant.url)
  const [payload = "", , ...rest] = url.pathname.slice(1).split("/")
  const where = grant.owner.kind === "thread" ? grant.owner.threadId : grant.owner.kind === "device" ? grant.owner.deviceId : grant.owner.socket
  return createHash("sha256").update(JSON.stringify([grant.owner.kind, where, signedIdentity(payload), rest, url.searchParams.get("rendition")])).digest("hex").slice(0, 40)
}

/** An owner's signed file as its payload names it (path, expiry, device, inode, size, modification time, folder). */
const OwnerFieldsSchema = z.tuple([z.string(), z.number(), z.number(), z.number(), z.number(), z.number(), z.number()])

/** The file an owner's payload names, without when its signature ends; an owner of another shape, its payload whole. */
function signedIdentity(payload: string): string {
  let decoded: z.infer<ReturnType<typeof z.json>> | undefined
  try {
    decoded = z.json().parse(JSON.parse(Buffer.from(payload, "base64url").toString()))
  } catch {
    return payload
  }
  const fields = OwnerFieldsSchema.safeParse(decoded)
  if (!fields.success) return payload
  const [path, , ...identity] = fields.data
  return JSON.stringify([path, ...identity])
}

/** A name to keep a copy under: its own, without anything that could leave its folder. */
function safeName(part: string | undefined): string {
  const name = decodeURIComponent(part ?? "").replace(/[\\/\0]/g, "_").replace(/^\.+/, "")
  return name || "file"
}
