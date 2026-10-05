import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react"
import { getSingularPatch, parseDiffFromFile, type CodeViewDiffItem, type DiffLineAnnotation, type FileDiffMetadata } from "@pierre/diffs"
import { CodeView, type CodeViewHandle, type CodeViewReactOptions } from "@pierre/diffs/react"
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, ChevronsDownUpIcon, ChevronsUpDownIcon, Columns2Icon, CopyIcon, EllipsisIcon, FileIcon, GitBranchIcon, GitCommitHorizontalIcon, Maximize2Icon, MessageSquareIcon, PencilIcon, RefreshCwIcon, Undo2Icon, WrapTextIcon } from "lucide-react"
import { ImageThumbs } from "@/components/inspector/binary-diff"
import { Annotation, GutterAdd } from "@/components/inspector/review"
import { Action, IconAction } from "@/components/ui/kit"
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/menu"
import { SearchSelect } from "@/components/ui/search-select"
import { binarySizes } from "@/lib/git-binary"
import { cn } from "@/lib/utils"
import type { GitCommitEntry, GitDiff, GitFile } from "@/lib/types"
import { git as gitActions } from "@/state/git"
import { discardFiles } from "@/state/git-discard"
import { useGitHub } from "@/state/github"
import { setPref, usePrefs } from "@/state/prefs"
import { review, useReview } from "@/state/review"
import { actions, store, useSession } from "@/state/session"
import { createHook, createStore } from "@/state/store"
import { viewer } from "@/state/viewer"
import { readWorktreeReview, useWorktrees, worktreeAt } from "@/state/worktrees"

/** Diffs read at once; each is a preview the host serves from `cat-file` and the disk. */
const LOADS = 4
/** Past this many changed lines a file starts folded, as GitHub's review does. */
const LARGE_LINES = 800
/** The custom header's height, so the stream reserves it before measuring. */
const HEADER_HEIGHT = 32

type Loaded =
  | { kind: "diff"; fileDiff: FileDiffMetadata; signature: string; lines: number; limited: boolean }
  | { kind: "binary"; diff: GitDiff }
  | { kind: "unavailable"; reason: string }

/** Which changes the stream shows: what isn't committed, everything since the branch left its base, or one commit. */
type Scope =
  | { kind: "uncommitted" }
  | { kind: "since"; ref: string; label: string }
  | { kind: "commit"; hash: string; shortHash: string; subject: string }

const UNCOMMITTED: Scope = { kind: "uncommitted" }
/** Commits the scope menu offers. */
const RECENT_COMMITS = 15

interface Entry {
  loaded: Loaded
  /** The status changed since this was read; it shows until the new read lands. */
  stale: boolean
}

const MARK = {
  conflicted: { glyph: "!", tone: "text-removed", title: "Merge conflict" },
  added: { glyph: "A", tone: "text-added", title: "Added" },
  untracked: { glyph: "U", tone: "text-added", title: "Untracked" },
  modified: { glyph: "M", tone: "text-caution", title: "Modified" },
  deleted: { glyph: "D", tone: "text-removed", title: "Deleted" },
} satisfies Record<GitFile["status"], { glyph: string; tone: string; title: string }>

/** Viewed marks by repository and path, each with the contents it was given for. */
const viewedStore = createStore<{ marks: Readonly<Record<string, string>> }>({ marks: {} })
const useViewed = createHook(viewedStore)
/** Marked before its diff was read: viewed until the file changes after a read. */
const UNREAD = "?"

const viewedKey = (workspace: string, path: string) => `${workspace}\n${path}`

function setViewed(workspace: string, path: string, signature: string | undefined) {
  const marks = { ...viewedStore.get().marks }
  if (signature === undefined) delete marks[viewedKey(workspace, path)]
  else marks[viewedKey(workspace, path)] = signature
  viewedStore.set({ marks })
}

const GENERATED = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|Gemfile\.lock|poetry\.lock|composer\.lock|go\.sum|uv\.lock)$|(^|\/)dist\/|\.min\.(js|css)$|\.map$/

/** Lockfiles, build output and minified files: folded with a placeholder until asked for. */
function generated(path: string): boolean {
  return GENERATED.test(path)
}

function changedLines(file: GitFile): number | null {
  return file.insertions === null || file.deletions === null ? null : file.insertions + file.deletions
}

function fingerprint(text: string, seed = 2166136261): number {
  let hash = seed
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function unreadable(error: Error): Loaded {
  return { kind: "unavailable", reason: error.message || "The diff could not be read." }
}

function toLoaded(diff: GitDiff): Loaded {
  if (diff.binary) return { kind: "binary", diff }
  if (diff.preview?.kind === "unavailable") return { kind: "unavailable", reason: diff.preview.reason }
  if (diff.preview?.kind === "patch") {
    const fileDiff = getSingularPatch(diff.preview.contents)
    const signature = `p${diff.preview.contents.length}:${fingerprint(diff.preview.contents)}`
    fileDiff.cacheKey = `${diff.path}:${signature}`
    return { kind: "diff", fileDiff, signature, lines: lineCount(fileDiff), limited: diff.preview.limited }
  }
  if (!diff.oldFile && !diff.newFile) return { kind: "unavailable", reason: "No text content to compare." }
  const before = diff.oldFile?.contents
  const after = diff.newFile?.contents
  const signature = `f${before?.length ?? -1}:${after?.length ?? -1}:${fingerprint(after ?? "", fingerprint(before ?? ""))}`
  const fileDiff = parseDiffFromFile(
    diff.oldFile ? { ...diff.oldFile, cacheKey: `${diff.path}:${signature}:before` } : null,
    diff.newFile ? { ...diff.newFile, cacheKey: `${diff.path}:${signature}:after` } : null,
  )
  return { kind: "diff", fileDiff, signature, lines: lineCount(fileDiff), limited: false }
}

function lineCount(fileDiff: FileDiffMetadata): number {
  return fileDiff.hunks.reduce((sum, hunk) => sum + hunk.additionLines + hunk.deletionLines, 0)
}

/** Reads the diffs of mounted headers, `LOADS` at a time; a header that unmounts first is skipped. */
function diffQueue(first: (path: string) => Promise<GitDiff>, onLoaded: (path: string, loaded: Loaded) => void) {
  let load = first
  let wanted: string[] = []
  let open = true
  const reading = new Set<string>()
  const pump = () => {
    while (open && reading.size < LOADS) {
      const path = wanted.shift()
      if (path === undefined) return
      reading.add(path)
      void load(path).then(toLoaded, unreadable).then((loaded) => {
        if (open) onLoaded(path, loaded)
      }).finally(() => {
        reading.delete(path)
        pump()
      })
    }
  }
  return {
    need(path: string) {
      if (!reading.has(path) && !wanted.includes(path)) wanted.push(path)
      pump()
    },
    drop(path: string) {
      wanted = wanted.filter((entry) => entry !== path)
    },
    open() {
      open = true
    },
    /** Reads from here on go through `next`. */
    use(next: (path: string) => Promise<GitDiff>) {
      load = next
    },
    close() {
      open = false
      wanted = []
    },
  }
}

/** Puts `@path` in the composer, as ⌘↩ in the file palette does: relative to the workspace when the file is inside it. */
function mention(root: string, path: string): void {
  const cwd = store.get().meta?.cwd ?? root
  const absolute = `${root}/${path}`
  const named = absolute.startsWith(`${cwd}/`) ? absolute.slice(cwd.length + 1) : absolute
  window.dispatchEvent(new CustomEvent("mako:insert", { detail: `@${named} ` }))
}

/** What a file shows before its diff is read: the header alone. */
function placeholder(file: GitFile): FileDiffMetadata {
  return {
    name: file.path,
    type: file.status === "added" || file.status === "untracked" ? "new" : file.status === "deleted" ? "deleted" : "change",
    hunks: [],
    splitLineCount: 0,
    unifiedLineCount: 0,
    isPartial: true,
    deletionLines: [],
    additionLines: [],
  }
}

function sameLoaded(left: Loaded, right: Loaded): boolean {
  if (left.kind === "diff" && right.kind === "diff") return left.signature === right.signature && left.limited === right.limited
  if (left.kind === "unavailable" && right.kind === "unavailable") return left.reason === right.reason
  if (left.kind === "binary" && right.kind === "binary") return binarySizes(left.diff) === binarySizes(right.diff) && left.diff.after?.image === right.diff.after?.image
  return left.kind === right.kind
}

/**
 * Every changed file in one scroll, the Review layout of Changes, for the
 * scope chosen in its header: what isn't committed (the default), everything
 * since the branch left its base, or one commit.
 */
export function ReviewStream({ files, workspace, staged, onReviewInCenter }: { files: readonly GitFile[]; workspace: string; staged: number; onReviewInCenter: () => void }) {
  // A scope belongs to the repository it was chosen in.
  const [chosen, setChosen] = useState<{ workspace: string; scope: Scope }>({ workspace, scope: UNCOMMITTED })
  const scope = chosen.workspace === workspace ? chosen.scope : UNCOMMITTED
  const choose = useCallback((next: Scope) => setChosen({ workspace, scope: next }), [workspace])
  const [read, setRead] = useState<{ key: string; files: readonly GitFile[] | null; base?: string }>()
  const key = scope.kind === "uncommitted" ? "uncommitted" : scope.kind === "since" ? `since:${scope.ref}` : `commit:${scope.hash}`

  // A since scope changes with every edit too, so it is read again with the status.
  useEffect(() => {
    if (scope.kind === "uncommitted") return
    let current = true
    const reading = scope.kind === "since"
      ? gitActions.changedSince(scope.ref).then((since) => ({ files: since?.files ?? null, base: since?.base }))
      : gitActions.commitFiles(scope.hash).then((listed) => ({ files: listed.map((file): GitFile => ({ ...file, staged: false })), base: undefined }))
    void reading.then(
      (next) => { if (current) setRead({ key, ...next }) },
      () => { if (current) setRead({ key, files: null }) },
    )
    return () => { current = false }
  }, [files, key, scope])

  const shown = scope.kind === "uncommitted" ? files : read?.key === key ? read.files : undefined
  const base = read?.key === key ? read.base : undefined
  const load = loader(scope, base)
  const picker = <ScopePicker scope={scope} onChoose={choose} />
  if (shown === undefined || (scope.kind === "since" && shown && !base)) return <ScopeMessage picker={picker} text="Reading…" />
  if (shown === null) return <ScopeMessage picker={picker} text={scope.kind === "since" ? `This branch shares no history with ${scope.label.replace(/^Since /, "")}.` : "This commit couldn't be read."} />
  return <ReviewFiles key={key} files={shown} workspace={workspace} staged={scope.kind === "uncommitted" ? staged : 0} scope={scope} picker={picker} load={load} onReviewInCenter={onReviewInCenter} />
}

function loader(scope: Scope, base: string | undefined): (path: string) => Promise<GitDiff> {
  if (scope.kind === "commit") return (path) => gitActions.commitFileDiff(scope.hash, path)
  if (scope.kind === "since") return (path) => base ? gitActions.sinceDiff(base, path) : Promise.reject(new Error("Reading where the branch started…"))
  return (path) => gitActions.diff(path)
}

function ScopeMessage({ picker, text }: { picker: ReactNode; text: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-hairline px-1.5 text-label text-faint">{picker}</div>
      <p role="status" className="p-3 text-label text-faint">{text}</p>
    </div>
  )
}

/**
 * The scope menu. Since main is offered on a branch other than the default
 * one; in a Thread's worktree it is the same Since main its branch bar shows.
 */
function ScopePicker({ scope, onChoose }: { scope: Scope; onChoose: (scope: Scope) => void }) {
  const cwd = useSession((state) => state.git?.cwd)
  const branch = useSession((state) => state.git?.branch)
  const worktree = useWorktrees((state) => worktreeAt(state.worktrees, cwd)?.worktree)
  const defaultBranch = useGitHub((state) => state.status?.defaultBranch)
  const [since, setSince] = useState<{ ref: string; label: string } | null>(null)
  const [commits, setCommits] = useState<readonly GitCommitEntry[] | null>(null)
  const open = (next: boolean) => {
    if (!next) return
    void gitActions.log(RECENT_COMMITS).then(setCommits, () => setCommits([]))
    if (worktree) {
      void readWorktreeReview(worktree.path).then(
        (review) => setSince({ ref: review.into ?? review.base, label: `Since ${review.into ?? "it started"}` }),
        () => setSince(null),
      )
    } else setSince(defaultBranch && branch && branch !== defaultBranch ? { ref: defaultBranch, label: `Since ${defaultBranch}` } : null)
  }
  const label = scope.kind === "uncommitted" ? "Uncommitted" : scope.kind === "since" ? scope.label : scope.shortHash
  return (
    <Menu modal={false} onOpenChange={open}>
      <MenuTrigger asChild>
        <Action size="xs" tone="quiet" aria-label={`Showing: ${scope.kind === "commit" ? `commit ${scope.shortHash}` : label}. Choose what to review`} title={scope.kind === "commit" ? scope.subject : undefined} className="max-w-40 gap-1 px-1.5 font-medium">
          {scope.kind === "commit" ? <GitCommitHorizontalIcon /> : scope.kind === "since" ? <GitBranchIcon /> : <PencilIcon />}
          <span className="truncate">{label}</span>
          <ChevronDownIcon className="size-3! text-faint/70" />
        </Action>
      </MenuTrigger>
      <MenuContent align="start" className="max-h-96 w-72 overflow-y-auto">
        <ScopeItem on={scope.kind === "uncommitted"} onSelect={() => onChoose(UNCOMMITTED)} title="Uncommitted" detail="What isn't committed yet, staged or not" />
        {since ? <ScopeItem on={scope.kind === "since" && scope.ref === since.ref} onSelect={() => onChoose({ kind: "since", ...since })} title={since.label} detail="Every commit on this branch and what isn't committed" /> : null}
        <MenuSeparator />
        <MenuLabel>A commit</MenuLabel>
        {commits === null ? <MenuItem disabled>Reading history…</MenuItem> : commits.length === 0 ? <MenuItem disabled>No commits yet</MenuItem> : commits.map((commit) => (
          <ScopeItem key={commit.hash} on={scope.kind === "commit" && scope.hash === commit.hash} onSelect={() => onChoose({ kind: "commit", hash: commit.hash, shortHash: commit.shortHash, subject: commit.subject })} title={commit.subject} detail={commit.shortHash} mono />
        ))}
      </MenuContent>
    </Menu>
  )
}

function ScopeItem({ on, title, detail, mono = false, onSelect }: { on: boolean; title: string; detail: string; mono?: boolean; onSelect: () => void }) {
  return (
    <MenuItem onSelect={onSelect} aria-checked={on} role="menuitemradio">
      <CheckIcon className={cn("size-3.5 shrink-0", on ? "text-foreground" : "invisible")} />
      <span className="min-w-0 flex-1">
        <span className="block truncate">{title}</span>
        <span className={cn("block truncate text-label text-faint", mono && "font-mono")}>{detail}</span>
      </span>
    </MenuItem>
  )
}

/**
 * One scope's files in one scroll.
 *
 * Each file starts as its header. A diff is read when its file enters the
 * rendered window, a few at a time, so 5,000 changed files cost what the
 * visible ones do. A status change re-reads only the files in view, and the
 * old diff stays up until the new one lands.
 */
function ReviewFiles({ files, workspace, staged, scope, picker, load, onReviewInCenter }: { files: readonly GitFile[]; workspace: string; staged: number; scope: Scope; picker: ReactNode; load: (path: string) => Promise<GitDiff>; onReviewInCenter: () => void }) {
  const diffStyle = usePrefs((prefs) => prefs.diffStyle)
  const wrapDiff = usePrefs((prefs) => prefs.wrapDiff)
  const marks = useViewed((state) => state.marks)
  const allComments = useReview((state) => state.comments)
  const draft = useReview((state) => state.draft)
  const handle = useRef<CodeViewHandle<undefined>>(null)
  const scrollTop = useRef(0)
  const [entries, setEntries] = useState(() => new Map<string, Entry>())
  const [opened, setOpened] = useState(() => new Map<string, boolean>())
  const [queue] = useState(() => diffQueue(load, (path, loaded) => setEntries((previous) => {
    const current = previous.get(path)
    return new Map(previous).set(path, { loaded: current && sameLoaded(current.loaded, loaded) ? current.loaded : loaded, stale: false })
  })))
  useEffect(() => {
    queue.open()
    return () => queue.close()
  }, [queue])
  useEffect(() => queue.use(load), [load, queue])

  const byPath = useMemo(() => new Map(files.map((file) => [file.path, file])), [files])

  const viewedFor = useCallback((path: string, entry: Entry | undefined) => {
    const mark = marks[viewedKey(workspace, path)]
    if (mark === undefined) return false
    if (mark === UNREAD || entry?.loaded.kind !== "diff") return true
    return mark === entry.loaded.signature
  }, [marks, workspace])

  const isOpen = useCallback((file: GitFile, entry: Entry | undefined) => {
    if (entry?.loaded.kind === "binary") return false
    const chosen = opened.get(file.path)
    if (chosen !== undefined) return chosen
    if (viewedFor(file.path, entry) || generated(file.path)) return false
    const lines = entry?.loaded.kind === "diff" ? entry.loaded.lines : changedLines(file)
    return lines === null || lines <= LARGE_LINES
  }, [opened, viewedFor])

  // Callbacks the stream calls later read the latest render through these.
  const byPathRef = useRef(byPath)
  const entriesRef = useRef(entries)
  const openRef = useRef(isOpen)
  useEffect(() => {
    byPathRef.current = byPath
    entriesRef.current = entries
    openRef.current = isOpen
  }, [byPath, entries, isOpen])

  // The status is the source: a path that left it is forgotten, and every
  // read diff is due again, re-read when it is next in view.
  useEffect(() => {
    queueMicrotask(() => setEntries((previous) => {
      const next = new Map<string, Entry>()
      for (const [path, entry] of previous) if (byPath.has(path)) next.set(path, { ...entry, stale: true })
      return next
    }))
  }, [byPath])

  const items = useMemo(() => files.map((file): CodeViewDiffItem<undefined> => {
    const entry = entries.get(file.path)
    const open = isOpen(file, entry)
    const collapsed = !(open && entry?.loaded.kind === "diff")
    const annotations: DiffLineAnnotation<undefined>[] = []
    const seen = new Set<string>()
    const annotate = (lineNumber: number, side: "additions" | "deletions") => {
      if (seen.has(`${side}:${lineNumber}`)) return
      seen.add(`${side}:${lineNumber}`)
      annotations.push({ lineNumber, side })
    }
    for (const comment of allComments) if (comment.workspace === workspace && comment.path === file.path) annotate(comment.line, comment.side)
    if (draft && draft.workspace === workspace && draft.path === file.path) annotate(draft.line, draft.side)
    const loaded = entry?.loaded
    // The stream redraws an item only when its version moves; this one moves
    // with anything its header or body shows.
    const version = fingerprint(`${loaded?.kind === "diff" ? loaded.signature : loaded?.kind ?? ""}|${collapsed}|${[...seen].join(",")}|${file.status}|${file.insertions}|${file.deletions}|${open}|${viewedFor(file.path, entry)}`)
    return {
      id: file.path,
      type: "diff",
      fileDiff: loaded?.kind === "diff" ? loaded.fileDiff : placeholder(file),
      collapsed,
      annotations,
      version,
    }
  }), [allComments, draft, entries, files, isOpen, viewedFor, workspace])

  const onScroll = useCallback((top: number) => {
    scrollTop.current = top
  }, [])

  const toggle = useCallback((path: string) => {
    const file = byPathRef.current.get(path)
    if (!file) return
    const open = openRef.current(file, entriesRef.current.get(path))
    setOpened((previous) => new Map(previous).set(path, !open))
  }, [])

  const markViewed = useCallback((path: string, on: boolean) => {
    const entry = entriesRef.current.get(path)
    setViewed(workspace, path, on ? (entry?.loaded.kind === "diff" ? entry.loaded.signature : UNREAD) : undefined)
    setOpened((previous) => {
      const next = new Map(previous)
      if (on) next.delete(path)
      else next.set(path, true)
      return next
    })
  }, [workspace])

  const reveal = useCallback((path: string) => {
    setOpened((previous) => new Map(previous).set(path, true))
    handle.current?.scrollTo({ type: "item", id: path, align: "start" })
  }, [])

  /** `j` and `k`, as in a review on GitHub: the next or previous file's header to the top. */
  const step = useCallback((by: 1 | -1) => {
    const instance = handle.current?.getInstance()
    if (!instance) return
    const top = scrollTop.current
    const ids = files.map((file) => file.path)
    const target = by === 1
      ? ids.find((id) => (instance.getTopForItem(id) ?? 0) > top + 2)
      : ids.findLast((id) => (instance.getTopForItem(id) ?? 0) < top - 2)
    if (target) handle.current?.scrollTo({ type: "item", id: target, align: "start" })
  }, [files])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    if (event.target instanceof HTMLElement && event.target.closest("input, textarea, [contenteditable=true]")) return
    if (event.key === "j" || event.key === "k") {
      event.preventDefault()
      step(event.key === "j" ? 1 : -1)
    }
  }

  const anyOpen = files.some((file) => isOpen(file, entries.get(file.path)))
  const setAll = (open: boolean) => setOpened(new Map(files.map((file) => [file.path, open])))
  const counted = files.every((file) => changedLines(file) !== null)
  const insertions = files.reduce((sum, file) => sum + (file.insertions ?? 0), 0)
  const deletions = files.reduce((sum, file) => sum + (file.deletions ?? 0), 0)
  const jumpOptions = useMemo(() => files.map((file) => {
    const slash = file.path.lastIndexOf("/")
    return { value: file.path, label: file.path.slice(slash + 1), detail: slash > 0 ? file.path.slice(0, slash) : undefined, keywords: file.path }
  }), [files])

  const options = useMemo((): CodeViewReactOptions<undefined> => ({
    diffStyle,
    overflow: wrapDiff ? "wrap" : "scroll",
    stickyHeaders: true,
    enableGutterUtility: true,
    itemMetrics: { diffHeaderHeight: HEADER_HEIGHT },
  }), [diffStyle, wrapDiff])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-hairline pr-2.5 pl-1.5 text-label text-faint">
        {picker}
        <span role="status" className="min-w-0 flex-1 truncate tabular">
          {`${files.length} ${files.length === 1 ? "file" : "files"}${scope.kind === "uncommitted" ? " changed" : ""}${staged > 0 ? ` · ${staged} staged` : ""}`}
        </span>
        {counted ? <>
          <span className="tabular text-added">+{insertions}</span>
          <span className="tabular text-removed">−{deletions}</span>
        </> : null}
        <div className="ml-auto flex items-center gap-0.5">
          <SearchSelect
            value=""
            options={jumpOptions}
            onChange={reveal}
            label="Jump to file"
            placeholder="Jump to file"
            searchPlaceholder="Jump to file"
            emptyMessage="No changed file matches."
            className="h-6 w-28 bg-transparent text-label ring-0"
          />
          <IconAction label={anyOpen ? "Fold every file" : "Unfold every file"} size="xs" onClick={() => setAll(!anyOpen)}>
            {anyOpen ? <ChevronsDownUpIcon /> : <ChevronsUpDownIcon />}
          </IconAction>
          <IconAction label={diffStyle === "unified" ? "Show side by side" : "Show unified diff"} size="xs" data-on={diffStyle === "split" || undefined} onClick={() => setPref("diffStyle", diffStyle === "unified" ? "split" : "unified")}>
            <Columns2Icon />
          </IconAction>
          <IconAction label={wrapDiff ? "Disable line wrapping" : "Wrap long lines"} size="xs" data-on={wrapDiff || undefined} onClick={() => setPref("wrapDiff", !wrapDiff)}>
            <WrapTextIcon />
          </IconAction>
          {scope.kind === "uncommitted" ? (
            <IconAction label="Review current changes in the center" size="xs" onClick={onReviewInCenter}>
              <Maximize2Icon />
            </IconAction>
          ) : null}
          <IconAction label="Refresh" size="xs" onClick={() => void actions.refreshGit()}>
            <RefreshCwIcon />
          </IconAction>
        </div>
      </div>
      <div
        data-review-stream
        data-file-count={files.length}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        aria-label="Every changed file. J and K move between files."
        className="flex min-h-0 flex-1 flex-col outline-none"
      >
        <CodeView<undefined>
          ref={handle}
          items={items}
          options={options}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
          onScroll={onScroll}
          renderCustomHeader={(item) => {
            const file = byPath.get(item.id)
            if (!file) return null
            const entry = entries.get(item.id)
            return (
              <FileHeader
                file={file}
                entry={entry}
                open={isOpen(file, entry)}
                viewed={viewedFor(file.path, entry)}
                onToggle={toggle}
                onViewed={markViewed}
                queue={queue}
                root={workspace}
                load={load}
                discardable={scope.kind === "uncommitted"}
              />
            )
          }}
          renderAnnotation={(annotation, item) => (
            <Annotation
              workspace={workspace}
              path={item.id}
              line={annotation.lineNumber}
              side={"side" in annotation ? annotation.side : "additions"}
              comments={allComments.filter((comment) => comment.workspace === workspace && comment.path === item.id)}
            />
          )}
          renderGutterUtility={(getHoveredLine, item) => (
            <GutterAdd
              onClick={() => {
                const hovered = getHoveredLine()
                const side = hovered && "side" in hovered && (hovered.side === "additions" || hovered.side === "deletions") ? hovered.side : undefined
                if (!hovered || !side) return
                const loaded = entriesRef.current.get(item.id)?.loaded
                const lines = loaded?.kind === "diff" && !loaded.fileDiff.isPartial
                  ? side === "deletions" ? loaded.fileDiff.deletionLines : loaded.fileDiff.additionLines
                  : undefined
                review.start({ workspace, path: item.id, line: hovered.lineNumber, side, code: lines?.[hovered.lineNumber - 1]?.replace(/\r?\n$/, "") })
              }}
            />
          )}
        />
      </div>
    </div>
  )
}

/**
 * One file's header. The stream mounts headers only for files in its window,
 * so a header asks for its own diff while it is mounted and the diff is due.
 */
function FileHeader({ file, entry, open, viewed, root, queue, load, discardable, onToggle, onViewed }: {
  file: GitFile
  entry: Entry | undefined
  open: boolean
  viewed: boolean
  root: string
  queue: ReturnType<typeof diffQueue>
  load: (path: string) => Promise<GitDiff>
  /** The file's changes aren't committed, so Discard can take them back. */
  discardable: boolean
  onToggle: (path: string) => void
  onViewed: (path: string, on: boolean) => void
}) {
  const due = entry ? entry.stale : open
  useEffect(() => {
    if (!due) return
    queue.need(file.path)
    return () => queue.drop(file.path)
  }, [due, file.path, queue])
  const mark = MARK[file.status]
  const slash = file.path.lastIndexOf("/")
  const folder = slash > 0 ? file.path.slice(0, slash + 1) : ""
  const name = file.path.slice(slash + 1)
  const loaded = entry?.loaded
  const lines = loaded?.kind === "diff" ? loaded.lines : changedLines(file)
  const center = () => void viewer.openDiff(file.path, async () => ({ diffs: [await load(file.path)] }))
  const note = loaded?.kind === "binary"
    ? (loaded.diff.before?.image || loaded.diff.after?.image ? binarySizes(loaded.diff) : `Binary${binarySizes(loaded.diff) ? ` · ${binarySizes(loaded.diff)}` : ""}`)
    : loaded?.kind === "unavailable"
      ? loaded.reason
      : !open && generated(file.path)
        ? "Generated · Load diff"
        : !open && lines !== null && lines > LARGE_LINES && !viewed
          ? `${lines.toLocaleString()} lines · Load diff`
          : open && !loaded
            ? "Reading…"
            : loaded?.kind === "diff" && loaded.limited
              ? "Shortened"
              : null
  return (
    <div data-review-file={file.path} className="flex h-8 items-center gap-1.5 border-b border-hairline bg-surface px-2 text-label select-none">
      <button
        type="button"
        aria-expanded={loaded?.kind === "binary" ? undefined : open}
        aria-label={loaded?.kind === "binary" ? `Review ${file.path} in the center` : `${open ? "Fold" : "Unfold"} ${file.path}`}
        onClick={() => (loaded?.kind === "binary" ? center() : onToggle(file.path))}
        title={file.path}
        className="pressable flex h-full min-w-0 flex-1 items-center gap-1.5 text-left"
      >
        <ChevronRightIcon className={cn("size-3.5 shrink-0 text-faint transition-transform duration-150 ease-[var(--ease-out)] motion-reduce:transition-none", open && "rotate-90")} />
        <span title={mark.title} className={cn("w-2.5 shrink-0 font-mono font-semibold", mark.tone)}>{mark.glyph}</span>
        <span className="min-w-0 truncate text-ui">
          <span className="text-faint">{folder}</span>
          <span className={viewed ? "text-muted-foreground" : "text-foreground"}>{name}</span>
        </span>
        {loaded?.kind === "binary" ? <ImageThumbs diff={loaded.diff} /> : null}
        {note ? <span className="shrink-0 truncate text-faint" title={loaded?.kind === "unavailable" ? loaded.reason : undefined}>{note}</span> : null}
        <span className="ml-auto flex shrink-0 gap-1 tabular">
          {file.insertions ? <span className="text-added">+{file.insertions}</span> : null}
          {file.deletions ? <span className="text-removed">−{file.deletions}</span> : null}
        </span>
      </button>
      <label className="pressable flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded px-1 text-faint hover:text-foreground">
        <input
          type="checkbox"
          checked={viewed}
          onChange={(event) => onViewed(file.path, event.target.checked)}
          className="size-3 accent-foreground"
        />
        Viewed
      </label>
      <Menu modal={false}>
        <MenuTrigger asChild>
          <IconAction label={`More for ${file.path}`} size="xs">
            <EllipsisIcon />
          </IconAction>
        </MenuTrigger>
        <MenuContent align="end" className="min-w-48">
          {file.status !== "deleted" ? (
            <MenuItem onSelect={() => void viewer.open(`${root}/${file.path}`)}>
              <FileIcon className="size-3.5 text-faint" />
              Open file
            </MenuItem>
          ) : null}
          <MenuItem onSelect={center}>
            <Maximize2Icon className="size-3.5 text-faint" />
            Review in the center
          </MenuItem>
          <MenuItem onSelect={() => mention(root, file.path)}>
            <MessageSquareIcon className="size-3.5 text-faint" />
            Ask the agent about this file
          </MenuItem>
          <MenuItem onSelect={() => void navigator.clipboard.writeText(file.path)}>
            <CopyIcon className="size-3.5 text-faint" />
            Copy path
          </MenuItem>
          {discardable && file.status !== "conflicted" ? <>
            <MenuSeparator />
            <MenuItem onSelect={() => void discardFiles([file])} className="text-negative">
              <Undo2Icon className="size-3.5" />
              Discard changes…
            </MenuItem>
          </> : null}
        </MenuContent>
      </Menu>
    </div>
  )
}
