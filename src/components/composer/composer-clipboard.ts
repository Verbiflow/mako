import { useRef, type ClipboardEvent } from "react"
import { removedAttachments } from "@/lib/attachment-references"
import { toast } from "sonner"
import { ACTION_TOAST_MS } from "@/lib/toast-duration"
import type { useAttachments } from "@/lib/attachments"
import { clipboardSelection, parsePromptClipboard, promptClipboard } from "@/lib/prompt-clipboard"
import { toDraftOffset, toViewOffset, type DraftView } from "@/lib/draft-view"
import { tokenize } from "@/lib/mentions"

/**
 * A paste this long reads better as a file the agent opens than as a wall in
 * the draft: past either bound it becomes a text chip, and the toast offers
 * the words instead.
 */
const LONG_PASTE_CHARS = 12_000
const LONG_PASTE_LINES = 250

/** Files on the clipboard, from its file list and its items: a copied image arrives as either. */
function clipboardFiles(data: DataTransfer): File[] {
  const files = [...data.files]
  for (const item of data.items) {
    if (item.kind !== "file") continue
    const file = item.getAsFile()
    if (file && !files.some((known) => known.name === file.name && known.size === file.size && known.type === file.type))
      files.push(file)
  }
  // An image copied from a page or a screenshot tool has no name of its own.
  return files.map((file) =>
    file.name && file.name !== "image.png"
      ? file
      : new File([file], `Pasted image ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.${file.type.split("/")[1] || "png"}`, { type: file.type })
  )
}

/**
 * `current` reads the draft and what the textarea shows for it at the moment
 * of the event; `replacing` is told the selection an insertion replaces,
 * which `execCommand` doesn't announce with `beforeinput`.
 */
export function useComposerClipboard(
  attachments: ReturnType<typeof useAttachments>,
  current: () => { draft: string; view: DraftView },
  replacing: (node: HTMLTextAreaElement) => void
) {
  const inserting = useRef(false)
  const insert = (node: HTMLTextAreaElement, text: string) => {
    replacing(node)
    inserting.current = true
    try {
      document.execCommand("insertText", false, text)
    } finally {
      inserting.current = false
    }
  }
  /** The records an edit took out of the draft; their chips went whole (`editDraftView`). */
  const edit = (after: string) => removedAttachments(after, attachments.items)
  const copy = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const node = event.currentTarget
    if (node.selectionStart === node.selectionEnd) return
    // Chips copy as what they stand for, so pasting them here brings them back.
    const { draft, view } = current()
    const selected = clipboardSelection(
      draft,
      attachments.items,
      toDraftOffset(view, node.selectionStart, true),
      toDraftOffset(view, node.selectionEnd)
    )
    if (!selected.attachments.length && selected.text === node.value.slice(node.selectionStart, node.selectionEnd)) return
    event.preventDefault()
    try {
      const payload = promptClipboard(selected.text, selected.attachments)
      event.clipboardData.setData("text/plain", payload.text)
      event.clipboardData.setData("text/html", payload.html)
      if (event.type === "cut") {
        node.setSelectionRange(toViewOffset(view, selected.start, true), toViewOffset(view, selected.end))
        insert(node, "")
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }
  const paste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const data = event.clipboardData
    const text = data.getData("text/plain")
    const draft = parsePromptClipboard(text, data.getData("text/html"))
    const files = draft ? [] : clipboardFiles(data)
    const lines = text.split("\n").length
    const long = !draft && !files.length && (text.length > LONG_PASTE_CHARS || lines > LONG_PASTE_LINES)
    if (!draft && !files.length && !long) return
    event.preventDefault()
    const node = event.currentTarget
    if (long) {
      const name = `Pasted text, ${lines.toLocaleString()} ${lines === 1 ? "line" : "lines"}.txt`
      const chip = attachments.add([new File([text], name, { type: "text/plain" })])
      if (!chip) return
      insert(node, `${chip} `)
      const recordId = tokenize(chip).find((segment) => segment.kind === "context")
      toast(`Pasted ${lines.toLocaleString()} ${lines === 1 ? "line" : "lines"} as a file`, {
        duration: ACTION_TOAST_MS,
        action: {
          label: "Paste as text",
          onClick: () => {
            const { draft: now, view } = current()
            const at = now.indexOf(chip)
            if (at === -1) return
            node.focus()
            node.setSelectionRange(toViewOffset(view, at, true), toViewOffset(view, at + chip.length + 1))
            insert(node, text)
            if (recordId?.kind === "context") attachments.remove(recordId.id)
          },
        },
      })
      return
    }
    const insertion = draft
      ? attachments.paste(draft.text, draft.attachments)
      : [text, attachments.add(files)].filter(Boolean).join(text.endsWith(" ") || text.endsWith("\n") ? "" : " ")
    insert(node, insertion)
  }
  return { onCopy: copy, onCut: copy, onPaste: paste, edit, inserting }
}
