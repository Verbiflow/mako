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

/** The longer side of the host's `inline` and `thumbnail` renditions (`SIDE` in its `media-renditions.ts`). */
export const INLINE_RENDITION_SIDE = 1440
const THUMBNAIL_SIDE = 640
/** A picture is drawn from the `inline` rendition only when it has at least this many pixels on its longer side: under it the rendition saves too little to be worth making. */
const INLINE_RENDITION_ABOVE = 2160
/** The longest a picture alone draws, in CSS pixels: `mediaBox`'s 30rem at the usual 16 px. */
const LONE_BOX_PX = 480

/**
 * What a picture alone in the column draws from: the smallest of the host's renditions that fills its box at this
 * display's `ratio`, else the original. The host signs a thumbnail's URL only for a picture large enough to have
 * one, and makes the `inline` rendition from the same signed URL, so the URL here is that one asking for another
 * size; a host from before `inline` answers it with the original. The lightbox always loads `previewUrl`.
 */
export function lonePictureUrl(file: { previewUrl?: string; thumbnailUrl?: string; width?: number; height?: number }, ratio: number): string | undefined {
  const { previewUrl, thumbnailUrl } = file
  const longer = Math.max(file.width ?? 0, file.height ?? 0)
  if (!previewUrl || !thumbnailUrl || !longer || !/[?&]rendition=thumbnail(?:&|$)/.test(thumbnailUrl)) return previewUrl
  const needed = LONE_BOX_PX * ratio
  if (needed <= THUMBNAIL_SIDE) return thumbnailUrl
  if (needed <= INLINE_RENDITION_SIDE && longer >= INLINE_RENDITION_ABOVE) return thumbnailUrl.replace("rendition=thumbnail", "rendition=inline")
  return previewUrl
}
