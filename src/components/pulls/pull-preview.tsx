import { useEffect, useState } from "react"
import { CheckIcon, CircleDotIcon, ExternalLinkIcon, MinusIcon, XIcon } from "lucide-react"
import { rowCode, type BoardIssue, type BoardPull, type BoardPullDetail } from "@mako/host/contracts/project-pulls"
import { Prose } from "@/components/transcript/markdown"
import { Action, IconAction, Keys } from "@/components/ui/kit"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { PullGlyph, IssueGlyph } from "@/components/pulls/board-rows"
import { pullNote } from "@/components/pulls/board-words"
import { openBoardRow } from "@/components/pulls/open-board-row"
import { readBoardPull } from "@/state/project-board"
import { formatRelative } from "@/lib/format"
import { cn } from "@/lib/utils"
import { desktop } from "@/state/desktop"

/*
 * The page's preview of the selected row, on the page's right: what it is, where it stands, its checks and reviews,
 * and its description. Enter opens a pull request as a tab; the preview reads its words when it's shown, never again
 * on its own.
 */

type Detail = { key: string; detail?: BoardPullDetail; failed?: true }

function usePullDetail(pull: BoardPull | undefined): Detail | undefined {
  const [held, setHeld] = useState<Detail>()
  const key = pull?.key
  const repository = pull?.repository
  const number = pull?.number
  useEffect(() => {
    if (!key || !repository || number === undefined) return
    let current = true
    // A short pause, so walking the list with j/k doesn't read every row it passes.
    const timer = window.setTimeout(() => {
      readBoardPull({ repository, number }).then(
        (detail) => { if (current) setHeld({ key, detail }) },
        () => { if (current) setHeld({ key, failed: true }) },
      )
    }, 250)
    return () => { current = false; window.clearTimeout(timer) }
  }, [key, repository, number])
  return held?.key === key ? held : undefined
}

export function BoardPreview({ row, multi, project }: { row: BoardPull | BoardIssue; multi: ReadonlySet<string>; project?: string }) {
  const pull = "head" in row ? row : undefined
  const issue = "head" in row ? undefined : row
  const held = usePullDetail(pull)
  return (
    <aside data-board-preview={row.key} aria-label="Preview" className="flex min-h-0 w-[min(420px,42%)] shrink-0 flex-col overflow-y-auto overscroll-contain bg-shell/40 px-5 pt-5 pb-16">
      <div className="flex items-center gap-2 text-label text-faint">
        {pull ? <PullGlyph pull={pull} /> : issue ? <IssueGlyph issue={issue} /> : null}
        <span className="tabular">{rowCode(row, multi)}</span>
        {project ? <span className="truncate">· {project}</span> : null}
        <span className="flex-1" />
        <IconAction size="xs" label="Open on GitHub" keys={["O"]} onClick={() => void desktop.openUrl(row.url)}><ExternalLinkIcon /></IconAction>
      </div>
      <h2 className="mt-2 text-title font-semibold text-foreground">{row.title}</h2>
      <p className="mt-1 text-label text-faint">
        {[row.author, pull ? `${pull.head} → ${pull.base}` : undefined, `updated ${formatRelative(row.updatedAt)}`].filter(Boolean).join(" · ")}
      </p>
      {pull ? (
        <>
          {pullNote(pull) ? <p className="mt-2 text-label text-attention">{pullNote(pull)}</p> : null}
          <div className="mt-4 flex items-center gap-2">
            <Action tone="quiet" size="sm" onClick={() => openBoardRow(pull, multi)}>Open as tab <Keys keys={["↵"]} /></Action>
          </div>
          <PullFacts held={held} />
        </>
      ) : (
        <>
          {issue?.labels.length ? <p className="mt-2 text-label text-muted-foreground">{issue.labels.join(", ")}</p> : null}
          <div className="mt-4"><Action tone="quiet" size="sm" onClick={() => void desktop.openUrl(row.url)}>Open on GitHub <Keys keys={["↵"]} /></Action></div>
        </>
      )}
    </aside>
  )
}

function PullFacts({ held }: { held: Detail | undefined }) {
  if (!held) return (
    <div className="mt-6 flex flex-col gap-2">
      <Skeleton className="h-3 w-40" />
      <Skeleton className="h-3 w-56" />
      <Skeleton className="h-3 w-48" />
    </div>
  )
  if (held.failed || !held.detail) return <p className="mt-6 text-label text-faint">GitHub didn't answer for this one. It's read again when you come back to it.</p>
  const { detail } = held
  const shown = detail.checks.filter((check) => check.state !== "skipped")
  const order = { failed: 0, running: 1, passed: 2, skipped: 3 } as const
  return (
    <>
      <p className="mt-5 text-label text-faint">
        <span className="text-positive">+{detail.additions}</span> <span className="text-negative">−{detail.deletions}</span> in {detail.changedFiles} {detail.changedFiles === 1 ? "file" : "files"}
        {detail.reviews.length ? ` · ${detail.reviews.filter((review) => review.state !== "commented").map((review) => `${review.state === "approved" ? "approved" : "changes"} by ${review.login}`).join(", ") || "commented"}` : ""}
      </p>
      {shown.length ? (
        <section className="mt-5">
          <h3 className="text-label font-medium text-muted-foreground">Checks</h3>
          <ul className="mt-1 flex flex-col">
            {[...shown].sort((left, right) => order[left.state] - order[right.state]).slice(0, 12).map((check, index) => (
              <li key={`${check.name}-${index}`} className="flex h-7 items-center gap-2 text-label">
                {check.state === "passed" ? <CheckIcon className="size-3 text-positive" /> : check.state === "failed" ? <XIcon className="size-3 text-negative" /> : check.state === "running" ? <Spinner className="size-3 text-faint" /> : <MinusIcon className="size-3 text-faint" />}
                {check.url ? (
                  <button type="button" className="min-w-0 truncate text-left text-muted-foreground hover:text-foreground" onClick={() => void desktop.openUrl(check.url!)}>{check.name}</button>
                ) : <span className="min-w-0 truncate text-muted-foreground">{check.name}</span>}
              </li>
            ))}
            {shown.length > 12 ? <li className="flex h-7 items-center gap-2 text-label text-faint"><CircleDotIcon className="size-3" />{shown.length - 12} more</li> : null}
          </ul>
        </section>
      ) : null}
      {detail.body.trim() ? <Prose text={detail.body} className={cn("mt-5 text-ui")} /> : null}
    </>
  )
}
