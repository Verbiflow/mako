import type { ThreadGroup } from "./contracts/thread-groups.js"
import type { HostEvent } from "./contracts/host-events-boot.js"
import { hostWarn } from "./host-log.js"
import type { ThreadStore } from "./thread-store.js"

/**
 * Every host on this Mac shares one Thread store, and a new Session in a
 * Thread is announced only to the windows of the host that made it. This
 * host looks for other hosts' commits once a second and tells its own
 * windows which Threads' tabs changed, and the Threads' purposes when
 * another host recorded one.
 */
export function followOtherHosts(store: ThreadStore, emit: (event: HostEvent) => void, intervalMs = 1000): () => void {
  let known = byId(store.groups())
  let purposes = JSON.stringify(store.purposes())
  let failing = false
  const timer = setInterval(() => {
    try {
      // A purpose is written after its Thread's placement, so it is read on
      // every tick rather than only when placements changed.
      const nextPurposes = store.purposes()
      const writtenPurposes = JSON.stringify(nextPurposes)
      if (writtenPurposes !== purposes) {
        purposes = writtenPurposes
        emit({ type: "thread-purposes", purposes: nextPurposes })
      }
      const changed = store.takeExternalChanges()
      failing = false
      if (!changed) return
      const groups = byId(store.groups())
      const threads = new Set<string>()
      for (const id of new Set([...known.keys(), ...groups.keys()]))
        if (JSON.stringify(known.get(id)) !== JSON.stringify(groups.get(id))) threads.add(id)
      known = groups
      for (const thread of threads) emit({ type: "thread-group", change: { thread, group: groups.get(thread) ?? null } })
    } catch (error) {
      if (!failing) hostWarn("threads", "another host's Thread changes could not be read", { error: error instanceof Error ? error.message : String(error) })
      failing = true
    }
  }, intervalMs)
  timer.unref()
  return () => clearInterval(timer)
}

function byId(groups: readonly ThreadGroup[]): Map<string, ThreadGroup> {
  return new Map(groups.map((group) => [group.id, group]))
}
