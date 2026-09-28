import { z } from "zod"

export const ThreadTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("live"), id: z.string().uuid() }),
  z.object({ kind: z.literal("file"), path: z.string().min(1) }),
  z.object({ kind: z.literal("native"), provider: z.string().min(1), nativeId: z.string().min(1) }),
])
export type ThreadTarget = z.infer<typeof ThreadTargetSchema>
export const ArchiveCommandSchema = z.object({ id: z.string().uuid(), target: ThreadTargetSchema, archived: z.boolean() })
export type ArchiveCommand = z.infer<typeof ArchiveCommandSchema>
export interface ThreadArchiveSnapshot { revision: number; keys: string[] }
export const StopTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("live"), id: z.string().uuid(), requestId: z.string().uuid() }),
  z.object({ kind: z.literal("native"), path: z.string(), token: z.string().uuid() }),
])
export type StopTarget = z.infer<typeof StopTargetSchema>
export interface ThreadControls { archived: boolean; stop: StopTarget | null; external: boolean }
export function threadArchiveKey(target: ThreadTarget): string {
  if (target.kind === "live") return `live:${target.id}`
  if (target.kind === "file") return `file:${target.path}`
  return `native:${JSON.stringify([target.provider, target.nativeId])}`
}
/** A harness's own archive of a Session, as the Session's row reports it. */
export interface NativeArchive {
  nativeArchived?: boolean
  /** Tells this archive from a later one, where the harness records that (digits only). */
  nativeArchiveStamp?: string
}
/**
 * Marks a Session its harness archived as restored in Mako all the same.
 * With a stamp the marker covers that one archive: archiving again in the
 * harness archives it here too, even if Mako never saw it come out.
 */
export function threadShownKey(key: string, stamp?: string): string {
  return stamp ? `shown@${stamp}:${key}` : `shown:${key}`
}
/** The archive key a restore marker is for, or undefined for any other key. */
export function shownKeyOf(marker: string): string | undefined {
  if (marker.startsWith("shown:")) return marker.slice("shown:".length)
  return /^shown@\d+:(.+)$/s.exec(marker)?.[1]
}
/**
 * Whether a Session sits with the archived ones: Mako archived it, or its
 * harness did and nobody restored it here since.
 */
export function archivedByKeys(keys: readonly string[], hidden: ReadonlySet<string>, archive: NativeArchive | undefined): boolean {
  if (keys.some((key) => hidden.has(key))) return true
  if (!archive?.nativeArchived) return false
  return !keys.some((key) => hidden.has(threadShownKey(key, archive.nativeArchiveStamp)))
}
/**
 * Restore markers a Session's current row makes stale: every one once the
 * harness no longer archives it, and those for an earlier archive when it
 * does. `markers` maps each archive key to the markers written for it.
 */
export function staleShownMarkers(keys: readonly string[], archive: NativeArchive, markers: ReadonlyMap<string, readonly string[]>): string[] {
  const stale: string[] = []
  for (const key of keys) {
    const current = archive.nativeArchived ? threadShownKey(key, archive.nativeArchiveStamp) : undefined
    for (const marker of markers.get(key) ?? []) if (marker !== current) stale.push(marker)
  }
  return stale
}
