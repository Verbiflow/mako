import { spawn } from "node:child_process"
import type {
  SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk"
import { trackProviderChild } from "../../provider-children.js"

/** Native executables cannot run from Electron's virtual archive. */
export function claudeExecutablePath(command: string): string {
  return command.replace(/([\\/])app\.asar([\\/])/, "$1app.asar.unpacked$2")
}

export function spawnClaudeProcess(options: SpawnOptions, owner?: string) {
  const child = spawn(claudeExecutablePath(options.command), options.args, {
    cwd: options.cwd,
    env: options.env,
    signal: options.signal,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  })
  if (owner) trackProviderChild(child, { kind: "claude:sdk", owner })
  // Diagnostics may contain provider input. Drain without forwarding to host logs.
  child.stderr.resume()
  return child
}
