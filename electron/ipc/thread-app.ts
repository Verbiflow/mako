import type { MethodTable } from "../host-methods.js"
import type { DeskApp } from "../environment-tools.js"
import { AppOutputKeySchema, type AppActionOutcome, type AppMark, type AppOutputChunk, type AppOutputCursor, type AppProbeView, type RoomView, type ThreadAppView } from "@mako/host/contracts/thread-app"
import type { ProjectAppSetup } from "@mako/host/contracts/project-app"

/**
 * A folder's app for the strip and the terminal dock: its view, its buttons, and what it printed. `target` is the one the person picked.
 * Without the Thread store there are no apps, and each call says so.
 */
export function installThreadAppIpc(methods: MethodTable, apps: DeskApp | undefined) {
  const desk = (): DeskApp => {
    if (!apps) throw new Error("Thread apps need the Thread store, which this host couldn't open.")
    return apps
  }
  methods.handle("mako:thread-app", (cwd: string, target?: string): Promise<ThreadAppView> => desk().view(cwd, target))
  methods.handle("mako:thread-app-start", (cwd: string, target?: string): Promise<AppActionOutcome> => desk().start(cwd, target))
  methods.handle("mako:thread-app-stop", (cwd: string): Promise<void> => desk().stop(cwd))
  methods.handle("mako:thread-app-restart", (cwd: string, target?: string): Promise<AppActionOutcome> => desk().restart(cwd, target))
  methods.handle("mako:thread-app-check", (cwd: string, tier: "quick" | "full", target?: string, steps?: string[]): Promise<AppActionOutcome> =>
    desk().check(cwd, tier, target, steps))
  methods.handle("mako:thread-app-make-room", (cwd: string, target?: string): Promise<AppActionOutcome> => desk().makeRoom(cwd, target))
  methods.handle("mako:thread-app-take-turn", (cwd: string, target?: string): Promise<AppActionOutcome> => desk().takeTurn(cwd, target))
  methods.handle("mako:thread-app-output", (cwd: string, key: string, cursor?: AppOutputCursor): Promise<AppOutputChunk> =>
    desk().output(cwd, AppOutputKeySchema.parse(key), cursor))
  methods.handle("mako:thread-app-probe", (cwd: string): Promise<AppProbeView> => desk().probe(cwd))
  methods.handle("mako:thread-app-marks", (): Promise<AppMark[]> => desk().marks())
  methods.handle("mako:thread-app-room", (): Promise<RoomView> => desk().room())
  methods.handle("mako:thread-app-stop-apps", (apps: string[]): Promise<void> => desk().stopApps(apps))
  methods.handle("mako:project-app-setup", (cwd: string): Promise<ProjectAppSetup> => desk().setup(cwd))
}
