import type { ClipboardEvent } from "react"
import type { Attachment } from "@/lib/attachments"
import { attachmentReference } from "@/lib/attachment-references"
import { promptClipboard } from "@/lib/prompt-clipboard"

export function copyPromptSelection(event: ClipboardEvent<HTMLElement>, attachments: readonly Attachment[]) {
  const selection = window.getSelection()
  if (!selection?.rangeCount || selection.isCollapsed) return
  const range = selection.getRangeAt(0).cloneRange()
  if (!event.currentTarget.contains(range.startContainer) || !event.currentTarget.contains(range.endContainer)) return
  for (const edge of ["start", "end"] as const) {
    const node = edge === "start" ? range.startContainer : range.endContainer
    const element = node instanceof Element ? node : node.parentElement
    const reference = element?.closest("[data-copy-reference], [data-copy-file]")
    if (reference) {
      if (edge === "start") range.setStartBefore(reference)
      else range.setEndAfter(reference)
    }
  }
  const fragment = range.cloneContents()
  const references = fragment.querySelectorAll("[data-copy-reference], [data-copy-file]")
  if (!references.length) return
  const copied = new Map<string, Attachment>()
  for (const reference of references) {
    const file = reference.getAttribute("data-copy-file")
    const item = attachments.find(item => item.stagedPath === file)
    if (item) copied.set(item.id, item)
    reference.replaceWith(item ? attachmentReference(item) : reference.getAttribute("data-copy-reference") ?? reference.textContent)
  }
  for (const block of fragment.querySelectorAll("p, pre, li, h1, h2, h3, h4, h5, h6, br")) block.append("\n")
  event.preventDefault()
  const text = fragment.textContent.trimEnd()
  try {
    const payload = promptClipboard(text, [...copied.values()])
    event.clipboardData.setData("text/plain", payload.text)
    event.clipboardData.setData("text/html", payload.html)
  } catch {
    event.clipboardData.setData("text/plain", text)
  }
}
