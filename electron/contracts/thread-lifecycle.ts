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
/** Marks a Session its harness archived as restored in Mako all the same. */
export function threadShownKey(key: string): string {
  return `shown:${key}`
}
/**
 * Whether a Session sits with the archived ones: Mako archived it, or its
 * harness did and nobody restored it here.
 */
export function archivedByKeys(keys: readonly string[], hidden: ReadonlySet<string>, nativeArchived: boolean | undefined): boolean {
  if (keys.some((key) => hidden.has(key))) return true
  return Boolean(nativeArchived) && !keys.some((key) => hidden.has(threadShownKey(key)))
}
