import type { ThreadRef } from "@mako/sessions"
import { plainRecordPath } from "@mako/sessions/record-encoding"

export interface NativeSourceIdentity {
  harness: string
  nativeId?: string
  nativePath?: string
}

/**
 * Catalog evidence only: preserve an exact source, never choose the first ID
 * collision. The same file under another encoding is still the exact source,
 * as when Codex compresses an idle rollout in place.
 */
export function nativeSessionPath(identity: NativeSourceIdentity, refs: readonly ThreadRef[]): string | undefined {
  if (!identity.nativeId) return undefined
  const candidates = refs.filter(ref => ref.harness === identity.harness && ref.nativeId === identity.nativeId && !ref.archived && ref.liveResume !== false)
  const recorded = identity.nativePath
  if (recorded) {
    if (candidates.some(ref => ref.path === recorded)) return recorded
    const place = plainRecordPath(recorded)
    const moved = candidates.find(ref => plainRecordPath(ref.path) === place)
    if (moved) return moved.path
  }
  const paths = new Set(candidates.map(ref => ref.path))
  return paths.size === 1 ? paths.values().next().value : undefined
}
