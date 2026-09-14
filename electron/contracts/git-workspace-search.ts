import type { ChatRole } from "./conversation-session.js"

export type GitFileStatus =
  "added" | "modified" | "deleted" | "renamed" | "untracked"

/** Cheap per-file entry. Contents are fetched on demand via `git:diff`. */
export interface GitFile {
  path: string
  status: GitFileStatus
  oldName?: string
  insertions: number | null
  deletions: number | null
  binary: boolean
  staged: boolean
}

export type GitCommitFile = Pick<GitFile, "path" | "status" | "insertions" | "deletions" | "binary">

export interface GitPushInput {
  cwd: string
  branch: string
}

export interface GitStatus {
  cwd: string
  root?: string
  branch?: string
  /** HEAD's commit, so a commit can be noticed without a watcher of its own. */
  head?: string
  upstream?: string
  ahead: number
  behind: number
  files: GitFile[]
  /** True when a merge, rebase, or cherry-pick is in progress. */
  operation?: string
}

export interface GitCommitEntry {
  hash: string
  shortHash: string
  subject: string
  author: string
  /** ISO timestamp. */
  date: string
  /** Files touched, for the summary line. */
  files: number | null
  insertions: number | null
  deletions: number | null
}

export type GitDiffPreview =
  | { kind: "patch"; contents: string; limited: boolean }
  | { kind: "unavailable"; reason: string }

export type GitDiff = { path: string } & (
  | { binary: boolean; oldFile: { name: string; contents: string } | null; newFile: { name: string; contents: string } | null; preview?: never }
  | { binary: false; oldFile: null; newFile: null; preview: GitDiffPreview }
)

/** One workspace file, for the composer's `@` picker. */
export interface WorkspaceFile {
  /** Path relative to the git root (or cwd when not a repo). */
  path: string
  /** True when the file also appears in the working diff. */
  changed?: boolean
}

/* ------------------------------------------------------------------ */
/* github                                                              */
/* ------------------------------------------------------------------ */

/**
 * Whether GitHub is usable, and if not, which of three different problems it
 * is — a missing tool, a missing login, or a folder that is not a GitHub repo.
 * They want three different answers from the UI, so they are three fields.
 */
export interface GitHubStatus {
  installed: boolean
  authenticated: boolean
  login?: string
  /** `owner/name`, when this folder has a GitHub remote. */
  repo?: string
  defaultBranch?: string
}

export interface CheckSummary {
  name: string
  state: "passed" | "failed" | "running" | "unknown"
  url?: string
}

export interface ReviewSummary {
  login: string
  state: "approved" | "changes" | "commented"
}

export interface PullRequest {
  number: number
  title: string
  body: string
  state: "open" | "closed" | "merged"
  draft: boolean
  url: string
  head: string
  base: string
  additions: number
  deletions: number
  files: number
  mergeable: "clean" | "conflicting" | "unknown"
  reviewDecision: "approved" | "changes" | "required" | "none"
  author?: string
  updatedAt?: string
  checks: CheckSummary[]
  reviews: ReviewSummary[]
}

/* ------------------------------------------------------------------ */
/* search                                                              */
/* ------------------------------------------------------------------ */

export interface SearchOptions {
  /** Treat the query as a regular expression rather than literal text. */
  regex?: boolean
  caseSensitive?: boolean
  /** Whole-word matching, as `\bfoo\b` would. */
  wholeWord?: boolean
  /** Search past conversations too, not only the working tree. */
  threads?: boolean
  /** Reach every project, or only this one. Threads only; files are per-workspace. */
  scope?: "workspace" | "all"
}

export interface SearchLine {
  line: number
  text: string
}

export interface FileMatches {
  /** Workspace-relative. */
  path: string
  lines: SearchLine[]
  /** Matches beyond the ones listed, so the UI can say so rather than lie. */
  more: number
}

export interface ThreadMatches {
  /** The session file, which is what `openSession` takes. */
  path: string
  title: string
  cwd: string
  modified: string
  lines: Array<{ role: ChatRole; text: string }>
  more: number
}

export interface SearchResults {
  query: string
  files: FileMatches[]
  threads: ThreadMatches[]
  /** Total matching lines found, including any not returned. */
  total: number
  /** True when the sweep hit a ceiling — the result set is not the whole truth. */
  truncated: boolean
  /** How long it took, in milliseconds. */
  elapsed: number
  /** Set when the query itself was the problem, e.g. an invalid regex. */
  error?: string
}

export interface ExternalEditor {
  id: string
  label: string
  available: boolean
}

/** One workspace file, opened for reading. */
export interface FileContents {
  /**
   * The file that was read, workspace-relative or absolute. Usually what was
   * asked for; when a request named a file without its directory
   * (`use-row-flip.ts`) it is the one tracked file that name resolves to, so
   * a reader, a refresh and an external editor all name the same thing.
   */
  path: string
  contents: string
  media?: "image" | "pdf" | "audio" | "video" | "spreadsheet"
  mimeType?: string
  previewUrl?: string
  thumbnailUrl?: string
  /** Sandboxed document supplied by a registered provider artifact reader. */
  artifactPreview?:
    { kind: "html"; html: string } | { kind: "unavailable"; reason: string }
  /** Bytes on disk, not of `contents` — they differ when truncated. */
  size: number
  /** Not text. `contents` is empty; the viewer says so rather than rendering noise. */
  binary: boolean
  /** Only the head was read, because the whole file is too large to render. */
  truncated: boolean
}

/**
 * A file the agent cannot receive inline — a PDF, a video, an archive.
 * The host materializes it to disk and hands back a path, so engine-owned read
 * and shell tools can open it. That is what makes "attach anything" honest
 * rather than a silent drop.
 */
export interface StagedFile {
  path: string
  name: string
  size: number
}
