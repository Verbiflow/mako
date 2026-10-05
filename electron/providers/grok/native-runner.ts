import { resolveExecutable } from "../../executable.js"
import {
  CLI_OWNED_CREDENTIALS,
  argumentAfter,
  commandTuning,
  dropUncarried,
  type NativeRunner,
} from "../native-runner.js"

const CARRIES = ["effort"] as const

function tuningArgs(options: Parameters<NativeRunner["fresh"]>[1]): string[] {
  const tuning = commandTuning(options)
  return [
    ...(tuning.model ? ["--model", tuning.model] : []),
    ...(tuning.cliEffort !== undefined
      ? ["--reasoning-effort", tuning.cliEffort]
      : []),
  ]
}

export const grokNativeRunner: NativeRunner = {
  provider: "grok",
  transport: "grok-cli-headless",
  launchCredentials: CLI_OWNED_CREDENTIALS,
  available: () => resolveExecutable("grok") !== null,
  fastMode: "supported",
  carries: CARRIES,
  prepare: async (options) => dropUncarried(options, CARRIES),
  resume(id, prompt, options) {
    return {
      command: "grok",
      args: [
        "-p",
        prompt,
        "--resume",
        id,
        "--always-approve",
        ...tuningArgs(options ?? {}),
      ],
    }
  },
  fresh(prompt, options) {
    return {
      command: "grok",
      args: [
        "-p",
        prompt,
        "--always-approve",
        ...tuningArgs(options),
      ],
    }
  },
  describe({ args }) {
    const options: Record<string, string> = {}
    const effort = argumentAfter(args, "--reasoning-effort")
    if (effort !== undefined) options.effort = effort
    return { model: argumentAfter(args, "--model"), options }
  },
}
