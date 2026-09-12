import type { RelayWorkerStatus } from "@mako/relay"

/**
 * The relay as the desk can describe it. The backend's health endpoint
 * answering says nothing about whether this Mac is actually leasing work;
 * this does.
 */
export type RelayPresence =
  | { kind: "disabled"; reason: string }
  | { kind: "starting" }
  | {
      kind: "worker"
      deviceName: string
      status: RelayWorkerStatus
      /** The project a new remote request would run in, when one is known. */
      workspace: string | null
    }

function ago(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1_000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  return `${Math.round(minutes / 60)}h ago`
}

function inFuture(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((Date.parse(iso) - now) / 1_000))
  return seconds < 60 ? `${seconds}s` : `${Math.round(seconds / 60)}m`
}

/** Three consecutive failures is a broken relay, not a slow poll. */
export function relayIsFailing(presence: RelayPresence): boolean {
  return (
    presence.kind === "worker" && presence.status.consecutiveFailures >= 3
  )
}

export function describeRelayPresence(
  presence: RelayPresence,
  now = Date.now()
): string {
  if (presence.kind === "disabled") return `Relay off: ${presence.reason}`
  if (presence.kind === "starting") return "Relay starting"
  const { status, deviceName, workspace } = presence
  if (status.currentJob)
    return `Relay running a ${status.currentJob.kind} job since ${ago(status.currentJob.startedAt, now)} on ${deviceName}`
  if (relayIsFailing(presence) && status.lastFailure)
    return `Relay failing: ${status.lastFailure.phase} — ${status.lastFailure.message} (${status.consecutiveFailures} attempts${status.nextPollAt ? `, retrying in ${inFuture(status.nextPollAt, now)}` : ""})`
  if (status.phase === "stopped") return "Relay stopped"
  const parts = [`Relay listening as ${deviceName}`]
  if (status.lastPollAt) parts.push(`checked ${ago(status.lastPollAt, now)}`)
  if (status.jobsCompleted > 0)
    parts.push(
      `${status.jobsCompleted} ${status.jobsCompleted === 1 ? "job" : "jobs"} completed`
    )
  parts.push(
    workspace
      ? `new requests run in ${workspace}`
      : "new requests run in your home directory"
  )
  return parts.join(" · ")
}
