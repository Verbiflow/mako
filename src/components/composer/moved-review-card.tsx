import { CheckIcon, GitBranchIcon } from "lucide-react"
import type { MoveOutcome } from "@mako/host/contracts/workspace-moves"
import { NoticeAction } from "@/components/ui/notice"
import { cn } from "@/lib/utils"
import { useAcp } from "@/state/acp"
import { moveReviews, unsure, useMoveReviews, type MoveReview } from "@/state/workspace-moves"

const CARD =
  "mx-2 mt-2 shrink-0 rounded-xl bg-popover text-ui text-foreground [box-shadow:inset_0_0_0_0.5px_var(--hairline)] motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1 motion-safe:duration-200 motion-safe:ease-[var(--ease-out)]"

const files = (count: number) => `${count} ${count === 1 ? "file" : "files"}`

/**
 * After a move, what the person may want to adjust, until they dismiss it:
 * the files Mako took on a best guess (only this Thread was working when
 * they changed), each of which can go back to the project folder, and the
 * files that stayed because Mako couldn't tell, which can follow. Nothing
 * here blocks the agent. Registered on `composer.above`.
 */
export function MovedReviewCard() {
  const activeKey = useAcp((state) => state.activeKey)
  const review = useMoveReviews((state) => (activeKey ? state.reviews[activeKey] : undefined))
  if (!activeKey || !review) return null
  return <Review conversationId={activeKey} review={review} />
}

function Review({ conversationId, review }: { conversationId: string; review: MoveReview }) {
  const { outcome, returned, busy } = review
  const guessed = outcome.likely?.paths ?? []
  const unlisted = Math.max(0, (outcome.likely?.files ?? 0) - guessed.length)
  const stayed = unsure(outcome.stayed)
  const rows = [...guessed.map((path) => ({ path, back: false })), ...returned.map((path) => ({ path, back: true }))]
  const working = busy !== null
  const where = review.branch ? `this thread's branch, ${review.branch}` : "this thread's worktree"

  const title = rows.length
    ? guessed.length
      ? `${files(guessed.length + unlisted)} came along on a best guess`
      : `${files(returned.length)} put back in the project folder`
    : `${files(stayed)} stayed in the project folder`
  const one = guessed.length + unlisted === 1
  const description = rows.length
    ? guessed.length
      ? one
        ? `Only this thread was working when it changed, so Mako moved it to ${where}. Put it back if it isn't this thread's.`
        : `Only this thread was working when they changed, so Mako moved them to ${where}. Put back any that aren't this thread's.`
      : returned.length === 1
        ? "It's as it was before the move, and out of the worktree. The agent hears on its next turn."
        : "They're as they were before the move, and out of the worktree. The agent hears on its next turn."
    : stayed === 1
      ? "Mako couldn't tell whether it's this thread's. Bring it if it is."
      : "Mako couldn't tell whether they're this thread's. Bring them if they are."

  return (
    <section role="group" aria-label="Files the move took or left" data-move-review className={CARD}>
      <div className="flex items-start gap-3 px-3 py-2.5">
        <span aria-hidden className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg bg-fill-hover">
          <GitBranchIcon className="size-3.5 text-foreground" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="leading-5">{title}</p>
          <p className="mt-0.5 text-label leading-relaxed text-muted-foreground">{description}</p>
          {rows.length ? (
            <ul className="mt-2 max-h-36 divide-y divide-hairline overflow-y-auto rounded-lg [box-shadow:inset_0_0_0_0.5px_var(--hairline)]">
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
              {unlisted ? <li className="px-2.5 py-1 text-label text-faint">and {files(unlisted)} more</li> : null}
            </ul>
          ) : null}
          {rows.length && stayed ? (
            <p data-move-review-stayed className="mt-2 flex min-w-0 items-baseline gap-1.5 text-label text-faint">
              <span className="min-w-0 truncate" title={stayedPaths(outcome).join("\n")}>
                Also stayed in the project folder: {files(stayed)} Mako couldn't place.
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
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            {!rows.length ? (
              <>
                <NoticeAction disabled={working} onClick={() => void moveReviews.bring(conversationId)}>
                  {busy === "bring" ? "Bringing…" : stayed === 1 ? "Bring it" : "Bring them"}
                </NoticeAction>
                <span title={stayedPaths(outcome).join("\n")}>
                  <NoticeAction quiet disabled={working} onClick={() => moveReviews.dismiss(conversationId)}>
                    {stayed === 1 ? "Leave it" : "Leave them"}
                  </NoticeAction>
                </span>
              </>
            ) : (
              <>
                <NoticeAction disabled={working} onClick={() => moveReviews.dismiss(conversationId)}>
                  {guessed.length ? (guessed.length === 1 ? "Keep it" : "Keep them") : "Done"}
                </NoticeAction>
                {guessed.length > 1 ? (
                  <NoticeAction quiet disabled={working} onClick={() => void moveReviews.putBack(conversationId, guessed)}>
                    Put all back
                  </NoticeAction>
                ) : null}
              </>
            )}
          </div>
        </div>
      </div>
    </section>
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

/** What stayed, path by path, for a tooltip. */
function stayedPaths(outcome: MoveOutcome): string[] {
  const listed = (label: string, share: { files: number; paths: string[] }) =>
    share.files ? [`${label}: ${share.paths.join(", ")}${share.files > share.paths.length ? `, and ${share.files - share.paths.length} more` : ""}`] : []
  return [...listed("Might be its", outcome.stayed.uncertain), ...listed("Changed before Mako was watching", outcome.stayed.unattributed)]
}
