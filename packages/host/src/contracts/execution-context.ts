import { z } from "zod"

const unavailable = z.object({ kind: z.literal("unavailable"), reason: z.string().min(1) })
export const NativeIdentityCapabilitySchema = z.union([
  z.object({ kind: z.literal("reported"), via: z.string().min(1) }),
  unavailable,
])
export type NativeIdentityCapability = z.infer<typeof NativeIdentityCapabilitySchema>

/** Whether execution consumes the account environment prepared by shared admission. */
export const LaunchEnvironmentCapabilitySchema = z.union([
  z.object({ kind: z.literal("prepared"), via: z.string().min(1) }),
  unavailable,
])
export type LaunchEnvironmentCapability = z.infer<typeof LaunchEnvironmentCapabilitySchema>

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

/** Public launch evidence only. Opaque revisions must never contain key material. */
export const ExecutionCredentialSchema = z.union([
  z.object({ kind: z.literal("configured"), source: z.string().min(1), revision: z.union([
    z.object({ kind: z.literal("reported"), value: z.string().min(1), via: z.string().min(1) }),
    unavailable,
  ]) }),
  unavailable,
])
export type ExecutionCredential = z.infer<typeof ExecutionCredentialSchema>

export const AccountConfirmationSchema = z.union([
  z.object({ kind: z.literal("matches"), principal: z.string().min(1) }),
  z.object({ kind: z.literal("differs"), principal: z.string().min(1), expected: z.string().min(1) }),
  unavailable,
])
export type AccountConfirmation = z.infer<typeof AccountConfirmationSchema>

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
  /** Optional only for older journals. A missing field is unverified. */
  credential: ExecutionCredentialSchema.optional(),
  /**
   * Whether the identity the native process reported is the account it was
   * launched with, by that account's email. Shared admission sets it; new
   * input is refused while they differ. Absent until both are known.
   */
  confirmation: AccountConfirmationSchema.optional(),
  service: z.union([
    z.object({ kind: z.literal("reported"), authority: z.string().min(1), via: z.string().min(1) }),
    unavailable,
  ]).optional(),
  store: z.union([
    z.object({ kind: z.literal("located"), path: z.string().min(1) }),
    unavailable,
  ]),
  /** Receipt from a native import response, never inferred from copy support. */
  sourceImport: z.object({ source: z.string().min(1), destination: z.string().min(1), nativeId: z.string().min(1), via: z.string().min(1), revision: z.string().min(1).optional() }).optional(),
})
export type ExecutionContext = z.infer<typeof ExecutionContextSchema>
