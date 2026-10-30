import { useMemo } from "react"
import type { FileDiffMetadata } from "@pierre/diffs"
import { LineCommentField } from "@/components/inspector/line-comment"
import { commentInput, commentLabel, diffCommentDetails, type LineRange } from "@/lib/line-comments"
import { addContext } from "@/state/composer-context"
import { useCommentTarget } from "@/components/inspector/comment-target"

/**
 * Lines picked in a diff. The diff engine picks them (a press on a line
 * number, shift-press or a drag to extend) and tints them with
 * `--fill-selected`; this is what the picked range turns into: the field
 * under its last line, and a chip per side in the message.
 */

/** The field for a picked range of a diff; adding puts one chip per side into the message. */
export function PickedDiffLines({ path, base, diff, range, onDone }: {
  /** Workspace-relative, as the chip names it. */
  path: string
  base?: string
  diff: FileDiffMetadata | null
  range: LineRange
  onDone: () => void
}) {
  const label = useMemo(
    () => {
      const details = diff ? diffCommentDetails({ path, base, diff, range }) : []
      // Across both sides each file's lines are named with their side.
      return details.map((detail) => (details.length > 1 ? `${commentLabel(detail)} ${detail.side}` : commentLabel(detail))).join(", ")
    },
    [base, diff, path, range]
  )
  const target = useCommentTarget()
  if (!diff || !label) return null
  return (
    <LineCommentField
      label={label}
      focus
      onClose={onDone}
      onAdd={(comment) => {
        // Kept open, words and all, when the composer it's for isn't there to take it.
        const taken = diffCommentDetails({ path, base, diff, range, comment }).map((detail) => addContext(commentInput(detail), target.conversation))
        if (taken.every(Boolean)) onDone()
      }}
    />
  )
}
