import { toast } from "sonner"
import { inboxModel, inboxView, inboxViewStore, openInboxItem } from "@/state/inbox"
import { stage } from "@/state/stage"
import { viewer } from "@/state/viewer"

/** The Inbox in the main pane, over the conversation, and the first item ready for Enter. */
export function openInbox(): void {
  viewer.showAgent()
  stage.showChat()
  inboxView.open()
  requestAnimationFrame(() => document.querySelector<HTMLElement>("[data-inbox-item]")?.focus())
}

/**
 * Cmd+Shift+U: the Inbox; pressed again with it open, the first thing in it,
 * which is what the chord did before the Inbox.
 */
export function inboxShortcut(): void {
  if (!inboxViewStore.get().open) return openInbox()
  const first = inboxModel().asks[0] ?? inboxModel().toRead[0]
  if (first) openInboxItem(first)
  else toast("Nothing is waiting for you")
}

