import type { SessionModel as HarnessModel } from "@mako/sessions/settings"
import type { SessionSettings } from "@mako/sessions/settings"
import type { ProviderCapability } from "./registry.js"

export interface NativeRunOptions extends SessionSettings {
  captureOutput?: boolean
  nativePath?: string
  /**
   * The catalog's default for each option of the selected model. A live
   * session holds its own defaults; a command line has none, so a runner
   * that must name a level (Cursor's flat ids) reads the provider's here.
   */
  defaults?: NonNullable<SessionSettings["options"]>
}

export interface NativeCommand {
  command: string
  args: string[]
  /** Settings the CLI reads from its environment rather than its arguments. */
  env?: Record<string, string>
}

/**
 * What `prepare` settled before a command is built: the options the command
 * carries, the option ids it cannot carry, and the ids whose selected value
 * is the command line's own default and so goes unstated (Cursor's
 * `gpt-5.3-codex` is medium with no suffix). A dropped option is reported to
 * the user; an implicit one is verified by `describe`.
 */
export interface PreparedRun {
  options: NativeRunOptions
  dropped: string[]
  implicit?: string[]
}

export interface NativeRunner extends ProviderCapability {
  fastMode: "supported" | "unsupported"
  /**
   * Option ids this command line expresses. A selection may carry more —
   * the same settings drive the provider's ACP transport — and anything
   * outside this list is dropped and said so, never silently.
   */
  carries: readonly string[]
  configureEnvironment?(env: NodeJS.ProcessEnv): void
  /**
   * Settle the settings a command line can carry before the command is
   * built, with the account's environment in hand: Cursor's CLI takes one
   * flat id from an account-dependent list, so the model is resolved against
   * that list here. Throws when the selection has no honest command-line
   * form; the run then fails with that reason instead of running elsewhere.
   * Runners without their own step get `dropUncarried`.
   */
  prepare?(
    options: NativeRunOptions,
    env: NodeJS.ProcessEnv
  ): Promise<PreparedRun>
  resume(
    id: string,
    prompt: string,
    options?: NativeRunOptions
  ): NativeCommand
  fresh(prompt: string, options: NativeRunOptions): NativeCommand
  /**
   * The settings a built command states, read back from its arguments
   * against the provider's catalog: a runner whose command line folds
   * settings into the model id (Cursor) needs the catalog's model ids and
   * option vocabulary to name what the id says. `test-transport-agreement.ts`
   * pins this against the settings the ACP transport applies from one
   * selection.
   */
  describe(command: NativeCommand, catalog: readonly HarnessModel[]): SessionSettings
}

export interface CommandTuning {
  model?: string
  effort?: string
  cliEffort?: string
  fast?: boolean
  serviceTier?: string
}

function stringOption(
  value: string | boolean | undefined
): string | undefined {
  if (value === undefined || value === true || value === false) return undefined
  return value
}

export function commandTuning(
  options: NativeRunOptions | undefined
): CommandTuning {
  if (!options) return {}
  const tuning: CommandTuning = {}
  const optionEffort = stringOption(options.options?.effort)
  const serviceTier = stringOption(options.options?.serviceTier)
  if (options.model !== undefined) tuning.model = options.model
  if (optionEffort !== undefined) {
    tuning.effort = optionEffort
    tuning.cliEffort = optionEffort
  }
  const fast = options.options?.fast
  if (fast === true || fast === false) tuning.fast = fast
  if (serviceTier !== undefined) tuning.serviceTier = serviceTier
  return tuning
}

/** The generic `prepare`: keep what the command line carries, name the rest. */
export function dropUncarried(
  options: NativeRunOptions,
  carries: readonly string[]
): PreparedRun {
  const kept: NonNullable<SessionSettings["options"]> = {}
  const dropped: string[] = []
  for (const [id, value] of Object.entries(options.options ?? {})) {
    if (value === undefined) continue
    if (carries.includes(id)) kept[id] = value
    else dropped.push(id)
  }
  return { options: { ...options, options: kept }, dropped }
}

/** The value following `flag` in an argument list, if any. */
export function argumentAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}
