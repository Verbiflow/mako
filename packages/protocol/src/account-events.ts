import { z } from "zod"
import type { StreamId } from "./events.js"

/**
 * What an account's own stream (`account:<id>`) carries: what happened to its devices, each event numbered by the
 * account's one object and kept, so every device following it hears of each in order, and a device that was off
 * hears of what happened meanwhile when it comes back. A device that joined, from where and how; a device that left,
 * and why. An event of a type a client doesn't know is skipped, never refused.
 */

/** Where a request came from, as the cloud read its address: never the address. */
export const AccountPlaceSchema = z.object({ city: z.string().nullable(), region: z.string().nullable(), country: z.string().nullable() })

export const AccountEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("device-joined"),
    device: z.object({
      id: z.uuid(),
      kind: z.enum(["desktop", "runtime", "cli"]),
      name: z.string().max(80),
      platform: z.string().max(40),
      enrolledBy: z.enum(["browser", "device-code"]),
      from: AccountPlaceSchema.nullable(),
    }),
  }),
  z.object({
    type: z.literal("device-removed"),
    deviceId: z.uuid(),
    /** `removed` by another of the account's devices (`by`), `signed-out` by itself, `credential-reused` by the cloud. */
    reason: z.enum(["removed", "signed-out", "credential-reused"]),
    by: z.uuid().nullable(),
  }),
])
export type AccountEvent = z.infer<typeof AccountEventSchema>

/** The stream an account's devices follow for its events. */
export function accountStream(accountId: string): StreamId {
  return `account:${accountId}`
}
