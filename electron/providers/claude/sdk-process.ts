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
  // Diagnostics may contain provider input. Drain without forwarding to host logs.
  child.stderr.resume()
  return child
}
