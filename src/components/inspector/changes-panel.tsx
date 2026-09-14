import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { ACTION_TOAST_MS } from "@/lib/toast-duration"
import { MultiFileDiff, Virtualizer } from "@pierre/diffs/react"
import { Action, Blank, IconAction } from "@/components/ui/kit"
import { useWorkspaceTransition } from "@/state/workspace-transition"
import { CommitBox, PushControl } from "@/components/inspector/commit-box"
import { Annotation, GutterAdd, ReviewBar } from "@/components/inspector/review"
import { review, useReview } from "@/state/review"
import { PullRequestCard } from "@/components/inspector/pull-request"
import { Slot } from "@/extend/slot"
import { actions, useSession } from "@/state/session"
import { git as gitActions } from "@/state/git"
import { GitLog } from "@/components/inspector/git-log"
import { GitLoading } from "@/components/inspector/git-loading"
import { GitDiffPreviewView } from "@/components/inspector/git-diff-preview"
import { ChangeList } from "@/components/inspector/change-list"
import { buildFileTree, type TreeRow } from "@/lib/file-tree"
import { cn } from "@/lib/utils"
import { prefsStore, setPref, togglePref, usePrefs } from "@/state/prefs"
import { viewer } from "@/state/viewer"
import type { GitDiff, GitFile } from "@/lib/types"
import { useWorkspaceFocus } from "@/components/stage/workspace-focus-context"
import {
  CheckCircle2Icon,
  ChevronRightIcon,
  Columns2Icon,
  FolderIcon,
  Maximize2Icon,
  MinusIcon,
  PanelBottomCloseIcon,
  PanelBottomOpenIcon,
  PlusIcon,
  RefreshCwIcon,
  WrapTextIcon,
  XIcon,
} from "lucide-react"

/**
 * The working tree.
 *
 * A folded directory tree over the changed files, staging on the row, and a
 * commit box beneath. Contents are fetched one file at a time on selection, so
 * a repo with a thousand dirty files still opens instantly.
 */
/**
 * The text of one line of the diff.
 *
 * Read from the file contents the panel already has rather than from the DOM:
 * the rendered row is virtualized and may not exist, and its text carries the
 * renderer's own whitespace handling. Quoting the source is the honest version.
 */
function lineAt(diff: GitDiff, line: number, side: "additions" | "deletions"): string | undefined {
  const file = side === "deletions" ? diff.oldFile : diff.newFile
  return file?.contents.split("\n")[line - 1]
}

interface StatusMark {
  glyph: string
  tone: string
  title: string
}

const MARK = {
  added: { glyph: "A", tone: "text-added", title: "Added" },
  untracked: { glyph: "U", tone: "text-added", title: "Untracked" },
  modified: { glyph: "M", tone: "text-caution", title: "Modified" },
  deleted: { glyph: "D", tone: "text-removed", title: "Deleted" },
  renamed: { glyph: "R", tone: "text-foreground/70", title: "Renamed" },
} satisfies Record<GitFile["status"], StatusMark>

export function ChangesPanel() {
  const focus = useWorkspaceFocus()
  const transition = useWorkspaceTransition((state) => state)
  const snapshot = useSession((state) => state.git)
  if (transition.kind === "failed") return <div role="alert" className="p-4 text-ui"><p>{transition.message}</p><Action onClick={() => void actions.openWorkspace(transition.cwd)}>Retry project</Action></div>
  if (transition.kind === "loading" || !focus.ready || !snapshot || (focus.cwd && snapshot.cwd !== focus.cwd)) {
    const cwd = transition.kind === "loading" ? transition.cwd : focus.cwd
    return <GitLoading label={`Reading changes${cwd ? ` in ${cwd.split(/[\\/]/).filter(Boolean).at(-1)}` : ""}`} />
  }
  return <WorkspaceChanges key={`${focus.identity}:${snapshot.cwd}`} />
}

function WorkspaceChanges() {
  const git = useSession((state) => state.git)
  const workspace = git?.root ?? git?.cwd ?? ""
  const collapsed = usePrefs((prefs) => prefs.collapsedDirs)
  const selectedDiffs = usePrefs((prefs) => prefs.selectedDiffs)
  const [stageOverrides, setStageOverrides] = useState(new Map<string, boolean>())
  const requestedStages = useRef(stageOverrides)
  const stageVersion = useRef(0)
  const inFlightWrites = useRef(0)
  const [pendingWrites, setPendingWrites] = useState(0)
  const staging = pendingWrites > 0
  const files = useMemo(() => (git?.files ?? []).map((file) => {
    const request = stageOverrides.get(file.path)
    return request === undefined ? file : { ...file, staged: request }
  }), [git, stageOverrides])

  const autoOpenDiff = usePrefs((prefs) => prefs.autoOpenDiff)
  const selected = git?.root ? selectedDiffs[git.root] : undefined
  const [diff, setDiff] = useState<GitDiff>()
  const [diffStyle, setDiffStyle] = useState<"unified" | "split">("unified")
  const [wrapDiff, setWrapDiff] = useState(false)

  const rows = useMemo(() => buildFileTree(files, collapsed), [collapsed, files])
  const staged = useMemo(() => files.filter((file) => file.staged).length, [files])

  // With the diff pane closed the list is the whole panel, so nothing is
  // "selected" and no file contents are fetched at all.
  const selectedFile = files.find((file) => file.path === selected)
  const active = autoOpenDiff ? selectedFile : undefined
  const showDiff = Boolean(active)
  const path = active?.path
  const ready = diff !== undefined && diff.path === path

  useEffect(() => {
    if (!path) return
    let cancelled = false
    void gitActions
      .diff(path)
      .then((next) => {
        if (!cancelled) setDiff(next)
      })
      .catch(() => {
        if (!cancelled) setDiff({ path, binary: false, oldFile: null, newFile: null })
      })
    return () => {
      cancelled = true
    }
  }, [path])

  // Commits open on the center stage, over the chat — the inspector's pane
  // is a few hundred pixels wide, fine for glancing at the working tree and
  // wrong for reading history. Split view, Escape gives the chat back.
  const pickCommitFile = useCallback((hash: string, filePath: string) => {
    void viewer.openDiff(`${hash.slice(0, 7)} · ${filePath}`, async () => ({
      diffs: [await gitActions.commitFileDiff(hash, filePath)],
    }))
  }, [])

  const pickCommit = useCallback((hash: string, subject: string) => {
    void viewer.openDiff(`${hash.slice(0, 7)} — ${subject}`, async () => {
      const { diffs, truncated } = await gitActions.commitDiffAll(hash)
      return {
        diffs,
        note: truncated > 0 ? `${truncated} more file${truncated === 1 ? "" : "s"} in this commit — open them from the commit's file list.` : undefined,
      }
    })
  }, [])

  const openWorkingTree = useCallback(() => {
    void viewer.openDiff("Current changes", async () => {
      const { diffs, truncated } = await gitActions.diffAll()
      return {
        diffs,
        note:
          truncated > 0
            ? `${truncated} more changed file${truncated === 1 ? "" : "s"} — open it from the Changes list.`
            : undefined,
      }
    })
  }, [])

  const selectFile = useCallback(
    (filePath: string) => {
      const root = git?.root
      if (root) {
        setPref("selectedDiffs", {
          ...prefsStore.get().selectedDiffs,
          [root]: filePath,
        })
      }
      if (prefsStore.get().autoOpenDiff) setPref("autoOpenDiff", false)
      void viewer.openDiff(filePath, async () => ({
        diffs: [await gitActions.diff(filePath)],
      }))
    },
    [git?.root]
  )

  const allComments = useReview((state) => state.comments)
  const draft = useReview((state) => state.draft)
  const comments = useMemo(
    () =>
      allComments.filter(
        (comment) =>
          comment.workspace === workspace && comment.path === path
      ),
    [allComments, path, workspace]
  )

  /**
   * Which lines carry an annotation.
   *
   * Saved comments and the one being written, deduplicated: a line already
   * carrying a note that is now being edited must not ask for two slots, or
   * the diff renders the same block twice.
   */
  const annotations = useMemo(() => {
    const keys = new Set<string>()
    const list: Array<{ lineNumber: number; side: "additions" | "deletions" }> = []
    const add = (line: number, side: "additions" | "deletions") => {
      const key = `${side}:${line}`
      if (keys.has(key)) return
      keys.add(key)
      list.push({ lineNumber: line, side })
    }
    for (const comment of comments) add(comment.line, comment.side)
    if (
      draft &&
      draft.workspace === workspace &&
      draft.path === path
    )
      add(draft.line, draft.side)
    return list
  }, [comments, draft, path, workspace])

  const toggleDir = useCallback((key: string) => {
    // Read through the store rather than the hook value so the callback stays
    // stable and the row components keep their memoization.
    const current = prefsStore.get().collapsedDirs
    setPref(
      "collapsedDirs",
      current.includes(key) ? current.filter((entry) => entry !== key) : [...current, key]
    )
  }, [])

  const updateStaging = useCallback(async (paths: string[], stage: boolean) => {
    stageVersion.current += 1
    inFlightWrites.current += 1
    const next = new Map(requestedStages.current)
    for (const path of paths) next.set(path, stage)
    requestedStages.current = next
    setStageOverrides(next)
    setPendingWrites(inFlightWrites.current)
    try {
      if (stage) await gitActions.stage(paths)
      else await gitActions.unstage(paths)
    } catch (error) {
      toast.error(stage ? "Files were not staged" : "Files were not unstaged", {
        duration: ACTION_TOAST_MS,
        description: error instanceof Error ? error.message : String(error),
        action: { label: "Refresh changes", onClick: () => void actions.refreshGit() },
      })
    } finally {
      inFlightWrites.current -= 1
      if (inFlightWrites.current) setPendingWrites(inFlightWrites.current)
      else {
        const version = stageVersion.current
        await actions.refreshGit()
        if (!inFlightWrites.current && stageVersion.current === version) {
          const settled = new Map<string, boolean>()
          requestedStages.current = settled
          setStageOverrides(settled)
          setPendingWrites(0)
        }
      }
    }
  }, [])

  const stagePaths = useCallback(async (paths: string[], stage: boolean) => {
    // Only paths whose state changes. A folder or "everything" selection
    // includes rows already where the user wants them, and one of those can
    // be a staged deletion, which exists in neither the index nor the
    // worktree; the engine refuses a selection it cannot find and the whole
    // write fails. Ask only for the rows that move.
    const current = new Map(files.map((file) => [file.path, requestedStages.current.get(file.path) ?? file.staged]))
    const targets = new Set(paths.filter((path) => current.get(path) !== stage))
    if (targets.size === 0) return
    for (const file of files) {
      if (!stage && targets.has(file.path) && file.status === "renamed" && file.oldName) targets.add(file.oldName)
    }
    // One call for the whole folder: `git add -- a b c` is atomic where a loop
    // would emit a status refresh per file and flicker the list.
    await updateStaging([...targets], stage)
  }, [files, updateStaging])

  const toggleStage = useCallback((file: GitFile) => stagePaths([file.path], !(requestedStages.current.get(file.path) ?? file.staged)), [stagePaths])

  if (files.length === 0) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="min-h-0 flex-1">
          <Blank
            icon={<CheckCircle2Icon />}
            title={git?.root ? "Working tree is clean" : "Not a git repository"}
            body={
              git?.root
                ? `Nothing has changed on ${git.branch ?? "this branch"}. Edits appear here as the agent makes them.`
                : "Run git init in this folder to see the agent's edits as diffs."
            }
          />
        </div>
        {/* A clean tree is exactly when history is the interesting part. */}
        <CommitsSection onPickFile={pickCommitFile} onPickCommit={pickCommit} defaultOpen />
        {/* Still here on a clean tree — a branch you have finished committing
            is exactly when you want to open the pull request. */}
        {git?.root ? <CommitBox staged={0} total={0} /> : null}
        <PullRequestCard />
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-hairline px-2.5 text-label text-faint">
        {/* The counts already project pending checkbox intent, so a stage
            write in flight only marks the reading busy; swapping the whole
            sentence for "Updating..." and back made every click blink. */}
        <span role="status" aria-busy={staging || undefined} className="min-w-0 flex-1 truncate tabular">
          {`${files.length} files changed${staged > 0 ? ` · ${staged} staged` : ""}`}
        </span>
        {/* Line totals are deferred for large changesets; an unknown total
            shows nothing rather than a label explaining its absence. */}
        {files.every((file) => file.insertions !== null && file.deletions !== null) ? <>
          <span className="tabular text-added">+{files.reduce((sum, file) => sum + (file.insertions ?? 0), 0)}</span>
          <span className="tabular text-removed">−{files.reduce((sum, file) => sum + (file.deletions ?? 0), 0)}</span>
        </> : null}
        <div className="ml-auto flex items-center gap-0.5">
          <IconAction
            label="Review current changes in the center"
            size="xs"
            onClick={openWorkingTree}
          >
            <Maximize2Icon />
          </IconAction>
          <IconAction
            label={staged === files.length ? "Unstage everything" : "Stage everything"}
            size="xs"
            onClick={() => void stagePaths(files.map((file) => file.path), staged !== files.length)}
          >
            {staged === files.length ? <MinusIcon /> : <PlusIcon />}
          </IconAction>
          <IconAction
            label={selectedFile ? showDiff ? "Hide the diff" : "Show the diff" : "Select a file to preview"}
            size="xs"
            disabled={!selectedFile}
            data-on={showDiff || undefined}
            onClick={() => togglePref("autoOpenDiff")}
          >
            {showDiff ? <PanelBottomCloseIcon /> : <PanelBottomOpenIcon />}
          </IconAction>
          <IconAction label="Refresh" size="xs" onClick={() => void actions.refreshGit()}>
            <RefreshCwIcon />
          </IconAction>
        </div>
      </div>

      <ChangeList rows={rows} compact={showDiff} renderRow={(row) => row.kind === "dir" ? (
        <DirRow row={row} busy={row.paths.some((path) => stageOverrides.has(path))} onToggle={toggleDir} onStage={stagePaths} />
      ) : (
        <FileRow row={row} busy={stageOverrides.has(row.file.path)} active={selected === row.file.path} onSelect={selectFile} onToggleStage={toggleStage} />
      )} />

      {showDiff ? (
        <div className="relative flex min-h-0 flex-1 flex-col border-t border-hairline">
          {/* Closing from the pane itself, not only from the header: the thing
              you want gone is the thing your pointer is already over. */}
          <div className="flex h-7 shrink-0 items-center gap-1 px-2.5">
            <span className="min-w-0 flex-1 truncate font-mono text-label text-faint">
              {active?.path ?? ""}
            </span>
            <IconAction
              label={diffStyle === "unified" ? "Show side by side" : "Show unified diff"}
              size="xs"
              data-on={diffStyle === "split" || undefined}
              onClick={() =>
                setDiffStyle((current) =>
                  current === "unified" ? "split" : "unified"
                )
              }
            >
              <Columns2Icon />
            </IconAction>
            <IconAction
              label={wrapDiff ? "Disable line wrapping" : "Wrap long lines"}
              size="xs"
              data-on={wrapDiff || undefined}
              onClick={() => setWrapDiff((current) => !current)}
            >
              <WrapTextIcon />
            </IconAction>
            <span aria-hidden className="mx-1 h-4 w-px bg-hairline" />
            <IconAction
              label="Close the diff"
              size="xs"
              onClick={() => togglePref("autoOpenDiff")}
            >
              <XIcon />
            </IconAction>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
        {!path ? (
          <p className="p-4 text-ui text-faint">Select a file to read its diff. Staging is available without opening a preview.</p>
        ) : !ready ? (
          <GitLoading kind="diff" label={`Reading ${path}`} />
        ) : diff.preview ? (
          <GitDiffPreviewView path={diff.path} preview={diff.preview} />
        ) : diff.binary || (!diff.oldFile && !diff.newFile) ? (
          <p className="p-3 text-ui text-faint">
            {diff.binary ? "Binary file — no text diff." : "No text content to compare."}
          </p>
        ) : (
          <Virtualizer className="min-h-full">
            <MultiFileDiff
              {...(diff.oldFile && diff.newFile
                ? { oldFile: diff.oldFile, newFile: diff.newFile }
                : diff.newFile
                  ? { oldFile: null, newFile: diff.newFile }
                  : { oldFile: diff.oldFile!, newFile: null })}
              options={{
                disableFileHeader: true,
                diffStyle,
                overflow: wrapDiff ? "wrap" : "scroll",
                // Off by default, which is why the comment control rendered
                // nowhere at all. `onGutterUtilityClick` is the other half of
                // this API and the two are mutually exclusive — a custom slot
                // owns its own click.
                enableGutterUtility: true,
              }}
              lineAnnotations={annotations}
              renderAnnotation={(annotation) => (
                <Annotation
                  workspace={workspace}
                  path={path ?? ""}
                  line={annotation.lineNumber}
                  side={annotation.side}
                  comments={comments}
                />
              )}
              renderGutterUtility={(getHoveredLine) => (
                <GutterAdd
                  onClick={() => {
                    const hovered = getHoveredLine()
                    if (!hovered || !path) return
                    review.start({
                      workspace,
                      path,
                      line: hovered.lineNumber,
                      side: hovered.side,
                      code: lineAt(diff, hovered.lineNumber, hovered.side),
                    })
                  }}
                />
              )}
            />
          </Virtualizer>
            )}
          </div>
        </div>
      ) : null}

      <CommitsSection onPickFile={pickCommitFile} onPickCommit={pickCommit} />
      <ReviewBar workspace={workspace} />
      <CommitBox staged={staged} total={files.length} />
      <PullRequestCard />
    </div>
  )
}

/**
 * The repository's commits, folded under the working tree.
 *
 * This is where commits belong — beside the changes that will become the
 * next one — rather than in a separate tab someone has to know about. Each
 * commit opens into its files; each file opens its diff in the same surface
 * the working tree uses.
 */
function CommitsSection({
  onPickFile,
  onPickCommit,
  defaultOpen = false,
}: {
  onPickFile: (hash: string, path: string) => void
  onPickCommit: (hash: string, subject: string) => void
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  const hasRepo = useSession((state) => Boolean(state.git?.root))
  const cwd = useSession((state) => state.git?.cwd ?? "")
  const branch = useSession((state) => state.git?.branch)
  const head = useSession((state) => state.git?.head)
  const ahead = useSession((state) => state.git?.ahead ?? 0)
  const upstream = useSession((state) => state.git?.upstream)
  if (!hasRepo) return null
  return (
    <div className={cn("flex min-h-0 shrink-0 flex-col border-t border-hairline", open && "max-h-[38%]")}>
      {/* The branch names the history, so it titles this row; Push publishes
          that history, so it sits here and only while there is something
          to publish or report. */}
      <div className="flex h-7 shrink-0 items-center pr-1.5">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="flex h-7 min-w-0 flex-1 items-center gap-1.5 px-2.5 text-label text-faint transition-colors hover:text-muted-foreground"
        >
          <ChevronRightIcon
            className={cn("size-3 shrink-0 transition-transform duration-200 ease-out", open && "rotate-90")}
          />
          <span className="truncate">{branch ? `Commits on ${branch}` : "Commits"}</span>
        </button>
        {head && branch ? <PushControl cwd={cwd} branch={branch} ahead={ahead} upstream={upstream} /> : null}
      </div>
      {open ? (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <GitLog onPickFile={onPickFile} onPickCommit={onPickCommit} />
        </div>
      ) : null}
    </div>
  )
}

/**
 * A staging checkbox. Directories carry the same control as files and act on
 * everything beneath them, with a partial state for the common case where the
 * agent touched several files in a folder and you only staged some.
 */
function StageBox({
  state,
  label,
  busy,
  onToggle,
}: {
  state: "on" | "off" | "partial"
  label: string
  busy: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-label={label}
      aria-checked={state === "partial" ? "mixed" : state === "on"}
      aria-busy={busy}
      onClick={(event) => {
        // The row underneath is a click target too; staging must not also
        // expand a folder or open a diff.
        event.stopPropagation()
        onToggle()
      }}
      className="pressable stage-hit-target flex size-6 shrink-0 cursor-pointer items-center justify-center select-none"
    >
      <span aria-hidden className={cn(
        "pointer-events-none flex size-3.5 items-center justify-center rounded-[3px] ring-1 ring-inset transition-colors",
        state === "off" ? "ring-border group-hover:ring-foreground/40" : "bg-foreground/85 ring-foreground/85"
      )}>
        {state === "on" ? (
          <svg viewBox="0 0 10 10" className="size-2.5 text-background" aria-hidden>
            <path
              d="M1.5 5.2 4 7.5 8.5 2.8"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : state === "partial" ? (
          <span className="block h-[1.5px] w-[7px] rounded-full bg-background" />
        ) : null}
      </span>
    </button>
  )
}

function DirRow({
  row,
  busy,
  onToggle,
  onStage,
}: {
  busy: boolean
  row: Extract<TreeRow, { kind: "dir" }>
  onToggle: (key: string) => void
  onStage: (paths: string[], stage: boolean) => void
}) {
  const state = row.staged === 0 ? "off" : row.staged === row.files ? "on" : "partial"

  return (
    <div
      style={{ paddingInlineStart: 4 + row.depth * 11 }}
      className="group flex h-6 items-center gap-1.5 rounded pr-1 select-none transition-colors duration-100 hover:bg-fill-hover"
    >
      <StageBox
        state={state}
        busy={busy}
        // Partially staged reads as "not yet done", so the useful action is to
        // finish staging it rather than to clear what you already picked.
        label={state === "on" ? `Unstage ${row.label}` : `Stage all of ${row.label}`}
        onToggle={() => onStage(row.paths, state !== "on")}
      />
      <button
        type="button"
        onClick={() => onToggle(row.key)}
        className="pressable stage-hit-target flex h-full min-w-0 flex-1 items-center gap-1 text-left"
      >
        <ChevronRightIcon
          className={cn(
            "size-3 shrink-0 text-faint transition-transform duration-150",
            !row.collapsed && "rotate-90"
          )}
        />
        <FolderIcon className="size-3 shrink-0 text-faint" />
        <span className="min-w-0 flex-1 truncate text-ui text-muted-foreground">
          {row.label}
        </span>
        <span className="tabular shrink-0 pr-1 text-label text-faint">
          {row.staged > 0 && row.staged < row.files ? `${row.staged}/${row.files}` : row.files}
        </span>
      </button>
    </div>
  )
}

function FileRow({
  row,
  active,
  busy,
  onSelect,
  onToggleStage,
}: {
  busy: boolean
  row: Extract<TreeRow, { kind: "file" }>
  active: boolean
  onSelect: (path: string) => void
  onToggleStage: (file: GitFile) => void
}) {
  const file = row.file
  const mark = MARK[file.status]

  return (
    <div
      style={{ paddingInlineStart: 4 + row.depth * 11 }}
      className={cn(
        "group flex h-6 items-center gap-1.5 rounded pr-1 select-none transition-colors duration-100",
        "hover:bg-fill-hover",
        active && "bg-fill-selected"
      )}
    >
      <StageBox
        state={file.staged ? "on" : "off"}
        busy={busy}
        label={file.staged ? `Unstage ${row.label}` : `Stage ${row.label}`}
        onToggle={() => onToggleStage(file)}
      />

      <button
        type="button"
        onClick={() => onSelect(file.path)}
        title={file.path}
        className="pressable stage-hit-target flex h-full min-w-0 flex-1 items-center gap-1.5 text-left"
      >
        <span
          title={mark.title}
          className={cn("w-2.5 shrink-0 font-mono text-label font-semibold", mark.tone)}
        >
          {mark.glyph}
        </span>
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-ui",
            active ? "text-foreground" : "text-foreground/85"
          )}
        >
          {row.label}
        </span>
        {file.insertions || file.deletions ? (
          <span className="tabular shrink-0 text-label">
            <span className="text-added">+{file.insertions}</span>{" "}
            <span className="text-removed">−{file.deletions}</span>
          </span>
        ) : null}
      </button>
      <Slot name="changes.file.trailing" file={file} />
    </div>
  )
}
