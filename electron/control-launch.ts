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
  return `<mako-local-control>\nBrowser and computer use: run ${JSON.stringify(control.command)} --help, then use its composable commands or exec --source-file. Your task session is already attached; no setup tool is needed. Read help only as needed. Screenshots are files; verify action results explicitly and never replay an unknown outcome.\n</mako-local-control>`
}
