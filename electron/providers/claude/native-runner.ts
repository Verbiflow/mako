import { z } from "zod"
import {
  argumentAfter,
  commandTuning,
  dropUncarried,
  type NativeCommand,
  type NativeRunner,
} from "../native-runner.js"

const CARRIES = ["effort", "fast", "agentTeams"] as const
const FastSettingsSchema = z.object({ fastMode: z.boolean().optional() })
/** The SDK driver sets the same variable for the CLI it spawns (`sdk-options.ts`). */
const AGENT_TEAMS = "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS"

function agentTeamsEnv(options: Parameters<NativeRunner["resume"]>[2]): Record<string, string> | undefined {
  const value = options?.options?.agentTeams
  return value === true || value === false ? { [AGENT_TEAMS]: value ? "1" : "0" } : undefined
}

function withEnv(command: NativeCommand, env: Record<string, string> | undefined): NativeCommand {
  if (env) command.env = env
  return command
}

export const claudeNativeRunner: NativeRunner = {
  provider: "claude",
  fastMode: "supported",
  carries: CARRIES,
  prepare: async (options) => dropUncarried(options, CARRIES),
  resume(id, prompt, options) {
    const tuning = commandTuning(options)
    return withEnv(
      {
        command: "claude",
        args: [
          "-p",
          prompt,
          "--resume",
          id,
          "--dangerously-skip-permissions",
          ...(tuning.model ? ["--model", tuning.model] : []),
          ...(tuning.effort ? ["--effort", tuning.effort] : []),
          ...(tuning.fast !== undefined ? ["--settings", JSON.stringify({ fastMode: tuning.fast })] : []),
        ],
      },
      agentTeamsEnv(options)
    )
  },
  fresh(prompt, options) {
    const tuning = commandTuning(options)
    return withEnv(
      {
        command: "claude",
        args: [
          "-p",
          prompt,
          "--dangerously-skip-permissions",
          ...(tuning.model ? ["--model", tuning.model] : []),
          ...(tuning.effort ? ["--effort", tuning.effort] : []),
          ...(tuning.fast !== undefined ? ["--settings", JSON.stringify({ fastMode: tuning.fast })] : []),
        ],
      },
      agentTeamsEnv(options)
    )
  },
  describe({ args, env }) {
    const options: Record<string, string | boolean> = {}
    const teams = env?.[AGENT_TEAMS]
    if (teams === "1" || teams === "0") options.agentTeams = teams === "1"
    const effort = argumentAfter(args, "--effort")
    if (effort !== undefined) options.effort = effort
    const settings = argumentAfter(args, "--settings")
    if (settings !== undefined) {
      const parsed = FastSettingsSchema.safeParse(JSON.parse(settings))
      if (parsed.success && parsed.data.fastMode !== undefined) options.fast = parsed.data.fastMode
    }
    return { model: argumentAfter(args, "--model"), options }
  },
}
