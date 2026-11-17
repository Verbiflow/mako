import type { Git } from "@mako/git"
import { existsSync, readdirSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { join, relative, resolve, sep } from "node:path"
import { chatsRoot } from "../base/chats.js"
import { QUIET_FOLDERS } from "../base/quiet-folders.js"
import { CALM_POLL_MS } from "../contracts/watcher-child.js"
import { pollTree, type TreePoll } from "./tree-poll.js"
import type { WatchBackend, WatchSubscription } from "./watch-backend.js"
import { onMac } from "../base/platform.js"

export const QUIET = new RegExp(`(^|/)(${QUIET_FOLDERS.map((name) => name.replace(".", "\\.")).join("|")})(/|$)`)
/** FSEventStreamSetExclusionPaths ignores the whole list when it holds more than eight. */
const MAX_EXCLUSIONS = 8
/** Enough packages to find a monorepo's dependency folders without reading a large folder's listing. */
const MAX_PACKAGES = 64
const QUIET_GLOBS = [`**/{${QUIET_FOLDERS.join(",")}}`, `**/{${QUIET_FOLDERS.join(",")}}/**`]
/**
 * How long a replaced subscription keeps delivering. A new FSEvents stream
 * starts from now, so what fseventsd had queued for the old one but not yet
 * sent, seconds of it on a busy Mac, comes from the old one alone; a longer
 * wait is a silence the watcher's canary answers by polling.
 */
const REPLACED_KEPT_MS = 30_000

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
 * start over so the folder is excluded too. The filesystem root, the home
 * folder and the Chats folder aren't watched: their churn is never one
 * project's.
 *
 * When the system drops events (FSEvents under load says "must be
 * re-scanned"), the watch keeps going and `onDropped("dropped")` says
 * anything may have changed. When nothing is delivered at all (a silent
 * fseventsd, a stalled watcher), changes are found by polling instead (see
 * `pollTree`), with `onDropped("polling")` on the way in and
 * `onDropped("listening")` on the way back out. When the watch can't start
 * or stops while the folder is still there (inotify out of watches, the
 * watcher child giving up), it's polling for good, after
 * `onDropped("dropped")`. `onError` means the folder went away.
 */
export function watchTree(
  git: Git, backend: WatchBackend, root: string, onChange: (paths: string[]) => void, onError: () => void,
  onDropped?: (why: "dropped" | "polling" | "listening") => void,
): TreeWatch | undefined {
  const target = resolve(root)
  if (target === sep || target === resolve(homedir()) || target === chatsRoot()) return undefined
  let real: string
  try {
    real = realpathSync(target)
  } catch {
    return undefined
  }
  let closed = false
  let excluded: string[] = []
  let subscription: Promise<WatchSubscription | undefined> = Promise.resolve(undefined)
  let generation = 0
  let poll: TreePoll | undefined
  /** The watch itself is gone, so polling is all there is. */
  let lost = false
  /** Subscriptions replaced, delivering what was queued for them until `REPLACED_KEPT_MS` is up. */
  const replaced = new Map<WatchSubscription, NodeJS.Timeout>()
  const stop = (old: WatchSubscription) => {
    clearTimeout(replaced.get(old))
    replaced.delete(old)
    void old.unsubscribe().catch(() => {})
  }

  /** Events come late, so the stream may be holding some back. */
  let late = false
  /** While `late`, a poll every `CALM_POLL_MS` beside the watch, unless `poll` already runs. */
  let calm: TreePoll | undefined
  const polled = (paths: string[]) => {
    const heard = paths.filter((path) => !QUIET.test(path))
    if (!closed && heard.length) onChange(heard)
  }
  const calmly = () => {
    const wanted = late && !poll && !closed
    if (wanted && !calm) calm = pollTree(git, real, QUIET, polled, CALM_POLL_MS)
    else if (!wanted && calm) {
      calm.close()
      calm = undefined
    }
  }

  const fallBack = (why: "dropped" | "polling") => {
    if (closed || poll) return
    poll = pollTree(git, real, QUIET, polled)
    calmly()
    onDropped?.(why)
  }
  const recover = () => {
    if (!poll || lost) return
    poll.close()
    poll = undefined
    calmly()
    if (!closed) onDropped?.("listening")
  }
  const failed = () => {
    if (closed) return
    if (!existsSync(real)) return onError()
    lost = true
    if (poll) onDropped?.("dropped")
    fallBack("dropped")
  }

  // The next subscription starts before the previous one stops, which is
  // `REPLACED_KEPT_MS` later, so nothing written in between is missed; a
  // change heard twice costs one more debounce.
  const start = () => {
    excluded = quietFoldersOf(real)
    const previous = subscription
    const current = ++generation
    subscription = backend(real, [...excluded, ...QUIET_GLOBS], {
      dropped: () => {
        if (!closed) onDropped?.("dropped")
      },
      gone: () => {
        if (current === generation) failed()
      },
      muted: (muted) => {
        if (muted) fallBack("polling")
        else recover()
      },
      late: (now) => {
        late = now
        calmly()
      },
      events: (events) => {
        if (closed) return
        const paths: string[] = []
        let appeared = false
        for (const event of events) {
          const path = relative(real, event.path).split(sep).join("/")
          if (!path || path.startsWith("..")) continue
          if (!QUIET.test(path)) paths.push(path)
          else if (event.type === "create" && !excluded.includes(event.path) && isQuietFolder(path)) appeared = true
        }
        if (appeared && onMac() && quietFoldersOf(real).join("\0") !== excluded.join("\0")) start()
        if (paths.length) onChange(paths)
      },
    })
      .then(async (next) => {
        const old = await previous.catch(() => undefined)
        if (old && !closed) {
          const timer = setTimeout(() => stop(old), REPLACED_KEPT_MS)
          timer.unref()
          replaced.set(old, timer)
        } else if (old) stop(old)
        if (!closed) return next
        await next.unsubscribe()
        return undefined
      }, () => {
        if (current === generation) failed()
        return undefined
      })
  }
  start()
  return {
    ready: subscription.then(() => {}),
    close() {
      if (closed) return
      closed = true
      poll?.close()
      poll = undefined
      calmly()
      for (const old of replaced.keys()) stop(old)
      void subscription.then((current) => current?.unsubscribe()).catch(() => {})
    },
  }
}
