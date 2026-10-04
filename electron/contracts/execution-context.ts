import { z } from "zod"

const unavailable = z.object({ kind: z.literal("unavailable"), reason: z.string().min(1) })
export const NativeIdentityCapabilitySchema = z.union([
  z.object({ kind: z.literal("reported"), via: z.string().min(1) }),
  unavailable,
])
export type NativeIdentityCapability = z.infer<typeof NativeIdentityCapabilitySchema>

/** A preflight process scan never establishes a native atomic lease. */
export const NativeExclusionCapabilitySchema = z.union([
  z.object({ kind: z.literal("atomic"), via: z.string().min(1) }),
  unavailable,
])
export type NativeExclusionCapability = z.infer<typeof NativeExclusionCapabilitySchema>
export const NO_NATIVE_EXCLUSION: NativeExclusionCapability = {
  kind: "unavailable",
  reason: "No verified native atomic lease excludes a noncooperating external executor. Preflight activity observations do not prevent another executor from starting later.",
}

/** Observations describe this launch. They are not credentials, a resume grant,
 * or proof that an external process cannot start executing later. */
export const ExecutionContextSchema = z.object({
  transport: z.string().min(1),
  executable: z.string().optional(),
  runtime: z.union([
    z.object({ kind: z.literal("reported"), version: z.string().min(1), via: z.string().min(1) }),
    unavailable,
  ]),
  account: z.union([
    z.object({ kind: z.literal("configured"), name: z.string(), managed: z.boolean() }),
    unavailable,
  ]),
  identity: z.union([
    z.object({ kind: z.literal("pending") }),
    z.object({ kind: z.literal("reported"), principal: z.string().min(1), backend: z.string().min(1), via: z.string().min(1) }),
    z.object({ kind: z.literal("unavailable"), reason: z.string().min(1), backend: z.string().optional() }),
  ]),
  store: z.union([
    z.object({ kind: z.literal("located"), path: z.string().min(1) }),
    unavailable,
  ]),
  /** Receipt from a native import response, never inferred from copy support. */
  sourceImport: z.object({ source: z.string().min(1), destination: z.string().min(1), nativeId: z.string().min(1), via: z.string().min(1) }).optional(),
})
export type ExecutionContext = z.infer<typeof ExecutionContextSchema>
