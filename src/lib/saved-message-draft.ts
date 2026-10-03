import type { LiveRequest } from "@/lib/types"
import { classify, parseAttachmentAppendix, type Attachment } from "@/lib/attachments"
import { namedAttachmentReference, restoreAttachmentReferences } from "@/lib/attachment-references"

/** Prepare an editable copy. The request and its native delivery receipt stay intact. */
export function savedMessageDraft(request: Pick<LiveRequest, "id" | "text" | "displayText" | "attachments">) {
  const parsed = parseAttachmentAppendix(request.displayText ?? request.text)
  const matches = parsed.files.length > 0 && parsed.files.every((entry) =>
    request.attachments.some((file) => file.path === entry.path && file.name === entry.name))
  const references: string[] = []
  const attachments: Attachment[] = request.attachments.map((file, at) => {
    const index = (matches ? parsed.files.find((entry) => entry.path === file.path)?.index : undefined) ?? at + 1
    const kind = classify({ name: file.name, type: file.mimeType })
    const reference = namedAttachmentReference(file.name, index, references)
    references.push(reference)
    return {
      id: `saved:${request.id}:${at}`,
      index,
      name: file.name,
      reference,
      mimeType: file.mimeType,
      size: file.size,
      kind,
      stagedPath: file.path,
      data: kind === "image" ? file.data : undefined,
      error: !file.path && !(kind === "image" && file.data)
        ? "This file is unavailable. Attach it again before sending."
        : undefined,
    }
  })
  // A parsed appendix is transport metadata only when its file set matches the
  // saved request. A user-authored example must not disappear on restoration.
  return {
    text: restoreAttachmentReferences(matches ? parsed.body : request.displayText ?? request.text, attachments),
    attachments,
  }
}

export type RestoreSavedMessageEvent = CustomEvent<{ conversationId: string; requestId: string }>
declare global {
  interface WindowEventMap {
    "mako:restore-saved-message": RestoreSavedMessageEvent
  }
}
