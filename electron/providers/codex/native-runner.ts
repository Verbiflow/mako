import { codexServiceTier } from "@mako/sessions/model-catalog"
import { codexWireSettings } from "./settings.js"
import {
  argumentAfter,
  dropUncarried,
  type NativeRunner,
} from "../native-runner.js"

const CARRIES = ["effort", "serviceTier"] as const

function tuningArgs(options: Parameters<NativeRunner["fresh"]>[1]): string[] {
  const tuning = codexWireSettings(options)
  return [
    ...(tuning.model ? ["-m", tuning.model] : []),
    ...(tuning.effort !== undefined
      ? ["-c", `model_reasoning_effort="${tuning.effort}"`]
      : []),
    ...(tuning.serviceTier !== undefined
      ? ["-c", `service_tier="${tuning.serviceTier}"`]
      : []),
  ]
}

/** The `-c key="value"` overrides in an argument list. */
function overrides(args: readonly string[]): Map<string, string> {
  const values = new Map<string, string>()
  args.forEach((argument, index) => {
    if (argument !== "-c") return
    const match = /^([\w.]+)="(.*)"$/.exec(args[index + 1] ?? "")
    if (match?.[1] !== undefined && match[2] !== undefined) values.set(match[1], match[2])
  })
  return values
}

export const codexNativeRunner: NativeRunner = {
  provider: "codex",
  fastMode: "supported",
  carries: CARRIES,
  // The legacy speed name becomes the request tier here, so what the command
  // states is what the ACP transport would have sent.
  prepare: async (options) => {
    const prepared = dropUncarried(options, CARRIES)
    const tier = prepared.options.options?.serviceTier
    if (tier !== undefined && tier !== true && tier !== false)
      prepared.options.options = { ...prepared.options.options, serviceTier: codexServiceTier(tier) }
    return prepared
  },
  resume(id, prompt, options) {
    return {
      command: "codex",
      args: [
        "exec",
        "--sandbox",
        "workspace-write",
        "--skip-git-repo-check",
        ...tuningArgs(options ?? {}),
        "resume",
        id,
        prompt,
      ],
    }
  },
  fresh(prompt, options) {
    return {
      command: "codex",
      args: [
        "exec",
        prompt,
        "--sandbox",
        "workspace-write",
        "--skip-git-repo-check",
        ...tuningArgs(options),
      ],
    }
  },
  describe({ args }) {
    const values = overrides(args)
    const options: Record<string, string> = {}
    const effort = values.get("model_reasoning_effort")
    if (effort !== undefined) options.effort = effort
    const serviceTier = values.get("service_tier")
    if (serviceTier !== undefined) options.serviceTier = serviceTier
    return { model: argumentAfter(args, "-m"), options }
  },
}
