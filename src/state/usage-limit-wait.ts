import type { LiveRequest } from "@/lib/types"
import { holdOf } from "@mako/host/contracts/request-hold"

/** The exact local queue row whose automatic send waits on a usage limit. */
export function usageLimitWait(requests: readonly LiveRequest[]): { request: LiveRequest; at: number; resets: boolean } | undefined {
  let byId: Map<string, LiveRequest> | undefined
  for (const request of requests) {
    const hold = holdOf(request)
    if (hold?.kind === "retry" && hold.retry.cause === "rate-limited")
      return { request, at: hold.retry.at, resets: hold.retry.until !== undefined }
    if (hold?.kind === "until") {
      byId ??= new Map(requests.map(row => [row.id, row]))
      if (byId.get(hold.wake.after)?.failure === "rate-limited") return { request, at: hold.wake.at, resets: true }
    }
  }
  return undefined
}

/** Only the failure chain this live wait carries; unrelated failures keep their recovery. */
export function usageLimitSources(requests: readonly LiveRequest[]): ReadonlySet<string> {
  const ids = new Set<string>()
  let request = usageLimitWait(requests)?.request
  if (!request) return ids
  const byId = new Map(requests.map(row => [row.id, row]))
  while (request && !ids.has(request.id)) {
    ids.add(request.id)
    request = request.continues ? byId.get(request.continues.requestId) : request.wake ? byId.get(request.wake.after) : undefined
  }
  return ids
}
