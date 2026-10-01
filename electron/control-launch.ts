import { delimiter } from "node:path"
import type { ControlLaunch } from "@mako/control-runtime/session"
import type { ThreadEnvironment } from "./contracts/thread-environments.js"
import { threadEnvironmentInstructions } from "./thread-environment.js"

/** Provider shell configuration only. Contains no browser/driver credentials. */
export function applyControlEnvironment(
  env: NodeJS.ProcessEnv,
  control?: ControlLaunch
): void {
  delete env.MAKO_CONTROL_URL
  delete env.MAKO_CONTROL_TOKEN
  delete env.MAKO_CONTROL_SESSION_FILE
  if (!control) return
  env.PATH = `${control.bin}${delimiter}${env.PATH ?? ""}`
  env.MAKO_CONTROL_SESSION_FILE = control.sessionFile
}

/**
 * Mako's note ahead of each prompt. One envelope, whatever it holds: every
 * reader of native history strips exactly this leading envelope.
 */
export function launchInstructions(control?: ControlLaunch, thread?: ThreadEnvironment): string | undefined {
  return controlNote(launchLines(control, thread))
}

export function launchLines(control?: ControlLaunch, thread?: ThreadEnvironment): string[] {
  return [
    control && `Browser and computer use: use the js tool on the mako-computer MCP server; its first result prints the SDK documentation once. Call control.rewriteDocumentation() only if that documentation is no longer in your context. For shell/file pipelines, ${JSON.stringify(control.command)} --help exposes the same task session. MCP and CLI share target ownership and program state; do not start another session. Verify results explicitly and never replay an unknown outcome.`,
    thread && threadEnvironmentInstructions(thread),
  ].filter((line): line is string => Boolean(line))
}

export function controlNote(lines: readonly string[]): string | undefined {
  return lines.length ? `<mako-local-control>\n${lines.join("\n")}\n</mako-local-control>` : undefined
}
