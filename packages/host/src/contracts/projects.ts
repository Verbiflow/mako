import { z } from "zod"

/**
 * Starting work in a project: the folders under a path the person types, the Git checkouts found on this Mac, a
 * GitHub repository cloned for them, and a new empty project. The open-project palette reads these; the host answers
 * them from its own disk (`workspaces/project-folders.ts`).
 */

/** A folder under the one a typed path names. */
export interface BrowsedFolder {
  name: string
  path: string
  /** It holds a `.git` folder: a checkout's root. */
  git: boolean
}

/** What the typed path itself is, resolved. */
export interface BrowsedPath {
  path: string
  kind: "folder" | "file" | "missing"
  git: boolean
  /** `owner/name` of its `origin` on GitHub, when it's a checkout of one. */
  repository?: string
}

/** The folders a typed path lists: those in its parent whose names start with its last part, or in itself after a slash. */
export interface FolderBrowse {
  home: string
  /** The folder listed. */
  folder: string
  /** Whether that folder could be read. */
  listed: boolean
  entries: BrowsedFolder[]
  exact: BrowsedPath
}

export interface FolderBrowseRequest {
  partialPath: string
  /** What `./` and `../` start from: the project on screen. The home folder without one. */
  base?: string
}

/** A Git checkout on this Mac, found by the host's scan of the home folder. */
export interface FoundCheckout {
  path: string
  name: string
  /** `owner/name` of its `origin` on GitHub; another host's remote as its address. */
  remote?: string
  branch?: string
  /** When its index or HEAD last changed, in ms. */
  touchedAt: number
}

/**
 * The checkouts found under the home folder, newest first. `skipped`: folders macOS guards (Desktop, Documents,
 * Downloads) the scan left out because nobody asked it to look there; `refused`: guarded folders macOS kept it out of.
 */
export interface FoundCheckouts {
  home: string
  state: "scanning" | "ready"
  checkouts: FoundCheckout[]
  skipped: string[]
  refused: string[]
}

export interface FoundCheckoutsRequest {
  /** Guarded folders under home to look in too: the person asked, or a project they work in is there. */
  within: string[]
}

/** How a clone stands. `signIn`: GitHub turned this Mac's credentials away, or has no such repository for them. */
export type CloneState =
  | { kind: "cloning"; phase: string; percent?: number }
  | { kind: "done"; path: string }
  | { kind: "failed"; message: string; signIn: boolean }
  | { kind: "cancelled" }

export interface CloneProgress {
  id: string
  /** `owner/name`. */
  repository: string
  path: string
  state: CloneState
}

export interface CloneRequest {
  /** Minted by the window: a repeat of the same request answers as the first did. */
  id: string
  /** A GitHub address in any shape Git takes, or `owner/name`. */
  repository: string
  /** The folder the clone goes in, as `<into>/<name>`. */
  into: string
}

/** A clone the host took on: where it goes, and `already` when a checkout of the same repository is there. */
export interface CloneAccepted {
  path: string
  already: boolean
}

export interface CreateProjectRequest {
  path: string
  /** Make it a Git repository too. */
  git: boolean
}

export const FolderBrowseRequestSchema = z.lazy(() => z.object({
  partialPath: z.string().min(1).max(1024).refine((text) => !text.includes("\0"), "expected a path"),
  base: z.string().max(1024).optional(),
}).strict())

export const FoundCheckoutsRequestSchema = z.lazy(() => z.object({ within: z.array(z.string().max(1024)).max(8) }).strict())

export const CloneRequestSchema = z.lazy(() => z.object({
  id: z.string().regex(/^[A-Za-z0-9-]{1,64}$/, "expected an id"),
  repository: z.string().min(1).max(300),
  into: z.string().min(1).max(1024).refine((text) => !text.includes("\0"), "expected a folder"),
}).strict())

export const CreateProjectRequestSchema = z.lazy(() => z.object({
  path: z.string().min(1).max(1024).refine((text) => !text.includes("\0"), "expected a path"),
  git: z.boolean(),
}).strict())

/** A GitHub repository as a person types or pastes it. */
export interface GitHubRepository {
  owner: string
  name: string
  /** `https://github.com/<owner>/<name>`. */
  url: string
}

const OWNER = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})"
const NAME = "[A-Za-z0-9_.-]{1,100}"
const SHORT = new RegExp(`^(${OWNER})/(${NAME})$`)
/** `https://github.com/o/r`, with or without the scheme, `.git`, a trailing path (`/tree/main`) or a query. */
const ADDRESS = new RegExp(`^(?:https?://)?(?:www\\.)?github\\.com/(${OWNER})/(${NAME}?)(?:\\.git)?(?:[/?#].*)?$`, "i")
const SSH = new RegExp(`^(?:ssh://)?git@github\\.com[:/](${OWNER})/(${NAME}?)(?:\\.git)?/?$`)

/** The repository `text` names, or undefined: a GitHub address, an SSH remote, or `owner/name`. */
export function githubRepository(text: string): GitHubRepository | undefined {
  const trimmed = text.trim()
  const match = SHORT.exec(trimmed) ?? ADDRESS.exec(trimmed) ?? SSH.exec(trimmed)
  if (!match?.[1] || !match[2]) return undefined
  const name = match[2].replace(/\.git$/, "")
  if (!name || name === "." || name === "..") return undefined
  return { owner: match[1], name, url: `https://github.com/${match[1]}/${name}` }
}

/** `owner/name` of a remote's address on GitHub; the address itself for another host. */
export function remoteLabel(remote: string): string {
  const repository = githubRepository(remote)
  return repository ? `${repository.owner}/${repository.name}` : remote
}

/** A step of `git clone --progress`, from one line of its standard error: "Receiving objects:  45% (450/1000)". */
export function cloneStep(line: string): { phase: string; percent?: number } | undefined {
  const match = /^(?:remote: )?([A-Z][A-Za-z ]+?):\s+(\d{1,3})%/.exec(line.trim())
  if (match?.[1] && match[2]) return { phase: match[1], percent: Math.min(100, Number(match[2])) }
  if (line.trim().startsWith("Cloning into")) return { phase: "Connecting" }
  return undefined
}

/** Where each of Git's clone steps falls in the whole, in percent. */
const CLONE_SPANS = new Map<string, readonly [number, number]>([
  ["Enumerating objects", [0, 2]],
  ["Counting objects", [2, 6]],
  ["Compressing objects", [6, 10]],
  ["Receiving objects", [10, 80]],
  ["Resolving deltas", [80, 95]],
  ["Updating files", [95, 100]],
])

/**
 * How far a clone has come overall, in percent: counting and compressing on GitHub's side are the first tenth,
 * receiving objects the next seven, resolving deltas and checking files out the rest.
 */
export function clonePercent(step: { phase: string; percent?: number }): number | undefined {
  const at = step.percent
  if (at === undefined) return undefined
  const [from, to] = CLONE_SPANS.get(step.phase) ?? [0, 100]
  return Math.round(from + ((to - from) * at) / 100)
}

/** Whether Git's words say GitHub refused this Mac's credentials, or has no repository by that name for them. */
export function cloneNeedsSignIn(stderr: string): boolean {
  return /Authentication failed|could not read Username|terminal prompts disabled|Repository not found|HTTP Basic: Access denied|returned error: 40[13]|Permission denied \(publickey\)/i.test(stderr)
}
