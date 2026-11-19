import type { AppKey } from "../contracts/thread-environments.js"
import type { RemoteAppDemand, RemoteAppReply, RemoteAppSnapshot } from "../contracts/remote-app.js"
import type { MethodTable } from "../base/methods.js"
import type { DeskApp } from "./environment-tools.js"
import { AppOutputKeySchema, type AppActionOutcome, type AppMark, type AppOutputChunk, type AppOutputCursor, type AppProbeView, type AppSamplingDemand, type AppSamplingReply, type RoomView, type ThreadAppView } from "../contracts/thread-app.js"
import { hostClient } from "../base/host-client.js"
import type { ProjectAppSetup } from "../contracts/project-app.js"
import type { ThreadAppSampler } from "./app-sampler.js"

/**
 * A folder's app for the strip and the terminal dock: its view, its buttons, and what it printed. `target` is the one the person picked.
 * Without the Thread store there are no apps, and each call says so.
 */
export function declareThreadAppMethods(methods: MethodTable, apps: DeskApp | undefined, sampler?: ThreadAppSampler, outputReady?: (apps: readonly AppKey[]) => boolean, windowShown?: (client: string, shown: boolean) => boolean) {
  const desk = (): DeskApp => {
    if (!apps) throw new Error("Thread apps need the Thread store, which this host couldn't open.")
    return apps
  }
  methods.handle("mako:thread-app-demand", (demand?: AppSamplingDemand): AppSamplingReply => {
    const client = hostClient()
    if (demand) {
      if (!sampler?.follow(client, demand)) return { kind: "unavailable" }
      return { kind: "following", ...(demand.outputs && { outputs: outputReady?.(demand.outputs) ?? false }) }
    }
    const connection = sampler?.connection(client)
    return connection ? { kind: "ready", connection, generation: sampler?.generation(client) ?? 0 } : { kind: "unavailable" }
  })
  // A window saying nobody can see it, or that someone can again: while hidden its stream is told nothing that exists
  // only to be painted (`live-ahead`). Everything it must hold to be right when it shows still reaches it.
  methods.handle("mako:window-shown", (shown: boolean): boolean => windowShown?.(hostClient(), shown) ?? false)
  // A window showing a folder's app hears it change by the sampler's pushes, so its ask keeps the sampler looking.
  methods.handle("mako:thread-app", (cwd: string, target?: string): Promise<ThreadAppView> => {
    sampler?.wanted(hostClient())
    return desk().view(cwd, target)
  })
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
  // As last looked at for every window (`ThreadAppSampler`), which then hears them pushed as they change.
  methods.handle("mako:thread-app-marks", (): Promise<AppMark[]> => sampler ? sampler.current(hostClient()) : desk().marks())
  methods.handle("mako:thread-app-room", (): Promise<RoomView> => {
    sampler?.wanted(hostClient())
    return desk().room()
  })
  methods.handle("mako:thread-app-stop-apps", (apps: string[]): Promise<void> => desk().stopApps(apps))
  methods.handle("mako:project-app-setup", (cwd: string): Promise<ProjectAppSetup> => desk().setup(cwd))
}

/** Conversation-scoped reads never trust a folder supplied by a remote page or renew its legacy client lease. */
export function declareRemoteAppMethods(methods: MethodTable, deps: {
  apps: Pick<DeskApp, "view"> | undefined
  sampler: ThreadAppSampler | undefined
  cwd(conversation: string): string | undefined
  position(): { epoch: string; revision: number }
  confirm(conversation: string): void
}) {
  methods.handle("mako:conversation-app-demand", (conversation: string, demand: RemoteAppDemand): RemoteAppReply => {
    if (!deps.cwd(conversation) || !deps.apps || !deps.sampler?.followRemote(hostClient(), conversation, demand)) return { kind: "unavailable" }
    if (demand.visible && demand.confirm) deps.confirm(conversation)
    return { kind: "following", ...deps.position() }
  })
  methods.handle("mako:conversation-app", async (conversation: string, view: string): Promise<RemoteAppSnapshot> => {
    const cwd = deps.cwd(conversation)
    if (!cwd || !deps.apps || !deps.sampler?.remoteActive(hostClient(), conversation, view)) throw new Error("This app view is no longer followed")
    return { folder: cwd, app: await deps.apps.view(cwd) }
  })
}
