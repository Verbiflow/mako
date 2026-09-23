import { execFile } from "node:child_process"
import { homedir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import {
  environmentForExecutable,
  resolveExecutable,
} from "../../executable.js"

const run = promisify(execFile)

export function codexExecutableCandidates(env = process.env): string[] {
  if (env.CODEX_EXECUTABLE) {
    const explicit = resolveExecutable(env.CODEX_EXECUTABLE, env)
    return explicit ? [explicit] : []
  }
  const commands = ["codex"]
  if (process.platform === "darwin") {
    for (const root of ["/Applications", join(homedir(), "Applications")])
      for (const app of ["ChatGPT.app", "Codex.app"])
        commands.push(join(root, app, "Contents", "Resources", "codex"))
  }
  return [
    ...new Set(
      commands.flatMap((command) => {
        const path = resolveExecutable(command, env)
        return path ? [path] : []
      })
    ),
  ]
}

/** Check configuration compatibility before creating any native thread. Explicit selection is respected. */
export async function resolveCodexExecutable(
  env = process.env
): Promise<string | null> {
  const candidates = codexExecutableCandidates(env)
  if (env.CODEX_EXECUTABLE || candidates.length < 2)
    return candidates[0] ?? null
  for (const command of candidates) {
    try {
      await run(command, ["features", "list"], {
        env: environmentForExecutable(command, env),
        timeout: 5_000,
        maxBuffer: 256 * 1024,
        windowsHide: true,
      })
      return command
    } catch {
      /* The next installed CLI may understand a newer configuration format. */
    }
  }
  // Preserve the selected CLI's actual startup diagnostic when no compatible installation exists.
  return candidates[0] ?? null
}
