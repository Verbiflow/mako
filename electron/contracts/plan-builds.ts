import { z } from "zod"

/**
 * Plans the user built, by plan id, so a plan card says it was built and
 * where in every window and on every computer connected to this host. A plan
 * counts as built when its implementation request was sent or its native plan
 * approval was answered with the approval's own choice; a new session opened
 * with the plan in its draft is not built until that draft is sent.
 */
export const PlanBuildSchema = z.object({
  at: z.number(),
  /** The live conversation the implementation went to. */
  conversation: z.string().optional(),
  /** The thread it went to, when it was not a live conversation. */
  thread: z.string().optional(),
})
export type PlanBuild = z.infer<typeof PlanBuildSchema>

export const PlanBuildTargetSchema = PlanBuildSchema.omit({ at: true })
export type PlanBuildTarget = z.infer<typeof PlanBuildTargetSchema>

/** A Build click's claim on a plan; it loses to a build made since the plan was last seen. */
export type PlanBuildClaim =
  | { claimed: true; build: PlanBuild }
  | { claimed: false; current: PlanBuild | undefined }

export const PlanBuildsSchema = z.record(z.string(), PlanBuildSchema)
export type PlanBuilds = z.infer<typeof PlanBuildsSchema>

/** The newest builds the host keeps. */
export const MAX_PLAN_BUILDS = 200
