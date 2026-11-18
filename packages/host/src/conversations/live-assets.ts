import type { SessionSettings } from "@mako/sessions/settings"
import { createHash, randomUUID } from "node:crypto"
import {
  accessSync,
  constants,
  copyFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { chmod, copyFile, mkdir, open, rename, rm, stat, utimes, type FileHandle } from "node:fs/promises"
import { join, relative, isAbsolute } from "node:path"
import type { AttachmentContent } from "@mako/sessions"
import type { PromptAttachment } from "../contracts/providers-acp.js"
import type { LiveUpdate } from "@mako/sessions/live-content"
import { fileSha256 } from "../base/file-hash.js"
import { hostWarn } from "../base/host-log.js"

export function promptFingerprint(
  text: string,
  attachments: PromptAttachment[],
  settings?: SessionSettings
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        text,
        attachments.map((attachment) => [
          attachment.name,
          attachment.mimeType,
          attachment.size,
          attachment.data,
          attachment.path,
        ]),
        ...(settings
          ? [
              [
                settings.model,
                Object.entries(settings.options ?? {}).sort(([a], [b]) =>
                  a.localeCompare(b)
                ),
              ],
            ]
          : []),
      ])
    )
    .digest("hex")
}

type StoredAttachment = AttachmentContent & {
  source: Extract<AttachmentContent["source"], { kind: "file" }>
}

const PREVIEW_LIMIT = 64_000
const SHORTENED = /\n\n\[Preview shortened\. The complete (input|output) is attached as ([^\n]+)\.\]$/u

/** What a call's field over `PREVIEW_LIMIT` reads as on the wire: its start, and the attachment holding all of it. */
function shortenedPreview(text: string, field: "input" | "output", name: string): string {
  return `${text.slice(0, PREVIEW_LIMIT)}\n\n[Preview shortened. The complete ${field} is attached as ${name}.]`
}

/** A call's field as Mako holds it, and the attachment it was read back from, when it was shortened. */
export interface WholeField {
  text: string
  attachment?: string
}

/**
 * A field `LiveAssets` shortened, whole again: the attachment it names, read
 * from its file. What Mako holds of the call, for a check that compares it
 * with the harness's stream; the text as it was when there is no such
 * attachment or its file is gone.
 */
export function wholeField(text: string, attachments: readonly AttachmentContent[] | undefined, read: (path: string) => string | null): WholeField {
  const match = SHORTENED.exec(text)
  if (!match) return { text }
  const attachment = attachments?.find((candidate) => candidate.name === match[2] && candidate.source.kind === "file")
  const whole = attachment?.source.kind === "file" ? read(attachment.source.path) : null
  return whole === null || !whole.startsWith(text.slice(0, match.index)) ? { text } : { text: whole, attachment: match[2] }
}

/** Why the file at `path` can't be read (its error's code), or undefined when it can. */
function sourceUnreadable(path: string): string | undefined {
  try {
    accessSync(path, constants.R_OK)
    return undefined
  } catch (error) {
    return error instanceof Error && "code" in error ? String(error.code) : String(error)
  }
}

/** Work `LiveAssets` did on a file, for a test that counts it: `sync` is anything done on the caller's own turn. */
export interface AssetWork {
  kind: "hash" | "clone" | "write" | "reuse" | "sync"
  /** The file's name in the store, or the source's path for a hash. */
  path: string
}

/** How many base64 characters of a prompt's inline bytes are decoded before it does: a multiple of four, so each piece decodes alone. */
const INLINE_STEP = 1 << 20
/** Prompts whose attachments are held for an admission that hasn't come; past these the oldest is forgotten. */
const HELD_PROMPTS = 64
/** Files whose hash is remembered by what `stat` said of them, so a prompt sent again reads none of it twice. */
const HASHES_KEPT = 256

/** One of a prompt's attachments as `hold` kept it: what it came as, and where its bytes are now. */
interface HeldAttachment {
  from: PromptAttachment
  path: string
}

const storedName = (name: string) => name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-100)

/**
 * Write what `data` decodes to into `file`, and answer its SHA-256. Whole pieces of clean base64 decode alone; a
 * piece that comes up short (spaces, a line break, padding inside) means it isn't, and the whole of it is decoded
 * at once, exactly as `Buffer.from` reads it.
 */
async function decodeInto(file: FileHandle, data: string): Promise<string> {
  const hash = createHash("sha256")
  let aligned = true
  for (let at = 0; aligned && at < data.length; at += INLINE_STEP) {
    const bytes = Buffer.from(data.slice(at, at + INLINE_STEP), "base64")
    if (at + INLINE_STEP < data.length && bytes.length !== INLINE_STEP / 4 * 3) aligned = false
    else {
      hash.update(bytes)
      await file.write(bytes)
    }
  }
  if (aligned) return hash.digest("hex")
  const bytes = Buffer.from(data, "base64")
  await file.truncate(0)
  await file.write(bytes, 0, bytes.length, 0)
  return createHash("sha256").update(bytes).digest("hex")
}

/** Keep large payloads in durable artifacts, with small references on the event wire. */
export class LiveAssets {
  private readonly root: string
  private readonly did: (work: AssetWork) => void
  private readonly held = new Map<string, (HeldAttachment | undefined)[]>()
  private readonly hashes = new Map<string, string>()
  /** `did`: told of each piece of work on a file, for a test that counts it. */
  constructor(root: string, did: (work: AssetWork) => void = () => undefined) {
    this.root = root
    this.did = did
  }

  /** Whether `path` is a file of this store already. */
  private owns(path: string): boolean {
    const local = relative(this.root, path)
    return Boolean(local) && !local.startsWith("..") && !isAbsolute(local)
  }

  /**
   * A prompt's attachments kept ahead of its admission, off the caller's turn: each file is hashed as a stream and
   * cloned once under its hash, and inline bytes are decoded a piece at a time. `retainPrompt` under the same `key`
   * then only swaps the paths in. An attachment that can't be kept here is left for `retainPrompt` to refuse.
   */
  async hold(key: string, attachments: readonly PromptAttachment[]): Promise<void> {
    if (!attachments.length) return
    const kept = await Promise.all(attachments.map((attachment) =>
      this.keep(attachment).then(
        (path): HeldAttachment | undefined => (path ? { from: attachment, path } : undefined),
        () => undefined
      )
    ))
    this.held.delete(key)
    this.held.set(key, kept)
    if (this.held.size > HELD_PROMPTS) {
      const oldest = this.held.keys().next().value
      if (oldest !== undefined) this.held.delete(oldest)
    }
  }

  /** Forget what `hold` kept under `key`: its prompt was admitted, or refused. The files stay for the sweep. */
  release(key: string): void {
    this.held.delete(key)
  }

  private async keep(attachment: PromptAttachment): Promise<string | undefined> {
    if (attachment.data !== undefined) return this.keepInline(attachment.name, attachment.data)
    if (!attachment.path) return undefined
    if (this.owns(attachment.path)) return attachment.path
    return this.keepFile(attachment.name, attachment.path)
  }

  /** A file by its hash: read once to hash it, then cloned, or only its times moved when the store holds it already. */
  private async keepFile(name: string, source: string): Promise<string> {
    const before = await stat(source)
    const identity = JSON.stringify([source, before.dev, before.ino, before.size, before.mtimeMs])
    let digest = this.hashes.get(identity)
    if (!digest) {
      digest = await fileSha256(source)
      this.did({ kind: "hash", path: source })
      const after = await stat(source)
      // Written while it was read: the hash names nothing that exists, so it's kept as a copy of its own.
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino) digest = undefined
      else {
        this.hashes.set(identity, digest)
        if (this.hashes.size > HASHES_KEPT) {
          const oldest = this.hashes.keys().next().value
          if (oldest !== undefined) this.hashes.delete(oldest)
        }
      }
    }
    await mkdir(this.root, { recursive: true })
    const path = join(this.root, `${digest ?? randomUUID()}-${storedName(name)}`)
    if (digest && await this.reused(path)) return path
    const temporary = join(this.root, `${randomUUID()}.tmp`)
    try {
      await copyFile(source, temporary, constants.COPYFILE_FICLONE)
      await chmod(temporary, 0o600)
      await rename(temporary, path)
      this.did({ kind: "clone", path })
    } finally {
      await rm(temporary, { force: true })
    }
    return path
  }

  /** Inline bytes by their hash, decoded and written a piece at a time so a large one never holds the loop. */
  private async keepInline(name: string, data: string): Promise<string> {
    await mkdir(this.root, { recursive: true })
    const temporary = join(this.root, `${randomUUID()}.tmp`)
    try {
      const file = await open(temporary, "wx", 0o600)
      let digest: string
      try {
        digest = await decodeInto(file, data)
      } finally {
        await file.close()
      }
      return await this.place(temporary, digest, name)
    } finally {
      await rm(temporary, { force: true })
    }
  }

  /** Whether the store holds `path` already. Reused by its hash, its times start again, as `save` says. */
  private async reused(path: string): Promise<boolean> {
    const now = new Date()
    const there = await utimes(path, now, now).then(() => true, () => false)
    if (there) this.did({ kind: "reuse", path })
    return there
  }

  private async place(temporary: string, digest: string, name: string): Promise<string> {
    const path = join(this.root, `${digest}-${storedName(name)}`)
    if (await this.reused(path)) return path
    await rename(temporary, path)
    this.did({ kind: "write", path })
    return path
  }

  private save(
    name: string,
    mimeType: string,
    bytes: Buffer
  ): StoredAttachment {
    const digest = createHash("sha256").update(bytes).digest("hex")
    mkdirSync(this.root, { recursive: true })
    const path = join(this.root, `${digest}-${storedName(name)}`)
    this.did({ kind: "sync", path })
    if (existsSync(path)) {
      // Reused by its hash: its times start again, so the attachments' sweep, which takes only a file older than its grace that nothing names, leaves it while this prompt reaches the journal.
      const now = new Date()
      utimesSync(path, now, now)
    } else {
      const temporary = join(this.root, `${randomUUID()}.tmp`)
      try {
        writeFileSync(temporary, bytes)
        renameSync(temporary, path)
      } finally {
        rmSync(temporary, { force: true })
      }
    }
    return {
      type: "attachment",
      name,
      mimeType,
      source: { kind: "file", path },
    }
  }

  /**
   * A prompt's attachments as files of this store. Under the `key` its sender held them by (`hold`), each is already
   * here and only its path is swapped in; anything not held is kept now, on the caller's turn.
   */
  retainPrompt(attachments: PromptAttachment[], key?: string): PromptAttachment[] {
    const held = key === undefined ? undefined : this.held.get(key)
    if (key !== undefined) this.held.delete(key)
    return attachments.map((attachment, index) => {
      const kept = held?.[index]
      if (kept && kept.from.name === attachment.name && kept.from.path === attachment.path && kept.from.data === attachment.data)
        return { ...attachment, path: kept.path }
      if (attachment.data !== undefined) {
        const retained = this.save(
          attachment.name,
          attachment.mimeType,
          Buffer.from(attachment.data, "base64")
        )
        return { ...attachment, path: retained.source.path }
      }
      if (!attachment.path)
        throw new Error(`Attachment ${attachment.name} has no retained bytes`)
      const retained = this.attachment({
        type: "attachment",
        name: attachment.name,
        mimeType: attachment.mimeType,
        source: { kind: "file", path: attachment.path },
      })
      if (retained.source.kind !== "file")
        throw new Error(retained.source.kind === "unavailable" ? retained.source.reason : "The attachment could not be retained")
      return { ...attachment, path: retained.source.path }
    })
  }

  private attachment(attachment: AttachmentContent): AttachmentContent {
    if (attachment.source.kind === "file") {
      if (this.owns(attachment.source.path)) return attachment
      mkdirSync(this.root, { recursive: true })
      const path = join(this.root, `${randomUUID()}-${storedName(attachment.name)}`)
      this.did({ kind: "sync", path })
      try {
        copyFileSync(attachment.source.path, path, constants.COPYFILE_FICLONE)
      } catch (error) {
        // A file the harness named that is gone or can't be read is an attachment Mako can't show, not a
        // conversation it can't save: that would stop the turn (`storageFailed`).
        const unreadable = sourceUnreadable(attachment.source.path)
        if (!unreadable) throw error
        hostWarn("live", "an attachment's file could not be read", { name: attachment.name, error: unreadable })
        return { ...attachment, source: { kind: "unavailable", reason: `${attachment.name} could not be read (${unreadable})` } }
      }
      chmodSync(path, 0o600)
      return {
        ...attachment,
        source: {
          kind: "file",
          path,
          originalPath:
            attachment.source.originalPath ?? attachment.source.path,
        },
      }
    }
    return attachment.source.kind === "inline"
      ? {
          ...attachment,
          source: this.save(
            attachment.name,
            attachment.mimeType,
            Buffer.from(attachment.source.data, "base64")
          ).source,
        }
      : attachment
  }

  prepare(update: LiveUpdate): LiveUpdate[] {
    if (
      update.kind === "text" ||
      update.kind === "thinking" ||
      update.kind === "proposed-plan"
    ) {
      if (update.text.length <= PREVIEW_LIMIT) return [update]
      const chunks: LiveUpdate[] = []
      for (let offset = 0; offset < update.text.length; offset += PREVIEW_LIMIT)
        chunks.push({
          ...update,
          text: update.text.slice(offset, offset + PREVIEW_LIMIT),
          replace: offset === 0 ? update.replace : false,
        })
      return chunks
    }
    if (update.kind === "attachment")
      return [{ ...update, attachment: this.attachment(update.attachment) }]
    if (update.kind === "plan" || update.kind === "provider-turn" || update.kind === "event" || update.kind === "retract") return [update]
    const attachments =
      update.attachments?.map((attachment) => this.attachment(attachment)) ?? []
    if (update.kind === "user") return [{ ...update, attachments }]
    const next = { ...update }
    if (update.attachments) next.attachments = attachments
    for (const field of ["input", "output"] as const) {
      const text = next[field]
      if (!text || text.length <= PREVIEW_LIMIT) continue
      const attachment = this.save(
        `${update.id}-${field}.txt`,
        "text/plain",
        Buffer.from(text)
      )
      attachments.push(attachment)
      next.attachments = attachments
      next[field] = shortenedPreview(text, field, attachment.name)
    }
    return [next]
  }
}
