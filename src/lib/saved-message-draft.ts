import type { LiveRequest } from "@/lib/types"
import { classify, type Attachment } from "@/lib/attachments"
import { attachmentReference } from "@/lib/attachment-references"
import { sentDraft } from "@/lib/context/draft"
import { readSent } from "@/lib/context/sent"
import { readMessage } from "@/lib/context/wire"
import type { ProposedPlan } from "@mako/sessions/content"

/**
 * An editable copy of a message that was sent or tried: its words with its
 * chips, read the way the transcript reads it (`readSent`), and the files it
 * carried. The request and its native delivery receipt stay intact.
 */
export interface SavedMessageDraft {
  text: string
  attachments: Attachment[]
  plans: ProposedPlan[]
}

export function savedMessageDraft(
  request: Pick<LiveRequest, "id" | "text" | "displayText" | "attachments">
): SavedMessageDraft {
  const raw = request.displayText ?? request.text
  const sent = readSent(raw)
  // An older prompt's appendix is transport only when its files are the ones
  // the request carried: a user-authored example must not disappear. Mako's
  // own block can't be typed, so it is always the message's.
  const files = sent.items.flatMap((item) => (item.kind === "file" ? [item.file] : []))
  const trusted =
    readMessage(raw).items.length > 0 ||
    files.every((file) => request.attachments.some((carried) => carried.path === file.path && carried.name === file.name))
  const draft = trusted ? sentDraft(sent) : { text: raw, records: [], plans: [] }
  const records = [...draft.records]
  let text = draft.text
  request.attachments.forEach((file, at) => {
    const known = records.find((record) => record.stagedPath && record.stagedPath === file.path)
    const kind = classify({ name: file.name, type: file.mimeType })
    if (known) {
      // The request kept the bytes an image went out with.
      if (kind === "image" && file.data && !known.data) known.data = file.data
      return
    }
    const record: Attachment = {
      id: `saved:${request.id}:${at}`,
      index: records.length + 1,
      name: file.name,
      mimeType: file.mimeType,
      size: file.size,
      kind,
      stagedPath: file.path,
      data: kind === "image" ? file.data : undefined,
      error: !file.path && !(kind === "image" && file.data)
        ? "This file is unavailable. Attach it again before sending."
        : undefined,
    }
    records.push(record)
    text = `${text}${text && !/\s$/.test(text) ? " " : ""}${attachmentReference(record)} `
  })
  return { text, attachments: records, plans: draft.plans }
}

export type RestoreSavedMessageEvent = CustomEvent<{ conversationId: string; requestId: string }>
declare global {
  interface WindowEventMap {
    "mako:restore-saved-message": RestoreSavedMessageEvent
  }
}
