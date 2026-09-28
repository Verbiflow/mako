import { existsSync, readdirSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { join, relative, resolve, sep } from "node:path"
import parcel, { type AsyncSubscription } from "@parcel/watcher"

/** Folders whose churn is never a change anyone watching a project means: dependencies and build output. */
export const QUIET_FOLDERS = ["node_modules", ".next", "dist", "dist-electron", "build", "out", "target", "coverage", ".turbo", "release", ".venv"] as const
export const QUIET = new RegExp(`(^|/)(${QUIET_FOLDERS.map((name) => name.replace(".", "\\.")).join("|")})(/|$)`)
/** FSEventStreamSetExclusionPaths ignores the whole list when it holds more than eight. */
const MAX_EXCLUSIONS = 8
/** Enough packages to find a monorepo's dependency folders without reading a large folder's listing. */
const MAX_PACKAGES = 64
const QUIET_GLOBS = [`**/{${QUIET_FOLDERS.join(",")}}`, `**/{${QUIET_FOLDERS.join(",")}}/**`]

function isQuietFolder(path: string): boolean {
  const segments = path.split("/")
  return segments.length <= 3 && QUIET_FOLDERS.some((name) => name === segments.at(-1))
}

export interface TreeWatch {
  /** Settles once changes are being heard; earlier ones may not be. */
  readonly ready: Promise<void>
  close(): void
}

/**
 * The quiet folders of `root` that exist now, most expensive first: its own,
 * then those of the packages directly inside it or inside `packages/`,
 * `apps/` and similar. At most eight, the most FSEvents excludes.
 */
export function quietFoldersOf(root: string): string[] {
  const found: string[] = []
  const add = (folder: string) => {
    if (found.length < MAX_EXCLUSIONS && existsSync(folder)) found.push(folder)
  }
  for (const name of QUIET_FOLDERS) add(join(root, name))
  const packages: string[] = []
  for (const parent of [root, ...["packages", "apps", "libs"].map((name) => join(root, name))]) {
    let entries: string[]
    try {
      entries = readdirSync(parent, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !QUIET.test(entry.name))
        .map((entry) => join(parent, entry.name))
    } catch {
      continue
    }
    packages.push(...entries.slice(0, MAX_PACKAGES - packages.length))
  }
  for (const folder of packages) add(join(folder, "node_modules"))
  return found
}

/**
 * Report changes under `root`, as paths relative to it, without hearing
 * dependency or build folders at all: on macOS FSEvents drops the eight
 * largest before they leave `fseventsd`, on Linux inotify never watches
 * inside any of them. Node's recursive `fs.watch` can do neither; an
 * `npm install` delivered every file it wrote, to be filtered here.
 *
 * A quiet folder created after the watch starts (the first install) makes it
 * start over so the folder is excluded too. The filesystem root and the home
 * folder aren't watched: a whole disk's churn is never one project's.
 *
 * `onError` means the watch couldn't start or went away. When the system
 * drops events instead (FSEvents under load says "must be re-scanned"), the
 * watch keeps going and `onDropped` says anything may have changed.
 */
export function watchTree(root: string, onChange: (paths: string[]) => void, onError: () => void, onDropped?: () => void): TreeWatch | undefined {
  const target = resolve(root)
  if (target === sep || target === resolve(homedir())) return undefined
  let real: string
  try {
    real = realpathSync(target)
  } catch {
    return undefined
  }
  let closed = false
  let excluded: string[] = []
  let subscription: Promise<AsyncSubscription | undefined> = Promise.resolve(undefined)

  // The next subscription starts before the previous one stops, so nothing
  // written in between is missed; a change heard twice costs one more debounce.
  const start = () => {
    excluded = quietFoldersOf(real)
    const previous = subscription
    subscription = parcel
      .subscribe(real, (error, events) => {
        if (closed) return
        if (error) {
          onDropped?.()
          return
        }
        const paths: string[] = []
        let appeared = false
        for (const event of events) {
          const path = relative(real, event.path).split(sep).join("/")
          if (!path || path.startsWith("..")) continue
          if (!QUIET.test(path)) paths.push(path)
          else if (event.type === "create" && !excluded.includes(event.path) && isQuietFolder(path)) appeared = true
        }
        if (appeared && process.platform === "darwin" && quietFoldersOf(real).join("\0") !== excluded.join("\0")) start()
        if (paths.length) onChange(paths)
      }, { ignore: [...excluded, ...QUIET_GLOBS] })
      .then(async (next) => {
        await previous.then((old) => old?.unsubscribe()).catch(() => {})
        if (!closed) return next
        await next.unsubscribe()
        return undefined
      }, () => {
        if (!closed) onError()
        return undefined
      })
  }
  start()
  return {
    ready: subscription.then(() => {}),
    close() {
      if (closed) return
      closed = true
      void subscription.then((current) => current?.unsubscribe()).catch(() => {})
    },
  }
}
