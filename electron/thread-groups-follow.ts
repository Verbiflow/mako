import type { ThreadGroup, ThreadRegroup } from "./contracts/thread-groups.js"
import { SessionIdSchema } from "./contracts/thread-identity.js"
import type { HostEvent } from "./contracts/host-events-boot.js"
import { hostWarn } from "./host-log.js"
import type { ThreadStore } from "./thread-store.js"

/**
 * Every host on this Mac shares one Thread store, and a regroup is announced
 * only to the windows of the host that made it. This host looks for other
 * hosts' commits once a second and tells its own windows which Sessions
 * moved and which Threads' tabs changed.
 */
export function followOtherHosts(store: ThreadStore, emit: (event: HostEvent) => void, intervalMs = 1000): () => void {
  let known = byId(store.groups())
  let failing = false
  const timer = setInterval(() => {
    try {
      const changed = store.takeExternalChanges()
      failing = false
      if (!changed) return
      const groups = byId(store.groups())
      const threads = new Set<string>()
      for (const id of new Set([...known.keys(), ...groups.keys()]))
        if (JSON.stringify(known.get(id)) !== JSON.stringify(groups.get(id))) threads.add(id)
      const sessions = new Set<string>(changed === "all" ? [] : changed)
      for (const id of threads)
        for (const group of [known.get(id), groups.get(id)])
          for (const member of group?.sessions ?? []) sessions.add(member.id)
      known = groups
      const placements: ThreadRegroup["placements"] = []
      for (const session of sessions) {
        const placed = store.sessionPlacement(SessionIdSchema.parse(session))
        if (placed) placements.push({ session: placed.session, thread: placed.thread })
      }
      if (placements.length) emit({ type: "thread-regroup", regroup: { placements } })
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
