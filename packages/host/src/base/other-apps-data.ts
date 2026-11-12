import { sep } from "node:path"

/**
 * Where macOS keeps other apps' data under the home folder: each sandboxed
 * app's container and each app group's shared one. On macOS 15 and later a
 * stat, a listing or a read in there by a process macOS holds Mako
 * responsible for makes it ask the person whether "Mako" may "access data
 * from other apps", and Mako itself is never sandboxed, so none of them is
 * its own. Mako's host reads nothing there unless the person asked for that
 * very file.
 */
export const OTHER_APPS_DATA = ["Library/Containers", "Library/Group Containers"] as const

/** The container folder holding `path` (`~/Library/Containers/com.example.app`), or undefined when it's in none. */
export function otherAppsData(path: string, home: string): string | undefined {
  const base = home.endsWith(sep) ? home.slice(0, -1) : home
  for (const folder of OTHER_APPS_DATA) {
    const root = `${base}${sep}${folder.split("/").join(sep)}`
    if (path !== root && !path.startsWith(root + sep)) continue
    const rest = path.slice(root.length + 1)
    const app = rest.split(sep)[0]
    return app ? `${root}${sep}${app}` : root
  }
  return undefined
}
