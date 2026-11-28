import type { ReactNode } from "react"
import { toast } from "sonner"
import {
  CheckIcon,
  CircleCheckIcon,
  CircleDotIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
  XIcon,
} from "lucide-react"
import {
  checksWords,
  problemWords,
  pullSection,
  rowCode,
  type BoardIssue,
  type BoardPull,
  type BoardKind,
  type BoardRepository,
} from "@mako/host/contracts/project-pulls"
import { pullNote } from "@/components/pulls/board-words"
import { ListRow, ROW_AGE, ROW_META, ROW_TITLE, RowEnd } from "@/components/ui/list"
import { Action, IconAction } from "@/components/ui/kit"
import { Spinner } from "@/components/ui/spinner"
import { desktop } from "@/state/desktop"
import { readBoard } from "@/state/project-board"
import { formatRelative } from "@/lib/format"
import { cn } from "@/lib/utils"

/*
 * The rows the Pull requests panel and page share: a state glyph, the code (`#12`, or `name#12` in a project of
 * several repositories) at one measured width, the title, the checks, and the age, which gives way to the row's
 * actions under the pointer or the keyboard.
 */

/** What the glyph says: hue only where it means something (open, failing); merged and draft stay quiet. */
export function PullGlyph({ pull }: { pull: BoardPull }) {
  const failing = (pull.checks?.failed ?? 0) > 0
  const [Icon, tone, label] =
    pull.state === "merged" ? [GitMergeIcon, "text-muted-foreground", "Merged"]
    : pull.state === "closed" ? [GitPullRequestClosedIcon, "text-faint", "Closed"]
    : pull.draft ? [GitPullRequestDraftIcon, "text-faint", "Draft"]
    : failing ? [GitPullRequestIcon, "text-negative", "Checks failing"]
    : [GitPullRequestIcon, "text-positive", "Open"]
  return (
    <span className="flex w-4 shrink-0 justify-center" title={label}>
      <Icon aria-label={label} className={cn("size-3.5", tone)} />
    </span>
  )
}

export function IssueGlyph({ issue }: { issue: BoardIssue }) {
  const open = issue.state === "open"
  const Icon = open ? CircleDotIcon : CircleCheckIcon
  return (
    <span className="flex w-4 shrink-0 justify-center" title={open ? "Open" : "Closed"}>
      <Icon aria-label={open ? "Open" : "Closed"} className={cn("size-3.5", open ? "text-positive" : "text-muted-foreground")} />
    </span>
  )
}

/** `✓ 7`, `✕ 2/7`, a turning `3/7` while they run; nothing when the head reports none or wasn't read. */
export function ChecksCell({ pull }: { pull: BoardPull }) {
  if (pull.state !== "open") return null
  const words = checksWords(pull.checks)
  if (!words) return null
  const Icon = words.tone === "positive" ? CheckIcon : XIcon
  const checks = pull.checks!
  const title = checks.failed ? `${checks.failed} of ${checks.total} checks failing` : checks.running ? `${checks.running} of ${checks.total} checks running` : `All ${checks.total} checks passed`
  return (
    <span title={title} className={cn("tabular flex shrink-0 items-center gap-0.5 text-label",
      words.tone === "positive" ? "text-positive" : words.tone === "negative" ? "text-negative" : "text-faint")}>
      {words.tone === "faint" ? <Spinner aria-hidden className="size-3" /> : <Icon aria-hidden className="size-3" />}
      {words.tone === "positive" ? null : words.text}
    </span>
  )
}

/** What a row's age cell says: when it merged or closed, else when it last moved. */
function age(row: { state: string; closedAt?: number; updatedAt: number }): string {
  return formatRelative(row.state === "open" ? row.updatedAt : row.closedAt ?? row.updatedAt)
}

interface RowProps {
  selected: boolean
  multi: ReadonlySet<string>
  width: string
  onSelect: () => void
  onOpen: () => void
  /** The page's wider row: author and project. */
  wide?: { project?: string }
}

export function PullRow({ pull, selected, multi, width, onSelect, onOpen, wide }: RowProps & { pull: BoardPull }) {
  const note = pullNote(pull)
  return (
    <ListRow
      rowKey={pull.key}
      selected={selected}
      data-pull={pull.key}
      data-pull-section={pullSection(pull)}
      className={wide ? undefined : "h-9 gap-2"}
      onClick={onSelect}
      onDoubleClick={onOpen}
      onKeyDown={(event) => { if (event.key === " ") { event.preventDefault(); onOpen() } }}
    >
      <PullGlyph pull={pull} />
      <span style={{ width }} className="tabular shrink-0 text-label text-faint">{rowCode(pull, multi)}</span>
      {wide && pull.author ? <span className="hidden w-24 shrink-0 truncate text-label text-muted-foreground @lg/list:block">{pull.author}</span> : null}
      <span className={cn(ROW_TITLE, "flex-1", pull.state !== "open" && "text-foreground/70")}>{pull.title}</span>
      {note ? <span className={cn(ROW_META, "hidden shrink-0 @md/list:block", pullSection(pull) === "needs-you" && "text-attention/90")}>{note}</span> : null}
      {wide?.project ? <span className={cn(ROW_META, "hidden max-w-32 shrink-0 @xl/list:block")}>{wide.project}</span> : null}
      <ChecksCell pull={pull} />
      <RowEnd
        className="w-14"
        age={<span className={cn(ROW_AGE, "w-auto")}>{age(pull)}</span>}
        actions={<IconAction size="xs" label="Open on GitHub" keys={["O"]} onClick={() => void desktop.openUrl(pull.url)}><GitPullRequestIcon /></IconAction>}
      />
    </ListRow>
  )
}

export function IssueRow({ issue, selected, multi, width, onSelect, onOpen, wide }: RowProps & { issue: BoardIssue }) {
  return (
    <ListRow
      rowKey={issue.key}
      selected={selected}
      data-issue={issue.key}
      className={wide ? undefined : "h-9 gap-2"}
      onClick={onSelect}
      onDoubleClick={onOpen}
    >
      <IssueGlyph issue={issue} />
      <span style={{ width }} className="tabular shrink-0 text-label text-faint">{rowCode(issue, multi)}</span>
      <span className={cn(ROW_TITLE, "flex-1", issue.state !== "open" && "text-foreground/70")}>{issue.title}</span>
      {issue.labels.length ? <span className={cn(ROW_META, "hidden max-w-28 shrink-0 @md/list:block")}>{issue.labels.slice(0, 2).join(", ")}</span> : null}
      {wide?.project ? <span className={cn(ROW_META, "hidden max-w-32 shrink-0 @xl/list:block")}>{wide.project}</span> : null}
      <RowEnd
        className="w-14"
        age={<span className={cn(ROW_AGE, "w-auto")}>{age(issue)}</span>}
        actions={<IconAction size="xs" label="Open on GitHub" keys={["O"]} onClick={() => void desktop.openUrl(issue.url)}><CircleDotIcon /></IconAction>}
      />
    </ListRow>
  )
}

/**
 * A repository that couldn't be read: one quiet line, its name and why, and the one thing that fixes it. A limit or
 * an outage clears itself with the next reading, so it offers nothing to press.
 */
export function ProblemLines({ repositories, folders, kind }: { repositories: readonly BoardRepository[]; folders: readonly string[]; kind: BoardKind }) {
  const failed = repositories.filter((repository) => repository.problem)
  if (!failed.length) return null
  return (
    <div data-board-problems className="flex flex-col pb-1">
      {failed.map((repository) => (
        <p key={repository.name} data-board-problem={repository.name} className="flex min-h-8 items-center gap-2 px-2 text-label text-faint">
          <span className="min-w-0 flex-1 truncate" title={`${repository.name} couldn't be read: ${problemWords(repository.problem!)}`}>
            <span className="text-muted-foreground">{repository.name}</span> couldn't be read: {problemWords(repository.problem!)}
          </span>
          <ProblemFix repository={repository} folders={folders} kind={kind} />
        </p>
      ))}
    </div>
  )
}

function ProblemFix({ repository, folders, kind }: { repository: BoardRepository; folders: readonly string[]; kind: BoardKind }): ReactNode {
  const fix = (label: string, run: () => void) => <Action size="xs" tone="quiet" className="shrink-0" onClick={run}>{label}</Action>
  switch (repository.problem?.kind) {
    case "signed-out":
      return fix("Sign in", () => {
        void navigator.clipboard.writeText("gh auth login")
        toast.success("Copied gh auth login", { description: "Run it in Terminal once; Mako uses that sign-in." })
      })
    case "no-cli":
      return fix("Install", () => void desktop.openUrl("https://cli.github.com"))
    case "no-access":
      return fix("Open on GitHub", () => void desktop.openUrl(repository.url))
    case "unreachable":
      return fix("Retry", () => void readBoard(folders, kind, "refresh"))
    default:
      return null
  }
}
