import { z } from "zod"

/**
 * Who owns a runtime's updates once it is installed.
 *
 * Read off the binary's real path: an npm, bun or pnpm global, a Homebrew
 * cellar, the CLI's own installer root (`self`), an application bundle
 * (`app`), another app's registry (`managed`), or a path Mako cannot place
 * (`manual`: shown, never updated by Mako).
 */
export const HarnessUpdateChannelSchema = z.enum([
  "npm",
  "bun",
  "pnpm",
  "brew",
  "self",
  "app",
  "managed",
  "manual",
])
export type HarnessUpdateChannel = z.infer<typeof HarnessUpdateChannelSchema>

export const HarnessUpdateCommandSchema = z.object({
  label: z.string(),
  command: z.string(),
  args: z.array(z.string()),
})
export type HarnessUpdateCommand = z.infer<typeof HarnessUpdateCommandSchema>

/** The receipt of the last update Mako ran for a runtime. */
export const HarnessUpdateResultSchema = z.object({
  at: z.number(),
  outcome: z.enum(["updated", "unchanged", "failed"]),
  from: z.string().optional(),
  to: z.string().optional(),
  /** The updater's own words on failure: the tail of what it printed. */
  message: z.string().optional(),
})
export type HarnessUpdateResult = z.infer<typeof HarnessUpdateResultSchema>

export const HarnessUpdateInfoSchema = z.object({
  /** The binary the provider would launch, resolved the way the driver does. */
  binary: z.string().optional(),
  installed: z.string().optional(),
  /** The newest public version, when the runtime publishes one Mako can read. */
  latest: z.string().optional(),
  channel: HarnessUpdateChannelSchema.optional(),
  /** Who owns the update when Mako cannot run it — "ChatGPT.app", "Zed". */
  managedBy: z.string().optional(),
  /** An update Mako can run for the user. */
  update: HarnessUpdateCommandSchema.optional(),
  /** What the host is doing with this runtime right now. Never persisted. */
  phase: z.enum(["checking", "updating"]).optional(),
  /** When the installed reading was taken. */
  checkedAt: z.number().optional(),
  /** When the public version was last read. */
  latestCheckedAt: z.number().optional(),
  /** The installed reading failed: no binary, or one that would not say its version. */
  error: z.string().optional(),
  /** The public version could not be read; the installed reading still stands. */
  latestError: z.string().optional(),
  result: HarnessUpdateResultSchema.optional(),
})
export type HarnessUpdateInfo = z.infer<typeof HarnessUpdateInfoSchema>

export type HarnessUpdates = Record<string, HarnessUpdateInfo>
