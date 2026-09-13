import type { Stats } from "node:fs"
import { extname } from "node:path"

/**
 * File types whose macOS default handler executes or installs rather than
 * displays. Extensions only; the executable bit and bundles (directories) are
 * checked from the stat.
 */
const LAUNCHABLE_EXTENSIONS = new Set([
  ".app",
  ".action",
  ".applescript",
  ".bundle",
  ".command",
  ".dmg",
  ".framework",
  ".inetloc",
  ".jar",
  ".kext",
  ".mpkg",
  ".pkg",
  ".plugin",
  ".prefpane",
  ".qlgenerator",
  ".saver",
  ".scpt",
  ".scptd",
  ".terminal",
  ".tool",
  ".url",
  ".webloc",
  ".workflow",
])

/**
 * How Reveal should treat a resolved path.
 *
 * `open` hands the file to its default application (a Markdown file lands in
 * the editor, an image in Preview). `reveal` only highlights it in Finder.
 * Anything the default handler would run or install — a bundle, a file with
 * the executable bit, a `.command` script — is revealed, never opened, so a
 * path that arrived from an agent's message is at most one click from being
 * *seen*, never from being executed.
 */
export function revealAction(
  path: string,
  stats: Pick<Stats, "mode" | "isDirectory">
): "open" | "reveal" {
  if (stats.isDirectory()) return "reveal"
  if ((stats.mode & 0o111) !== 0) return "reveal"
  if (LAUNCHABLE_EXTENSIONS.has(extname(path).toLowerCase())) return "reveal"
  return "open"
}
