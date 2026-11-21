import { posix, win32 } from "node:path"
import { linkableLocalFolder } from "@mako/host/contracts/local-folder"

/** The scheme Mako registers for itself on Windows (`app.setAsDefaultProtocolClient`). */
export const DEEP_LINK_SCHEME = "mako"

/**
 * What a `mako:` link asks the desktop for:
 *
 *   `mako://open?path=<folder>`  open a folder on this computer's drives as a project, once the person agrees
 *                                (`openProjectLink`); a share, a device path or a relative one is refused
 *   `mako://thread/<subject>`    open a Thread, as clicking its notification does
 *   anything else, `mako://`     bring Mako forward
 */
export type DeepLink =
  | { kind: "open-project"; path: string }
  | { kind: "open-thread"; subject: string }
  | { kind: "focus" }
  | { kind: "refused"; reason: string }

/** The link a `mako:` URL names, or undefined for one that isn't Mako's. */
export function parseDeepLink(url: string, windows = process.platform === "win32"): DeepLink | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (parsed.protocol !== `${DEEP_LINK_SCHEME}:`) return undefined
  if (parsed.hostname === "open") {
    const path = parsed.searchParams.get("path")
    if (!path) return { kind: "focus" }
    // Read from the text alone: a share's path is refused before anything could connect to it.
    return linkableLocalFolder(path, windows) ? { kind: "open-project", path } : { kind: "refused", reason: "it isn't a folder on this computer's drives" }
  }
  if (parsed.hostname === "thread") {
    const subject = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""))
    return subject ? { kind: "open-thread", subject } : { kind: "focus" }
  }
  return { kind: "focus" }
}

/**
 * The `mako:` link Windows started this app with, or handed a second launch (`second-instance`): it comes as an argument
 * of its own after `--` (the registration's `"Mako.exe" "--" "%1"`), so no link is ever read as a switch.
 */
export function deepLinkInArgv(argv: readonly string[], windows = process.platform === "win32"): DeepLink | undefined {
  for (const argument of argv) {
    if (!argument.toLowerCase().startsWith(`${DEEP_LINK_SCHEME}:`)) continue
    const link = parseDeepLink(argument, windows)
    if (link) return link
  }
  return undefined
}

/** What `localFolderRefusal` reads of a path: `lstat`, which never follows a link to where it points. */
export interface FolderReader {
  lstat(path: string): Promise<{ isSymbolicLink(): boolean; isDirectory(): boolean }>
}

/**
 * Why a linked folder can't be opened, or undefined when it's an existing folder on this computer's drives. Its text is
 * checked first, so a share is refused without a single file-system call; then each part of it, from the drive down,
 * with `lstat`, refusing a link or junction on the way (one could point at a share) and anything missing, and the last
 * part must be a folder.
 */
export async function localFolderRefusal(path: string, windows: boolean, reader: FolderReader): Promise<string | undefined> {
  if (!linkableLocalFolder(path, windows)) return "it isn't a folder on this computer's drives"
  const paths = windows ? win32 : posix
  const resolved = paths.resolve(path)
  const { root } = paths.parse(resolved)
  let current = root
  let last: Awaited<ReturnType<FolderReader["lstat"]>> | undefined
  for (const part of resolved.slice(root.length).split(paths.sep).filter(Boolean)) {
    current = paths.join(current, part)
    last = await reader.lstat(current).catch(() => undefined)
    if (!last) return "it doesn't exist"
    if (last.isSymbolicLink()) return "it goes through a link or junction"
  }
  if (!last?.isDirectory()) return "it isn't a folder"
  return undefined
}

export interface ProjectLinkSteps {
  windows: boolean
  reader: FolderReader
  /** Asks the person, in the app's own dialog, whether to open this folder; true only for Open. */
  confirm(path: string): Promise<boolean>
  /** Opens it as a project in a window (`requestOpenProject`). */
  open(path: string): void
  refused(path: string, reason: string): void
}

/** A `mako://open` link's folder: opened only when it's a local folder and the person said Open. */
export async function openProjectLink(path: string, steps: ProjectLinkSteps): Promise<"opened" | "declined" | "refused"> {
  const reason = await localFolderRefusal(path, steps.windows, steps.reader)
  if (reason) {
    steps.refused(path, reason)
    return "refused"
  }
  if (!(await steps.confirm(path))) return "declined"
  steps.open(path)
  return "opened"
}
