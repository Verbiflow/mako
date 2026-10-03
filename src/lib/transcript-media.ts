import type { AttachmentContent } from "@mako/sessions"
import { attachmentFromUrl } from "@mako/sessions/content"
import { markdownFileTarget } from "./file-citations"

// Preserve the public helper while sharing maintained MIME lookup with composer
// and preview routing. No renderer-owned list of media extensions.
export { fileMimeTypeForPath as mediaTypeForPath } from "../../electron/contracts/file-preview"
import { fileMimeTypeForPath as mediaTypeForPath } from "../../electron/contracts/file-preview"

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
