import { registerIpc } from "./register.js"
import type { DeskApp } from "../environment-tools.js"
import { AppOutputKeySchema, type AppActionOutcome, type AppMark, type AppOutputChunk, type AppOutputCursor, type AppProbeView, type RoomView, type ThreadAppView } from "../contracts/thread-app.js"
import type { ProjectAppSetup } from "../contracts/project-app.js"

/** A folder's app for the strip and the terminal dock: its view, its buttons, and what it printed. `target` is the one the person picked. */
export function installThreadAppIpc(desk: DeskApp) {
  registerIpc("mako:thread-app", (_event, cwd: string, target?: string): Promise<ThreadAppView> => desk.view(cwd, target))
  registerIpc("mako:thread-app-start", (_event, cwd: string, target?: string): Promise<AppActionOutcome> => desk.start(cwd, target))
  registerIpc("mako:thread-app-stop", (_event, cwd: string): Promise<void> => desk.stop(cwd))
  registerIpc("mako:thread-app-restart", (_event, cwd: string, target?: string): Promise<AppActionOutcome> => desk.restart(cwd, target))
  registerIpc("mako:thread-app-check", (_event, cwd: string, tier: "quick" | "full", target?: string, steps?: string[]): Promise<AppActionOutcome> =>
    desk.check(cwd, tier, target, steps))
  registerIpc("mako:thread-app-make-room", (_event, cwd: string, target?: string): Promise<AppActionOutcome> => desk.makeRoom(cwd, target))
  registerIpc("mako:thread-app-take-turn", (_event, cwd: string, target?: string): Promise<AppActionOutcome> => desk.takeTurn(cwd, target))
  registerIpc("mako:thread-app-output", (_event, cwd: string, key: string, cursor?: AppOutputCursor): Promise<AppOutputChunk> =>
    desk.output(cwd, AppOutputKeySchema.parse(key), cursor))
  registerIpc("mako:thread-app-probe", (_event, cwd: string): Promise<AppProbeView> => desk.probe(cwd))
  registerIpc("mako:thread-app-marks", (): Promise<AppMark[]> => desk.marks())
  registerIpc("mako:thread-app-room", (): Promise<RoomView> => desk.room())
  registerIpc("mako:thread-app-stop-apps", (_event, apps: string[]): Promise<void> => desk.stopApps(apps))
  registerIpc("mako:project-app-setup", (_event, cwd: string): Promise<ProjectAppSetup> => desk.setup(cwd))
  registerIpc("mako:project-app-secrets", (_event, cwd: string, allow: boolean): Promise<ProjectAppSetup> => desk.allowSecrets(cwd, allow))
}
