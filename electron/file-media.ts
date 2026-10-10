import { fileMimeTypeForPath } from "./contracts/file-preview.js"
import type { FileContents } from "./shared.js"
import { heavy } from "./heavy-packages.js"

interface MediaType {
  media: NonNullable<FileContents["media"]>
  mimeType: string
}

/** Detect only the supplied bounded prefix; never read/decompress the whole file. */
export async function fileContentType(
  path: string,
  head: Buffer
): Promise<string | undefined> {
  const { fileTypeFromBuffer } = await heavy.fileType.load("file type")
  const detected = await fileTypeFromBuffer(head)
  if (detected) {
    // An ISO-BMFF prefix identifies the container, not its track layout. Use
    // the maintained audio MIME hint only for this ambiguous MP4 container.
    const hint = fileMimeTypeForPath(path)
    return detected.mime === "video/mp4" && hint === "audio/mp4"
      ? hint
      : detected.mime
  }
  // file-type deliberately excludes text formats. Extensionless SVG remains a
  // bounded text probe; validation/rendering still belongs to the image decoder.
  if (/^\s*(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)/u.test(head.toString("utf8")))
    return "image/svg+xml"
  return fileMimeTypeForPath(path)
}

export async function fileMedia(
  path: string,
  head: Buffer
): Promise<MediaType | undefined> {
  return mediaForContentType(await fileContentType(path, head))
}
export function mediaForContentType(
  mimeType: string | undefined
): MediaType | undefined {
  if (!mimeType) return undefined
  const media = mimeType.startsWith("image/")
    ? "image"
    : mimeType.startsWith("audio/")
      ? "audio"
      : mimeType.startsWith("video/")
        ? "video"
        : mimeType === "application/pdf"
          ? "pdf"
          : /(?:spreadsheet|excel|numbers)/.test(mimeType)
            ? "spreadsheet"
            : undefined
  return media ? { media, mimeType } : undefined
}
