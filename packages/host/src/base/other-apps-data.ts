import { sep } from "node:path"
import { nodePlatform } from "./platform.js"

/**
 * Where macOS keeps other apps' data under the home folder: each sandboxed
 * app's container, each app group's shared one, each sandboxed daemon's, and
 * each sandboxed app's scripts folder. On macOS 15 and later a stat, a
 * listing or a read in there by a process macOS holds Mako responsible for
 * makes it ask the person whether "Mako" may "access data from other apps",
 * and Mako itself is never sandboxed, so none of them is its own. Mako's
 * host reads nothing there unless the person asked for that very file.
 */
export const OTHER_APPS_DATA = ["Library/Containers", "Library/Group Containers", "Library/Daemon Containers", "Library/Application Scripts"] as const

/**
 * The container folder holding `path` (`~/Library/Containers/com.example.app`), or undefined when it's in none. On
 * macOS the match ignores case, as APFS usually does: `~/library/containers/…` is the same folder.
 */
export function otherAppsData(path: string, home: string, platform: NodeJS.Platform = nodePlatform()): string | undefined {
  const fold = platform === "darwin" ? (text: string) => text.toLowerCase() : (text: string) => text
  const base = home.endsWith(sep) ? home.slice(0, -1) : home
  const folded = fold(path)
  for (const folder of OTHER_APPS_DATA) {
    const root = `${base}${sep}${folder.split("/").join(sep)}`
    const key = fold(root)
    if (folded !== key && !folded.startsWith(key + sep)) continue
    const app = path.slice(root.length + 1).split(sep)[0]
    return app ? `${path.slice(0, root.length)}${sep}${app}` : path.slice(0, root.length)
  }
  return undefined
}
