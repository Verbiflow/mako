import { openCodeExecutable, verifyOpenCodeSession, resolveOpenCodeInstallation } from "./installation.js"
import {
  argumentAfter,
  commandTuning,
  dropUncarried,
  type CommandTuning,
  type NativeRunner,
} from "../native-runner.js"

const CARRIES = ["effort"] as const

function tuningArgs(tuning: CommandTuning) {
  if (!tuning.model) return []
  return ["--model", tuning.cliEffort ? `${tuning.model}#${tuning.cliEffort}` : tuning.model]
}

export const openCodeNativeRunner: NativeRunner = {
  provider: "opencode",
  available: () => openCodeExecutable() !== null,
  fastMode: "supported",
  carries: CARRIES,
  prepare: async (options) => dropUncarried(options, CARRIES),
  async resume(id, prompt, options, env = process.env) {
    await verifyOpenCodeSession(id, options?.nativePath, env)
    const installation = await resolveOpenCodeInstallation(env)
    return {
      command: installation.command,
      args: [
        "run",
        "--auto",
        "--session",
        id,
        ...tuningArgs(commandTuning(options)),
        prompt,
      ],
    }
  },
  async fresh(prompt, options, env = process.env) {
    const installation = await resolveOpenCodeInstallation(env)
    return {
      command: installation.command,
      args: [
        "run",
        "--auto",
        ...tuningArgs(commandTuning(options)),
        prompt,
      ],
    }
  },
  describe({ args }) {
    const options: Record<string, string> = {}
    const model = argumentAfter(args, "--model")
    // OpenCode v2 carries the variant in `model#variant`.
    const hash = model?.indexOf("#") ?? -1
    const variant = hash >= 0 ? model?.slice(hash + 1) : undefined
    if (variant) options.effort = variant
    return { model: hash >= 0 ? model?.slice(0, hash) : model, options }
  },
}
