import type { HarnessDescriptor } from "@/lib/types"
import { getMako, hasBridge } from "@/lib/bridge"
import { isHostReconnectingError } from "@mako/host/contracts/host-connection"
import { internalReviewSession, listedAsThread, sameNativeSession, threadList } from "@mako/host/contracts/thread-list"
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
  retireInternalReview,
  threadViewingActions,
} from "@/state/thread-viewing"
import { nativeSessionRefs, threadsStore, useThreads } from "@/state/thread-store"
import { followThreadMoves } from "@/state/thread-moves"
import { noteOutcome, noticeId, retireNotice, retireSubject } from "@/state/notifications"
import { offerWindowRenames } from "@/state/thread-titles"
import { inboxView } from "@/state/inbox-view"

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

/** The Sessions that are a conversation's background agents: shown under it, never a Thread of their own, so nothing of theirs notifies. */
const helpers = new Set<string>()
/** What an app outside Mako last asked the person, by its Thread's path: the notice it was said as. */
const externalAsks = new Map<string, string>()

function noteHelpers(list: readonly ThreadRef[]): void {
  for (const ref of list) {
    if (listedAsThread(ref)) helpers.delete(ref.path)
    else helpers.add(ref.path)
  }
}

export function applyThreadRef(ref: ThreadRef) {
  ref = nativeSessionRefs.observe(ref)
  if (retireInternalReview(ref)) {
    if (nativeSessionRefs.owns(ref)) noteHelpers([ref])
    const current = threadsStore.get().threads
    if (current.some(candidate => sameNativeSession(nativeSessionRefs.classify(candidate), ref)))
      applyThreads(current.filter(candidate => !sameNativeSession(nativeSessionRefs.classify(candidate), ref)))
    return
  }
  noteHelpers([ref])
  if (helpers.has(ref.path)) {
    clearObserved(ref.path)
    if (threadsStore.get().threads.some((entry) => entry.path === ref.path)) applyThreadRemoved(ref.path)
    followViewedRef(ref)
    return
  }
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
  followViewedRef(ref)
}

/** A Session still opening, or whose last read failed, is described by its newest row too: the composer reads where it works from this ref. */
function followViewedRef(ref: ThreadRef): void {
  const { viewing, opening } = threadsStore.get()
  if (opening?.ref.path === ref.path && sameNativeSession(opening.ref, ref)) threadsStore.set({ opening: { ...opening, ref } })
  if (viewing?.ref.path === ref.path && sameNativeSession(viewing.ref, ref)) {
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
  if (!provider || helpers.has(path)) return
  const subject = threadSubject(path, provider)
  if (activity?.status === "needs-input") {
    if (previous?.status !== "needs-input") {
      const marker = `external:${activity.since}`
      externalAsks.set(path, noticeId(subject, "needs-you", marker))
      noteOutcome({ kind: "needs-you", subject, marker, detail: activity.detail })
    }
    return
  }
  // What it asked goes by its own notice once it no longer waits on the person.
  const asked = externalAsks.get(path)
  if (asked) {
    externalAsks.delete(path)
    retireNotice(asked)
  }
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
    noteOutcome({ kind: "finished", subject, marker: `external:${previous.since}` })
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
  const { threads: previous, loaded: wasLoaded } = threadsStore.get()
  const initialHydration = loaded && !wasLoaded
  const observed = list.map(ref => nativeSessionRefs.observe(ref))
  for (const ref of observed) retireInternalReview(ref)
  const previousByPath = new Map(previous.map(ref => [ref.path, ref]))
  const candidates = observed.map(ref => {
    const held = nativeSessionRefs.version(ref.path)?.ref ?? previousByPath.get(ref.path)
    return internalReviewSession(ref) && held && !sameNativeSession(held, ref) ? held : ref
  })
  noteHelpers(candidates)
  const unique = threadList(candidates)
  threadsStore.set({ threads: unique, loaded })
  followThreadMoves(previous, unique)
  offerWindowRenames(unique)
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
  /** The person's open action; background reader recovery uses threadViewingActions directly. */
  view(ref: ThreadRef, mode?: "conversation" | "native") {
    inboxView.close()
    return threadViewingActions.view(ref, mode)
  },
}
