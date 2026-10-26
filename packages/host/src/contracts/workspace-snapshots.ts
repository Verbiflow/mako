import { z } from "zod"
import { ForkInputSchema } from "./conversation-control.js"

export const WorkspaceSnapshotSchema = z.object({
  id: z.string().uuid(),
  scope: z.string(),
  createdAt: z.number(),
  files: z.number().int().nonnegative(),
  /**
   * Other turns (their request ids) that ran in this workspace while this
   * checkpoint's turn did: their edits are in it too, so a rewind to it says
   * whose each changed file is.
   */
  shared: z.array(z.string().min(1).max(200)).max(64).optional(),
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
  /** One repository's share of a rewind across several (a project folder, submodules): the whole rewind's checkpoints and fork, which recovery finishes. */
  whole: z.object({ targetId: z.string().uuid(), expectedId: z.string().uuid(), forkId: z.string().uuid() }).optional(),
})
export type RewindPlan = z.infer<typeof RewindPlanSchema>
export const RewindInputSchema = z.object({
  id: z.string().uuid(),
  requestId: z.string().uuid(),
  position: z.enum(["before", "after"]).optional(),
  expectedId: z.string().uuid(),
})
export type RewindInput = z.infer<typeof RewindInputSchema>
/** Who changed a file since a checkpoint, as the attribution journal knows: a Thread (`sure` when it proved or named the file), the person, or nobody it can name. */
export type RewindWriter = { kind: "thread"; thread: string; sure: boolean } | { kind: "person" } | { kind: "unknown" }
/** Each file's writers since a checkpoint, by its path. */
export type FileWriters = Record<string, RewindWriter[]>

export interface RewindPreview {
  target: WorkspaceSnapshot
  current: WorkspaceSnapshot
  changedFiles: string[]
  changedFileCount: number
  stagingChanged: boolean
  /** Of `changedFiles`, who changed each since the checkpoint; absent while the journal can't say. */
  writers?: FileWriters
}
