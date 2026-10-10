import { z } from "zod"
import { ForkInputSchema } from "./conversation-control.js"

export const WorkspaceSnapshotSchema = z.object({
  id: z.string().uuid(),
  scope: z.string(),
  createdAt: z.number(),
  files: z.number().int().nonnegative(),
})
export type WorkspaceSnapshot = z.infer<typeof WorkspaceSnapshotSchema>
export const RunSnapshotsSchema = z.object({
  before: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("ready"), snapshot: WorkspaceSnapshotSchema }),
    z.object({ kind: z.literal("unavailable"), reason: z.string() }),
  ]),
  after: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("ready"), snapshot: WorkspaceSnapshotSchema }),
      z.object({ kind: z.literal("unavailable"), reason: z.string() }),
    ])
    .optional(),
})
export type RunSnapshots = z.infer<typeof RunSnapshotsSchema>
export const RewindPlanSchema = z.object({
  sourceId: z.string().uuid(),
  fork: ForkInputSchema,
  targetId: z.string().uuid(),
  expectedId: z.string().uuid(),
})
export type RewindPlan = z.infer<typeof RewindPlanSchema>
export const RewindInputSchema = z.object({
  id: z.string().uuid(),
  requestId: z.string().uuid(),
  position: z.enum(["before", "after"]).optional(),
  expectedId: z.string().uuid(),
})
export type RewindInput = z.infer<typeof RewindInputSchema>
export interface RewindPreview {
  target: WorkspaceSnapshot
  current: WorkspaceSnapshot
  changedFiles: string[]
  changedFileCount: number
  stagingChanged: boolean
}
