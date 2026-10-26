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
import { join, relative, isAbsolute } from "node:path"
import type { AttachmentContent } from "@mako/sessions"
import type { PromptAttachment } from "../contracts/providers-acp.js"
import type { LiveUpdate } from "@mako/sessions/live-content"
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

/** Keep large payloads in durable artifacts, with small references on the event wire. */
export class LiveAssets {
  private readonly root: string
  constructor(root: string) {
    this.root = root
  }

  private save(
    name: string,
    mimeType: string,
    bytes: Buffer
  ): StoredAttachment {
    const digest = createHash("sha256").update(bytes).digest("hex")
    mkdirSync(this.root, { recursive: true })
    const path = join(
      this.root,
      `${digest}-${name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-100)}`
    )
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

  retainPrompt(attachments: PromptAttachment[]): PromptAttachment[] {
    return attachments.map((attachment) => {
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
      const local = relative(this.root, attachment.source.path)
      if (local && !local.startsWith("..") && !isAbsolute(local))
        return attachment
      mkdirSync(this.root, { recursive: true })
      const path = join(
        this.root,
        `${randomUUID()}-${attachment.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-100)}`
      )
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
