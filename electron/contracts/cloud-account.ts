import { z } from "zod"

/**
 * This Mac's Mako account: who it is signed in as, and its live connection to
 * the cloud. The host answers with public account facts and never the device
 * credential or a connection token.
 */
export const CloudDeviceKindSchema = z.enum(["desktop", "runtime", "cli"])

export const CloudDeviceSchema = z.object({
  id: z.string(),
  kind: CloudDeviceKindSchema,
  name: z.string(),
  platform: z.string(),
  appVersion: z.string().nullable(),
  enrolledBy: z.enum(["browser", "device-code"]),
  createdAt: z.string(),
  lastSeenAt: z.string(),
})
export type CloudDevice = z.infer<typeof CloudDeviceSchema>

export const CloudPersonSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  image: z.string().nullable(),
  entitlements: z.array(z.string()),
})
export type CloudPerson = z.infer<typeof CloudPersonSchema>

/** Why this Mac is signed out, when something other than the person did it. */
export const CloudSignedOutNoticeSchema = z.object({
  kind: z.enum(["removed", "timed-out", "failed"]),
  message: z.string(),
})
export type CloudSignedOutNotice = z.infer<typeof CloudSignedOutNoticeSchema>

export const CloudAccountStateSchema = z.discriminatedUnion("status", [
  /** No cloud is configured for this build, or this host may not reach it. */
  z.object({ status: z.literal("unavailable"), message: z.string() }),
  z.object({ status: z.literal("signed-out"), notice: CloudSignedOutNoticeSchema.optional() }),
  /** The browser is open at `url`; the host finishes by itself when it returns. */
  z.object({ status: z.literal("signing-in"), url: z.string(), startedAt: z.string() }),
  z.object({
    status: z.literal("signed-in"),
    account: CloudPersonSchema,
    device: CloudDeviceSchema,
    connection: z.enum(["connecting", "connected", "offline"]),
    /** False when the system keychain was unavailable: the sign-in lasts until Mako quits. */
    /** Where the sign-in is kept: the keychain, or memory until Mako quits (no keychain, or a fixture desk that writes nothing). */
    kept: z.enum(["keychain", "memory", "fixture"]),
  }),
])
export type CloudAccountState = z.infer<typeof CloudAccountStateSchema>

export const CloudAccountSchema = z.object({
  /** The cloud's address as people read it, such as `cloud.example.com` or `127.0.0.1:8787`. */
  cloud: z.string().nullable(),
  state: CloudAccountStateSchema,
})
export type CloudAccount = z.infer<typeof CloudAccountSchema>
