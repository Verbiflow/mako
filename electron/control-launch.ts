import { delimiter } from "node:path"
import type { ControlLaunch } from "@mako/control-runtime/session"

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

export function controlLaunchInstructions(control: ControlLaunch): string {
  return `<mako-local-control>\nBrowser and computer use: use the mako-control MCP js tool; its first result supplies the SDK documentation. After lost context call control.rewriteDocumentation(). For shell/file pipelines, ${JSON.stringify(control.command)} --help exposes the same task session. MCP and CLI share target ownership and program state; do not start another session. Verify results explicitly and never replay an unknown outcome.\n</mako-local-control>`
}
