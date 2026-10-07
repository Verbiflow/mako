import type { SessionSettings } from "@mako/sessions/settings"
import { createHash, randomUUID } from "node:crypto"
import {
  constants,
  copyFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { join, relative, isAbsolute } from "node:path"
import type { AttachmentContent } from "@mako/sessions"
import type { PromptAttachment } from "./shared.js"
import type { LiveUpdate } from "@mako/sessions/live-content"

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
    if (!existsSync(path)) {
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
        throw new Error("The attachment could not be retained")
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
      copyFileSync(attachment.source.path, path, constants.COPYFILE_FICLONE)
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
      next[field] =
        `${text.slice(0, PREVIEW_LIMIT)}\n\n[Preview shortened. The complete ${field} is attached as ${attachment.name}.]`
    }
    return [next]
  }
}
