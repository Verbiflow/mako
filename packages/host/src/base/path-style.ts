import { posix, win32 } from "node:path"
import { keptPath, windowsPath } from "@mako/protocol/attribution"

/*
 * Paths in the record of changes, on a Mac, Linux and Windows.
 *
 * An absolute path is kept as its system writes it: `/Users/ana/site` on a Mac or Linux, `C:\Users\ana\site` on
 * Windows, which is what Node's own `join` and `resolve` give there and so what the rest of the host holds. What comes
 * in another way (`C:/Users/ana/site` from Git, `c:\…` from a harness) is turned into that once, where it comes in
 * (`kept`, and `AbsolutePathSchema` does it for everything it reads). A path inside a tracked root is always
 * `/`-separated, as Git writes it (`src/app.ts`), on every system.
 *
 * Nothing here asks which system the host runs on: a path says its own style by how it starts, so a Windows path is
 * handled the same way wherever the code runs (and the tests of it run on a Mac). A path that starts with `/` is
 * handled exactly as before, byte for byte.
 */

/** Whether `path` is a Windows path: a drive's (`C:\x`, `C:/x`) or a share's (`\\server\share\x`). */
export const windowsStyle = windowsPath

/** An absolute path as the record keeps it (`keptPath`): a Windows path with `\` and a capital drive letter; any other as it is. */
export const kept = keptPath

/** Whether `path` is absolute in either style. */
export function absolutePath(path: string): boolean {
  return path.startsWith("/") || windowsStyle(path)
}

/** The absolute path of `inside` (a `/`-separated path in `root`), in `root`'s style. */
export function under(root: string, inside: string): string {
  return windowsStyle(root) ? `${root}\\${inside.replaceAll("/", "\\")}` : `${root}/${inside}`
}

/** `path` (absolute, in `root`) as a `/`-separated path inside `root`. */
export function insideOf(root: string, path: string): string {
  const rest = path.slice(root.length + 1)
  return windowsStyle(root) ? rest.replaceAll("\\", "/") : rest
}

/** Whether `path` is inside `folder` or is it. Windows names are compared without regard to case, as Windows does. */
export function within(folder: string, path: string): boolean {
  if (!windowsStyle(folder)) return path === folder || path.startsWith(folder.endsWith("/") ? folder : `${folder}/`)
  const outer = folder.toLowerCase()
  const inner = path.toLowerCase()
  return inner === outer || inner.startsWith(outer.endsWith("\\") ? outer : `${outer}\\`)
}

/** The separator `path` is written with. */
export function separatorOf(path: string): "/" | "\\" {
  return windowsStyle(path) ? "\\" : "/"
}

/** The names along `path`. */
export function partsOf(path: string): string[] {
  return windowsStyle(path) ? path.split(/[\\/]/) : path.split("/")
}

/** The folder `path` is in; a drive's own folder (`C:\`) is its own. */
export function folderOf(path: string): string {
  return windowsStyle(path) ? win32.dirname(path) : posix.dirname(path)
}

/** The last name of `path`. */
export function nameOf(path: string): string {
  return windowsStyle(path) ? win32.basename(path) : posix.basename(path)
}

/** `folder` with these names after it, as Node joins them. */
export function joined(folder: string, ...names: string[]): string {
  return windowsStyle(folder) ? win32.join(folder, ...names) : posix.join(folder, ...names)
}

/** `path` with `.`, `..` and doubled separators taken out, as Node normalizes it in its own style. */
export function normalizedPath(path: string): string {
  return windowsStyle(path) ? win32.normalize(path) : posix.normalize(path)
}

/**
 * `path` when it's absolute, else `path` read from `folder` (joined, or resolved as a shell would when `how` says
 * so), kept; undefined with no folder to read it from.
 */
export function absoluteFrom(folder: string | undefined, path: string, how: "join" | "resolve" = "join"): string | undefined {
  if (absolutePath(path)) return kept(path)
  if (!folder) return undefined
  if (windowsStyle(folder)) return kept(how === "join" ? win32.join(folder, path) : win32.resolve(folder, path))
  return how === "join" ? posix.join(folder, path) : posix.resolve(folder, path)
}
