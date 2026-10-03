import { z } from "zod"
import { SavedAttachmentSchema } from "./draft-persistence"
import { buildForeignPrompt, parseAttachmentAppendix, type Attachment } from "./attachments"
import { attachmentRanges, attachmentReference, restoreAttachmentReferences, reusablePromptAttachments } from "./attachment-references"

const MAX_CLIPBOARD_LENGTH = 4 * 1024 * 1024
const ClipboardDraftSchema = z.object({
  version: z.literal(1),
  text: z.string().max(MAX_CLIPBOARD_LENGTH),
  attachments: z.array(SavedAttachmentSchema.extend({
    index: z.number().int().positive(),
    stagedPath: z.string().min(1),
    size: z.number().nonnegative().optional(),
  })).max(256),
}).refine(({ attachments }) =>
  new Set(attachments.map(item => item.id)).size === attachments.length &&
  new Set(attachments.map(item => item.index)).size === attachments.length &&
  new Set(attachments.map(attachmentReference)).size === attachments.length
)

export function promptClipboard(text: string, attachments: readonly Attachment[]) {
  if (attachments.some(item => item.pending || item.error || !item.stagedPath)) {
    throw new Error("Wait for attachments to finish adding before copying. Remove and reattach any failed files.")
  }
  const payload = JSON.stringify(ClipboardDraftSchema.parse({ version: 1, text, attachments }))
  if (payload.length > MAX_CLIPBOARD_LENGTH) throw new Error("This selection is too large to copy with attachments. Copy a smaller selection.")
  const escaped = text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  return {
    text: attachments.length ? buildForeignPrompt(text, [...attachments]) : text,
    html: `<pre data-mako-draft="${encodeURIComponent(payload)}">${escaped}</pre>`,
  }
}

function parseRichClipboard(html: string) {
  if (html.length > MAX_CLIPBOARD_LENGTH * 4) return null
  const encoded = /data-mako-draft="([^"]+)"/.exec(html)?.[1]
  if (!encoded) return null
  try {
    const decoded = decodeURIComponent(encoded)
    if (decoded.length > MAX_CLIPBOARD_LENGTH) return null
    const parsed = ClipboardDraftSchema.safeParse(JSON.parse(decoded))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export function parsePromptClipboard(text: string, html = ""): { text: string; attachments: Attachment[] } | null {
  const rich = parseRichClipboard(html)
  if (rich) return rich
  if (text.length > MAX_CLIPBOARD_LENGTH) return null
  const parsed = parseAttachmentAppendix(text)
  if (!parsed.files.length) return null
  const attachments = reusablePromptAttachments(parsed.files, [])
  const restored = ClipboardDraftSchema.safeParse({ version: 1, text: restoreAttachmentReferences(parsed.body, attachments), attachments })
  return restored.success ? restored.data : null
}

export function clipboardSelection(text: string, items: readonly Attachment[], start: number, end: number) {
  const ranges = attachmentRanges(text, items).filter(range => range.start < end && range.end > start)
  const from = Math.min(start, ...ranges.map(range => range.start))
  const to = Math.max(end, ...ranges.map(range => range.end))
  return {
    start: from,
    end: to,
    text: text.slice(from, to),
    attachments: [...new Map(ranges.map(range => [range.item.id, range.item])).values()],
  }
}
