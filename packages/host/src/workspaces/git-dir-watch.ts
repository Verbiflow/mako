import { realpath } from "node:fs/promises"
import { join, sep } from "node:path"
import { childBackend, type WatchBackend, type WatchSubscription } from "./watch-backend.js"
import { locateGitDir } from "../base/checkout-location.js"

/** What moves on every commit, add, reset or checkout, and nothing else does. */
const MARKERS = ["index", join("logs", "HEAD")]
/**
 * What moves only when a checkout's HEAD does: a commit, checkout, reset, merge or rebase. The index also moves when
 * any `git status` refreshes its stat cache, as a Changes panel's does on every edit.
 */
export const HEAD_MARKER = ["HEAD", join("logs", "HEAD")]
/** Shared ref changes, including a push/fetch that leaves the worktree HEAD alone. */
export const REF_MARKERS = ["packed-refs", "FETCH_HEAD", join("refs", "remotes")]
/** What moves when what's staged does, and on any `git status` that refreshes the index's stat cache. */
export const INDEX_MARKER = ["index"]

export interface GitDirWatch {
  /** Settles once the markers are watched, or once it's clear there's nothing to watch. */
  readonly ready: Promise<void>
  close(): Promise<void>
}

/**
 * A checkout whose Git directory is outside the folder a workspace watch
 * covers: a linked worktree (its index and reflog live in the main
 * checkout's `.git/worktrees/<name>`), a submodule, or a project opened at a
 * subfolder. A commit there changes no file under the folder, so it would go
 * unheard. The two marker files are watched themselves, which on macOS is a
 * kqueue handle rather than another FSEvents stream. Git replaces the index
 * by renaming over it, which ends a watch on the old file, so each event
 * moves the watch to the new file before announcing the change.
 *
 * Every Git read, even with `--no-optional-locks`, updates the index's access
 * time, and the watch reports that too. Announcing it would make each status
 * read schedule the next one, forever, so an event that leaves the file's
 * inode, size, mtime and ctime as they were is not a change.
 */
export function watchOutsideGitDir(folder: string, changed: () => void, backend: WatchBackend = childBackend()): GitDirWatch {
  let markers: GitDirWatch | undefined
  let closed = false
  let closing: Promise<void> | undefined
  const ready = (async () => {
    const [gitDir, root] = await Promise.all([
      locateGitDir(folder).then((found) => found && realpath(found)).catch(() => null),
      realpath(folder).catch(() => null),
    ])
    if (closed || !gitDir || !root || gitDir.startsWith(root + sep)) return
    markers = watchGitMarkers(gitDir, () => { if (!closed) changed() }, MARKERS, backend)
    await markers.ready
  })()
  return {
    ready,
    close() {
      closed = true
      return closing ??= ready.then(() => markers?.close())
    },
  }
}

/** Git markers use the same child as tree watches; dropped events invalidate the whole marker set. */
export function watchGitMarkers(gitDir: string, changed: () => void, markers: readonly string[] = MARKERS, backend: WatchBackend = childBackend()): GitDirWatch {
  let closed = false
  let release: Promise<void> | undefined
  let closing: Promise<void> | undefined
  let subscription: WatchSubscription | undefined
  const done = () => release ??= subscription?.unsubscribe() ?? Promise.resolve()
  const notify = () => { if (!closed) changed() }
  const ready = (async () => {
    const found = await backend(gitDir, [], {
      events: notify,
      dropped: notify,
      gone: notify,
      muted: (muted) => { if (!muted) notify() },
    }, { kind: "git-markers", markers: [...markers] })
    subscription = found
    if (closed) await done()
  })()
  // A missing/unwatchable Git directory is still covered by explicit refreshes, as before.
  const settled = ready.catch(() => {})
  return { ready: settled, close() { closed = true; return closing ??= settled.then(done) } }
}
