import { dirname, sep } from "node:path"
import type { ChildWatchBackend, WatchListener } from "./watch-backend.js"

/** Past this many paths in one delivery, it's taken as "anything under the root": a build or a checkout, not an edit. */
const NAMED_PATHS = 64

const plain = (path: string) => (path.startsWith("/private/") ? path.slice("/private".length) : path)

/**
 * The folders the host's tree watches hear now, and what they hear, for whoever wants to know that files under a
 * folder changed without starting a watch of their own. Every tree watch in the host goes through one backend
 * (`over`): the folder a tab has open, each checkout attribution follows while a Thread works in it, a conversation's
 * files, an automation's folder. A worktree's summary takes its file events from those, so showing which worktrees
 * have uncommitted work starts no watch and walks no tree. Watches of single files or of Git's markers aren't trees
 * and aren't told.
 */
export class WatchedTrees {
  /** Each watched root, with how many watches hear it and how many of those are deaf for now (polling instead). */
  private readonly roots = new Map<string, { watches: number; deaf: number }>()
  private listener: ((root: string, paths: readonly string[] | undefined) => void) | undefined

  /**
   * Hears what any tree watch hears: `paths`, absolute, under `root`; undefined when anything under it may have
   * changed (events dropped, delivery back after a silence, too many to name).
   */
  follow(listener: (root: string, paths: readonly string[] | undefined) => void): void {
    this.listener = listener
  }

  /** Whether a tree watch that is delivering covers `path`: an edit there would be heard. */
  covers(path: string): boolean {
    for (let folder = plain(path); ; folder = dirname(folder)) {
      const root = this.roots.get(folder)
      if (root && root.watches > root.deaf) return true
      if (folder === sep || dirname(folder) === folder) return false
    }
  }

  /** `inner`, with every tree watch made through it told here. */
  over(inner: ChildWatchBackend): ChildWatchBackend {
    const watch: ChildWatchBackend = Object.assign(async (root: string, ignore: readonly string[], listener: WatchListener, native?: Parameters<ChildWatchBackend>[3]) => {
      if (native) return inner(root, ignore, listener, native)
      const at = plain(root)
      let deaf = false
      const heard = (paths: readonly string[] | undefined) => this.listener?.(at, paths)
      const hearing = (muted: boolean) => {
        const held = this.roots.get(at)
        if (!held || muted === deaf) return
        deaf = muted
        held.deaf += muted ? 1 : -1
      }
      const subscription = await inner(root, ignore, {
        events: (events) => {
          heard(events.length > NAMED_PATHS ? undefined : events.map((event) => plain(event.path)))
          listener.events(events)
        },
        dropped: (reason) => {
          heard(undefined)
          listener.dropped(reason)
        },
        gone: () => listener.gone(),
        muted: (muted) => {
          hearing(muted)
          // What changed during the silence was heard by nobody.
          if (!muted) heard(undefined)
          listener.muted(muted)
        },
        ...listener.late && { late: (late: boolean) => listener.late?.(late) },
      })
      const held = this.roots.get(at)
      if (held) held.watches += 1
      else this.roots.set(at, { watches: 1, deaf: 0 })
      // A watch that just began heard nothing of what came before it: whoever relies on it looks once.
      heard(undefined)
      let closed = false
      return {
        unsubscribe: async () => {
          if (!closed) {
            closed = true
            hearing(false)
            const left = this.roots.get(at)
            if (left && --left.watches <= 0) this.roots.delete(at)
          }
          await subscription.unsubscribe()
        },
      }
    }, { recover: () => inner.recover(), paced: (poll: symbol, spacingMs: number | undefined) => inner.paced(poll, spacingMs) })
    return watch
  }
}
