import type { ThreadGroup } from "../contracts/thread-groups.js"
import type { HostEvent } from "../contracts/host-events-boot.js"
import { hostWarn } from "../base/host-log.js"
import type { HostJobs, JobDemand } from "../base/host-jobs.js"
import type { ThreadStore } from "./store.js"

/**
 * Every host on this Mac shares one Thread store, and a new Session in a
 * Thread is announced only to the windows of the host that made it. This
 * host looks for other hosts' commits once a second and tells its own
 * windows which Threads' tabs and names changed, and the Threads' purposes
 * when another host recorded one. With no client subscribed it doesn't look;
 * the first look after one subscribes catches up on everything since.
 */
export function followOtherHosts(
  store: ThreadStore,
  emit: (event: HostEvent) => void,
  { jobs, subscribed, everyMs = 1000, formats }: {
    jobs: HostJobs
    subscribed: JobDemand
    everyMs?: number
    /**
     * The shared stores' formats as this host holds them (`key`), and what
     * to do when another host raised one, so this one now only reads it.
     */
    formats?: { key: () => string; changed: () => void }
  },
): () => void {
  let known = byId(store.groups())
  let purposes = JSON.stringify(store.purposes())
  let format = formats?.key()
  let failing = false
  return jobs.every("follow other hosts' Thread changes", everyMs, () => {
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
      // Reading the changes rereads the store's format after another host's commit.
      const standing = formats?.key()
      if (standing !== format) {
        format = standing
        formats?.changed()
      }
      const titles = store.takeExternalTitles()
      if (titles.length) emit({ type: "thread-titles", titles })
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
  }, { needs: [subscribed] })
}

function byId(groups: readonly ThreadGroup[]): Map<string, ThreadGroup> {
  return new Map(groups.map((group) => [group.id, group]))
}
