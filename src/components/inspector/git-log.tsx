import { useEffect, useState } from "react"
import { Action, Blank, IconAction } from "@/components/ui/kit"
import { Collapse } from "@/components/ui/collapse"
import { FileTypeIcon } from "@/components/ui/file-type-icon"
import { LineCounts, StatusLetter } from "@/components/inspector/change-marks"
import { PathLabel } from "@/components/ui/path-label"
import { GitLoading } from "@/components/inspector/git-loading"
import { useWorkspaceFocus } from "@/components/stage/workspace-focus-context"
import { useWorkspaceTransition } from "@/state/workspace-transition"
import { git, type GitCommitFile } from "@/state/git"
import { formatRelative } from "@/lib/format"
import { useSession } from "@/state/session"
import { cn } from "@/lib/utils"
import type { GitCommitEntry } from "@/lib/types"
import { GitCommitHorizontalIcon, Maximize2Icon } from "lucide-react"
import { Shimmer } from "@/components/ui/shimmer"

/**
 * Commit history, openable.
 *
 * A commit row unfolds into the files it touched — fetched the first time it
 * opens, kept after — as a folder in the tree does, and each file is a click
 * from its diff: the parent's version against the commit's, on the center
 * stage. The whole commit opens there from the row's own action.
 */

export function GitLog(props: Parameters<typeof WorkspaceGitLog>[0]) {
  const focus = useWorkspaceFocus()
  const transition = useWorkspaceTransition((state) => state)
  const snapshot = useSession((state) => state.git)
  if (transition.kind === "failed") return <p role="alert" className="p-3 text-ui text-negative">{transition.message}</p>
  if (transition.kind === "loading" || !focus.ready || !snapshot || (focus.cwd && snapshot.cwd !== focus.cwd)) return <GitLoading kind="history" label="Reading project history" />
  if (!snapshot.root) return null
  return <WorkspaceGitLog key={`${snapshot.cwd}:${snapshot.root}`} {...props} />
}

function WorkspaceGitLog({
  onPickFile,
  onPickCommit,
  picked,
}: {
  /** Present when a diff surface is attached; absent renders read-only. */
  onPickFile?: (hash: string, path: string) => void
  /** Clicking the commit itself: the whole diff, center stage. */
  onPickCommit?: (hash: string, subject: string) => void
  picked?: { hash: string; path: string } | null
}) {
  const files = useSession((state) => state.git?.files.length ?? 0)
  const branch = useSession((state) => state.git?.branch)
  const root = useSession((state) => state.git?.root)
  const ahead = useSession((state) => state.git?.ahead ?? 0)

  const head = useSession((state) => state.git?.head)
  const [attempt, setAttempt] = useState(0)
  const key = JSON.stringify([root, head, branch, attempt])
  const [history, setHistory] = useState<({ key: string } & ({ kind: "ready"; commits: GitCommitEntry[] } | { kind: "failed"; message: string })) | null>(null)
  const [page, setPage] = useState(0)
  const [open, setOpen] = useState<string | null>(null)
  const [filesByHash, setFilesByHash] = useState<Record<string, GitCommitFile[]>>({})

  useEffect(() => {
    if (!root) return
    let cancelled = false
    void git
      .log(80)
      .then((next) => {
        if (!cancelled) setHistory({ key, kind: "ready", commits: next })
      })
      .catch((error) => {
        if (!cancelled) setHistory({ key, kind: "failed", message: error instanceof Error ? error.message : "History could not be read." })
      })
    return () => {
      cancelled = true
    }
    // `files` participates so the list refreshes after a commit lands.
  }, [root, files, branch, key])

  const toggle = (hash: string) => {
    const next = open === hash ? null : hash
    setOpen(next)
    setPage(0)
    if (next && !filesByHash[next]) {
      void git
        .commitFiles(next)
        .then((list) => setFilesByHash((prev) => ({ ...prev, [next]: list })))
        .catch(() => setFilesByHash((prev) => ({ ...prev, [next]: [] })))
    }
  }

  if (!root) return null
  if (!history || history.key !== key) return <GitLoading kind="history" label={`Reading commits${branch ? ` on ${branch}` : ""}`} />
  if (history.kind === "failed") return <div role="alert" className="p-3 text-ui"><p>{history.message}</p><Action onClick={() => setAttempt((value) => value + 1)}>Retry history</Action></div>
  const commits = history.commits
  if (commits.length === 0) {
    return (
      <Blank
        icon={<GitCommitHorizontalIcon />}
        title="No commits yet"
        body="Once you make the first commit, the history shows up here."
      />
    )
  }

  return (
    <div className="px-1 pb-1.5">
      {commits.map((commit, index) => {
        const expanded = open === commit.hash
        const commitFiles = filesByHash[commit.hash]
        // Unpushed commits are the ones still under your control.
        const unpushed = index < ahead
        return (
          <div key={commit.hash} className="group/commit relative">
            {index < commits.length - 1 ? <span aria-hidden className="pointer-events-none absolute top-[17px] bottom-0 left-[13.5px] w-px bg-foreground/[0.09]" /> : null}
            <button
              type="button"
              aria-expanded={expanded}
              onClick={() => toggle(commit.hash)}
              title={`${commit.subject}\n${commit.shortHash} · ${commit.author} · ${new Date(commit.date).toLocaleString()}`}
              className="pressable flex w-full items-start gap-2.5 rounded-md py-1.5 pr-9 pl-2 text-left transition-colors duration-100 hover:bg-fill-hover [contain-intrinsic-size:auto_42px] [content-visibility:auto]"
            >
              <span aria-hidden className="relative flex h-[18px] w-3 shrink-0 items-center justify-center">
                <span className={cn(
                  "size-[7px] rounded-full ring-[1.5px]",
                  unpushed ? "bg-caution/25 ring-caution/80" : index === 0 ? "bg-foreground/60 ring-foreground/60" : "bg-background ring-foreground/30"
                )} />
              </span>
              <span className="min-w-0 flex-1">
                <span className={cn("block truncate text-ui", expanded ? "text-foreground" : "text-foreground/85")}>{commit.subject}</span>
                <span className="flex min-w-0 items-center gap-1.5 text-label text-faint">
                  <span className="shrink-0 font-mono">{commit.shortHash}</span>
                  <span aria-hidden>·</span>
                  <span className="min-w-0 truncate">{commit.author}</span>
                  <span aria-hidden>·</span>
                  <span className="tabular shrink-0">{formatRelative(commit.date)}</span>
                  {unpushed ? <span className="shrink-0 text-caution/80">· Not pushed</span> : null}
                </span>
              </span>
            </button>
            {onPickCommit ? (
              <IconAction label="Open the commit in the center" size="xs" onClick={() => onPickCommit(commit.hash, commit.subject)}
                className="absolute top-1.5 right-1.5 text-faint opacity-0 group-hover/commit:opacity-100 focus-visible:opacity-100">
                <Maximize2Icon />
              </IconAction>
            ) : null}
            <Collapse open={expanded}>
              <div className="pt-0.5 pb-1.5 pl-[26px]">
                {commitFiles === undefined ? (
                  <p className="flex h-6 items-center px-2 text-label"><Shimmer text="Reading the commit…" /></p>
                ) : commitFiles.length === 0 ? (
                  <p className="flex h-6 items-center px-2 text-label text-faint">Nothing readable in it.</p>
                ) : (
                  <>{commitFiles.slice(page * 100, (page + 1) * 100).map((file) => {
                    const active = picked?.hash === commit.hash && picked.path === file.path
                    return (
                      <button
                        key={file.path}
                        type="button"
                        disabled={!onPickFile}
                        onClick={() => onPickFile?.(commit.hash, file.path)}
                        data-active={active || undefined}
                        title={file.path}
                        className={cn(
                          "flex h-6 w-full items-center gap-1.5 rounded pr-1.5 pl-2 text-left",
                          "transition-colors duration-100 data-active:bg-fill-selected",
                          onPickFile && "hover:bg-fill-hover"
                        )}
                      >
                        <FileTypeIcon path={file.path} className="size-3.5 shrink-0 text-faint/80" />
                        <PathLabel path={file.path} className="flex-1" nameClassName={file.status === "deleted" ? "text-faint line-through decoration-faint/60" : "text-foreground/85"} />
                        {!file.binary ? <LineCounts insertions={file.insertions} deletions={file.deletions} /> : null}
                        <StatusLetter status={file.status} className="w-3 text-center" />
                      </button>
                    )
                  })}
                  {commitFiles.length > 100 ? <div className="flex items-center justify-between py-1.5 pr-1.5 pl-2 text-label text-faint"><Action size="xs" disabled={page === 0} onClick={() => setPage((value) => value - 1)}>Previous</Action><span>{page * 100 + 1}–{Math.min((page + 1) * 100, commitFiles.length)} of {commitFiles.length} files</span><Action size="xs" disabled={(page + 1) * 100 >= commitFiles.length} onClick={() => setPage((value) => value + 1)}>Next</Action></div> : null}</>
                )}
              </div>
            </Collapse>
          </div>
        )
      })}
    </div>
  )
}
