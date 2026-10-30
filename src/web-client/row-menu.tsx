import { useState } from "react"
import { ArchiveIcon, CircleDotIcon, LinkIcon, PencilIcon } from "lucide-react"
import { toast } from "sonner"
import { whileBusy } from "./busy"
import { useWebClient } from "./client"
import { markUnread } from "./read-state"
import { askedRename } from "./renames"
import { routeHref } from "./route"
import { Sheet, SheetScroll } from "./sheet"
import type { WebThread } from "./threads"

/**
 * What a row offers when it's held: rename the Thread, mark it unread, copy its link, archive it. A Thread on a Mac
 * that's off can only be marked and linked: renaming and archiving ask its owner. Pinning isn't offered: the account
 * keeps no pins yet, and one kept on this device alone would list differently on every other.
 */
export function RowMenu({ thread, open, anchor, onDismiss, onArchive, unread }: { thread: WebThread | undefined; open: boolean; anchor: HTMLElement | null; onDismiss: () => void; onArchive: (thread: WebThread) => void; unread: boolean }) {
  const client = useWebClient()
  const [naming, setNaming] = useState<string | undefined>(undefined)
  if (!thread) return null
  const reachable = !thread.quietSince && !thread.archived
  const copyLink = async () => {
    onDismiss()
    const link = new URL(routeHref({ kind: "thread", thread: thread.id }, client.options.base), location.origin).href
    try {
      await navigator.clipboard.writeText(link)
      toast.success("Link copied", { description: thread.title })
    } catch {
      toast.error("The link wasn't copied", { description: link })
    }
  }
  const rename = async (title: string) => {
    const words = title.trim()
    onDismiss()
    if (!words || words === thread.title) return
    const session = thread.sessions[0]!
    askedRename(thread.id, words)
    try {
      const conversations = await client.conversations()
      await whileBusy(conversations.call(session.row.conversation, "mako:thread-rename", [crypto.randomUUID(), thread.id, words]))
    } catch (error) {
      askedRename(thread.id, undefined)
      toast.error("Not renamed", { description: error instanceof Error ? error.message : String(error) })
    }
  }
  return (
    <Sheet open={open} onDismiss={onDismiss} label={thread.title} anchor={anchor}>
      <h3 className="web-sheet-title truncate">{thread.title}</h3>
      <SheetScroll className="flex flex-col px-2 pb-[calc(env(safe-area-inset-bottom)+12px)]">
        {naming !== undefined ? (
          <form
            className="flex flex-col gap-3 px-2 pt-1 pb-2"
            onSubmit={(event) => {
              event.preventDefault()
              void rename(naming)
            }}
          >
            {/* The field is what the person opened the rename for: it takes the keyboard at once. */}
            <input autoFocus aria-label="Thread name" value={naming} onChange={(event) => setNaming(event.target.value)} maxLength={400} enterKeyHint="done" className="web-field" />
            <button type="submit" className="web-button" disabled={!naming.trim()}>
              Rename
            </button>
          </form>
        ) : (
          <>
            {reachable ? (
              <button type="button" className="web-choice" onClick={() => setNaming(thread.title)}>
                <PencilIcon aria-hidden className="size-[18px] text-muted-foreground" />
                Rename
              </button>
            ) : null}
            {unread ? null : (
              <button
                type="button"
                className="web-choice"
                onClick={() => {
                  markUnread(thread.id)
                  onDismiss()
                }}
              >
                <CircleDotIcon aria-hidden className="size-[18px] text-muted-foreground" />
                Mark unread
              </button>
            )}
            <button type="button" className="web-choice" onClick={() => void copyLink()}>
              <LinkIcon aria-hidden className="size-[18px] text-muted-foreground" />
              Copy link
            </button>
            {reachable ? (
              <button
                type="button"
                className="web-choice"
                onClick={() => {
                  onDismiss()
                  onArchive(thread)
                }}
              >
                <ArchiveIcon aria-hidden className="size-[18px] text-muted-foreground" />
                Archive
              </button>
            ) : null}
          </>
        )}
      </SheetScroll>
    </Sheet>
  )
}
