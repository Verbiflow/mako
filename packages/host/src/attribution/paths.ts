import { QUIET_FOLDERS } from "../base/quiet-folders.js"

/*
 * What the tracker never journals, and what a turn's footprint leaves out.
 * Inside a tracked root: dependencies and build output (unless Git tracks the
 * file, as an Electron app's `build/` icons), Git's own folder, and every
 * folder the caller names as noise (the harnesses' stores, Mako's own data).
 * Outside the roots: caches, shell histories and the system's own churn,
 * unless a turn's calls named the path.
 */

const QUIET = new Set<string>(QUIET_FOLDERS)
/** Folders that are never a project's content, wherever they are. */
const NEVER = new Set(["node_modules", ".git", ".DS_Store", ".Trash"])

/** Whether `path` (relative to its root, `/`-separated) is never tracked; `tracked` says Git tracks it. */
export function untrackable(path: string, tracked: boolean): boolean {
  const parts = path.split("/")
  if (parts.some((part) => NEVER.has(part))) return true
  return !tracked && parts.some((part) => QUIET.has(part))
}

/** Whether `path` is inside `folder` or is it. */
export function within(folder: string, path: string): boolean {
  return path === folder || path.startsWith(folder.endsWith("/") ? folder : `${folder}/`)
}

/** Under the home folder: churn no turn means, unless one of its calls named the path. */
const HOME_NOISE = [
  "Library",
  ".cache",
  ".npm",
  ".pnpm-store",
  ".yarn",
  ".bun/install",
  ".cargo/registry",
  ".cargo/git",
  ".rustup",
  ".gradle",
  ".m2/repository",
  "go/pkg",
  ".local/share/Trash",
  ".local/state",
  ".zsh_sessions",
  ".Trash",
]
const HOME_NOISE_FILES = new Set([".zsh_history", ".bash_history", ".python_history", ".node_repl_history", ".lesshst", ".viminfo", ".DS_Store", ".CFUserTextEncoding"])
/** Anywhere outside the roots. */
const NOISE_PARTS = new Set(["node_modules", "__pycache__", ".git", ".DS_Store", ".cache", "tmp", "temp", ".tmp", "Caches"])
/** Files whose churn is a program's own bookkeeping: SQLite's journals, locks, temporary copies. */
const NOISE_FILE = /(-wal|-shm|-journal|\.lock|\.pid|\.tmp|\.swp|~)$|\.tmp\b/

/**
 * Whether a changed path outside the roots is noise: `stores` are the
 * harnesses' own stores and Mako's folders, never a footprint, named or not.
 * A path a call named itself is never noise otherwise; one only in a folder
 * a call named still is when it's a program's bookkeeping (a lock, a
 * temporary copy); the rest is noise when it's churn no turn means.
 */
export function footprintNoise(path: string, home: string, stores: readonly string[], named: "path" | "folder" | undefined): boolean {
  if (stores.some((store) => within(store, path))) return true
  if (named === "path") return false
  const parts = path.split("/")
  if (NOISE_FILE.test(parts.at(-1) ?? "")) return true
  if (named === "folder") return false
  if (parts.some((part) => NOISE_PARTS.has(part))) return true
  if (!within(home, path)) return false
  const inside = path.slice(home.length + 1)
  if (HOME_NOISE_FILES.has(inside)) return true
  return HOME_NOISE.some((folder) => within(folder, inside))
}
