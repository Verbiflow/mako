import type { ThreadRef } from "@mako/sessions"
import { threadIdentity } from "@mako/sessions"
import type { ExternalThreadActivity } from "./contracts/host-events-boot.js"
import type { ProviderActivitySession } from "./providers/process-probe.js"

/**
 * A store written this recently, while a process holds it open or another
 * host holds the session, is a running turn. Cursor's and Grok's probes can
 * only say "open" (lsof sees the store, not the turn), and a turn in the
 * other Mako host has no process this one can ask; without this a reopened
 * client drew a hollow ring beside a thread that was visibly streaming.
 * The window covers a tool call of ordinary length: an agent writes nothing
 * while its shell command runs, and a 20 s window once showed a streaming
 * session as merely open every time it waited on a build.
 */
export const WRITE_ACTIVE_MS = 45_000

export type ActivityRef = Pick<ThreadRef, "path" | "harness" | "nativeId" | "identity">

export interface ActivityIndex {
  refs: ActivityRef[]
  byPath: Map<string, ActivityRef>
  byIdentity: Map<string, ActivityRef>
}

export function indexActivityRefs(refs: Iterable<ThreadRef>): ActivityIndex {
  const slim: ActivityRef[] = []
  for (const ref of refs)
    slim.push({ path: ref.path, harness: ref.harness, nativeId: ref.nativeId, identity: ref.identity })
  // Keyed by the provider's identity, so a store that shares a native id
  // with another (a Cursor chats fork) does not shadow it here either.
  return {
    refs: slim,
    byPath: new Map(slim.map((ref) => [ref.path, ref])),
    byIdentity: new Map(slim.map((ref) => [threadIdentity(ref), ref])),
  }
}

function refForNativeId(
  provider: string,
  nativeId: string,
  index: ActivityIndex
): ActivityRef | undefined {
  const direct = index.byIdentity.get(`${provider}:${nativeId}`)
  if (direct) return direct
  const candidates = index.refs.filter(
    (ref) =>
      ref.harness === provider &&
      (ref.nativeId.startsWith(nativeId) || nativeId.startsWith(ref.nativeId))
  )
  return candidates.length === 1 ? candidates[0] : undefined
}

export interface ActivityInputs {
  index: ActivityIndex
  /** Each provider probe's latest snapshot. */
  probes: Iterable<[provider: string, sessions: ProviderActivitySession[]]>
  /** When each store last visibly moved; entries older than `WRITE_ACTIVE_MS` are ignored. */
  writes: ReadonlyMap<string, number>
  /** Whether another host holds the session; asked only for recently written stores. */
  heldElsewhere: (ref: ActivityRef) => boolean
  previous: ReadonlyMap<string, ExternalThreadActivity>
  now: number
}

/**
 * What each catalogued thread is doing outside this host, keyed by path.
 * `since` is kept from `previous` while nothing about the activity changed.
 */
export function deriveActivity(inputs: ActivityInputs): Map<string, ExternalThreadActivity> {
  const { index, previous, now } = inputs
  const written = new Set<string>()
  for (const [path, at] of inputs.writes) if (now - at < WRITE_ACTIVE_MS) written.add(path)
  const next = new Map<string, ExternalThreadActivity>()
  const place = (
    path: string,
    provider: string,
    session: ProviderActivitySession,
    evidence?: "writes"
  ) => {
    const before = previous.get(path)
    const unchanged =
      before?.provider === provider &&
      before.status === session.status &&
      before.detail === session.detail &&
      before.evidence === evidence
    const activity: ExternalThreadActivity = {
      provider,
      since: unchanged ? before.since : now,
      status: session.status,
      detail: session.detail,
      evidence,
    }
    const held = next.get(path)
    if (
      !held ||
      activity.status === "needs-input" ||
      (held.status === "open" && activity.status === "active")
    )
      next.set(path, activity)
  }
  for (const [provider, sessions] of inputs.probes) {
    for (const session of sessions) {
      const ref =
        (session.path ? index.byPath.get(session.path) : undefined) ??
        (session.nativeId ? refForNativeId(provider, session.nativeId, index) : undefined)
      if (!ref) continue
      if (session.status === "open" && written.has(ref.path))
        place(ref.path, provider, { ...session, status: "active" }, "writes")
      else place(ref.path, provider, session)
    }
  }
  // A session another host holds has no process to probe here; its writes
  // are the only word on whether it is running.
  for (const path of written) {
    if (next.has(path)) continue
    const ref = index.byPath.get(path)
    if (!ref || !inputs.heldElsewhere(ref)) continue
    place(path, ref.harness, { path, status: "active" }, "writes")
  }
  return next
}

export function sameActivity(
  left: ExternalThreadActivity | undefined,
  right: ExternalThreadActivity | undefined
): boolean {
  return (
    left?.provider === right?.provider &&
    left?.status === right?.status &&
    left?.detail === right?.detail &&
    left?.evidence === right?.evidence
  )
}
