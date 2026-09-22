import { useEffect, useState } from "react"
import { Action, Blank } from "@/components/ui/kit"
import { GitLoading } from "@/components/inspector/git-loading"
import { useWorkspaceFocus } from "@/components/stage/workspace-focus-context"
import { useWorkspaceTransition } from "@/state/workspace-transition"
import { git, type GitCommitFile } from "@/state/git"
import { formatRelative } from "@/lib/format"
import { useSession } from "@/state/session"
import { cn } from "@/lib/utils"
import type { GitCommitEntry, GitFileStatus } from "@/lib/types"
import { ChevronRightIcon, GitCommitHorizontalIcon } from "lucide-react"

/**
 * Commit history, openable.
 *
 * A commit row expands into the files it touched — fetched the first time it
 * opens, kept after — and each file is a click from its diff: the parent's
 * version against the commit's, in the same diff surface the working tree
 * uses. History you can only read is a list; history you can open is a tool.
 */

interface StatusGlyph {
  glyph: string
  tone: string
}

const GLYPH = {
  added: { glyph: "A", tone: "text-added" },
  modified: { glyph: "M", tone: "text-caution" },
  deleted: { glyph: "D", tone: "text-removed" },
  renamed: { glyph: "R", tone: "text-foreground/70" },
  conflicted: { glyph: "!", tone: "text-removed" },
  untracked: { glyph: "U", tone: "text-added" },
} satisfies Record<GitFileStatus, StatusGlyph>

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
    <div className="py-1">
      {commits.map((commit, index) => {
        const expanded = open === commit.hash
        const commitFiles = filesByHash[commit.hash]
        return (
          <div key={commit.hash}>
            <button
              type="button"
              // The commit is the unit you read: clicking it opens the whole
              // diff on the center stage. The chevron below is the smaller
              // gesture — unfold the file list without leaving the panel.
              onClick={() =>
                onPickCommit ? onPickCommit(commit.hash, commit.subject) : toggle(commit.hash)
              }
              className="contain-turn group flex w-full gap-2 rounded-md px-2.5 py-1 text-left transition-colors duration-100 hover:bg-fill-hover [contain-intrinsic-size:auto_38px]"
            >
              <span className="relative flex w-3 shrink-0 justify-center">
                {index < commits.length - 1 ? (
                  <span className="absolute top-3.5 bottom-[-4px] w-px bg-hairline" />
                ) : null}
                <span
                  className={cn(
                    "relative z-10 mt-[7px] size-1.5 rounded-full",
                    // Unpushed commits are the ones still under your control.
                    index < ahead ? "bg-caution" : "bg-foreground/30"
                  )}
                />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate text-ui text-foreground/85">
                    {commit.subject}
                  </span>
                  <span className="tabular shrink-0 text-label text-faint">
                    {formatRelative(commit.date)}
                  </span>
                </span>
                <span className="flex items-center gap-2 text-label text-faint">
                  <span
                    role="button"
                    tabIndex={-1}
                    aria-label={expanded ? "Hide files" : "Show files"}
                    onClick={(event) => {
                      event.stopPropagation()
                      toggle(commit.hash)
                    }}
                    className="rounded p-0.5 hover:text-foreground"
                  >
                    <ChevronRightIcon
                      className={cn(
                        "size-2.5 shrink-0 transition-transform duration-200 ease-out",
                        expanded && "rotate-90"
                      )}
                    />
                  </span>
                  <span className="font-mono">{commit.shortHash}</span>
                  <span className="truncate">{commit.author}</span>
                  {commit.insertions || commit.deletions ? (
                    <span className="tabular ml-auto shrink-0">
                      <span className="text-added">+{commit.insertions}</span>{" "}
                      <span className="text-removed">−{commit.deletions}</span>
                    </span>
                  ) : null}
                </span>
              </span>
            </button>

            <div
              className={cn(
                "grid transition-[grid-template-rows] duration-200 ease-out",
                expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
              )}
            >
              <div className="min-h-0 overflow-hidden">
                {expanded ? (
                  commitFiles === undefined ? (
                    <p className="shimmer py-1 pl-10 text-label">Reading the commit…</p>
                  ) : commitFiles.length === 0 ? (
                    <p className="py-1 pl-10 text-label text-faint">Nothing readable in it.</p>
                  ) : (
                    <>{commitFiles.slice(page * 100, (page + 1) * 100).map((file) => {
                      const mark = GLYPH[file.status] ?? GLYPH.modified
                      const active = picked?.hash === commit.hash && picked.path === file.path
                      return (
                        <button
                          key={file.path}
                          type="button"
                          disabled={!onPickFile}
                          onClick={() => onPickFile?.(commit.hash, file.path)}
                          data-active={active || undefined}
                          className={cn(
                            "flex w-full items-center gap-2 rounded py-[3px] pr-2.5 pl-10 text-left",
                            "transition-colors duration-100 data-active:bg-raised",
                            onPickFile && "hover:bg-fill-hover"
                          )}
                        >
                          <span className={cn("w-2.5 shrink-0 text-label font-semibold", mark?.tone)}>
                            {mark?.glyph}
                          </span>
                          <span className="min-w-0 flex-1 truncate font-mono text-label text-foreground/80">
                            {file.path}
                          </span>
                          {!file.binary && file.insertions !== null && file.deletions !== null ? (
                            <span className="tabular shrink-0 text-label text-faint">
                              <span className="text-added">+{file.insertions}</span>{" "}
                              <span className="text-removed">−{file.deletions}</span>
                            </span>
                          ) : null}
                        </button>
                      )
                    })}
                    {commitFiles.length > 100 ? <div className="flex items-center justify-between px-3 py-2 pl-10 text-label text-faint"><Action size="xs" disabled={page === 0} onClick={() => setPage((value) => value - 1)}>Previous</Action><span>{page * 100 + 1}–{Math.min((page + 1) * 100, commitFiles.length)} of {commitFiles.length} files</span><Action size="xs" disabled={(page + 1) * 100 >= commitFiles.length} onClick={() => setPage((value) => value + 1)}>Next</Action></div> : null}</>
                  )
                ) : null}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
