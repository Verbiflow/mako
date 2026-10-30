import { MessageSquareIcon, XIcon } from "lucide-react"
import { openReview, touchReviewCode } from "./review-open"
import { dropReviewNote, noteLabel, useReviewNotes } from "./review-notes"
import { commentWords } from "./review-model"

/**
 * The comments waiting in this Session's next message, above its composer: each a chip with its lines, removable.
 * They go with whatever is sent next (`withReviewNotes`), never by themselves; "Review" opens Changes again.
 */
export function ReviewTray({ conversation }: { conversation: string }) {
  const notes = useReviewNotes(conversation)
  if (!notes.length) return null
  return (
    <div className="rv-tray" data-review-tray={notes.length} aria-label={`${commentWords(notes.length)} going with your next message`}>
      <ul role="list" className="web-scroll -my-1.5 flex min-w-0 flex-1 gap-1.5 overflow-x-auto py-1.5 pr-2">
        {notes.map((note) => (
          <li key={note.id} className="rv-tray-chip" title={note.detail.comment}>
            <MessageSquareIcon aria-hidden className="size-3.5 shrink-0 text-faint" />
            <span className="shrink-0 font-mono">{noteLabel(note)}</span>
            <span className="min-w-0 truncate text-faint">{note.detail.comment}</span>
            <button type="button" aria-label={`Remove the comment on ${noteLabel(note)}`} className="rv-tray-remove" onClick={() => dropReviewNote(conversation, note.id)}>
              <XIcon className="size-3.5" />
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="web-chip shrink-0"
        onClick={() => {
          void touchReviewCode.read()
          openReview({ conversation, scope: { kind: "thread" } })
        }}
      >
        Review
      </button>
    </div>
  )
}
