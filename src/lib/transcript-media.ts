import type { AttachmentContent } from "@mako/sessions"
import { attachmentFromUrl } from "@mako/sessions/content"
import { markdownFileTarget } from "./file-citations"
import { mediaKind } from "@mako/sessions/turn-media"
import type { MediaCheck, MediaConfirmation } from "@mako/host/contracts/turn-media"

// Preserve the public helper while sharing maintained MIME lookup with composer
// and preview routing. No renderer-owned list of media extensions.
export { fileMimeTypeForPath as mediaTypeForPath } from "@mako/host/contracts/file-preview"
import { fileMimeTypeForPath as mediaTypeForPath } from "@mako/host/contracts/file-preview"

export function markdownMedia(
  source: string,
  label?: string
): AttachmentContent {
  const file = markdownFileTarget(source)
  const pathname = file?.path ?? source.split(/[?#]/)[0] ?? source
  const name = label || pathname.split("/").at(-1) || "Attachment"
  const mimeType =
    /^data:([^;,]+)/i.exec(source)?.[1] ??
    mediaTypeForPath(pathname) ??
    "image/png"
  return file
    ? {
        type: "attachment",
        name,
        mimeType,
        source: { kind: "file", path: file.path },
      }
    : attachmentFromUrl(name, mimeType, source)
}

export function previewableMediaUrl(url: string): boolean {
  return (
    /^https?:\/\//i.test(url) ||
    /^data:(?:image|audio|video)\/[a-z0-9.+-]+;base64,/i.test(url)
  )
}

/**
 * The check that keeps an embed in a landed answer (`embedded`): an absolute path to a picture, video, audio file,
 * page or PDF, keyed by the answer and stamped with when it landed. None for prose that keeps nothing, a URL, or a
 * relative path, which only the window that wrote it can place.
 */
export function embeddedCheck(attachment: AttachmentContent, keeps: { callId: string; at: number } | undefined): MediaCheck | undefined {
  const path = attachment.source?.kind === "file" ? attachment.source.path : undefined
  if (!keeps || !path?.startsWith("/") || !mediaKind(path)) return undefined
  return { callId: keeps.callId, path, evidence: "embedded", endedAt: Math.round(keeps.at) }
}

/** The embed drawn from the host's copy once it kept one; as it was otherwise. */
export function keptEmbed(attachment: AttachmentContent, answer: MediaConfirmation | undefined): AttachmentContent {
  if (answer?.kind !== "kept" || attachment.source?.kind !== "file") return attachment
  const { path } = attachment.source
  return { ...attachment, source: { kind: "file", path: answer.media.file, ...(answer.media.file !== path && { originalPath: path }) } }
}
