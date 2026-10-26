import { CheckIcon } from "lucide-react"
import { NoticeAction } from "@/components/ui/notice"
import { cn } from "@/lib/utils"
import { fileCount, stayedPaths } from "@/lib/moved-files"
import { moveReviews, unsure, type MoveReview } from "@/state/workspace-moves"

/** The files a move took or left, each to put back or bring, under the notice's line. */
export function MovedReviewDetail({ conversationId, review, description }: { conversationId: string; review: MoveReview; description: string }) {
  const { outcome, returned, busy } = review
  const guessed = outcome.likely?.paths ?? []
  const unlisted = Math.max(0, (outcome.likely?.files ?? 0) - guessed.length)
  const stayed = unsure(outcome.stayed)
  const rows = [...guessed.map((path) => ({ path, back: false })), ...returned.map((path) => ({ path, back: true }))]
  const working = busy !== null
  return (
      <div className="flex flex-col gap-2">
        <p>{description}</p>
        {rows.length ? (
          <ul className="max-h-36 divide-y divide-hairline overflow-y-auto rounded-lg [box-shadow:inset_0_0_0_0.5px_var(--hairline)]">
            {rows.map(({ path, back }) => (
              <FileRow
                key={path}
                path={path}
                back={back}
                pending={Array.isArray(busy) && busy.includes(path)}
                disabled={working}
                onPutBack={() => void moveReviews.putBack(conversationId, [path])}
              />
            ))}
            {unlisted ? <li className="px-2.5 py-1 text-label text-faint">and {fileCount(unlisted)} more</li> : null}
          </ul>
        ) : null}
        {rows.length && stayed ? (
          <p data-move-review-stayed className="flex min-w-0 items-baseline gap-1.5 text-label text-faint">
            <span className="min-w-0" title={stayedPaths(outcome).join("\n")}>
              Also stayed in the project folder: {fileCount(stayed)} Mako couldn't place.
            </span>
            <button
              type="button"
              disabled={working}
              onClick={() => void moveReviews.bring(conversationId)}
              className="pressable shrink-0 rounded text-label text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-45"
            >
              {busy === "bring" ? "Bringing…" : stayed === 1 ? "Bring it" : "Bring them"}
            </button>
          </p>
        ) : null}
      </div>
)
}

function FileRow({ path, back, pending, disabled, onPutBack }: { path: string; back: boolean; pending: boolean; disabled: boolean; onPutBack(): void }) {
  const slash = path.lastIndexOf("/")
  const name = path.slice(slash + 1)
  const folder = slash > 0 ? path.slice(0, slash) : ""
  return (
    <li data-move-review-file={back ? "back" : "came"} className="flex min-h-7 items-center gap-2 py-0.5 pr-1 pl-2.5">
      <span className={cn("flex min-w-0 flex-1 items-baseline gap-1.5 text-label", back && "text-faint")} title={path}>
        <span className={cn("shrink-0", !back && "text-foreground")}>{name}</span>
        {folder ? <span className="min-w-0 truncate text-faint">{folder}</span> : null}
      </span>
      {back ? (
        <span className="flex shrink-0 items-center gap-1 px-2 text-label text-faint">
          <CheckIcon aria-hidden className="size-3" />
          Back in the project folder
        </span>
      ) : (
        <NoticeAction quiet disabled={disabled} onClick={onPutBack}>
          {pending ? "Putting back…" : "Put back"}
        </NoticeAction>
      )}
    </li>
  )
}
