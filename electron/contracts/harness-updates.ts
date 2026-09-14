import { z } from "zod"

/** Where a runtime's updates come from once it is installed. */
export const HarnessUpdateChannelSchema = z.enum([
  "npm",
  "brew",
  "self",
  "app",
  "managed",
])
export type HarnessUpdateChannel = z.infer<typeof HarnessUpdateChannelSchema>

export const HarnessUpdateInfoSchema = z.object({
  /** The binary the provider would launch, resolved the way the driver does. */
  binary: z.string().optional(),
  installed: z.string().optional(),
  /** The newest public version, when the runtime publishes one Mako can read. */
  latest: z.string().optional(),
  channel: HarnessUpdateChannelSchema.optional(),
  /** Who owns the update when Mako cannot run it — "Codex.app", "Zed". */
  managedBy: z.string().optional(),
  /** An update Mako can run for the user. */
  update: z
    .object({ label: z.string(), command: z.string(), args: z.array(z.string()) })
    .optional(),
  error: z.string().optional(),
})
export type HarnessUpdateInfo = z.infer<typeof HarnessUpdateInfoSchema>
