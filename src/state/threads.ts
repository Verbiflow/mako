import type { LiveCapability } from "@/lib/types"
import { getMako, hasBridge } from "@/lib/bridge"
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

export function uniqueThreadRefs(list: ThreadRef[]) {
  const byIdentity = new Map<string, ThreadRef>()
  for (const ref of list) {
    // A provider may say one native id names two distinct stores (a Cursor
    // session continued by the CLI into chats/); those stay separate rows.
    const key = `${ref.harness}:${ref.identity ?? ref.nativeId}`
    const held = byIdentity.get(key)
    if (
      !held ||
      (held.archived && !ref.archived) ||
      (Boolean(held.archived) === Boolean(ref.archived) &&
        (ref.updatedAt ?? "") > (held.updatedAt ?? ""))
    )
      byIdentity.set(key, ref)
  }
  return [...byIdentity.values()].sort((left, right) =>
    (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "")
  )
}

export function applyThreads(list: ThreadRef[], loaded = true) {
  const initialHydration = loaded && !threadsStore.get().loaded
  const unique = uniqueThreadRefs(list)
  threadsStore.set({ threads: unique, loaded })
  if (initialHydration) seedRecentThreadActivity(unique)
}

let focusRefetch = false

const threadCatalogActions = {
  /** Re-ask on window focus: cheap, and heals any missed push for good. */
  watchFocus() {
    if (focusRefetch || globalThis.window === undefined) return
    focusRefetch = true
    window.addEventListener("focus", () => void threadCatalogActions.load())
  },

  async load() {
    if (!hasBridge()) return
    const [raw, resumable, targets, capabilities]: [
      ThreadCatalogResponse,
      string[],
      string[],
      LiveCapability[],
    ] = await Promise.all([
      getMako().threads().catch(unavailableThreadCatalog),
      getMako()
        .resumableHarnesses()
        .catch((): string[] => []),
      getMako()
        .continueTargets()
        .catch((): string[] => []),
      getMako()
        .liveCapabilities()
        .catch((): LiveCapability[] => []),
    ])
    const nativeRequests = await getMako()
      .nativeRequests()
      .catch(() => [])
    threadsStore.set({ nativeRequests })
    // An engine one vintage older answers with a bare array; treat it as
    // ready rather than spinning forever against the shape difference.
    const result = normalizeThreadCatalog(raw)
    threadsStore.set({
      resumable,
      targets,
      liveCapabilities: capabilities,
      acpable: capabilities.map((item) => item.provider),
    })
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
