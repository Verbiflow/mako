import type { PromptAttachment } from "@mako/host/contracts/providers-acp"

/**
 * A message travels to its owner as one socket message, under 1 MiB on every hop (`MAX_EVENT_BYTES` is the runtime's
 * side of the same limit); its attachments go inside it, as base64. So a phone sends this much of them at most, and says
 * so for more. Larger files would go through the account's file store, which isn't built.
 */
export const ATTACHMENT_BUDGET = 700 * 1024

/** A photo is drawn to at most this many pixels on its long side: plenty for an agent to read, a fraction of the bytes. */
const LONG_SIDE = 2048
const JPEG_QUALITY = 0.85

/** A file the person picked, ready to send: its attachment, and a picture of it to show while it waits. */
export interface Picked {
  id: string
  attachment: PromptAttachment & { data: string; size: number }
  /** An object URL of the image, for its chip; none for other files. */
  preview?: string
}

/** What one attachment costs in a message: its base64. */
export function encodedBytes(picked: readonly Picked[]): number {
  return picked.reduce((sum, each) => sum + each.attachment.data.length, 0)
}

/** Kilobytes, as a person reads them. */
export function kilobytes(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function base64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""))
    reader.onerror = () => reject(reader.error ?? new Error("The file couldn't be read"))
    reader.readAsDataURL(blob)
  })
}

/** A picture the browser can draw, at most `LONG_SIDE` on its long side, as JPEG; a small PNG (a screenshot) as it is. */
async function scaled(file: File): Promise<{ blob: Blob; name: string; mimeType: string }> {
  const bitmap = await createImageBitmap(file).catch(() => undefined)
  if (!bitmap) return { blob: file, name: file.name, mimeType: file.type || "application/octet-stream" }
  const scale = Math.min(1, LONG_SIDE / Math.max(bitmap.width, bitmap.height))
  // A screenshot already small enough keeps its exact pixels, which text in it needs.
  if (scale === 1 && file.type === "image/png" && file.size * 1.37 <= ATTACHMENT_BUDGET) {
    bitmap.close()
    return { blob: file, name: file.name, mimeType: file.type }
  }
  const canvas = document.createElement("canvas")
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY))
  if (!blob) return { blob: file, name: file.name, mimeType: file.type }
  return { blob, name: file.name.replace(/\.(heic|heif|png|webp|jpe?g)$/i, "") + ".jpg", mimeType: "image/jpeg" }
}

const DRAWN = /^image\/(png|jpe?g|webp|heic|heif|avif|bmp)$/i

/** A picked file as an attachment, a photo made small first. */
export async function readPicked(file: File): Promise<Picked> {
  const image = DRAWN.test(file.type)
  const { blob, name, mimeType } = image ? await scaled(file) : { blob: file, name: file.name, mimeType: file.type || "application/octet-stream" }
  const data = await base64(blob)
  const picked: Picked = { id: crypto.randomUUID(), attachment: { name: name || "attachment", mimeType, size: blob.size, data } }
  if (mimeType.startsWith("image/")) picked.preview = URL.createObjectURL(blob)
  return picked
}

/** Lets go of what the chips drew. */
export function releasePicked(picked: readonly Picked[]): void {
  for (const each of picked) if (each.preview) URL.revokeObjectURL(each.preview)
}
