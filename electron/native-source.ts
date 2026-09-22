import type { ThreadRef } from "@mako/sessions"

export interface NativeSourceIdentity {
  harness: string
  nativeId?: string
  nativePath?: string
}

/** Catalog evidence only: preserve an exact source, never choose the first ID collision. */
export function nativeSessionPath(identity: NativeSourceIdentity, refs: readonly ThreadRef[]): string | undefined {
  if (!identity.nativeId) return undefined
  const candidates = refs.filter(ref => ref.harness === identity.harness && ref.nativeId === identity.nativeId && !ref.archived && ref.liveResume !== false)
  if (identity.nativePath && candidates.some(ref => ref.path === identity.nativePath)) return identity.nativePath
  const paths = new Set(candidates.map(ref => ref.path))
  return paths.size === 1 ? paths.values().next().value : undefined
}
