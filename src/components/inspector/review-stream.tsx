import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react"
import { getSingularPatch, parseDiffFromFile, type CodeViewDiffItem, type DiffLineAnnotation, type FileDiffMetadata, type SelectedLineRange } from "@pierre/diffs"
import { CodeView, type CodeViewHandle, type CodeViewReactOptions } from "@pierre/diffs/react"
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, ChevronsDownUpIcon, ChevronsUpDownIcon, Columns2Icon, CopyIcon, EllipsisIcon, FileIcon, GitBranchIcon, GitCommitHorizontalIcon, Maximize2Icon, MessageSquareIcon, PencilIcon, RefreshCwIcon, Undo2Icon, WrapTextIcon } from "lucide-react"
import { countedChanges, type TurnChangeLines } from "@mako/host/contracts/turn-changes"
import type { TurnFileWriters, TurnUndoScope } from "@mako/host/contracts/turn-review"
import type { LiveRequest } from "@mako/host/contracts/live-conversations"
import { ImageThumbs } from "@/components/inspector/binary-diff"
import { Annotation, GutterAdd } from "@/components/inspector/review"
import { TurnUndoDialog } from "@/components/inspector/turn-undo"
import { WriterRow } from "@/components/inspector/turn-writers"
import { PickedDiffLines } from "@/components/inspector/diff-line-pick"
import { useCommentTarget } from "@/components/inspector/comment-target"
import { isPickEnd, pickEnd, workspacePath } from "@/lib/line-comments"
import { LineCounts, StatusLetter, UnsureCount } from "@/components/inspector/change-marks"
import { FileTypeIcon } from "@/components/ui/file-type-icon"
import { Action, IconAction, Toggle } from "@/components/ui/kit"
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuSub, MenuSubContent, MenuSubTrigger, MenuTrigger } from "@/components/ui/menu"
import { SearchSelect } from "@/components/ui/search-select"
import { DIFF_THEME } from "@/lib/diff-theme"
import { binarySizes } from "@/lib/git-binary"
import { anyUnsure, fileRoot, recordedTurnChanges, type Unsure } from "@/lib/turn-changes"
import { undoneWords } from "@/lib/turn-undone"
import { formatTime } from "@/lib/format"
import { noteKey, writerNotes, type WriterNote } from "@/lib/turn-writers"
import { cn } from "@/lib/utils"
import type { GitCommitEntry, GitDiff, GitFile } from "@/lib/types"
import { turnWords } from "@/state/prompt-delivery"
import { acp, activeLiveAcp, useAcp } from "@/state/acp"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { git as gitActions } from "@/state/git"
import { discardFiles } from "@/state/git-discard"
import { useGitHub } from "@/state/github"
import { setPref, usePrefs } from "@/state/prefs"
import { review, useReview } from "@/state/review"
import { releaseReviewTurn, requestedTurn, useReviewScope, type TurnScope } from "@/state/review-scope"
import { actions, useSession } from "@/state/session"
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
  | { kind: "diff"; fileDiff: FileDiffMetadata; signature: string; lines: number; limited: boolean; writers?: ReadonlyMap<string, WriterNote> }
  | { kind: "binary"; diff: GitDiff }
  | { kind: "unavailable"; reason: string }

/**
 * Which changes the stream shows: what isn't committed, everything since the
 * branch left its base, what one of the agent's turns changed, or one commit.
 */
type Scope =
  | { kind: "uncommitted" }
  | { kind: "since"; ref: string; label: string }
  | TurnScope
  | { kind: "commit"; hash: string; shortHash: string; subject: string }

const UNCOMMITTED: Scope = { kind: "uncommitted" }
/** Commits the scope menu offers. */
const RECENT_COMMITS = 15

interface Entry {
  loaded: Loaded
  /** The status changed since this was read; it shows until the new read lands. */
  stale: boolean
}

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

/** Who wrote each changed line of a file's diff, for a turn: read beside the diff. */
type Writers = (path: string) => Promise<TurnFileWriters | null>

/** A diff with its writers' rows, when another writer than the turn's own changed lines in it. */
function withWriters(loaded: Loaded, found: TurnFileWriters | null | undefined): Loaded {
  if (loaded.kind !== "diff" || !found?.runs.length) return loaded
  const writers = writerNotes(loaded.fileDiff, found.runs)
  return writers.size ? { ...loaded, writers, signature: `${loaded.signature}:w${fingerprint([...writers].map(([key, note]) => `${key}${note.writer}${note.lines}`).join())}` } : loaded
}

/** Reads the diffs of mounted headers, `LOADS` at a time; a header that unmounts first is skipped. */
function diffQueue(first: (path: string) => Promise<GitDiff>, firstWriters: Writers | undefined, onLoaded: (path: string, loaded: Loaded) => void) {
  let load = first
  let writers = firstWriters
  let wanted: string[] = []
  let open = true
  const reading = new Set<string>()
  const pump = () => {
    while (open && reading.size < LOADS) {
      const path = wanted.shift()
      if (path === undefined) return
      reading.add(path)
      // A file's writers come beside its diff; without them it still shows.
      void Promise.all([load(path), writers?.(path).catch(() => null)]).then(([diff, found]) => withWriters(toLoaded(diff), found), unreadable).then((loaded) => {
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
    use(next: (path: string) => Promise<GitDiff>, nextWriters: Writers | undefined) {
      load = next
      writers = nextWriters
    },
    close() {
      open = false
      wanted = []
    },
  }
}

/** Puts `@path` in the composer, as ⌘↩ in the file palette does: relative to the workspace when the file is inside it. */
function mention(root: string, path: string, folder: string | undefined): void {
  const cwd = folder ?? root
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
 * since the branch left its base, a turn, or one commit. A turn the
 * transcript asked to review (`reviewTurn`) is the scope until the person
 * picks another one here.
 */
export function ReviewStream({ files, workspace, staged, onReviewInCenter }: { files: readonly GitFile[]; workspace: string; staged: number; onReviewInCenter: () => void }) {
  // A scope belongs to the repository it was chosen in.
  const [chosen, setChosen] = useState<{ workspace: string; scope: Scope }>({ workspace, scope: UNCOMMITTED })
  const requested = useReviewScope((state) => requestedTurn(state.requested, workspace))
  const scope = requested ?? (chosen.workspace === workspace ? chosen.scope : UNCOMMITTED)
  const choose = useCallback((next: Scope) => {
    if (next.kind !== "turn" || next.requestId !== requested?.requestId) releaseReviewTurn()
    setChosen({ workspace, scope: next })
  }, [workspace, requested])
  const [read, setRead] = useState<{ key: string; files: readonly GitFile[] | null; base?: string }>()
  const key = scopeKey(scope)
  // A since scope changes with every edit too, so it is read again with the status; a turn or a commit is fixed.
  const edits = scope.kind === "since" ? files : null

  useEffect(() => {
    if (scope.kind === "uncommitted") return
    let current = true
    void readScope(scope, workspace).then(
      (next) => { if (current) setRead({ key, ...next }) },
      () => { if (current) setRead({ key, files: null }) },
    )
    return () => { current = false }
  }, [edits, key, scope, workspace])

  // "Only this thread's lines" belongs to the turn it was turned on for.
  const [onlyFor, setOnlyFor] = useState<string | null>(null)
  const only = scope.kind === "turn" && onlyFor === key
  const shown = scope.kind === "uncommitted" ? files : read?.key === key ? read.files : undefined
  const base = read?.key === key ? read.base : undefined
  const load = loader(scope, base, only)
  const writers = scope.kind === "turn" && !only ? (path: string) => acp.turnWriters(scope.conversation, scope.requestId, path) : undefined
  const picker = <ScopePicker scope={scope} workspace={workspace} onChoose={choose} />
  if (shown === undefined || (scope.kind === "since" && shown && !base)) return <ScopeMessage picker={picker} text="Reading…" />
  if (shown === null) return <ScopeMessage picker={picker} text={unreadScope(scope)} />
  if (shown.length === 0 && scope.kind === "turn") return <ScopeMessage picker={picker} text="That turn changed no files." />
  const bar = scope.kind === "turn" ? <TurnBar scope={scope} only={only} onOnly={(on) => setOnlyFor(on ? key : null)} /> : null
  return <ReviewFiles key={only ? `${key}:only` : key} files={shown} workspace={workspace} staged={scope.kind === "uncommitted" ? staged : 0} scope={scope} picker={picker} bar={bar} load={load} writers={writers} only={only} onReviewInCenter={onReviewInCenter} />
}

/**
 * A turn's diffs read from somewhere other than this window's host: the web
 * app on a laptop reads them from the Session's own computer through the
 * account, in the bounded stretches a phone reads, kept on the device.
 */
export interface TurnReads {
  /** A file's diff over the turn; with `only`, the turn's own lines alone. */
  diff: (path: string, only: boolean) => Promise<GitDiff>
  /** Who wrote each changed line of a file's diff. */
  writers: (path: string) => Promise<TurnFileWriters | null>
}

/**
 * One turn as Changes › Turn draws it, for a Session whose checkout isn't
 * this window's (the web app on a laptop): its counts, its bar (Only this
 * thread's lines, Undo) and every file in one scroll, read through
 * `reads`. Nothing here opens, refreshes or discards in a checkout, and
 * comments go to the Session `CommentTargetContext` names.
 */
export function TurnReview({ scope, files, workspace, reads, picker }: { scope: TurnScope; files: readonly GitFile[]; workspace: string; reads: TurnReads; picker: ReactNode }) {
  const key = scopeKey(scope)
  const [onlyFor, setOnlyFor] = useState<string | null>(null)
  const only = onlyFor === key
  const load = useCallback((path: string) => reads.diff(path, only), [reads, only])
  if (files.length === 0) return <ScopeMessage picker={picker} text="That turn changed no files." />
  const bar = <TurnBar scope={scope} only={only} onOnly={(on) => setOnlyFor(on ? key : null)} away />
  return <ReviewFiles key={only ? `${key}:only` : key} files={files} workspace={workspace} staged={0} scope={scope} picker={picker} bar={bar} load={load} writers={only ? undefined : reads.writers} only={only} away />
}

/** The request a turn scope reviews, as its conversation holds it: its record of changes and its undo. */
function useTurnRequest(scope: Scope): LiveRequest | undefined {
  return useAcp((state) => {
    if (scope.kind !== "turn") return undefined
    const conversation = state.conversations[scope.conversation]
    return conversation?.kind === "live" ? conversation.requests?.find((request) => request.id === scope.requestId) : undefined
  })
}

/**
 * A turn's counts in its header, from its request's record as the line
 * under its answer reads them: the agent's own files and lines, then what
 * is not sure whose. They don't move with "Only this thread's lines",
 * which only redraws the diffs to match them; the bar under them says when
 * the turn was undone.
 */
function TurnCounts({ files, insertions, deletions, unsure }: { files: number; insertions: number | null; deletions: number | null; unsure: Unsure }) {
  return (
    <span role="status" data-turn-counts={files} className="tabular flex min-w-0 items-center gap-2 text-muted-foreground">
      <span className="shrink-0">{files ? `${files} ${files === 1 ? "file" : "files"}` : "No files for sure"}</span>
      <LineCounts insertions={insertions} deletions={deletions} />
      {anyUnsure(unsure) ? (
        <>
          <span aria-hidden className="shrink-0 text-faint">·</span>
          <UnsureCount unsure={unsure} className="min-w-0 truncate" />
        </>
      ) : null}
    </span>
  )
}

/**
 * A turn's bar under the header: "Only this thread's lines", which redraws
 * each diff with every other writer's change on both sides, and undoing the
 * turn, or every change of the Thread, keeping everyone else's lines.
 */
function TurnBar({ scope, only, onOnly, away = false }: { scope: TurnScope; only: boolean; onOnly: (on: boolean) => void; away?: boolean }) {
  const [undo, setUndo] = useState<TurnUndoScope | null>(null)
  const undone = useTurnRequest(scope)?.undone
  return (
    <div data-turn-bar="" className="flex h-8 shrink-0 items-center gap-2 border-b border-hairline pr-1.5 pl-2.5 text-label">
      <label className="pressable flex min-w-0 cursor-pointer items-center gap-2 text-muted-foreground hover:text-foreground">
        <Toggle label="Only this thread's lines" on={only} onChange={() => onOnly(!only)} />
        <span className="truncate">Only this thread's lines</span>
      </label>
      <div className="ml-auto flex shrink-0 items-center">
        {undone ? (
          <span data-turn-undone="" title={undoneWords(undone)} className="flex h-6 cursor-default items-center gap-1.5 px-2 text-muted-foreground [&_svg]:size-3.5 [&_svg]:text-faint">
            <Undo2Icon />
            {`Undone at ${formatTime(undone.at)}`}
          </span>
        ) : (
          <Action size="xs" tone="ghost" data-undo-turn="" onClick={() => setUndo({ kind: "turn", requestId: scope.requestId })}>
            <Undo2Icon />
            Undo this turn…
          </Action>
        )}
        <Menu modal={false}>
          <MenuTrigger asChild>
            <IconAction label="More ways to undo" size="xs">
              <EllipsisIcon />
            </IconAction>
          </MenuTrigger>
          <MenuContent align="end" className="min-w-56">
            <MenuItem onSelect={() => setUndo({ kind: "thread" })}>
              <Undo2Icon className="size-3.5 text-faint" />
              Undo every change of this thread…
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>
      {undo ? (
        <TurnUndoDialog
          conversation={scope.conversation}
          scope={undo}
          prompt={undo.kind === "turn" ? scope.prompt : undefined}
          open
          onOpenChange={(open) => { if (!open) setUndo(null) }}
          onUndone={away ? undefined : () => void actions.refreshGit()}
        />
      ) : null}
    </div>
  )
}

function scopeKey(scope: Scope): string {
  if (scope.kind === "since") return `since:${scope.ref}`
  if (scope.kind === "turn") return `turn:${scope.conversation}:${scope.requestId}`
  if (scope.kind === "commit") return `commit:${scope.hash}`
  return "uncommitted"
}

async function readScope(scope: Exclude<Scope, { kind: "uncommitted" }>, workspace: string): Promise<{ files: readonly GitFile[] | null; base?: string }> {
  if (scope.kind === "since") {
    const since = await gitActions.changedSince(scope.ref)
    return { files: since?.files ?? null, base: since?.base }
  }
  if (scope.kind === "turn") {
    const turn = await acp.turnChanges(scope.conversation, scope.requestId, workspace)
    return { files: turn.root === workspace ? turn.files : null }
  }
  return { files: (await gitActions.commitFiles(scope.hash)).map((file): GitFile => ({ ...file, staged: false })) }
}

function unreadScope(scope: Scope): string {
  if (scope.kind === "since") return `This branch shares no history with ${scope.label.replace(/^Since /, "")}.`
  if (scope.kind === "turn") return "That turn's changes couldn't be read."
  return "This commit couldn't be read."
}

/** What a scope's diffs compare against, as a comment on their lines names it. */
function scopeBase(scope: Scope, only = false): string {
  if (scope.kind === "commit") return `${scope.shortHash}^`
  if (scope.kind === "since") return scope.ref
  if (scope.kind === "turn") return only ? "the start of that turn, with only its own lines changed" : "the start of that turn"
  return "HEAD"
}

function loader(scope: Scope, base: string | undefined, only: boolean): (path: string) => Promise<GitDiff> {
  if (scope.kind === "commit") return (path) => gitActions.commitFileDiff(scope.hash, path)
  if (scope.kind === "turn") return (path) => acp.turnDiff(scope.conversation, scope.requestId, path, only ? { only } : undefined)
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

/** A turn the scope menu offers: its scope, its place among the conversation's prompts, and what it changed here. */
interface TurnChoice {
  scope: TurnScope
  number: number
  /** Files, and net lines, the turn's record counts as its own in this repository; null for a turn read from its checkpoints. */
  files: number | null
  added: number
  removed: number
  /** Files not sure whose, counted apart. */
  unsure: Unsure
}

/** Each conversation's turns, by its requests and the repository: worked out once per change of its requests, not per streamed token. */
const turnRows = new WeakMap<readonly LiveRequest[], Map<string, string>>()

/**
 * Every finished turn of the open conversation that changed files in this
 * repository, newest first: those whose record names a file here, and those
 * from before the record whose checkpoints either side saved it. Kept as one
 * string so the selector is stable.
 */
function useTurns(workspace: string): TurnChoice[] {
  const found = useAcp((state) => {
    const live = activeLiveAcp(state)
    const requests = live?.requests
    if (!live || !requests) return ""
    const byWorkspace = turnRows.get(requests) ?? new Map<string, string>()
    turnRows.set(requests, byWorkspace)
    const held = byWorkspace.get(workspace)
    if (held !== undefined) return held
    const rows: string[] = []
    requests.forEach((request, index) => {
      const counted = countedChanges(request.changes)
      const before = request.snapshots?.before
      const words = turnWords(requests, request)
      if (counted) {
        if (!counted.files.some((file) => fileRoot(file) === workspace)) return
        // The turn's own, as its line and its header count them; files not sure whose apart.
        const here = recordedTurnChanges(request.changes, workspace)!
        rows.push([live.key, request.id, index + 1, here.files, here.insertions ?? 0, here.deletions ?? 0, here.unsure.lines, here.unsure.files, words].join("\t"))
      } else if (before?.kind === "ready" && request.snapshots?.after?.kind === "ready" && before.snapshot.scope === workspace) {
        rows.push([live.key, request.id, index + 1, -1, 0, 0, 0, 0, words].join("\t"))
      }
    })
    const joined = rows.reverse().join("\n")
    byWorkspace.set(workspace, joined)
    return joined
  })
  return useMemo(() => (found ? found.split("\n") : []).map((row): TurnChoice => {
    const [conversation = "", requestId = "", number = "0", files = "-1", added = "0", removed = "0", unsureLines = "0", unsureFiles = "0", ...prompt] = row.split("\t")
    return { scope: { kind: "turn", conversation, requestId, prompt: prompt.join("\t") }, number: Number(number), files: Number(files) < 0 ? null : Number(files), added: Number(added), removed: Number(removed), unsure: { lines: Number(unsureLines), files: Number(unsureFiles) } }
  }), [found])
}

/**
 * The scope menu. Since main is offered on a branch other than the default
 * one, named by GitHub or else by the repository itself; in a Thread's
 * worktree it is the same Since main its branch bar shows.
 */
export function ScopePicker({ scope, workspace, onChoose, turnsOnly = false }: {
  scope: Scope
  workspace: string
  onChoose: (scope: Scope) => void
  /** Only the conversation's turns: a review of a Session whose checkout isn't this window's has no Git of its own here. */
  turnsOnly?: boolean
}) {
  const repository = useSession((state) => state.git?.root)
  const branch = useSession((state) => state.git?.branch)
  const worktree = useWorktrees((state) => worktreeAt(state.worktrees, repository)?.worktree)
  const hosted = useGitHub((state) => state.status?.defaultBranch)
  const turns = useTurns(workspace)
  const lastTurn = turns[0]?.scope ?? null
  const turnHarness = useAcp((state) => {
    const conversation = scope.kind === "turn" ? state.conversations[scope.conversation] : undefined
    return conversation?.kind === "live" ? conversation.session.harness : undefined
  })
  const [since, setSince] = useState<{ ref: string; label: string } | null>(null)
  const [commits, setCommits] = useState<readonly GitCommitEntry[] | null>(null)
  const open = (next: boolean) => {
    if (!next || turnsOnly) return
    void gitActions.log(RECENT_COMMITS).then(setCommits, () => setCommits([]))
    if (worktree) {
      void readWorktreeReview(worktree.path).then(
        (review) => setSince({ ref: review.into ?? review.base, label: `Since ${review.into ?? "it started"}` }),
        () => setSince(null),
      )
      return
    }
    const offer = (name: string | null | undefined) => setSince(name && branch && branch !== name ? { ref: name, label: `Since ${name}` } : null)
    if (hosted) offer(hosted)
    else void gitActions.defaultBranch().then(offer, () => setSince(null))
  }
  const turnOn = scope.kind === "turn" && lastTurn?.requestId === scope.requestId
  const chosenTurn = scope.kind === "turn" ? turns.find((turn) => turn.scope.requestId === scope.requestId) : undefined
  // A turn the transcript asked for that the menu doesn't list (no file of it here yet) is offered by its words, checked.
  const otherTurn = scope.kind === "turn" && !chosenTurn ? scope : null
  const label = scope.kind === "uncommitted" ? "Uncommitted" : scope.kind === "since" ? scope.label : scope.kind === "turn" ? turnOn ? "Last turn" : chosenTurn ? `Turn ${chosenTurn.number}` : "Turn" : scope.shortHash
  return (
    <Menu modal={false} onOpenChange={open}>
      <MenuTrigger asChild>
        <Action size="xs" tone="quiet" aria-label={`Showing: ${scope.kind === "commit" ? `commit ${scope.shortHash}` : label}. Choose what to review`} title={scope.kind === "commit" ? scope.subject : scope.kind === "turn" ? scope.prompt || undefined : undefined} className="max-w-40 gap-1 px-1.5 font-medium">
          {scope.kind === "commit" ? <GitCommitHorizontalIcon /> : scope.kind === "since" ? <GitBranchIcon /> : scope.kind === "turn" ? turnHarness ? <HarnessIcon harness={turnHarness} /> : <MessageSquareIcon /> : <PencilIcon />}
          <span className="truncate">{label}</span>
          <ChevronDownIcon className="size-3! text-faint/70" />
        </Action>
      </MenuTrigger>
      <MenuContent align="start" className="max-h-96 w-72 overflow-y-auto">
        {turnsOnly ? null : <ScopeItem on={scope.kind === "uncommitted"} onSelect={() => onChoose(UNCOMMITTED)} title="Uncommitted" detail="What isn't committed yet, staged or not" />}
        {since ? <ScopeItem on={scope.kind === "since" && scope.ref === since.ref} onSelect={() => onChoose({ kind: "since", ...since })} title={since.label} detail="Every commit on this branch and what isn't committed" /> : null}
        {otherTurn ? <ScopeItem on onSelect={() => onChoose(otherTurn)} title="Turn" detail={otherTurn.prompt || "What the agent changed in that answer"} /> : null}
        {lastTurn ? <ScopeItem on={turnOn} onSelect={() => onChoose(lastTurn)} title="Last turn" detail={lastTurn.prompt || "What the agent changed in its last answer"} /> : null}
        {turns.length > 1 ? (
          <MenuSub>
            <MenuSubTrigger data-turn-picker="">
              <CheckIcon className={cn("size-3.5 shrink-0", scope.kind === "turn" && !turnOn && chosenTurn ? "text-foreground" : "invisible")} />
              <span className="min-w-0 flex-1">
                <span className="block truncate">Turn…</span>
                <span className="block truncate text-label text-faint">{`Any of ${turns.length} turns that changed files here`}</span>
              </span>
            </MenuSubTrigger>
            <MenuSubContent className="max-h-96 w-80 overflow-y-auto">
              {turns.map((turn) => (
                <MenuItem key={turn.scope.requestId} onSelect={() => onChoose(turn.scope)} aria-checked={scope.kind === "turn" && scope.requestId === turn.scope.requestId} role="menuitemradio" data-turn-choice={turn.number}>
                  <CheckIcon className={cn("size-3.5 shrink-0", scope.kind === "turn" && scope.requestId === turn.scope.requestId ? "text-foreground" : "invisible")} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{turn.scope.prompt || `Turn ${turn.number}`}</span>
                    <span className="flex items-center gap-1.5 text-label text-faint">
                      <span className="tabular">{`Turn ${turn.number}`}</span>
                      <span aria-hidden>·</span>
                      {turn.files === null ? <span>From its checkpoints</span> : <>
                        {turn.files ? <span className="tabular">{turn.files === 1 ? "1 file" : `${turn.files} files`}</span> : null}
                        <LineCounts insertions={turn.added} deletions={turn.removed} />
                        <UnsureCount unsure={turn.unsure} />
                      </>}
                    </span>
                  </span>
                </MenuItem>
              ))}
            </MenuSubContent>
          </MenuSub>
        ) : null}
        {turnsOnly ? null : <>
          <MenuSeparator />
          <MenuLabel>A commit</MenuLabel>
          {commits === null ? <MenuItem disabled>Reading history…</MenuItem> : commits.length === 0 ? <MenuItem disabled>No commits yet</MenuItem> : commits.map((commit) => (
            <ScopeItem key={commit.hash} on={scope.kind === "commit" && scope.hash === commit.hash} onSelect={() => onChoose({ kind: "commit", hash: commit.hash, shortHash: commit.shortHash, subject: commit.subject })} title={commit.subject} detail={commit.shortHash} mono />
          ))}
        </>}
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
function ReviewFiles({ files, workspace, staged, scope, picker, bar, load, writers, only, onReviewInCenter, away = false }: {
  files: readonly GitFile[]
  workspace: string
  staged: number
  scope: Scope
  picker: ReactNode
  /** A turn's bar, under the header. */
  bar?: ReactNode
  load: (path: string) => Promise<GitDiff>
  /** Who wrote each changed line, read beside each diff (a turn's). */
  writers?: Writers
  /** The diffs show only the turn's own lines. */
  only?: boolean
  onReviewInCenter?: () => void
  /** The checkout isn't this window's (`TurnReview`): nothing to open, refresh or review in the center here. */
  away?: boolean
}) {
  const target = useCommentTarget()
  const diffStyle = usePrefs((prefs) => prefs.diffStyle)
  const wrapDiff = usePrefs((prefs) => prefs.wrapDiff)
  const marks = useViewed((state) => state.marks)
  const allComments = useReview((state) => state.comments)
  const draft = useReview((state) => state.draft)
  const base = scopeBase(scope, only)
  const handle = useRef<CodeViewHandle<undefined>>(null)
  const harness = useAcp((state) => {
    const conversation = scope.kind === "turn" ? state.conversations[scope.conversation] : undefined
    return conversation?.kind === "live" ? conversation.session.harness : undefined
  })
  const turn = useTurnRequest(scope)
  // A turn's counts are its record's, as the line under its answer reads them, in this repository.
  const counts = useMemo(() => recordedTurnChanges(turn?.changes, workspace), [turn?.changes, workspace])
  const unsure = useMemo(() => {
    const found = new Map<string, TurnChangeLines | null>()
    for (const file of countedChanges(turn?.changes)?.files ?? []) if (file.maybe !== undefined && fileRoot(file) === workspace) found.set(file.relative, file.maybe)
    return found
  }, [turn?.changes, workspace])
  // Lines picked in one file, once the press that picked them ends; the
  // stream reports every step of a drag, kept here until then.
  const [picked, setPicked] = useState<{ id: string; range: SelectedLineRange } | null>(null)
  const picking = useRef<{ id: string; range: SelectedLineRange } | null>(null)
  const onSelectedLinesChange = useCallback((selection: { id: string; range: SelectedLineRange } | null) => {
    picking.current = selection
  }, [])
  const onLineSelectionEnd = useCallback(() => setPicked(picking.current), [])
  const stream = useRef<HTMLDivElement>(null)
  const letGo = useCallback(() => {
    setPicked(null)
    handle.current?.clearSelectedLines()
    // The field held the focus: it goes back to the stream, so J, K and Escape go on working from the keyboard.
    requestAnimationFrame(() => {
      if (!document.activeElement || document.activeElement === document.body) stream.current?.focus({ preventScroll: true })
    })
  }, [])
  const scrollTop = useRef(0)
  const [entries, setEntries] = useState(() => new Map<string, Entry>())
  const [opened, setOpened] = useState(() => new Map<string, boolean>())
  const [queue] = useState(() => diffQueue(load, writers, (path, loaded) => setEntries((previous) => {
    const current = previous.get(path)
    return new Map(previous).set(path, { loaded: current && sameLoaded(current.loaded, loaded) ? current.loaded : loaded, stale: false })
  })))
  useEffect(() => {
    queue.open()
    return () => queue.close()
  }, [queue])
  useEffect(() => queue.use(load, writers), [load, writers, queue])

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
    if (picked?.id === file.path) {
      const end = pickEnd(picked.range)
      annotate(end.lineNumber, end.side)
    }
    const loaded = entry?.loaded
    // Who wrote each stretch, under its last line, where another writer shares the file.
    if (loaded?.kind === "diff" && loaded.writers)
      for (const key of loaded.writers.keys()) {
        const [side, line] = key.split(":")
        annotate(Number(line), side === "deletions" ? "deletions" : "additions")
      }
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
  }), [allComments, draft, entries, files, isOpen, picked, viewedFor, workspace])

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
    theme: DIFF_THEME,
    diffStyle,
    overflow: wrapDiff ? "wrap" : "scroll",
    stickyHeaders: true,
    enableGutterUtility: true,
    enableLineSelection: true,
    onLineSelectionEnd,
    itemMetrics: { diffHeaderHeight: HEADER_HEIGHT },
  }), [diffStyle, onLineSelectionEnd, wrapDiff])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-hairline pr-1.5 pl-1.5 text-label">
        {picker}
        {counts ? (
          <TurnCounts files={counts.files} insertions={counts.insertions} deletions={counts.deletions} unsure={counts.unsure} />
        ) : (
          <>
            <span role="status" className="tabular min-w-0 truncate text-muted-foreground">
              {`${files.length} ${files.length === 1 ? "file" : "files"}`}
              {staged > 0 ? <span className="text-faint">{` · ${staged} staged`}</span> : null}
            </span>
            {counted ? <LineCounts insertions={insertions} deletions={deletions} /> : null}
          </>
        )}
        <div className="ml-auto flex items-center text-faint">
          <SearchSelect
            value=""
            options={jumpOptions}
            onChange={reveal}
            label="Jump to file"
            placeholder="Jump to…"
            searchPlaceholder="Jump to file"
            emptyMessage="No changed file matches."
            className="h-6 w-24 bg-transparent text-label text-faint ring-0"
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
          {scope.kind === "uncommitted" && onReviewInCenter ? (
            <IconAction label="Review current changes in the center" size="xs" onClick={onReviewInCenter}>
              <Maximize2Icon />
            </IconAction>
          ) : null}
          {away ? null : (
            <IconAction label="Refresh" size="xs" onClick={() => void actions.refreshGit()}>
              <RefreshCwIcon />
            </IconAction>
          )}
        </div>
      </div>
      {bar}
      <div
        ref={stream}
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
          onSelectedLinesChange={onSelectedLinesChange}
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
                base={base}
                discardable={scope.kind === "uncommitted"}
                only={only}
                unsure={unsure.get(file.path)}
                away={away}
              />
            )
          }}
          renderAnnotation={(annotation, item) => {
            const side = "side" in annotation ? annotation.side : "additions"
            const line = annotation.lineNumber
            const found = entries.get(item.id)?.loaded
            const note = found?.kind === "diff" ? found.writers?.get(noteKey(side, line)) : undefined
            const comments = allComments.filter((comment) => comment.workspace === workspace && comment.path === item.id)
            const picks = picked?.id === item.id && isPickEnd(picked.range, { lineNumber: line, side })
            const noted = picks || comments.some((comment) => comment.line === line && comment.side === side) || (draft?.workspace === workspace && draft.path === item.id && draft.line === line && draft.side === side)
            const writer = note ? <WriterRow note={note} harness={harness} /> : null
            if (!noted) return writer
            const loaded = picked?.id === item.id ? found : undefined
            return (
              <>
              {writer}
              <Annotation
                workspace={workspace}
                path={item.id}
                line={annotation.lineNumber}
                side={side}
                comments={comments}
                selection={picks && picked ? (
                  <PickedDiffLines
                    path={workspacePath(`${workspace}/${item.id}`, target.cwd())}
                    base={base}
                    diff={loaded?.kind === "diff" ? loaded.fileDiff : null}
                    range={picked.range}
                    onDone={letGo}
                  />
                ) : undefined}
              />
              </>
            )
          }}
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
                letGo()
                review.start({ workspace, path: item.id, line: hovered.lineNumber, side, code: lines?.[hovered.lineNumber - 1]?.replace(/\r?\n$/, ""), base })
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
function FileHeader({ file, entry, open, viewed, root, queue, load, base, discardable, only = false, unsure, away = false, onToggle, onViewed }: {
  file: GitFile
  entry: Entry | undefined
  open: boolean
  viewed: boolean
  root: string
  queue: ReturnType<typeof diffQueue>
  load: (path: string) => Promise<GitDiff>
  /** What the diff compares against. */
  base: string
  /** The file's changes aren't committed, so Discard can take them back. */
  discardable: boolean
  /** The diff shows only a turn's own lines. */
  only?: boolean
  /** A turn's lines in the file not sure whose (null: not counted by lines); absent when it has none. */
  unsure?: TurnChangeLines | null
  /** The checkout isn't this window's: no file to open, no center to review it in. */
  away?: boolean
  onToggle: (path: string) => void
  onViewed: (path: string, on: boolean) => void
}) {
  const target = useCommentTarget()
  const due = entry ? entry.stale : open
  useEffect(() => {
    if (!due) return
    queue.need(file.path)
    return () => queue.drop(file.path)
  }, [due, file.path, queue])
  const slash = file.path.lastIndexOf("/")
  const folder = slash > 0 ? file.path.slice(0, slash + 1) : ""
  const name = file.path.slice(slash + 1)
  const loaded = entry?.loaded
  const lines = loaded?.kind === "diff" ? loaded.lines : changedLines(file)
  const center = away ? undefined : () => void viewer.openDiff(file.path, async () => ({ diffs: [await load(file.path)], base, root }))
  const note = loaded?.kind === "binary"
    ? (loaded.diff.before?.image || loaded.diff.after?.image ? binarySizes(loaded.diff) : `Binary${binarySizes(loaded.diff) ? ` · ${binarySizes(loaded.diff)}` : ""}`)
    : loaded?.kind === "unavailable"
      ? loaded.reason
      : only && loaded?.kind === "diff" && !loaded.fileDiff.hunks.length
        ? "None of its lines are this thread's for sure"
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
    <div data-review-file={file.path} className="flex h-8 items-center gap-1 border-b border-hairline bg-surface pr-3 pl-2 text-label select-none">
      <button
        type="button"
        aria-expanded={loaded?.kind === "binary" ? undefined : open}
        aria-label={loaded?.kind === "binary" ? (center ? `Review ${file.path} in the center` : file.path) : `${open ? "Fold" : "Unfold"} ${file.path}`}
        onClick={() => (loaded?.kind === "binary" ? center?.() : onToggle(file.path))}
        title={file.path}
        className="pressable flex h-full min-w-0 flex-1 items-center gap-1.5 text-left"
      >
        <ChevronRightIcon className={cn("size-3 shrink-0 text-faint transition-transform duration-150 ease-[var(--ease-out)] motion-reduce:transition-none", open && "rotate-90")} />
        <FileTypeIcon path={file.path} className="ml-0.5 size-3.5 shrink-0 text-faint/80" />
        <span className="min-w-0 truncate text-ui">
          <span className="text-faint">{folder}</span>
          <span className={file.status === "deleted" ? "text-faint line-through decoration-faint/60" : viewed ? "text-muted-foreground" : "text-foreground"}>{name}</span>
        </span>
        {loaded?.kind === "binary" ? <ImageThumbs diff={loaded.diff} /> : null}
        {note ? <span className="shrink-0 truncate text-faint" title={loaded?.kind === "unavailable" ? loaded.reason : undefined}>{note}</span> : null}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          <LineCounts insertions={file.insertions} deletions={file.deletions} />
          {unsure !== undefined ? <UnsureCount unsure={unsure && unsure.added + unsure.removed ? { lines: unsure.added + unsure.removed, files: 0 } : { lines: 0, files: 1 }} /> : null}
          <StatusLetter status={file.status} />
        </span>
      </button>
      <label className={cn("pressable ml-1 flex h-6 shrink-0 cursor-pointer items-center gap-1.5 rounded px-1.5 transition-colors duration-100 hover:bg-fill-hover", viewed ? "text-muted-foreground" : "text-faint hover:text-foreground")}>
        <input
          type="checkbox"
          checked={viewed}
          onChange={(event) => onViewed(file.path, event.target.checked)}
          className="peer sr-only"
        />
        <span aria-hidden className={cn(
          "flex size-3.5 items-center justify-center rounded-[4px] ring-1 ring-inset transition-colors duration-100 peer-focus-visible:outline-2 peer-focus-visible:outline-ring",
          viewed ? "bg-foreground/70 ring-foreground/70" : "ring-foreground/35"
        )}>
          {viewed ? <CheckIcon className="size-2.5 text-background" strokeWidth={3} /> : null}
        </span>
        Viewed
      </label>
      <Menu modal={false}>
        <MenuTrigger asChild>
          <IconAction label={`More for ${file.path}`} size="xs">
            <EllipsisIcon />
          </IconAction>
        </MenuTrigger>
        <MenuContent align="end" className="min-w-48">
          {file.status !== "deleted" && !away ? (
            <MenuItem onSelect={() => void viewer.open(`${root}/${file.path}`)}>
              <FileIcon className="size-3.5 text-faint" />
              Open file
            </MenuItem>
          ) : null}
          {center ? (
            <MenuItem onSelect={center}>
              <Maximize2Icon className="size-3.5 text-faint" />
              Review in the center
            </MenuItem>
          ) : null}
          <MenuItem onSelect={() => mention(root, file.path, target.cwd())}>
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
