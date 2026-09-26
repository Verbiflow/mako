import type { HarnessDescriptor } from "@/lib/types"
import { getMako, hasBridge } from "@/lib/bridge"
import { isHostReconnectingError } from "../../electron/contracts/host-connection.ts"
import { threadList } from "../../electron/contracts/thread-list.ts"
import { toast } from "sonner"
import type { ExternalThreadActivity, ThreadRef } from "@/lib/types"
import {
  threadContinuationActions,
  withConversion,
} from "@/state/thread-continuation"
import {
  activeThreadRefs,
  applyThreadRun,
  clearObserved,
  markObserved,
  markThreadReviewed,
  OBSERVED_IDLE_MS,
  recentThreadActivityDuration,
  sameThreadStatus,
  seedRecentThreadActivity,
  setThreadAttention,
  setThreadRunning,
  setThreadWorkDetail,
  threadStatus,
  threadStatusPriority,
  threadSubject,
} from "@/state/thread-status"
import type { ThreadStatus } from "@/state/thread-status"
import { setComposerHarness } from "@/state/thread-tuning"
import {
  applyThreadEntries,
  rememberThread,
  threadViewingActions,
} from "@/state/thread-viewing"
import { threadsStore, useThreads } from "@/state/thread-store"
import { noteOutcome, retireSubject } from "@/state/notifications"

interface ThreadCatalog {
  ready: boolean
  threads: ThreadRef[]
  activity?: Record<string, ExternalThreadActivity>
}

type ThreadCatalogResponse = ThreadCatalog | ThreadRef[]

function unavailableThreadCatalog(): ThreadCatalog {
  return { ready: false, threads: [] }
}

function normalizeThreadCatalog(
  response: ThreadCatalogResponse
): ThreadCatalog {
  return Array.isArray(response) ? { ready: true, threads: response } : response
}

export {
  threadsStore,
  useThreads,
  activeThreadRefs,
  applyThreadEntries,
  applyThreadRun,
  markThreadReviewed,
  recentThreadActivityDuration,
  sameThreadStatus,
  setComposerHarness,
  setThreadAttention,
  setThreadRunning,
  setThreadWorkDetail,
  threadStatus,
  threadStatusPriority,
  withConversion,
}
export type { ThreadStatus }

export function applyThreadRef(ref: ThreadRef) {
  const current = threadsStore.get().threads
  const at = current.findIndex((entry) => entry.path === ref.path)
  const previous = at === -1 ? undefined : current[at]
  const updatedAt = ref.updatedAt ? Date.parse(ref.updatedAt) : Number.NaN
  const recentlyAdded =
    at === -1 &&
    Number.isFinite(updatedAt) &&
    Date.now() - updatedAt < OBSERVED_IDLE_MS
  const advanced = Boolean(
    previous &&
    ((ref.bytes ?? 0) > (previous.bytes ?? 0) ||
      ref.updatedAt !== previous.updatedAt)
  )
  if (ref.active !== undefined) clearObserved(ref.path)
  else if (recentlyAdded || advanced) markObserved(ref.path)
  const next =
    at === -1
      ? [...current, ref]
      : current.map((entry, index) => (index === at ? ref : entry))
  next.sort((left, right) =>
    (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "")
  )
  applyThreads(next, threadsStore.get().loaded)
  const viewing = threadsStore.get().viewing
  if (viewing?.ref.path === ref.path) {
    const updated = { ...viewing, ref }
    threadsStore.set({ viewing: updated })
    rememberThread(updated)
  }
}

/**
 * Activity seen in another app is an outcome too. A Claude Code or OpenCode
 * session that starts waiting for input in a terminal asks you just as a
 * live one does (the registry and the plugin report it, keyed by `since`);
 * a working session that settles to open has finished a turn. A session
 * whose process vanished says nothing: an exit is not an answer.
 */
function noteExternalOutcome(
  path: string,
  previous: ExternalThreadActivity | undefined,
  activity: ExternalThreadActivity | null
): void {
  const provider = activity?.provider ?? previous?.provider
  if (!provider) return
  const subject = threadSubject(path, provider)
  if (activity?.status === "needs-input") {
    if (previous?.status !== "needs-input")
      noteOutcome({
        kind: "ask",
        subject,
        marker: `external:${activity.since}`,
        detail: activity.detail,
      })
    return
  }
  if (previous?.status === "needs-input") retireSubject(subject.id, "ask")
  if (activity?.status === "active") {
    if (previous?.status !== "active") retireSubject(subject.id)
    return
  }
  // Activity inferred from writes settles whenever the agent pauses (a long
  // command, a slow model); only a process's own word on a turn is an answer.
  if (
    previous?.status === "active" &&
    previous.evidence !== "writes" &&
    activity?.status === "open"
  )
    noteOutcome({ kind: "ready", subject, marker: `external:${previous.since}` })
}

export function applyThreadActivity(
  path: string,
  activity: ExternalThreadActivity | null
): void {
  const current = threadsStore.get().externalActivity[path]
  if (
    current?.provider === activity?.provider &&
    current?.since === activity?.since &&
    current?.status === activity?.status &&
    current?.detail === activity?.detail
  )
    return
  if (activity) clearObserved(path)
  const externalActivity = { ...threadsStore.get().externalActivity }
  if (activity) externalActivity[path] = activity
  else delete externalActivity[path]
  threadsStore.set({ externalActivity })
  noteExternalOutcome(path, current, activity)
}

export function applyThreadRemoved(path: string) {
  clearObserved(path)
  applyThreadActivity(path, null)
  setThreadRunning(path, false)
  setThreadAttention(path, null)
  applyThreads(
    threadsStore.get().threads.filter((entry) => entry.path !== path)
  )
}

export function applyThreads(list: ThreadRef[], loaded = true) {
  const initialHydration = loaded && !threadsStore.get().loaded
  const unique = threadList(list)
  threadsStore.set({ threads: unique, loaded })
  if (initialHydration) seedRecentThreadActivity(unique)
}

// A host older than this window fails the descriptor call like every other
// channel it predates — and a silent `[]` then routes every send down the
// headless native path. A restart rides the reconnect banner instead.
let staleHostWarned = false

async function harnessDescriptors(): Promise<HarnessDescriptor[]> {
  try {
    return await getMako().harnessDescriptors()
  } catch (error) {
    if (
      !staleHostWarned &&
      error instanceof Error &&
      /unknown mako host method|newer shared host/i.test(error.message) &&
      !isHostReconnectingError(error)
    ) {
      staleHostWarned = true
      toast.error(
        "The connected Mako host is running an older build — restart it to pick up the current one."
      )
    }
    return []
  }
}

const threadCatalogActions = {
  /**
   * What each live driver offers a new session — its access ladder, its
   * steering kind, whether it resumes. A provider whose transport just
   * changed (Cursor signing its SDK in or out) offers a different ladder, so
   * the host's `provider-connections` push re-asks for exactly this.
   */
  async refreshCapabilities() {
    if (!hasBridge()) return
    threadsStore.set({ descriptors: await harnessDescriptors() })
  },

  async load() {
    if (!hasBridge()) return
    const [raw, descriptors]: [ThreadCatalogResponse, HarnessDescriptor[]] =
      await Promise.all([
        getMako().threads().catch(unavailableThreadCatalog),
        harnessDescriptors(),
      ])
    const nativeRequests = await getMako()
      .nativeRequests()
      .catch(() => [])
    threadsStore.set({ nativeRequests })
    // An engine one vintage older answers with a bare array; treat it as
    // ready rather than spinning forever against the shape difference.
    const result = normalizeThreadCatalog(raw)
    threadsStore.set({ descriptors })
    applyThreads(result.threads, result.ready)
    if (result.activity) threadsStore.set({ externalActivity: result.activity })
    // The catalog scans for a moment at boot, and its "here is the list"
    // push can fire while the window is still loading — a lossy first
    // handshake. Retrying until the host says ready is what makes the rail
    // reliable rather than usually-fine.
    if (!result.ready) {
      setTimeout(() => void threadCatalogActions.load(), 1500)
    }
  },
}

export const threads = {
  ...threadCatalogActions,
  ...threadViewingActions,
  ...threadContinuationActions,
}
