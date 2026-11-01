import { z } from "zod"
import { ThreadIdSchema } from "./ids.js"

/**
 * What a Session's row says of a continue in the cloud (`continues.ts`): apart from the rest, which composes
 * operations, so the list's schemas take these without importing what imports the list.
 */

/** Where a continue stands. */
export const ContinuePhaseSchema = z.enum(["making", "arriving", "continued", "failed"])
export type ContinuePhase = z.infer<typeof ContinuePhaseSchema>

/** The longest reason a failed continue says. */
export const CONTINUE_REASON_MAX = 2_000

/**
 * A continue as each of its Session's rows says it, the account's own word beside its owner's report (link version 16
 * on): `from`, the device whose Session it is; `by`, the device it was pressed on; `cloudThread`, where it goes.
 */
export const ListedContinueSchema = z
  .object({
    op: z.uuid(),
    phase: ContinuePhaseSchema,
    from: z.uuid(),
    by: z.uuid(),
    cloudThread: ThreadIdSchema,
    at: z.iso.datetime(),
    reason: z.string().max(CONTINUE_REASON_MAX).optional(),
  })
  .strip()
export type ListedContinue = z.infer<typeof ListedContinueSchema>

/** The repository a continued Thread's machine clones: the device's origin on GitHub, at the branch it last pushed. */
export const ContinueRepositorySchema = z
  .object({
    url: z.string().max(200).regex(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    branch: z.string().min(1).max(250).optional(),
  })
  .strict()
export type ContinueRepository = z.infer<typeof ContinueRepositorySchema>
