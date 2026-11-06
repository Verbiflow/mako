import type { HostEvent } from "../contracts/host-events-boot.js"
import { hostWarn } from "../base/host-log.js"
import type { HostJobs, JobDemand } from "../base/host-jobs.js"
import type { ThreadStore } from "./store.js"

/**
 * Every host on this Mac shares one Thread store. This host looks for other
 * hosts' commits once a second and tells its own windows which Threads' names
 * changed, and the Threads' purposes when another host recorded one. With no
 * client subscribed it doesn't look; the first look after one subscribes
 * catches up on everything since.
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
      store.takeExternalChanges()
      // Reading the changes rereads the store's format after another host's commit.
      const standing = formats?.key()
      if (standing !== format) {
        format = standing
        formats?.changed()
      }
      const titles = store.takeExternalTitles()
      if (titles.length) emit({ type: "thread-titles", titles })
      failing = false
    } catch (error) {
      if (!failing) hostWarn("threads", "another host's Thread changes could not be read", { error: error instanceof Error ? error.message : String(error) })
      failing = true
    }
  }, { needs: [subscribed] })
}
