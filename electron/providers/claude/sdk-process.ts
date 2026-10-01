import type {
  SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk"
import { spawnProviderProcess } from "../provider-process.js"
import { unpackedPath } from "../../asar-unpacked.js"

export function claudeExecutablePath(command: string): string {
  return unpackedPath(command)
}

export function spawnClaudeProcess(options: SpawnOptions, owner?: string) {
  const child = spawnProviderProcess(claudeExecutablePath(options.command), options.args, {
    cwd: options.cwd,
    env: options.env,
    signal: options.signal,
    windowsHide: true,
  }, owner ? { kind: "claude:sdk", owner } : undefined)
  // Diagnostics may contain provider input, so only a bounded tail is kept,
  // for the one line that explains an abnormal exit.
  let stderr = ""
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-4000)
  })
  return { child, stderr: () => stderr }
}
