import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { Action } from "@/components/ui/kit"
import {
  addReviewToMessage,
  review,
  useReview,
  type ReviewComment,
} from "@/state/review"
import { useCommentTarget } from "@/components/inspector/comment-target"
import { cn } from "@/lib/utils"
import { MessageSquarePlusIcon, PencilIcon, Trash2Icon } from "lucide-react"

/**
 * Comments on the diff.
 *
 * Rendered through the diff engine's own annotation slot rather than as an
 * overlay, so a comment sits between the lines and moves with them — an
 * absolutely-positioned bubble would need to track scroll, virtualization and
 * hunk expansion, and would be wrong the first time any of the three moved.
 */

/** The comment shown under a line, or the field for writing one, and picked lines ending on it. */
export function Annotation({
  workspace,
  path,
  line,
  side,
  comments,
  selection,
}: {
  workspace: string
  path: string
  line: number
  side: "additions" | "deletions"
  comments: ReviewComment[]
  /** Lines picked in the diff that end on this line, ready to add to the message. */
  selection?: ReactNode
}) {
  const draft = useReview((state) => state.draft)
  const editing =
    draft?.workspace === workspace &&
    draft.path === path &&
    draft.line === line &&
    draft.side === side
  const mine = comments.filter(
    (comment) => comment.line === line && comment.side === side
  )

  return (
    <div className="border-y border-hairline bg-surface/60 px-3 py-1.5">
      {mine.map((comment) =>
        editing && draft?.id === comment.id ? (
          <Editor key={comment.id} initial={comment.body} />
        ) : (
          <SavedComment key={comment.id} comment={comment} />
        )
      )}
      {editing && !draft?.id ? <Editor initial="" /> : null}
      {selection ? <div className="py-0.5">{selection}</div> : null}
    </div>
  )
}

const SavedComment = memo(function SavedComment({
  comment,
}: {
  comment: ReviewComment
}) {
  const target = useCommentTarget()
  return (
    <div className="group flex items-start gap-2 py-0.5">
      <span className="mt-[3px] size-1.5 shrink-0 rounded-full bg-caution" />
      <p className="min-w-0 flex-1 text-ui leading-relaxed whitespace-pre-wrap text-foreground/85">
        {comment.body}
      </p>
      <button
        type="button"
        aria-label="Add this note to the message"
        title="Add to message"
        onClick={() => addReviewToMessage([comment], target.cwd(), target.conversation)}
        className="pressable shrink-0 rounded p-1 text-faint opacity-0 transition-opacity duration-100 group-hover:opacity-100 focus-visible:opacity-100 hover:text-foreground"
      >
        <MessageSquarePlusIcon className="size-3" />
      </button>
      <button
        type="button"
        aria-label="Edit"
        onClick={() => review.edit(comment)}
        className="pressable shrink-0 rounded p-1 text-faint opacity-0 transition-opacity duration-100 group-hover:opacity-100 hover:text-foreground"
      >
        <PencilIcon className="size-3" />
      </button>
      <button
        type="button"
        aria-label="Delete"
        onClick={() => review.remove(comment.id)}
        className="pressable shrink-0 rounded p-1 text-faint opacity-0 transition-opacity duration-100 group-hover:opacity-100 hover:text-removed"
      >
        <Trash2Icon className="size-3" />
      </button>
    </div>
  )
})

function Editor({ initial }: { initial: string }) {
  const [body, setBody] = useState(initial)
  const field = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    field.current?.focus()
    field.current?.setSelectionRange(initial.length, initial.length)
  }, [initial.length])

  return (
    <div className="py-0.5">
      <textarea
        ref={field}
        value={body}
        rows={2}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          // ⌘↩ saves and ⎋ abandons, matching every other field in the app.
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            review.save(body)
          }
          if (event.key === "Escape") {
            event.preventDefault()
            review.cancel()
          }
        }}
        placeholder="What is wrong with this line?"
        className="w-full resize-none rounded-md bg-raised px-2 py-1.5 text-ui leading-relaxed placeholder:text-faint focus:outline-none focus-visible:ring-1 focus-visible:ring-border"
      />
      <div className="mt-1 flex items-center gap-2">
        <Action tone="outline" onClick={() => review.save(body)}>
          Save
        </Action>
        <Action tone="ghost" onClick={() => review.cancel()}>
          Cancel
        </Action>
        <span className="ml-auto text-label text-faint">⌘↩ to save</span>
      </div>
    </div>
  )
}

/**
 * The control in the gutter of whichever line is hovered.
 *
 * A custom slot owns its own click: the renderer refuses `renderGutterUtility`
 * and `onGutterUtilityClick` together, so `getHoveredLine()` is how this knows
 * which line it is on.
 *
 * No wrapper. The renderer already puts this inside its own slot element
 * carrying `GutterUtilitySlotStyles` — absolutely positioned, pinned top and
 * bottom, with no width of its own. Adding a second div with the same styles
 * nested it inside a zero-width box, and the button measured 0×0: present in
 * the DOM, findable by label, and invisible. That is a worse failure than not
 * rendering at all, because everything about it looks correct.
 *
 * Its press stops at the button: the diff picks lines from a press in the
 * gutter, and a note's line would otherwise also become a picked range.
 */
export function GutterAdd({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label="Comment on this line"
      ref={stopPress}
      onClick={onClick}
      className={cn(
        "pressable absolute top-1/2 left-1/2 flex size-4 -translate-x-1/2 -translate-y-1/2",
        "items-center justify-center rounded bg-raised text-faint ring-1 ring-hairline",
        "transition-colors duration-100 hover:text-foreground"
      )}
    >
      <MessageSquarePlusIcon className="size-2.5" />
    </button>
  )
}

/**
 * The diff listens on its own element, inside its shadow root, which a
 * React handler only reaches after the event has passed it.
 */
function stopPress(button: HTMLButtonElement | null) {
  if (!button) return
  const stop = (event: PointerEvent) => event.stopPropagation()
  button.addEventListener("pointerdown", stop)
  return () => button.removeEventListener("pointerdown", stop)
}

/**
 * The bar that turns a page of notes into the message's chips.
 *
 * It adds to the composer rather than sending, so the last word is still
 * yours, and it adds beside what is already written: a review usually wants a
 * sentence of framing on top, and replacing the draft would throw away the
 * one already there.
 */
export function ReviewBar({ workspace }: { workspace: string }) {
  const target = useCommentTarget()
  const allComments = useReview((state) => state.comments)
  const comments = useMemo(
    () => allComments.filter((comment) => comment.workspace === workspace),
    [allComments, workspace]
  )
  const count = comments.length
  const files = useMemo(
    () => new Set(comments.map((comment) => comment.path)).size,
    [comments]
  )

  if (count === 0) return null

  return (
    <div className="flex shrink-0 items-center gap-2 border-t border-hairline bg-surface px-2.5 py-1.5">
      <span className="size-1.5 shrink-0 rounded-full bg-caution" />
      <span className="min-w-0 flex-1 truncate text-ui text-muted-foreground">
        {count} {count === 1 ? "note" : "notes"} on {files}{" "}
        {files === 1 ? "file" : "files"}
      </span>
      <button
        type="button"
        onClick={() => review.clear(workspace)}
        className="pressable rounded px-1 text-label text-faint hover:text-foreground"
      >
        Discard
      </button>
      <Action
        tone="solid"
        onClick={() => addReviewToMessage(comments, target.cwd(), target.conversation)}
      >
        Add {count} {count === 1 ? "note" : "notes"} to message
      </Action>
    </div>
  )
}
