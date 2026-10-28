import { z } from "zod"

export const ThreadTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("live"), id: z.string().uuid() }),
  z.object({ kind: z.literal("file"), path: z.string().min(1) }),
  z.object({ kind: z.literal("native"), provider: z.string().min(1), nativeId: z.string().min(1) }),
])
export type ThreadTarget = z.infer<typeof ThreadTargetSchema>
/**
 * `anyway`: archive a cloud Thread whose machine can't start all the same. Its records are kept; its checkout's changes
 * since it last moved can't be, and it can't be restored.
 */
export const ArchiveCommandSchema = z.object({ id: z.string().uuid(), target: ThreadTargetSchema, archived: z.boolean(), anyway: z.literal(true).optional() })
export type ArchiveCommand = z.infer<typeof ArchiveCommandSchema>
/**
 * The keys of the Sessions archived, as this device shows them: those it archived of its own, and those of the cloud
 * Threads its account archived, which it reads from the account and never keeps.
 */
export interface ThreadArchiveSnapshot { revision: number; keys: string[] }

/**
 * How archiving or restoring a cloud Thread went, by the cloud Thread. `refused`: nothing changed, and `reason` says
 * why in the person's words; `anyway`, when its machine couldn't start, offers to archive it all the same.
 */
export type CloudArchiveOutcome =
  | { kind: "archived"; thread: string }
  | { kind: "restored"; thread: string }
  | { kind: "refused"; thread: string; reason: string; anyway?: true }
/** What an archive command answers: the archive keys as they stand, and how a cloud Thread's archive went, if it was one. */
export type ArchiveAnswer = ThreadArchiveSnapshot & { cloud?: CloudArchiveOutcome }
/**
 * A cloud Thread's archive or restore going on, step by step, for the window that asked: its machine packing, its
 * machine ending, or its checkout and records arriving here.
 */
export type CloudArchiveStep = { thread: string; kind: "packing" | "ending" | "bringing" }
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
