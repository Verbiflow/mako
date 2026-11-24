import { z } from "zod"
import { RuntimeVersionsSchema } from "./harness-versions.js"

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

export const HarnessUpdateCommandSchema = z.lazy(() => z.object({
  label: z.string(),
  command: z.string(),
  args: z.array(z.string()),
  /** What the plan does in a line, for a script of Mako's own that nobody would read: shown in its place. */
  summary: z.string().optional(),
}))
export type HarnessUpdateCommand = z.infer<typeof HarnessUpdateCommandSchema>

/** The receipt of the last update Mako ran for a runtime. */
export const HarnessUpdateResultSchema = z.lazy(() => z.object({
  at: z.number(),
  outcome: z.enum(["installed", "updated", "unchanged", "failed"]),
  from: z.string().optional(),
  to: z.string().optional(),
  /** Why it failed, in Mako's sentence; what the updater itself printed is worded (`updateFailureWords`) and logged. */
  message: z.string().optional(),
}))
export type HarnessUpdateResult = z.infer<typeof HarnessUpdateResultSchema>

/** The sentences a failed update or install is said in; anything else an updater printed is the log's. */
const UPDATE_FAILURES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bEACCES\b|\bEPERM\b|permission denied|operation not permitted/i, "It needs permission to change the folder it's installed in."],
  [/\bENOSPC\b|no space left/i, "The disk is full."],
  [/\bENOTFOUND\b|\bETIMEDOUT\b|\bECONNRE(?:SET|FUSED)\b|\bEAI_AGAIN\b|getaddrinfo|could not resolve host|socket hang up|network|fetch failed/i, "The download didn't get through. Check the connection."],
  [/\bEBUSY\b|text file busy|resource busy/i, "It's in use. Quit what's running it."],
]

/** What the person reads of what a failed updater or installer printed: one of `UPDATE_FAILURES`, else that it didn't finish. */
export function updateFailureWords(printed: string): string {
  return UPDATE_FAILURES.find(([pattern]) => pattern.test(printed))?.[1] ?? "The updater didn't finish."
}

export const HarnessUpdateInfoSchema = z.lazy(() => z.object({
  provider: z.string().optional(),
  label: z.string().optional(),
  description: z.string().optional(),
  primary: z.boolean().optional(),
  /** Identity of the release feed; cached readings never cross feeds. */
  releaseSource: z.string().optional(),
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
  /** The installer Mako can run while no binary is found: the first plan whose command exists here. */
  install: HarnessUpdateCommandSchema.optional(),
  /** The version `install` puts in place: the harness's `tested`, where its installs are pinned to it. */
  installs: z.string().optional(),
  /** What the host is doing with this runtime right now. Never persisted. */
  phase: z.enum(["checking", "updating", "installing"]).optional(),
  /** When the installed reading was taken. */
  checkedAt: z.number().optional(),
  /** When the public version was last read. */
  latestCheckedAt: z.number().optional(),
  /** The installed reading failed: no binary, or one that would not say its version. */
  error: z.string().optional(),
  /** The public version could not be read; the installed reading still stands. */
  latestError: z.string().optional(),
  result: HarnessUpdateResultSchema.optional(),
  /**
   * Where the installed version stands against the harness's declared oldest
   * and tested versions. Absent when the version is unknown or the harness
   * declares none: an unreadable version never stops anything.
   */
  versions: RuntimeVersionsSchema.optional(),
}))
export type HarnessUpdateInfo = z.infer<typeof HarnessUpdateInfoSchema>

export type HarnessUpdates = Record<string, HarnessUpdateInfo>
