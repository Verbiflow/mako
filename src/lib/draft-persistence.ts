import { z } from "zod"
import { toast } from "sonner"
import type { Attachment } from "./attachments"

export const SavedAttachmentSchema = z.object({
  id: z.string(),
  index: z.number(),
  name: z.string(),
  reference: z.string().optional(),
  contextLabel: z.string().optional(),
  mimeType: z.string(),
  size: z.number(),
  kind: z.enum(["image", "text", "binary"]),
  stagedPath: z.string().optional(),
  contextPath: z.string().optional(),
  error: z.string().optional(),
})
let warned = false
const unsaved = new Map<string, string>()

export function assertDraftsSaved(): void {
  for (const [key, value] of unsaved) {
    try {
      if (!globalThis.localStorage) throw new Error("Draft storage is unavailable")
      globalThis.localStorage.setItem(key, value)
      unsaved.delete(key)
    } catch { throw new Error("A draft could not be saved. Mako stayed open. Copy your draft somewhere safe or free local storage before closing.") }
  }
}
function storageKey(key: string): string {
  const preview = new URLSearchParams(globalThis.location?.search).get("preview")
  return preview ? `mako.preview.${preview}.${key}` : key
}
export function writeDraftStorage(key: string, value: string): boolean {
  const target = storageKey(key)
  unsaved.set(target, value)
  try {
    if (!globalThis.localStorage) return false
    globalThis.localStorage.setItem(target, value)
    unsaved.delete(target)
    return true
  } catch {
    if (!warned) {
      warned = true
      toast.error(
        "This draft is kept in memory, but could not be saved for reopening"
      )
    }
    return false
  }
}
export function readDraftStorage(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(storageKey(key)) ?? null
  } catch {
    return null
  }
}
export function savedAttachment(item: Attachment) {
  const saved = SavedAttachmentSchema.parse(item)
  if (item.pending || !item.stagedPath)
    saved.error =
      "This file was not fully staged before closing. Attach it again."
  return saved
}

const KEY = "mako.attachment-drafts.v1"
export function readAttachmentDrafts(): Record<string, Attachment[]> {
  const raw = readDraftStorage(KEY)
  if (!raw) return {}
  try {
    return z
      .record(z.string(), z.array(SavedAttachmentSchema))
      .parse(JSON.parse(raw))
  } catch {
    return {}
  }
}
export function writeAttachmentDrafts(
  buckets: Record<string, Attachment[]>
): void {
  writeDraftStorage(
    KEY,
    JSON.stringify(
      Object.fromEntries(
        Object.entries(buckets).map(([key, items]) => [
          key,
          items.map(savedAttachment),
        ])
      )
    )
  )
}
