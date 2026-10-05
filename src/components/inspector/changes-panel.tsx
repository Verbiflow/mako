import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { ACTION_TOAST_MS } from "@/lib/toast-duration"
import { MultiFileDiff, Virtualizer } from "@pierre/diffs/react"
import { Action, Blank, IconAction } from "@/components/ui/kit"
import { useWorkspaceTransition } from "@/state/workspace-transition"
import { CommitBox } from "@/components/inspector/commit-box"
import { Annotation, GutterAdd, ReviewBar } from "@/components/inspector/review"
import { review, useReview } from "@/state/review"
import { PullRequestCard } from "@/components/inspector/pull-request"
import { WorktreeReview } from "@/components/inspector/worktree-review"
import { Slot } from "@/extend/slot"
import { actions, useSession } from "@/state/session"
import { git as gitActions } from "@/state/git"
import { GitLog } from "@/components/inspector/git-log"
import { GitLoading } from "@/components/inspector/git-loading"
import { GitDiffPreviewView } from "@/components/inspector/git-diff-preview"
import { ChangeList } from "@/components/inspector/change-list"
import { ReviewStream } from "@/components/inspector/review-stream"
import { DIFF_THEME } from "@/lib/diff-theme"
import { buildFileTree, type TreeRow } from "@/lib/file-tree"
import { cn } from "@/lib/utils"
import { Collapse } from "@/components/ui/collapse"
import { discardFiles } from "@/state/git-discard"
import { prefsStore, setPref, togglePref, usePrefs } from "@/state/prefs"
import { viewer } from "@/state/viewer"
import type { GitDiff, GitFile, GitStatus } from "@/lib/types"
import { useWorkspaceFocus } from "@/components/stage/workspace-focus-context"
import { FileTypeIcon } from "@/components/ui/file-type-icon"
import { LineCounts } from "@/components/inspector/change-marks"
import { MARK, type StatusMark } from "@/lib/git-marks"
import {
  CheckCircle2Icon,
  ChevronRightIcon,
  Columns2Icon,
  FolderIcon,
  FolderOpenIcon,
  GitBranchIcon,
  ListIcon,
  ListTreeIcon,
  Maximize2Icon,
  MinusIcon,
  PanelBottomCloseIcon,
  PanelBottomOpenIcon,
  PlusIcon,
  RefreshCwIcon,
  Undo2Icon,
  WrapTextIcon,
  XIcon,
} from "lucide-react"

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

/** Pixels per tree level. */
const TREE_INDENT = 10

export function ChangesPanel() {
  const focus = useWorkspaceFocus()
  const transition = useWorkspaceTransition((state) => state)
  const snapshot = useSession((state) => state.git)
  if (transition.kind === "failed") return <div role="alert" className="p-4 text-ui"><p>{transition.message}</p><Action onClick={() => void actions.openWorkspace(transition.cwd)}>Retry project</Action></div>
  if (transition.kind === "loading" || !focus.ready || !snapshot || (focus.cwd && snapshot.cwd !== focus.cwd)) {
    const cwd = transition.kind === "loading" ? transition.cwd : focus.cwd
    return <GitLoading label={`Reading changes${cwd ? ` in ${cwd.split(/[\\/]/).filter(Boolean).at(-1)}` : ""}`} />
  }
  return <RepositoryChanges key={`${focus.identity}:${snapshot.cwd}`} snapshot={snapshot} />
}

function RepositoryChanges({ snapshot }: { snapshot: GitStatus }) {
  // The Review stream fills the open repository; the Files tree fits its rows.
  const grow = usePrefs((prefs) => prefs.changesLayout) === "review" ? "flex-1" : "shrink"
  const [collapsed, setCollapsed] = useState(false)
  const [pending, setPending] = useState<string>()
  const [error, setError] = useState<string>()
  const select = async (root: string) => {
    setCollapsed(false)
    setPending(root)
    setError(undefined)
    try { await actions.selectGitRepository(root) }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not read this repository.") }
    finally { setPending(undefined) }
  }
  if (!snapshot.repositories?.length) return (
    <div className="flex h-full min-h-0 flex-col">
      {snapshot.discoveryLimited ? <p className="px-2.5 py-2 text-label text-faint">Some folders could not be scanned. Open a more specific folder to find additional repositories.</p> : null}
      <div className="min-h-0 flex-1"><WorkspaceChanges key={snapshot.root ?? snapshot.cwd} /></div>
    </div>
  )
  const activeRoot = pending ?? snapshot.root
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 flex-1 flex-col">
        {snapshot.repositories.map((repository) => {
          const expanded = activeRoot === repository.root && !collapsed
          return (
            <section key={repository.root} className={cn("flex min-h-0 flex-col", expanded ? grow : "shrink-0")}>
              <button type="button" aria-label={repository.label} aria-expanded={expanded}
                disabled={Boolean(pending)} title={repository.root}
                className="pressable group flex h-8 w-full shrink-0 items-center gap-2 border-b border-hairline px-2.5 text-left transition-colors duration-100 hover:bg-fill-hover disabled:cursor-wait"
                onClick={() => {
                  if (repository.root === snapshot.root) setCollapsed((value) => !value)
                  else void select(repository.root)
                }}>
                <ChevronRightIcon className={cn("size-3 shrink-0 text-faint transition-transform duration-150 ease-[var(--ease-out)]", expanded && "rotate-90")} />
                <span className={cn("min-w-0 truncate text-ui font-medium", expanded ? "text-foreground" : "text-foreground/80")}>{repository.label}</span>
                {/* Expanded, the Files header below counts them. */}
                {!expanded && repository.changes ? <span className="tabular shrink-0 rounded-full bg-foreground/[0.07] px-1.5 text-label leading-4 text-muted-foreground">{repository.changes}</span> : null}
                <span className="flex-1" />
                {repository.unavailable ? <span className="truncate text-label text-faint">Unavailable</span> : (
                  <span className="flex min-w-0 items-center gap-1 text-label text-faint">
                    <GitBranchIcon className="size-3 shrink-0" />
                    <span className="truncate">{repository.branch ?? "Detached HEAD"}</span>
                  </span>
                )}
              </button>
              {expanded ? (
                <div role="region" aria-label={`Changes in ${repository.label}`} className={cn("flex min-h-0 flex-col", grow)}>
                  {pending ? <GitLoading label={`Reading changes in ${repository.label}`} /> : <WorkspaceChanges key={snapshot.root} inline />}
                </div>
              ) : null}
            </section>
          )
        })}
        {snapshot.discoveryLimited ? <p className="px-2.5 py-2 text-label text-faint">Some folders could not be scanned. Open a more specific folder to find additional repositories.</p> : null}
        {error ? <p role="alert" className="px-2.5 py-2 text-label text-removed">{error}</p> : null}
      </div>
      <fieldset disabled={Boolean(pending)} className="min-w-0 shrink-0 border-0 p-0">
        <CommitBox key={snapshot.root} staged={snapshot.files.filter((file) => file.staged).length} total={snapshot.files.length} />
        <PullRequestCard />
      </fieldset>
    </div>
  )
}

/**
 * The working tree, in the layout Settings › Git picks: Review, every file's
 * diff in one scroll, or Files, a folded tree with staging on the row and one
 * file's diff. Both read the same status and end in the same commit box.
 */
function WorkspaceChanges({ inline = false }: { inline?: boolean }) {
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

  const layout = usePrefs((prefs) => prefs.changesLayout)
  const autoOpenDiff = usePrefs((prefs) => prefs.autoOpenDiff)
  const diffStyle = usePrefs((prefs) => prefs.diffStyle)
  const wrapDiff = usePrefs((prefs) => prefs.wrapDiff)
  const selected = git?.root ? selectedDiffs[git.root] : undefined
  const [diff, setDiff] = useState<GitDiff>()

  const filesView = usePrefs((prefs) => prefs.filesView)
  const rows = useMemo(() => buildFileTree(files, collapsed, filesView), [collapsed, files, filesView])
  const staged = useMemo(() => files.filter((file) => file.staged).length, [files])

  // With the diff pane closed the list is the whole panel, so nothing is
  // "selected" and no file contents are fetched at all.
  const selectedFile = files.find((file) => file.path === selected)
  const active = layout === "files" && autoOpenDiff ? selectedFile : undefined
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
    // One call for the whole folder: `git add -- a b c` is atomic where a loop
    // would emit a status refresh per file and flicker the list.
    await updateStaging([...targets], stage)
  }, [files, updateStaging])

  const toggleStage = useCallback((file: GitFile) => stagePaths([file.path], !(requestedStages.current.get(file.path) ?? file.staged)), [stagePaths])
  const discardPaths = useCallback((paths: readonly string[]) => {
    const chosen = new Set(paths)
    void discardFiles(files.filter((file) => chosen.has(file.path) && file.status !== "conflicted"))
  }, [files])

  if (files.length === 0) {
    return (
      <div className={cn("flex min-h-0 flex-col", inline ? "shrink" : "h-full")}>
        <WorktreeReview />
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
        {!inline && git?.root ? <CommitBox staged={0} total={0} /> : null}
        {!inline ? <PullRequestCard /> : null}
      </div>
    )
  }

  if (layout === "review") {
    return (
      <div className={cn("flex min-h-0 flex-col", inline ? "flex-1" : "h-full")}>
        <WorktreeReview />
        <ReviewStream files={files} workspace={workspace} staged={staged} onReviewInCenter={openWorkingTree} />
        <CommitsSection onPickFile={pickCommitFile} onPickCommit={pickCommit} />
        <ReviewBar workspace={workspace} />
        {!inline ? <CommitBox staged={staged} total={files.length} /> : null}
        {!inline ? <PullRequestCard /> : null}
      </div>
    )
  }

  return (
    <div className={cn("flex min-h-0 flex-col", inline ? "shrink" : "h-full")}>
      <WorktreeReview />
      <div className="flex h-8 shrink-0 items-center gap-2 pr-1.5 pl-3 text-label">
        {/* The counts already project pending checkbox intent, so a stage
            write in flight only marks the reading busy; swapping the whole
            sentence for "Updating..." and back made every click blink. */}
        <span role="status" aria-busy={staging || undefined} className="tabular min-w-0 truncate text-muted-foreground">
          {`${files.length} ${files.length === 1 ? "change" : "changes"}`}
          {staged > 0 ? <span className="text-faint">{` · ${staged} staged`}</span> : null}
        </span>
        {/* Line totals are deferred for large changesets; an unknown total
            shows nothing rather than a label explaining its absence. */}
        {files.every((file) => file.insertions !== null && file.deletions !== null) ? (
          <LineCounts insertions={files.reduce((sum, file) => sum + (file.insertions ?? 0), 0)} deletions={files.reduce((sum, file) => sum + (file.deletions ?? 0), 0)} />
        ) : null}
        <div className="ml-auto flex items-center text-faint">
          <IconAction
            label="Review current changes in the center"
            size="xs"
            onClick={openWorkingTree}
          >
            <Maximize2Icon />
          </IconAction>
          <IconAction
            label={filesView === "tree" ? "List by folder" : "Show as a tree"}
            size="xs"
            onClick={() => setPref("filesView", filesView === "tree" ? "folders" : "tree")}
          >
            {filesView === "tree" ? <ListIcon /> : <ListTreeIcon />}
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

      <ChangeList rows={rows} compact={showDiff} fitContent={inline && !showDiff} renderRow={(row) => row.kind === "dir" ? (
        <DirRow row={row} busy={row.paths.some((path) => stageOverrides.has(path))} onToggle={toggleDir} onStage={stagePaths} onDiscard={discardPaths} />
      ) : (
        <FileRow row={row} busy={stageOverrides.has(row.file.path)} active={selected === row.file.path} onSelect={selectFile} onToggleStage={toggleStage} onDiscard={discardPaths} />
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
              onClick={() => setPref("diffStyle", diffStyle === "unified" ? "split" : "unified")}
            >
              <Columns2Icon />
            </IconAction>
            <IconAction
              label={wrapDiff ? "Disable line wrapping" : "Wrap long lines"}
              size="xs"
              data-on={wrapDiff || undefined}
              onClick={() => setPref("wrapDiff", !wrapDiff)}
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
                theme: DIFF_THEME,
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
      {!inline ? <CommitBox staged={staged} total={files.length} /> : null}
      {!inline ? <PullRequestCard /> : null}
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
  const branch = useSession((state) => state.git?.branch)
  const ahead = useSession((state) => state.git?.ahead ?? 0)
  // With several repositories, each one's header already names its branch.
  const named = useSession((state) => Boolean(state.git?.repositories?.length))
  if (!hasRepo) return null
  return (
    <div className="flex min-h-0 shrink-0 flex-col border-t border-hairline">
      <button
        type="button"
        aria-expanded={open}
        aria-label={branch ? `History on ${branch}` : "History"}
        onClick={() => setOpen((value) => !value)}
        className="pressable flex h-8 w-full shrink-0 items-center gap-2 pr-2.5 pl-3 text-left text-label transition-colors duration-100 hover:bg-fill-hover"
      >
        <span className="text-muted-foreground">History</span>
        {ahead > 0 ? <span className="tabular text-caution/80">{ahead} not pushed</span> : null}
        <span className="flex-1" />
        {branch && !named ? (
          <span className="flex min-w-0 items-center gap-1 text-faint">
            <GitBranchIcon className="size-3 shrink-0" />
            <span className="truncate">{branch}</span>
          </span>
        ) : null}
        <ChevronRightIcon className={cn("size-3 shrink-0 text-faint transition-transform duration-200 ease-[var(--ease-out)]", open ? "-rotate-90" : "rotate-90")} />
      </button>
      <Collapse open={open}>
        <div className="max-h-[36vh] overflow-y-auto overscroll-contain">
          <GitLog onPickFile={onPickFile} onPickCommit={onPickCommit} />
        </div>
      </Collapse>
    </div>
  )
}

/**
 * The cell at a row's end: the file's status letter, which turns into its
 * staging checkbox on hover or focus. Staged rows keep the check, so what the
 * next commit takes reads at a glance. Folders carry the same control and act
 * on everything beneath them, partial when only some of it is staged.
 */
function StageCell({
  state,
  mark,
  label,
  busy,
  onToggle,
}: {
  state: "on" | "off" | "partial"
  mark?: StatusMark
  label: string
  busy: boolean
  onToggle: () => void
}) {
  const shown = state !== "off" || busy
  return (
    <span className="relative flex size-6 shrink-0 items-center justify-center">
      {mark ? (
        <span title={mark.title} className={cn(
          "pointer-events-none font-mono text-label leading-none font-semibold transition-opacity duration-100 group-hover:opacity-0 group-focus-within:opacity-0",
          mark.tone,
          shown && "opacity-0"
        )}>
          {mark.glyph}
        </span>
      ) : null}
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
        className={cn(
          "pressable stage-hit-target absolute inset-0 flex cursor-pointer items-center justify-center select-none transition-opacity duration-100 focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100",
          !shown && "opacity-0"
        )}
      >
        <span aria-hidden className={cn(
          "pointer-events-none flex size-3.5 items-center justify-center rounded-[4px] ring-1 ring-inset transition-colors duration-100",
          state === "off" ? "ring-foreground/35 hover:ring-foreground/55" : "bg-foreground/80 ring-foreground/80"
        )}>
          {state === "on" ? (
            <svg viewBox="0 0 10 10" className="size-2.5 text-background" aria-hidden>
              <path d="M1.8 5.2 4 7.3 8.2 2.9" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : state === "partial" ? (
            <span className="block h-[1.5px] w-[7px] rounded-full bg-background" />
          ) : null}
        </span>
      </button>
    </span>
  )
}

/** Where a row's content starts, as the Files tab indents. */
function indent(depth: number) {
  return { paddingInlineStart: 4 + depth * TREE_INDENT }
}

/** One faint line per enclosing folder, under that folder's chevron. */
function Guides({ depth }: { depth: number }) {
  if (depth === 0) return null
  return <>{Array.from({ length: depth }, (_, level) => (
    <span key={level} aria-hidden className="pointer-events-none absolute inset-y-0 w-px bg-foreground/[0.07]" style={{ left: 4 + level * TREE_INDENT + 6 }} />
  ))}</>
}

function DirRow({
  row,
  busy,
  onToggle,
  onStage,
  onDiscard,
}: {
  busy: boolean
  row: Extract<TreeRow, { kind: "dir" }>
  onToggle: (key: string) => void
  onStage: (paths: string[], stage: boolean) => void
  onDiscard: (paths: readonly string[]) => void
}) {
  const state = row.staged === 0 ? "off" : row.staged === row.files ? "on" : "partial"
  const FolderGlyph = row.collapsed ? FolderIcon : FolderOpenIcon
  return (
    <div className="group relative flex h-6 items-center gap-1 rounded select-none transition-colors duration-100 hover:bg-fill-hover">
      <Guides depth={row.depth} />
      <button
        type="button"
        aria-expanded={!row.collapsed}
        onClick={() => onToggle(row.key)}
        title={row.key}
        style={indent(row.depth)}
        className="pressable stage-hit-target flex h-full min-w-0 flex-1 items-center gap-1.5 text-left"
      >
        <ChevronRightIcon className={cn("size-3 shrink-0 text-faint transition-transform duration-150 ease-[var(--ease-out)]", !row.collapsed && "rotate-90")} />
        <FolderGlyph className="size-3.5 shrink-0 text-faint" />
        <span className="min-w-0 truncate text-ui text-foreground/85">{row.label}</span>
        {/* Open, the files below say what the count would; it earns its
            place when it hides them or when only part of them is staged. */}
        {row.collapsed || state === "partial" ? (
          <span className="tabular shrink-0 text-label text-faint">
            {state === "partial" ? `${row.staged} of ${row.files}` : row.files}
          </span>
        ) : null}
      </button>
      <DiscardAction label={`Discard changes in ${row.label}`} onDiscard={() => onDiscard(row.paths)} />
      {row.collapsed ? <LineCounts insertions={row.insertions} deletions={row.deletions} className="group-hover:hidden group-focus-within:hidden" /> : null}
      <StageCell
        state={state}
        busy={busy}
        // Partially staged reads as "not yet done", so the useful action is to
        // finish staging it rather than to clear what you already picked.
        label={state === "on" ? `Unstage ${row.label}` : `Stage all of ${row.label}`}
        onToggle={() => onStage(row.paths, state !== "on")}
      />
    </div>
  )
}

/** Shown on the row's hover or focus, as VS Code's is; the dialog it opens says what goes. */
function DiscardAction({ label, onDiscard }: { label: string; onDiscard: () => void }) {
  return (
    <IconAction label={label} size="xs" onClick={onDiscard} className="hidden text-faint group-hover:flex group-focus-within:flex focus-visible:flex">
      <Undo2Icon />
    </IconAction>
  )
}

function FileRow({
  row,
  active,
  busy,
  onSelect,
  onToggleStage,
  onDiscard,
}: {
  busy: boolean
  row: Extract<TreeRow, { kind: "file" }>
  active: boolean
  onSelect: (path: string) => void
  onToggleStage: (file: GitFile) => void
  onDiscard: (paths: readonly string[]) => void
}) {
  const file = row.file
  const mark = MARK[file.status]
  return (
    <div className={cn(
      "group relative flex h-6 items-center gap-1 rounded select-none transition-colors duration-100",
      active ? "bg-fill-selected" : "hover:bg-fill-hover"
    )}>
      <Guides depth={row.depth} />
      <button
        type="button"
        onClick={() => onSelect(file.path)}
        title={file.path}
        style={indent(row.depth)}
        className="pressable stage-hit-target flex h-full min-w-0 flex-1 items-center gap-1.5 text-left"
      >
        {/* Files sit under their folder's label, past the chevron column. */}
        <span className="w-3 shrink-0" />
        <FileTypeIcon path={file.path} className="size-3.5 shrink-0 text-faint/80" />
        <span className={cn(
          "min-w-0 truncate text-ui",
          file.status === "deleted" ? "text-faint line-through decoration-faint/60" : file.status === "conflicted" ? "text-removed" : active ? "text-foreground" : "text-foreground/85"
        )}>
          {row.label}
        </span>
      </button>
      {file.status !== "conflicted" ? <DiscardAction label={`Discard changes to ${row.label}`} onDiscard={() => onDiscard([file.path])} /> : null}
      <LineCounts insertions={file.insertions} deletions={file.deletions} className="group-hover:hidden group-focus-within:hidden" />
      <StageCell
        state={file.staged ? "on" : "off"}
        mark={mark}
        busy={busy}
        label={file.staged ? `Unstage ${row.label}` : `Stage ${row.label}`}
        onToggle={() => onToggleStage(file)}
      />
      <Slot name="changes.file.trailing" file={file} />
    </div>
  )
}
