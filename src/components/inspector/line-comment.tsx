import { useEffect, useRef, useState } from "react"
import { MessageSquarePlusIcon } from "lucide-react"
import { Action } from "@/components/ui/kit"
import { COMMENT_TEXT_LIMIT } from "@/lib/line-comments"
import { cn } from "@/lib/utils"

/**
 * Picked lines, about to become a chip in the message: which lines they
 * are, an optional line of comment, and Add to message. Enter adds and
 * Escape closes, from the field or the button.
 *
 * The file viewer floats it under the last picked line; a diff shows it in
 * the diff's own annotation slot, where notes sit, so it moves with the
 * lines when hunks expand or the stream scrolls.
 */
export function LineCommentField({
  label,
  focus = false,
  onAdd,
  onClose,
  className,
}: {
  /** `review.ts:200–208`, the label the chip will read. */
  label: string
  /** Take focus as it appears. Not after a text selection, whose highlight focus would clear. */
  focus?: boolean
  onAdd: (comment: string) => void
  onClose: () => void
  className?: string
}) {
  const [comment, setComment] = useState("")
  const field = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (focus) field.current?.focus({ preventScroll: true })
  }, [focus, label])

  return (
    <div
      data-line-comment={label}
      // A diff's annotation slot inherits the code face; the field is UI.
      // In a split diff's half column it wraps rather than crushing the field.
      className={cn("flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 font-sans", className)}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return
        // The file viewer closes itself on Escape; this one belongs to the field.
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }}
    >
      <span className="shrink-0 font-mono text-label text-faint">{label}</span>
      <input
        ref={field}
        value={comment}
        maxLength={COMMENT_TEXT_LIMIT}
        onChange={(event) => setComment(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.nativeEvent.isComposing) return
          event.preventDefault()
          onAdd(comment)
        }}
        aria-label={`Comment on ${label}`}
        placeholder="Comment (optional)"
        className="h-6 min-w-40 flex-1 rounded-md bg-raised px-2 text-ui placeholder:text-faint focus:outline-none focus-visible:ring-1 focus-visible:ring-border"
      />
      <Action size="xs" tone="outline" aria-label={`Add ${label} to message`} onClick={() => onAdd(comment)}>
        <MessageSquarePlusIcon />
        Add to message
      </Action>
    </div>
  )
}
