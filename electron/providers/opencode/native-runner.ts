import { openCodeExecutable, openCodeSessionGeneration, resolveOpenCodeInstallation } from "./installation.js"
import {
  argumentAfter,
  commandTuning,
  dropUncarried,
  type CommandTuning,
  type NativeRunner,
} from "../native-runner.js"

const CARRIES = ["effort"] as const

function tuningArgs(tuning: CommandTuning, generation: "v1" | "v2") {
  if (!tuning.model) return []
  if (generation === "v2") {
    return [
      "--model",
      tuning.cliEffort ? `${tuning.model}#${tuning.cliEffort}` : tuning.model,
    ]
  }
  return [
    "--model",
    tuning.model,
    ...(tuning.cliEffort ? ["--variant", tuning.cliEffort] : []),
  ]
}

export const openCodeNativeRunner: NativeRunner = {
  provider: "opencode",
  available: () => openCodeExecutable() !== null,
  fastMode: "supported",
  carries: CARRIES,
  prepare: async (options) => dropUncarried(options, CARRIES),
  async resume(id, prompt, options, env = process.env) {
    const preferred = await openCodeSessionGeneration(id, options?.nativePath, env)
    const installation = await resolveOpenCodeInstallation(preferred, env)
    const generation = installation.generation
    return {
      command: installation.command,
      args: [
        "run",
        ...(generation === "v2" ? ["--auto"] : []),
        "--session",
        id,
        ...tuningArgs(commandTuning(options), generation),
        prompt,
      ],
    }
  },
  async fresh(prompt, options, env = process.env) {
    const installation = await resolveOpenCodeInstallation(undefined, env)
    const generation = installation.generation
    return {
      command: installation.command,
      args: [
        "run",
        ...(generation === "v2" ? ["--auto"] : []),
        ...tuningArgs(commandTuning(options), generation),
        prompt,
      ],
    }
  },
  describe({ args }) {
    const options: Record<string, string> = {}
    const model = argumentAfter(args, "--model")
    // v2 folds the variant into the model as `model#variant`; v1 flags it.
    const hash = model?.indexOf("#") ?? -1
    const variant = hash >= 0 ? model?.slice(hash + 1) : argumentAfter(args, "--variant")
    if (variant) options.effort = variant
    return { model: hash >= 0 ? model?.slice(0, hash) : model, options }
  },
}
