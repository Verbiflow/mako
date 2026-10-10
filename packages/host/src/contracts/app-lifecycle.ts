import { z } from "zod"

export const BuildIdentitySchema = z.object({
  id: z.string().regex(/^[a-f0-9]{12,64}$/),
  builtAt: z.iso.datetime(),
  revision: z
    .string()
    .regex(/^[a-f0-9]{7,40}$/)
    .nullable(),
  dirty: z.boolean(),
})
export type BuildIdentity = z.infer<typeof BuildIdentitySchema>
export const LifecycleWorkSchema = z.object({
  id: z.string(),
  token: z.string(),
  title: z.string(),
  provider: z.string(),
  cwd: z.string(),
  status: z.enum(["running", "waiting", "queued", "finishing"]),
  stoppable: z.boolean(),
})
export type LifecycleWork = z.infer<typeof LifecycleWorkSchema>
export const LifecycleActionSchema = z.enum(["quit", "install", "restart"])
export type LifecycleAction = z.infer<typeof LifecycleActionSchema>
export const LifecycleStateSchema = z.object({
  work: z.array(LifecycleWorkSchema),
  revision: z.string(),
  operation: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("idle") }),
    z.object({ kind: z.literal("waiting"), action: LifecycleActionSchema }),
    z.object({ kind: z.literal("stopping"), action: LifecycleActionSchema }),
    z.object({ kind: z.literal("applying"), action: LifecycleActionSchema }),
    z.object({
      kind: z.literal("error"),
      action: LifecycleActionSchema,
      message: z.string(),
    }),
  ]),
})
export type LifecycleState = z.infer<typeof LifecycleStateSchema>
export const LifecycleCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("cancel") }),
  z.object({ kind: z.literal("wait"), action: LifecycleActionSchema }),
  z.object({
    kind: z.literal("stop"),
    action: LifecycleActionSchema,
    revision: z.string(),
  }),
])
export type LifecycleCommand = z.infer<typeof LifecycleCommandSchema>
export type LocalBuildState =
  | { kind: "idle" }
  | {
      kind: "building"
      phase: "copying" | "compiling" | "checking" | "packaging" | "verifying"
    }
  | { kind: "ready"; build: BuildIdentity }
  | { kind: "error"; message: string }
export interface UpdateInstallation {
  distribution: "development" | "local" | "signed" | "unsigned"
  build: BuildIdentity | null
  source: string | null
  local: LocalBuildState
}
