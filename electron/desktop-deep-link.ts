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
  /** The path the system resolves this one to: its real case and names, and a mapped drive's share. */
  realpath(path: string): Promise<string>
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

/**
 * The folder a link's path really names, or why it can't be opened: checked as written (`localFolderRefusal`), then
 * resolved by the system, and the resolved path checked the same way, so `C:\\Work\\app\\..\\..\\Users\\x` is what it
 * is before anyone is asked, and a mapped drive's share is refused as a share.
 */
export async function resolveLinkedFolder(path: string, windows: boolean, reader: FolderReader): Promise<{ folder: string } | { refusal: string }> {
  const written = await localFolderRefusal(path, windows, reader)
  if (written) return { refusal: written }
  const folder = await reader.realpath(path).catch(() => undefined)
  if (!folder) return { refusal: "it doesn't exist" }
  const resolved = await localFolderRefusal(folder, windows, reader)
  return resolved ? { refusal: resolved } : { folder }
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

/**
 * A `mako://open` link's folder: opened only when it's a local folder and the person said Open. The person is shown
 * the resolved folder, never the path as written, and that folder is what opens; it is resolved and checked again
 * after Open, since what a path names can change while a dialog waits.
 */
export async function openProjectLink(path: string, steps: ProjectLinkSteps): Promise<"opened" | "declined" | "refused"> {
  const first = await resolveLinkedFolder(path, steps.windows, steps.reader)
  if ("refusal" in first) {
    steps.refused(path, first.refusal)
    return "refused"
  }
  if (!(await steps.confirm(first.folder))) return "declined"
  const again = await resolveLinkedFolder(first.folder, steps.windows, steps.reader)
  if ("refusal" in again || again.folder !== first.folder) {
    steps.refused(path, "refusal" in again ? again.refusal : "it changed while the question was open")
    return "refused"
  }
  steps.open(first.folder)
  return "opened"
}

/**
 * One question at a time: a link that arrives while another's folder is being checked or asked about is dropped, so a
 * page can't stack dialogs for the person to click through.
 */
export function projectLinkOpener(steps: ProjectLinkSteps & { dropped(path: string): void }): (path: string) => Promise<"opened" | "declined" | "refused" | "dropped"> {
  let busy = false
  return async (path) => {
    if (busy) {
      steps.dropped(path)
      return "dropped"
    }
    busy = true
    try {
      return await openProjectLink(path, steps)
    } finally {
      busy = false
    }
  }
}
