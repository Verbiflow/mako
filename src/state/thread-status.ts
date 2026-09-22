import { toast } from "sonner"
import { acpForThread, acpStore } from "@/state/acp-state"
import type { ThreadRef, ThreadRunState } from "@/lib/types"
import { harnessLabel } from "@/lib/harness-label"
import { workspaceName } from "@/lib/format"
import {
  noteOutcome,
  retireSubject,
  subjectId,
  subjectWorkspace,
  type NotificationSubject,
} from "@/state/notifications"
import { prefsStore } from "@/state/prefs"
import type { AttentionByPath, ThreadsState } from "@/state/thread-state"
import { threadsStore } from "@/state/thread-store"

export type ThreadStatus =
  | { kind: "idle" }
  | { kind: "working"; since: number; detail?: string }
  | { kind: "needs-permission"; since: number; detail?: string }
  | { kind: "failed"; at: number; detail?: string }
  | { kind: "review"; at: number; unread: boolean }
  | { kind: "observed" }
  | { kind: "external-open"; app: string }
  | { kind: "external-active"; app?: string }

const IDLE_STATUS: ThreadStatus = { kind: "idle" }
const OBSERVED_STATUS: ThreadStatus = { kind: "observed" }
const EXTERNAL_ACTIVE_STATUS: ThreadStatus = { kind: "external-active" }

/**
 * Field-wise equality for a selector: `threadStatus` allocates for most
 * kinds, and a row that compares by identity re-renders on every catalog
 * event of every other thread.
 */
export function sameThreadStatus(left: ThreadStatus, right: ThreadStatus): boolean {
  if (left === right) return true
  if (left.kind !== right.kind) return false
  switch (left.kind) {
    case "idle":
    case "observed":
      return true
    case "working":
    case "needs-permission":
      return (
        right.kind === left.kind &&
        left.since === right.since &&
        left.detail === right.detail
      )
    case "failed":
      return right.kind === "failed" && left.at === right.at && left.detail === right.detail
    case "review":
      return right.kind === "review" && left.at === right.at && left.unread === right.unread
    case "external-open":
      return right.kind === "external-open" && left.app === right.app
    case "external-active":
      return right.kind === "external-active" && left.app === right.app
  }
}

export function threadStatusPriority(status: ThreadStatus): number {
  switch (status.kind) {
    case "needs-permission":
      return 5
    case "failed":
      return 4
    case "review":
      return status.unread ? 3 : 0
    case "working":
      return 2
    case "observed":
    case "external-active":
      return 1
    case "external-open":
    case "idle":
      return 0
  }
}

export function threadStatus(
  ref: ThreadRef,
  state: ThreadsState = threadsStore.get()
): ThreadStatus {
  const owned = acpForThread(acpStore.get(), ref)
  const attention = state.attention[owned?.threadPath ?? ref.path]
  if (owned?.kind === "live" && owned.session.connection === "connected") {
    if (owned.permission)
      return { kind: "needs-permission", since: owned.updatedAt, detail: owned.permission.title }
    if (owned.session.status === "running" || owned.session.status === "starting")
      return state.working[owned.threadPath ?? ref.path] ?? { kind: "working", since: owned.createdAt }
    // A failure is an outcome you acknowledge by opening the thread, exactly
    // like an unread answer; it is recorded as attention when the session
    // fails (`syncThreadStatus`) and cleared by `markThreadReviewed`. It was
    // once read from the session's own status, which stays `failed` until the
    // next prompt, so a row and its folder's chip wore the red mark for as
    // long as the session existed, whatever you did.
    return attention?.kind === "review" || attention?.kind === "failed"
      ? attention
      : IDLE_STATUS
  }
  if (attention?.kind === "needs-permission") return attention
  const working = state.working[ref.path]
  if (working) return working
  const external = state.externalActivity[ref.path]
  if (external?.status === "needs-input")
    return {
      kind: "needs-permission",
      since: external.since,
      detail: external.detail,
    }
  // A turn another Mako host runs is named by its holder; a process the
  // probe saw is "another app" until the provider says more.
  if (external?.status === "active")
    return ref.heldBy ? { kind: "working", since: external.since } : EXTERNAL_ACTIVE_STATUS
  if (ref.active === true && !external)
    return ref.heldBy ? { kind: "working", since: 0 } : EXTERNAL_ACTIVE_STATUS
  if (attention) return attention
  // A warm agent in another Mako host is still this app. Only external
  // applications get the hollow open-elsewhere ring.
  if (ref.heldBy) return IDLE_STATUS
  if (external?.status === "open") return { kind: "external-open", app: external.provider }
  if (ref.locked) return { kind: "external-open", app: ref.harness }
  if (ref.active === false) return IDLE_STATUS
  return state.observed[ref.path] ? OBSERVED_STATUS : IDLE_STATUS
}

export const OBSERVED_IDLE_MS = 60_000
const observedTimers = new Map<string, ReturnType<typeof setTimeout>>()

export function clearObserved(path: string) {
  const timer = observedTimers.get(path)
  if (timer) clearTimeout(timer)
  observedTimers.delete(path)
  if (!threadsStore.get().observed[path]) return
  const observed = { ...threadsStore.get().observed }
  delete observed[path]
  threadsStore.set({ observed })
}

export function markObserved(path: string, duration = OBSERVED_IDLE_MS) {
  if (threadsStore.get().working[path]) return
  if (!threadsStore.get().observed[path]) {
    threadsStore.set({
      observed: { ...threadsStore.get().observed, [path]: true },
    })
  }
  const held = observedTimers.get(path)
  if (held) clearTimeout(held)
  observedTimers.delete(path)
  observedTimers.set(
    path,
    setTimeout(() => clearObserved(path), Math.max(1, duration))
  )
}

export function recentThreadActivityDuration(
  ref: ThreadRef,
  now = Date.now()
): number | null {
  if (ref.active !== undefined || ref.locked || ref.heldBy || !ref.updatedAt) return null
  const elapsed = now - Date.parse(ref.updatedAt)
  return Number.isFinite(elapsed) && elapsed >= 0 && elapsed < OBSERVED_IDLE_MS
    ? OBSERVED_IDLE_MS - elapsed
    : null
}

export function seedRecentThreadActivity(
  refs: ThreadRef[],
  now = Date.now()
): void {
  for (const ref of refs) {
    const duration = recentThreadActivityDuration(ref, now)
    if (duration !== null) markObserved(ref.path, duration)
  }
}

export function activeThreadRefs(
  refs: ThreadRef[],
  state: ThreadsState = threadsStore.get()
): ThreadRef[] {
  return refs
    .filter((ref) => {
      const status = threadStatus(ref, state)
      return (
        status.kind === "working" ||
        status.kind === "needs-permission" ||
        status.kind === "external-active"
      )
    })
    .sort((left, right) => {
      const priority =
        threadStatusPriority(threadStatus(right, state)) -
        threadStatusPriority(threadStatus(left, state))
      return (
        priority || (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "")
      )
    })
}

/** A native run started, finished, or failed, on any thread. */
export function setThreadRunning(path: string, active: boolean) {
  const current = threadsStore.get().working[path]
  if (Boolean(current) === active) return
  if (active) clearObserved(path)
  const working = { ...threadsStore.get().working }
  if (active) working[path] = { kind: "working", since: Date.now() }
  else delete working[path]
  threadsStore.set({ working })
}

export function setThreadWorkDetail(path: string, detail?: string) {
  const current = threadsStore.get().working[path]
  if (!current || current.detail === detail) return
  threadsStore.set({
    working: {
      ...threadsStore.get().working,
      [path]: { ...current, detail },
    },
  })
}

export function setThreadAttention(
  path: string,
  attention: AttentionByPath[string] | null
) {
  const current = threadsStore.get().attention[path]
  if (!current && !attention) return
  const next = { ...threadsStore.get().attention }
  if (attention) next[path] = attention
  else delete next[path]
  threadsStore.set({ attention: next })
}

/**
 * Opening a thread is how you acknowledge what it has to tell you: an
 * unread answer and a failure both stand down. A pending permission does
 * not; that waits for an answer, not a look.
 */
export function markThreadReviewed(path: string) {
  const kind = threadsStore.get().attention[path]?.kind
  if (kind !== "review" && kind !== "failed") return
  setThreadAttention(path, null)
}

/** A native thread's notification identity, named the way the rail names it. */
export function threadSubject(
  path: string,
  harness: string,
  ref: ThreadRef | undefined = threadsStore.get().threads.find((entry) => entry.path === path)
): NotificationSubject {
  return {
    id: subjectId({ kind: "thread", path }),
    target: { kind: "thread", path },
    title: prefsStore.get().titleOverrides[path] ?? ref?.title ?? workspaceName(ref?.cwd),
    agent: harnessLabel(harness),
    workspace: subjectWorkspace(ref?.cwd),
  }
}

/** The last run status seen per thread, so a repeated event is not a second outcome. */
const lastRunStatus = new Map<string, ThreadRunState["status"]>()

export function applyThreadRun(run: ThreadRunState) {
  const { viewing, nativeRequests } = threadsStore.get()
  const queue = nativeRequests.some(
    (request) => request.input.path === run.path && request.status === "queued"
  )
  const previousRun = lastRunStatus.get(run.path)
  lastRunStatus.set(run.path, run.status)
  if (previousRun !== run.status) {
    const subject = threadSubject(run.path, run.harness)
    if (run.status === "running") retireSubject(subject.id)
    else if (run.status === "done" && !queue)
      noteOutcome({ kind: "ready", subject, marker: `run:${Date.now()}` })
    else if (run.status === "failed")
      noteOutcome({ kind: "failed", subject, marker: `run:${Date.now()}`, detail: run.error })
  }
  setThreadRunning(run.path, run.status === "running")
  if (run.status === "running") setThreadAttention(run.path, null)
  else if (run.status === "done" && !queue)
    setThreadAttention(
      run.path,
      viewing?.ref.path === run.path
        ? null
        : { kind: "review", at: Date.now(), unread: true }
    )
  else if (run.status === "failed")
    setThreadAttention(
      run.path,
      viewing?.ref.path === run.path
        ? null
        : { kind: "failed", at: Date.now(), detail: run.error }
    )
  else setThreadAttention(run.path, null)
  if (viewing && viewing.ref.path === run.path) threadsStore.set({ run })
  if (run.status === "failed" && run.error) toast.error(run.error)
}
