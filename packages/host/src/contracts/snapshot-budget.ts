import { z } from "zod"

export const SnapshotBudgetSettingsSchema = z.object({
  mode: z.enum(["preview", "evict"]),
  maxBytes: z.number().int().min(1024 ** 2).max(1024 ** 5),
}).strict()
export type SnapshotBudgetSettings = z.infer<typeof SnapshotBudgetSettingsSchema>
/** Evidence read from the owning conversation journals, not file age. */
export interface SnapshotSettlement {
  valid: boolean
  settledIds: string[]
  blockedScopes: string[]
}
export interface SnapshotBudgetEntry {
  id: string
  scope: string
  createdAt: number
  bytes: number
  eligible: boolean
  reason: string
  selected: boolean
  removed?: boolean
}
export interface SnapshotBudgetReport {
  settings: SnapshotBudgetSettings
  at: number
  payloadBytes: number
  selectedBytes: number
  untrackedBytes: number
  inventoryKnown: boolean
  remainingBytes: number
  entries: SnapshotBudgetEntry[]
}
