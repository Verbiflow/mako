import { devinExecutable } from "./executable.js"
import {
  argumentAfter,
  commandTuning,
  dropUncarried,
  type NativeRunner,
} from "../native-runner.js"

/** Devin's command line names a variant id; the variant already carries effort and speed. */
const CARRIES: readonly string[] = []

export const devinNativeRunner: NativeRunner = {
  provider: "devin",
  fastMode: "supported",
  carries: CARRIES,
  prepare: async (options) => dropUncarried(options, CARRIES),
  resume(id, prompt, options) {
    const tuning = commandTuning(options)
    return {
      command: devinExecutable() ?? "devin",
      args: [
        "-p",
        prompt,
        "--resume",
        id,
        "--permission-mode",
        "smart",
        "--respect-workspace-trust",
        "false",
        ...(tuning.model ? ["--model", tuning.model] : []),
      ],
    }
  },
  fresh(prompt, options) {
    const tuning = commandTuning(options)
    return {
      command: devinExecutable() ?? "devin",
      args: [
        "-p",
        prompt,
        "--permission-mode",
        "smart",
        "--respect-workspace-trust",
        "false",
        ...(tuning.model ? ["--model", tuning.model] : []),
      ],
    }
  },
  describe({ args }) {
    return { model: argumentAfter(args, "--model"), options: {} }
  },
}
