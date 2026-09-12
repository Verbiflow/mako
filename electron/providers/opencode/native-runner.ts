import { openCodeInstallation } from "./installation.js"
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
  fastMode: "supported",
  carries: CARRIES,
  prepare: async (options) => dropUncarried(options, CARRIES),
  resume(id, prompt, options) {
    const preferred =
      options?.nativePath?.includes("#v2:") ||
      options?.nativePath?.includes("opencode-next.db#")
        ? "v2"
        : "v1"
    const installation = openCodeInstallation(preferred)
    if (!installation)
      throw new Error(
        `OpenCode ${preferred} is required to resume this session.`
      )
    const generation = installation.generation
    return {
      command: installation?.command ?? "opencode",
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
  fresh(prompt, options) {
    const installation = openCodeInstallation()
    const generation = installation?.generation ?? "v1"
    return {
      command: installation?.command ?? "opencode",
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
