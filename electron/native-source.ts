import { realpath } from "node:fs/promises"
import type { ProviderLiveDriver } from "./providers/live-driver.js"
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

/** Adapters split native DB locators; shared policy only compares their keys
 * and canonical files. A pathname alias never changes a native record ID. */
export async function sameNativeSource(driver: ProviderLiveDriver, left: string, right: string, nativeId: string | undefined): Promise<boolean> {
  const a = nativeRecord(driver, left, nativeId)
  const b = nativeRecord(driver, right, nativeId)
  if (!a || !b || a.record !== b.record) return false
  if (a.path === b.path) return true
  const paths = await Promise.all([realpath(a.path).catch(() => undefined), realpath(b.path).catch(() => undefined)])
  return paths[0] !== undefined && paths[0] === paths[1]
}

/** The record `path` names for `nativeId`: the file itself unless the adapter keeps many sessions in one store. */
export function nativeRecord(driver: Pick<ProviderLiveDriver, "nativeSource"> | undefined, path: string, nativeId: string | undefined): { path: string; record: string } | undefined {
  return driver?.nativeSource ? driver.nativeSource(path, nativeId) : { path, record: "file" }
}
