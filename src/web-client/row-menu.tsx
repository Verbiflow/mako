import { useState } from "react"
import { ArchiveIcon, CheckIcon, ChevronRightIcon, CircleDashedIcon, LinkIcon, MailIcon, MailOpenIcon, PencilIcon } from "lucide-react"
import { toast } from "sonner"
import { WORK_STATUSES, WORK_STATUS_WORDS, type ThreadMarkChange, type WorkStatus } from "@mako/host/contracts/thread-marks"
import { WorkGlyph } from "@/components/rail/work-status"
import { whileBusy } from "./busy"
import { useWebClient } from "./client"
import { markSeen, markUnread } from "./read-state"
import { canMark, markOnOwner, shownMarks, useAskedMarks } from "./thread-marks"
import { askedRename } from "./renames"
import { routeHref } from "./route"
import { Sheet, SheetScroll } from "./sheet"
import type { WebThread } from "./threads"

/**
 * What a row offers when it's held, as the desk's Thread menu does: Mark as unread (or read) and its Status first, then
 * rename it, copy its link, archive it. The marks are the Thread's, kept by its owner and shown on every device
 * (`mako:thread-mark`); Mark as unread is kept here too, so a Thread on a Mac that's off still lists as unread here.
 * Status, renaming and archiving ask its owner, so a Thread on a Mac that's off offers none of them. Pinning isn't
 * offered: the account keeps no pins yet, and one kept on this device alone would list differently on every other.
 */
export function RowMenu({ thread, open, anchor, onDismiss, onArchive, unread }: { thread: WebThread | undefined; open: boolean; anchor: HTMLElement | null; onDismiss: () => void; onArchive: (thread: WebThread) => void; unread: boolean }) {
  const client = useWebClient()
  const [naming, setNaming] = useState<string | undefined>(undefined)
  const [choosing, setChoosing] = useState(false)
  const status = useAskedMarks((state) => (thread ? shownMarks(thread, state).workStatus : undefined))
  if (!thread) return null
  const reachable = canMark(thread)
  const mark = async (change: ThreadMarkChange, refused: string) => {
    try {
      await markOnOwner(client, thread, change)
    } catch (error) {
      toast.error(refused, { description: error instanceof Error ? error.message : String(error) })
    }
  }
  const toggleUnread = () => {
    onDismiss()
    if (unread) markSeen(thread.id, thread.activityAt)
    else markUnread(thread.id)
    // Here at once; on its owner, for every device, when it can be asked. A refusal leaves this device's mark.
    if (reachable) void mark({ unread: !unread }, unread ? "Not marked as read on its computer" : "Not marked as unread on its computer")
  }
  const choose = (next: WorkStatus | null) => {
    onDismiss()
    if (next !== (status ?? null)) void mark({ status: next }, "The status wasn't changed")
  }
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
      <h3 className="web-sheet-title truncate">{choosing ? "Status" : thread.title}</h3>
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
        ) : choosing ? (
          <div role="group" aria-label="Status" data-status-choices className="flex flex-col">
            {WORK_STATUSES.map((entry) => (
              <button key={entry} type="button" data-work-status-choice={entry} aria-pressed={status === entry} className="web-choice" onClick={() => choose(entry)}>
                <WorkGlyph status={entry} className="size-[18px]" />
                <span className="flex-1">{WORK_STATUS_WORDS[entry]}</span>
                {status === entry ? <CheckIcon aria-hidden className="size-[18px] text-muted-foreground" /> : null}
              </button>
            ))}
            <button type="button" data-work-status-choice="none" aria-pressed={!status} disabled={!status} className="web-choice" onClick={() => choose(null)}>
              <span aria-hidden className="size-[18px]" />
              <span className="flex-1">No status</span>
              {status ? null : <CheckIcon aria-hidden className="size-[18px] text-muted-foreground" />}
            </button>
          </div>
        ) : (
          <>
            <button type="button" data-row-action="unread" className="web-choice" onClick={toggleUnread}>
              {unread ? <MailOpenIcon aria-hidden className="size-[18px] text-muted-foreground" /> : <MailIcon aria-hidden className="size-[18px] text-muted-foreground" />}
              {unread ? "Mark as read" : "Mark as unread"}
            </button>
            {reachable ? (
              <button type="button" data-row-action="status" className="web-choice" onClick={() => setChoosing(true)}>
                {status ? <WorkGlyph status={status} className="size-[18px]" /> : <CircleDashedIcon aria-hidden className="size-[18px] text-muted-foreground" />}
                <span className="flex-1">Status</span>
                <span className="text-label text-faint">{status ? WORK_STATUS_WORDS[status] : "None"}</span>
                <ChevronRightIcon aria-hidden className="size-4 text-faint" />
              </button>
            ) : null}
            {reachable ? (
              <button type="button" className="web-choice" onClick={() => setNaming(thread.title)}>
                <PencilIcon aria-hidden className="size-[18px] text-muted-foreground" />
                Rename
              </button>
            ) : null}
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
